// api/stripe-webhook.js
import { buffer } from "micro";
import Stripe from "stripe";

export const config = { api: { bodyParser: false }, runtime: "nodejs" };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2020-08-27" });
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

/** Utils */
const trimOrNull = (v) => {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
};
function getCompanyFieldsFromSession(session) {
  const out = { companyName: null, taxNumber: null };
  const fields = session?.custom_fields || [];
  for (const f of fields) {
    if (f?.key === "company_name") out.companyName = trimOrNull(f?.text?.value);
    if (f?.key === "company_tax_number") out.taxNumber = trimOrNull(f?.text?.value);
  }
  return out;
}
function buildInvoiceCustomFields({ companyName, taxNumber }) {
  const arr = [];
  if (companyName) arr.push({ name: "Company", value: companyName });
  if (taxNumber)   arr.push({ name: "Tax ID", value: taxNumber });
  return arr.length ? arr : null;
}
async function findLatestDraftInvoiceForCustomer(customerId) {
  const list = await stripe.invoices.list({ customer: customerId, limit: 1, status: "draft" });
  return list.data?.[0] || null;
}
async function setCustomerInvoiceDefaults(customerId, fields, eventId) {
  const customFields = buildInvoiceCustomFields(fields);
  if (!customFields) return;
  await stripe.customers.update(
    customerId,
    { invoice_settings: { custom_fields: customFields } },
    { idempotencyKey: `cust-invoice-defaults-${customerId}-${eventId}` }
  );
}
async function applyFieldsToDraft(invoice, fields, eventId) {
  if (!invoice || invoice.status !== "draft") return;
  const customFields = buildInvoiceCustomFields(fields);
  if (!customFields) return;
  await stripe.invoices.update(
    invoice.id,
    { custom_fields: customFields, auto_advance: false }, // stays draft  
    { idempotencyKey: `inv-update-${invoice.id}-${eventId}` }
  );
}
async function pauseAutoAdvance(invoiceId, eventId) {
  await stripe.invoices.update(
    invoiceId,
    { auto_advance: false },
    { idempotencyKey: `inv-pause-${invoiceId}-${eventId}` }
  );
}
async function finalizeInvoice(invoiceId, eventId) {
  await stripe.invoices.finalizeInvoice(
    invoiceId,
    { idempotencyKey: `inv-finalize-${invoiceId}-${eventId}` }
  );
}
async function payInvoice(invoiceId, eventId) {
  await stripe.invoices.pay(
    invoiceId,
    { idempotencyKey: `inv-pay-${invoiceId}-${eventId}` }
  );
}
async function stashFieldsOnCustomer(customerId, fields, eventId) {
  const meta = {};
  if (fields.companyName) meta.company_name_from_checkout = fields.companyName;
  if (fields.taxNumber)   meta.company_tax_number_from_checkout = fields.taxNumber;
  if (!Object.keys(meta).length) return;
  await stripe.customers.update(
    customerId,
    { metadata: meta },
    { idempotencyKey: `cust-stash-${customerId}-${eventId}` }
  );
}
function readStashedFieldsFromCustomer(customer) {
  const m = customer?.metadata || {};
  return {
    companyName: trimOrNull(m.company_name_from_checkout),
    taxNumber:   trimOrNull(m.company_tax_number_from_checkout),
  };
}

/** Webhook */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, endpointSecret);
  } catch (err) {
    console.error("[WH] signature error:", err?.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const sessionId = event.data.object.id;
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ["invoice", "customer", "subscription.latest_invoice", "payment_intent"],
        });

        const fields = getCompanyFieldsFromSession(session);
        const customerId = session.customer || session.customer_id;

        // 1) Defaults am Customer setzen (für diese & künftige Invoices)
        if (customerId) {
          await setCustomerInvoiceDefaults(customerId, fields, event.id);
          await stashFieldsOnCustomer(customerId, fields, event.id);
        }

        // 2) Draft‐Invoice ermitteln
        let invoice = session.invoice;
        if (!invoice && session.subscription?.latest_invoice) {
          invoice = await stripe.invoices.retrieve(session.subscription.latest_invoice);
        }
        if (!invoice && customerId) {
          invoice = await findLatestDraftInvoiceForCustomer(customerId);
        }

        // 3) Wenn Invoice existiert und ist draft → Felder anwenden → finalisieren → bezahlen
        if (invoice && invoice.status === "draft") {
          await applyFieldsToDraft(invoice, fields, event.id);
          await finalizeInvoice(invoice.id, event.id);
          await payInvoice(invoice.id, event.id);
        } else {
          // Invoice war nicht draft – wir setzen nur die defaults, die Felder greifen bei Folge‐Rechnungen
          console.log(`[WH] checkout.session.completed: invoice.status=${invoice?.status || 'none'} – skipping update/finalize.`);
        }
        break;
      }

      case "invoice.created": {
        const invoice = event.data.object;
        if (!invoice?.id) break;

        // 1) AutoAdvance sofort stoppen, damit Invoice als draft bleibt
        await pauseAutoAdvance(invoice.id, event.id);

        if (invoice.status !== "draft") break;

        const customerId = invoice.customer;
        if (!customerId) break;

        const customer = await stripe.customers.retrieve(customerId);
        const fields = readStashedFieldsFromCustomer(customer);
        if (!fields.companyName && !fields.taxNumber) break;

        await applyFieldsToDraft(invoice, fields, event.id);
        // Kein finalize hier – wartet auf checkout.session.completed
        break;
      }

      default:
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("[WH] handler error:", err);
    return res.json({ received: true, warn: "handler_error" });
  }
}
