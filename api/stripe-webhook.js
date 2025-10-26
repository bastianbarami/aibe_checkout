// api/stripe-webhook.js
import { buffer } from "micro";
import Stripe from "stripe";

export const config = {
  api: { bodyParser: false }, // wichtig: raw body für Sig-Verifikation
  runtime: "nodejs",
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2020-08-27",
});

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// --- Hilfsfunktionen -------------------------------------------------

/** Extrahiert Werte aus Checkout-Session.custom_fields */
function getCompanyFieldsFromSession(session) {
  const out = { companyName: null, taxNumber: null };
  try {
    const fields = session?.custom_fields || [];
    for (const f of fields) {
      if (f?.key === "company_name") {
        out.companyName = f?.text?.value?.trim() || null;
      }
      if (f?.key === "company_tax_number") {
        out.taxNumber = f?.text?.value?.trim() || null;
      }
    }
  } catch {}
  return out;
}

/** Baut Invoice.custom_fields Array nur mit vorhandenen Werten */
function buildInvoiceCustomFields({ companyName, taxNumber }) {
  const arr = [];
  if (companyName) arr.push({ name: "Company", value: companyName });
  if (taxNumber) arr.push({ name: "Tax ID", value: taxNumber });
  return arr.length ? arr : null;
}

/** Sucht eine DRAFT-Invoice des Kunden, falls session.invoice noch nicht expandiert war */
async function findLatestDraftInvoiceForCustomer(customerId) {
  const list = await stripe.invoices.list({
    customer: customerId,
    limit: 1,
    status: "draft",
  });
  return list.data?.[0] || null;
}

/** Setzt Customer-Defaults für Invoices (robusteste Variante, SOP 4.4) */
async function setCustomerInvoiceDefaults(customerId, fields, eventId) {
  const customFields = buildInvoiceCustomFields(fields);
  if (!customFields) return;

  await stripe.customers.update(
    customerId,
    { invoice_settings: { custom_fields: customFields } },
    { idempotencyKey: `cust-invoice-defaults-${customerId}-${eventId}` }
  );
}

/** Nur wenn die Rechnung noch DRAFT ist: Felder setzen & finalisieren */
async function applyFieldsAndFinalizeDraftInvoice(invoice, fields, eventId) {
  if (!invoice || invoice.status !== "draft") return;

  const customFields = buildInvoiceCustomFields(fields);
  if (!customFields) return;

  // ⚠️ SOP §3.3: KEIN customer_name auf Invoice-Ebene setzen!
  const idempotencyKey = `inv-update-${invoice.id}-${eventId}`;
  await stripe.invoices.update(
    invoice.id,
    { custom_fields: customFields },
    { idempotencyKey }
  );

  const idempotencyKeyFinalize = `inv-finalize-${invoice.id}-${eventId}`;
  await stripe.invoices.finalizeInvoice(invoice.id, { idempotencyKey: idempotencyKeyFinalize });
}

/** Fallback: Werte am Customer.metadata ablegen (für spätere Rechnungen, optional) */
async function stashFieldsOnCustomer(customerId, fields, eventId) {
  const meta = {};
  if (fields.companyName) meta.company_name_from_checkout = fields.companyName;
  if (fields.taxNumber) meta.company_tax_number_from_checkout = fields.taxNumber;
  if (Object.keys(meta).length === 0) return;

  await stripe.customers.update(
    customerId,
    { metadata: meta },
    { idempotencyKey: `cust-stash-${customerId}-${eventId}` }
  );
}

function readStashedFieldsFromCustomer(customer) {
  const m = customer?.metadata || {};
  const companyName = (m.company_name_from_checkout || "").trim() || null;
  const taxNumber = (m.company_tax_number_from_checkout || "").trim() || null;
  return { companyName, taxNumber };
}

// --- Webhook Handler -------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end("Method Not Allowed");
  }

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
      // Präferierter Pfad: Session erfolgreich -> Customer-Defaults setzen (VOR Rechnungserstellung)
      case "checkout.session.completed": {
        const sessionId = event.data.object.id;
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ["invoice", "customer", "payment_intent"],
        });

        const fields = getCompanyFieldsFromSession(session);
        const customerId = session.customer || session.customer_id;

        // 1) Customer-Defaults für künftige/aktuelle Invoice setzen (robust, SOP 4.4)
        if (customerId) {
          await setCustomerInvoiceDefaults(customerId, fields, event.id);
          await stashFieldsOnCustomer(customerId, fields, event.id); // optionaler Fallback
        }

        // 2) Falls die (erste) Rechnung hier noch DRAFT ist, direkt patchen & finalisieren
        let invoice = session.invoice || null;
        if (!invoice && customerId) {
          invoice = await findLatestDraftInvoiceForCustomer(customerId);
        }
        if (invoice && invoice.status === "draft") {
          await applyFieldsAndFinalizeDraftInvoice(invoice, fields, event.id);
        }

        break;
      }

      // Fallback-Pfad: Entwurfsrechnung wird erstellt (z.B. Subscription oder Race-Condition)
      case "invoice.created": {
        const invoice = event.data.object;
        if (invoice?.status !== "draft") break;

        const customerId = invoice.customer;
        if (!customerId) break;

        // Aus Customer.metadata (Fallback) lesen
        const customer = await stripe.customers.retrieve(customerId);
        const fields = readStashedFieldsFromCustomer(customer);
        if (!fields.companyName && !fields.taxNumber) break;

        await applyFieldsAndFinalizeDraftInvoice(invoice, fields, event.id);
        break;
      }

      // Für Vollständigkeit: keine weiteren Aktionen nötig
      case "invoice.payment_succeeded":
      case "invoice.finalized":
      default:
        break;
    }

    // Immer 200, damit Stripe nicht erneut sendet
    return res.json({ received: true });
  } catch (err) {
    console.error("[WH] handler error:", err);
    // Trotzdem 200 zurückgeben, um Endless-Retries zu vermeiden (Operationen sind idempotent)
    return res.json({ received: true, warn: "handler_error" });
  }
}
