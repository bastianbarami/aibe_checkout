// api/stripe-webhook.js
import { buffer } from "micro";
import Stripe from "stripe";

export const config = {
  api: { bodyParser: false }, // raw body für Signaturprüfung
  runtime: "nodejs",
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2020-08-27" });
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

/** Utils */
function trimOrNull(v) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}
function getCompanyFieldsFromSession(session) {
  const out = { companyName: null, taxNumber: null };
  const fields = session?.custom_fields || [];
  for (const f of fields) {
    if (f?.key === "company_name")       out.companyName = trimOrNull(f?.text?.value);
    if (f?.key === "company_tax_number") out.taxNumber  = trimOrNull(f?.text?.value);
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
async function applyFieldsAndFinalizeDraftInvoice(invoice, fields, eventId) {
  if (!invoice || invoice.status !== "draft") return;
  const customFields = buildInvoiceCustomFields(fields);
  if (!customFields) return;

  // Nur Drafts bearbeiten, niemals finalized/open
  await stripe.invoices.update(
    invoice.id,
    { custom_fields: customFields },
    { idempotencyKey: `inv-update-${invoice.id}-${eventId}` }
  );

  await stripe.invoices.finalizeInvoice(
    invoice.id,
    { idempotencyKey: `inv-finalize-${invoice.id}-${eventId}` }
  );
}
async function stashFieldsOnCustomer(customerId, fields, eventId) {
  const meta = {};
  if (fields.companyName) meta.company_name_from_checkout = fields.companyName;
  if (fields.taxNumber)   meta.company_tax_number_from_checkout = fields.taxNumber;
  if (!Object.keys(meta).length) return;
  await stripe.customers.update(customerId, { metadata: meta }, { idempotencyKey: `cust-stash-${customerId}-${eventId}` });
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
      /**
       * Bevor irgendeine Finalisierung passieren kann:
       * - Session laden (expand)
       * - Custom Fields lesen
       * - Customer-Defaults setzen (so übernimmt JEDE neue Draft-Invoice die Felder)
       * - Falls die erste Invoice bereits als Draft existiert: patchen & finalisieren
       */
      case "checkout.session.completed": {
        const sessionId = event.data.object.id;
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ["invoice", "customer", "payment_intent"],
        });

        const fields = getCompanyFieldsFromSession(session);
        const customerId = session.customer || session.customer_id;

        if (customerId) {
          await setCustomerInvoiceDefaults(customerId, fields, event.id);
          await stashFieldsOnCustomer(customerId, fields, event.id);
        }

        // Wenn die erste Rechnung bereits existiert und noch Draft ist → jetzt patchen & finalisieren.
        let invoice = session.invoice || null;
        if (!invoice && customerId) invoice = await findLatestDraftInvoiceForCustomer(customerId);
        if (invoice && invoice.status === "draft") {
          await applyFieldsAndFinalizeDraftInvoice(invoice, fields, event.id);
        }
        break;
      }

      /**
       * Fallback: Manche Flows erzeugen Draft-Invoices vor/ohne completed-Event-Race.
       * Hier nutzen wir die beim Customer zuvor gestashten Felder.
       */
      case "invoice.created": {
        const invoice = event.data.object;
        if (invoice?.status !== "draft") break;

        const customerId = invoice.customer;
        if (!customerId) break;

        const customer = await stripe.customers.retrieve(customerId);
        const fields = readStashedFieldsFromCustomer(customer);
        if (!fields.companyName && !fields.taxNumber) break;

        await applyFieldsAndFinalizeDraftInvoice(invoice, fields, event.id);
        break;
      }

      // Keine Aktion nötig
      case "invoice.payment_succeeded":
      case "invoice.finalized":
      default:
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("[WH] handler error:", err);
    // Idempotent & kein endloses Retry
    return res.json({ received: true, warn: "handler_error" });
  }
}
