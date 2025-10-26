// api/stripe-webhook.js
import { buffer } from "micro";
import Stripe from "stripe";

export const config = {
  api: { bodyParser: false },
  runtime: "nodejs",
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2020-08-27" });
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

/** --- Utils --- */
function trimOrNull(v) { const s = (v ?? "").toString().trim(); return s.length ? s : null; }

function getCompanyFieldsFromSession(session) {
  const out = { companyName: null, taxNumber: null };
  for (const f of (session?.custom_fields || [])) {
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
  const list = await stripe.invoices.list({ customer: customerId, status: "draft", limit: 1 });
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
  if (!invoice || invoice.status !== "draft") return false;
  const customFields = buildInvoiceCustomFields(fields);
  if (!customFields) return false;

  await stripe.invoices.update(
    invoice.id,
    {
      custom_fields: customFields,
      // erlaubt & sicher auf 2020-08-27; verhindert auto-Finalisierung durch Rules
      auto_advance: false,
    },
    { idempotencyKey: `inv-update-${invoice.id}-${eventId}` }
  );
  return true;
}

async function finalizeInvoice(invoiceId, eventId) {
  await stripe.invoices.finalizeInvoice(
    invoiceId,
    { idempotencyKey: `inv-finalize-${invoiceId}-${eventId}` }
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

function readInvoiceSettingsFields(customer) {
  const cf = customer?.invoice_settings?.custom_fields || null;
  if (!cf || !cf.length) return { companyName: null, taxNumber: null };
  let companyName = null, taxNumber = null;
  for (const f of cf) {
    if (f?.name === "Company") companyName = trimOrNull(f?.value);
    if (f?.name === "Tax ID")  taxNumber  = trimOrNull(f?.value);
  }
  return { companyName, taxNumber };
}

/** --- Webhook --- */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");
  if (!endpointSecret) return res.status(500).end("Missing STRIPE_WEBHOOK_SECRET");

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
          expand: ["invoice", "customer", "payment_intent"],
        });

        const fields = getCompanyFieldsFromSession(session);
        const customerId = session.customer || session.customer_id;

        if (customerId) {
          // 1) Defaults setzen + Fallback stashen
          await setCustomerInvoiceDefaults(customerId, fields, event.id);
          await stashFieldsOnCustomer(customerId, fields, event.id);
        }

        // 2) Falls die erste Rechnung bereits existiert (Draft) → patchen **und direkt finalisieren**
        let invoice = session.invoice || null;
        if (!invoice && customerId) invoice = await findLatestDraftInvoiceForCustomer(customerId);
        if (invoice && invoice.status === "draft") {
          const patched = await applyFieldsToDraft(invoice, fields, event.id);
          if (patched) {
            // kurze Pause ist optional; unter 10s bleiben
            await new Promise(r => setTimeout(r, 1000));
            await finalizeInvoice(invoice.id, event.id);
          }
        }
        break;
      }

      case "invoice.created": {
        const invoice = event.data.object;
        if (invoice?.status !== "draft") break;

        const customerId = invoice.customer;
        if (!customerId) break;

        // Customer laden und beide Quellen prüfen
        const customer = await stripe.customers.retrieve(customerId);
        const fromInvoiceSettings = readInvoiceSettingsFields(customer);
        const fromStash = readStashedFieldsFromCustomer(customer);

        const fields = {
          companyName: fromInvoiceSettings.companyName || fromStash.companyName,
          taxNumber:   fromInvoiceSettings.taxNumber   || fromStash.taxNumber,
        };
        if (!fields.companyName && !fields.taxNumber) break;

        const patched = await applyFieldsToDraft(invoice, fields, event.id);
        if (patched) {
          await new Promise(r => setTimeout(r, 1000));
          await finalizeInvoice(invoice.id, event.id);
        }
        break;
      }

      default:
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("[WH] handler error:", err);
    // bewusst 200, Operationen sind idempotent
    return res.json({ received: true, warn: "handler_error" });
  }
}
