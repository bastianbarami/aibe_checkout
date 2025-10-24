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

/** baut Invoice.custom_fields Array nur mit vorhandenen Werten */
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

/** Setzt Felder in die Rechnung und finalisiert sie (idempotent pro eventId) */
async function applyFieldsAndFinalizeInvoice(invoice, fields, eventId) {
  const { companyName, taxNumber } = fields || {};
  const customFields = buildInvoiceCustomFields({ companyName, taxNumber });

  // Nichts zu tun?
  if (!customFields && !companyName) return;

  // Update-Params für die Rechnung
  const updateParams = {};
  if (customFields) updateParams.custom_fields = customFields;
  // ⚠️ entfernt: updateParams.customer_name = companyName;  // <-- Verboten auf Invoice-Ebene

  // Invoice updaten (idempotent pro Event)
  const idempotencyKey = `inv-update-${invoice.id}-${eventId}`;
  await stripe.invoices.update(invoice.id, updateParams, { idempotencyKey });

  // Finalisieren, falls noch Entwurf
  if (invoice.status === "draft" || invoice.status === "open") {
    const idempotencyKeyFinalize = `inv-finalize-${invoice.id}-${eventId}`;
    await stripe.invoices.finalizeInvoice(invoice.id, {
      idempotencyKey: idempotencyKeyFinalize,
    });
  }
}

/** Fallback: Werte temporär am Customer ablegen (Metadata), damit invoice.created sie greifen kann */
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

/** Liest Fallback-Werte vom Customer.metadata wieder aus */
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
      // Präferierter Pfad: Wir haben die Session + (Entwurfs-)Rechnung
      case "checkout.session.completed": {
        const sessionId = event.data.object.id;
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ["invoice", "customer", "payment_intent"],
        });

        const fields = getCompanyFieldsFromSession(session);
        const customerId = session.customer || session.customer_id;
        let invoice = session.invoice || null;

        // Falls die Invoice hier noch nicht expandiert/rückgeliefert wurde, versuchen wir sie zu finden
        if (!invoice && customerId) {
          const draft = await findLatestDraftInvoiceForCustomer(customerId);
          if (draft) invoice = draft;
        }

        if (invoice) {
          await applyFieldsAndFinalizeInvoice(invoice, fields, event.id);
        } else if (customerId) {
          // Fallback: stash am Customer, damit invoice.created kurz danach zugreifen kann
          await stashFieldsOnCustomer(customerId, fields, event.id);
        }
        break;
      }

      // Fallback-Pfad: Rechnung ist als Entwurf da, Session-Event kam später
      case "invoice.created": {
        const invoice = event.data.object;
        if (invoice?.status !== "draft") break;

        // Nur reagieren, wenn auto_advance:false (unser Flow)
        const autoAdvance = invoice.auto_advance === false;
        if (!autoAdvance) break;

        // Werte vom Customer-Metadata ziehen (falls zuvor gestasht)
        const customerId = invoice.customer;
        if (!customerId) break;

        const customer = await stripe.customers.retrieve(customerId);
        const fields = readStashedFieldsFromCustomer(customer);

        // Nichts? Dann nichts tun.
        if (!fields.companyName && !fields.taxNumber) break;

        await applyFieldsAndFinalizeInvoice(invoice, fields, event.id);
        break;
      }

      // Für Vollständigkeit: bereits erfolgreich bezahlt
      case "invoice.payment_succeeded":
      case "invoice.finalized":
      case "checkout.session.completed":
      default:
        // keine Aktion nötig
        break;
    }

    // Immer 200, damit Stripe nicht erneut sendet (idempotente internen Aufrufe sichern robustes Verhalten)
    return res.json({ received: true });
  } catch (err) {
    console.error("[WH] handler error:", err);
    // Trotzdem 200 zurückgeben, um Endless-Retries zu vermeiden (wir sind intern idempotent)
    return res.json({ received: true, warn: "handler_error" });
  }
}
