// api/stripe-webhook.js
import { buffer } from "micro";
import Stripe from "stripe";

export const config = { api: { bodyParser: false }, runtime: "nodejs" };

// --- Stripe init (TEST-fähig via Fallbacks) ---
const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY
    || "sk_test_51KYNYQGB35pnerjHY39T9ADmFiIIHZMDP4gycSycCSuonlSmLiIB8MKJWjv9BimNadES2MJosVI6Mru0zbxEwbFO00yeeJrdaL",
  { apiVersion: "2020-08-27" }
);

// Webhook-Signing-Secret
const endpointSecret =
  process.env.STRIPE_WEBHOOK_SECRET
  || "whsec_dmmm5UvDOhlwJgjzidsvMCacg2a6O2sx";

// ========== Utils ==========
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
    { custom_fields: customFields, auto_advance: false }, // bleibt Draft
    { idempotencyKey: `inv-update-${invoice.id}-${eventId}` }
  );
}

async function pauseAutoAdvance(invoiceId, eventId) {
  // stoppt sofortiges Finalisieren durch Stripe
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

// ========== Webhook ==========
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
      // 1) Rechnung entsteht (Draft) -> sofort Draft fixieren
      case "invoice.created": {
        const invoice = event.data.object;
        if (!invoice?.id) break;
        await pauseAutoAdvance(invoice.id, event.id); // Draft bleibt Draft
        // Felder werden später im completed-Event gesetzt (wenn sicher vorhanden)
        break;
      }

      // 2) Checkout abgeschlossen -> Felder sicher anwenden, finalisieren, bezahlen
      case "checkout.session.completed": {
        const sessionId = event.data.object.id;
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ["invoice", "customer", "subscription.latest_invoice", "payment_intent"],
        });

        const fields = getCompanyFieldsFromSession(session);
        const customerId = session.customer || session.customer_id;

        // Defaults am Customer (greift auch für Folgerechnungen)
        if (customerId) {
          await setCustomerInvoiceDefaults(customerId, fields, event.id);
          await stashFieldsOnCustomer(customerId, fields, event.id); // Fallback
        }

        // passende Draft-Invoice ermitteln
        let invoice = session.invoice;
        if (!invoice && session.subscription?.latest_invoice) {
          invoice = await stripe.invoices.retrieve(session.subscription.latest_invoice);
        }
        if (!invoice && customerId) {
          invoice = await findLatestDraftInvoiceForCustomer(customerId);
        }

        // Felder auf Draft anwenden -> finalisieren -> bezahlen
        if (invoice && invoice.status === "draft") {
          await applyFieldsToDraft(invoice, fields, event.id);
          await finalizeInvoice(invoice.id, event.id);
          await payInvoice(invoice.id, event.id);
        } else {
          // Keine Draft-Invoice gefunden – Defaults sind gesetzt, greifen ab nächster Rechnung
          console.log(`[WH] checkout.session.completed: invoice.status=${invoice?.status || 'none'} – no draft to patch.`);
        }
        break;
      }

      default:
        // andere Events derzeit nicht erforderlich
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("[WH] handler error:", err);
    // bewusst 200 zurück, Operationen idempotent, sonst retried Stripe endlos
    return res.json({ received: true, warn: "handler_error" });
  }
}
