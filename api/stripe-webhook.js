// api/stripe-webhook.js
import { buffer } from "micro";
import Stripe from "stripe";

export const config = {
  api: { bodyParser: false },
  runtime: "nodejs",
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2020-08-27",
});

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// --- Hilfsfunktionen -------------------------------------------------

function getCompanyFieldsFromSession(session) {
  const out = { companyName: null, taxNumber: null };
  try {
    const fields = session?.custom_fields || [];
    for (const f of fields) {
      if (f?.key === "company_name") out.companyName = f?.text?.value?.trim() || null;
      if (f?.key === "company_tax_number") out.taxNumber = f?.text?.value?.trim() || null;
    }
  } catch {}
  return out;
}

function buildInvoiceCustomFields({ companyName, taxNumber }) {
  const arr = [];
  if (companyName && companyName !== "") arr.push({ name: "Company", value: companyName });
  if (taxNumber && taxNumber !== "") arr.push({ name: "Tax ID", value: taxNumber });
  return arr.length ? arr : null;
}

async function findLatestDraftInvoiceForCustomer(customerId) {
  const list = await stripe.invoices.list({
    customer: customerId,
    limit: 1,
    status: "draft",
  });
  return list.data?.[0] || null;
}

/** Nur Custom Fields auf Rechnung schreiben, wenn sie ausgefüllt wurden */
async function applyFieldsAndFinalizeInvoice(invoice, fields, eventId) {
  const { companyName, taxNumber } = fields || {};
  const customFields = buildInvoiceCustomFields({ companyName, taxNumber });

  // ✅ Nur wenn mindestens ein Feld existiert
  if (!customFields) return;

  const updateParams = { custom_fields: customFields };
  const idempotencyKey = `inv-update-${invoice.id}-${eventId}`;
  await stripe.invoices.update(invoice.id, updateParams, { idempotencyKey });

  // Rechnung finalisieren, falls noch nicht
  if (invoice.status === "draft" || invoice.status === "open") {
    const idempotencyKeyFinalize = `inv-finalize-${invoice.id}-${eventId}`;
    await stripe.invoices.finalizeInvoice(invoice.id, { idempotencyKey: idempotencyKeyFinalize });
  }
}

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
          expand: ["invoice", "customer", "payment_intent"],
        });

        const fields = getCompanyFieldsFromSession(session);
        const customerId = session.customer || session.customer_id;
        let invoice = session.invoice || null;

        if (!invoice && customerId) {
          const draft = await findLatestDraftInvoiceForCustomer(customerId);
          if (draft) invoice = draft;
        }

        if (invoice) {
          await applyFieldsAndFinalizeInvoice(invoice, fields, event.id);
        } else if (customerId) {
          await stashFieldsOnCustomer(customerId, fields, event.id);
        }
        break;
      }

      case "invoice.created": {
        const invoice = event.data.object;
        if (invoice?.status !== "draft") break;
        if (invoice.auto_advance !== false) break;

        const customerId = invoice.customer;
        if (!customerId) break;

        const customer = await stripe.customers.retrieve(customerId);
        const fields = readStashedFieldsFromCustomer(customer);
        if (!fields.companyName && !fields.taxNumber) break;

        await applyFieldsAndFinalizeInvoice(invoice, fields, event.id);
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
