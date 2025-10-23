// api/stripe-webhook.js
import { buffer } from "micro";

export const config = {
  api: { bodyParser: false }, // wichtig: raw body für Stripe-Signatur
};

// ---------- kleine Log-Helfer ----------
const log = (...args) => console.log("[WH]", ...args);
const warn = (...args) => console.warn("[WH]", ...args);
const err  = (...args) => console.error("[WH]", ...args);

// ---------- Extraktion aus Checkout-Session ----------
function extractCompanyFromSession(session) {
  // Custom Fields sind in session.custom_fields: [{key, text:{value}} ...]
  const byKey = (k) => (session.custom_fields || []).find(f => f.key === k)?.text?.value || null;

  const companyName = byKey("company_name");
  const taxId       = byKey("company_tax_number");

  return {
    companyName: companyName && companyName.trim() ? companyName.trim() : null,
    taxId:       taxId && taxId.trim() ? taxId.trim() : null,
  };
}

// ---------- Customer aktualisieren (metadata + invoice_settings.custom_fields) ----------
async function upsertCustomerCompany(stripe, customerId, companyName, taxId) {
  if (!customerId) return;

  const invoiceCustomFields = [];
  if (companyName) invoiceCustomFields.push({ name: "Company", value: companyName });
  if (taxId)       invoiceCustomFields.push({ name: "Tax ID",  value: taxId });

  const update = {
    metadata: {
      ...(companyName ? { company_name: companyName } : {}),
      ...(taxId ? { vat_or_tax_id: taxId } : {}),
    },
  };
  if (invoiceCustomFields.length) {
    update.invoice_settings = { custom_fields: invoiceCustomFields };
  }

  if (Object.keys(update).length) {
    log("update customer", customerId, update);
    await stripe.customers.update(customerId, update);
  }
}

// ---------- Rechnung aktualisieren, wenn möglich ----------
async function applyCompanyToInvoice(stripe, invoiceId, customerId) {
  if (!invoiceId) return;

  // Hole Customer-Felder (Quelle der Wahrheit)
  const cust = customerId ? await stripe.customers.retrieve(customerId) : null;

  const cf = (cust?.invoice_settings?.custom_fields || []).filter(Boolean);
  if (!cf.length) {
    warn("no invoice custom_fields on customer yet -> skip invoice update", { invoiceId, customerId });
    return;
  }

  // Rechnung updaten (auch nach Finalize möglich)
  log("update invoice custom_fields", { invoiceId, custom_fields: cf });
  await stripe.invoices.update(invoiceId, { custom_fields: cf });
}

// ---------- Haupt-Handler ----------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret   = process.env.STRIPE_SECRET_KEY;
  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    err("Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
    return res.status(500).json({ error: "missing_env" });
  }

  const stripe = (await import("stripe")).default(stripeSecret);

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (e) {
    err("signature verification failed:", e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    switch (event.type) {
      // =====================================================
      // 1) Direkt nach Checkout – beste Quelle für Company/Tax
      // =====================================================
      case "checkout.session.completed": {
        const session = event.data.object;

        const { companyName, taxId } = extractCompanyFromSession(session);
        log("checkout.session.completed -> extracted", { companyName, taxId });

        const customerId = session.customer || null;
        // Customer immer updaten (metadata + invoice_settings.custom_fields)
        await upsertCustomerCompany(stripe, customerId, companyName, taxId);

        // Falls die Rechnung bereits existiert, sofort aktualisieren
        // - Einmalzahlung: session.invoice (bei invoice_creation)
        // - Abo: session.subscription -> aktuelle Invoice gleich danach
        if (session.invoice) {
          await applyCompanyToInvoice(stripe, session.invoice, customerId);
        }
        break;
      }

      // =====================================================
      // 2) Rechnung erstellt – versuche sofort zu befüllen
      // =====================================================
      case "invoice.created": {
        const invoice = event.data.object;
        log("invoice.created", { invoiceId: invoice.id, customer: invoice.customer });

        // Holt (falls vorhanden) die zuletzt abgeschlossene Checkout-Session des Kunden,
        // um notfalls direkt aus deren custom_fields zu lesen.
        // (Nice-to-have: Wir verlassen uns primär auf Customer.invoice_settings, das
        // in checkout.session.completed gesetzt wurde.)
        await applyCompanyToInvoice(stripe, invoice.id, invoice.customer);
        break;
      }

      // =====================================================
      // 3) Falls die Rechnung schon finalisiert war – trotzdem draufschreiben
      // =====================================================
      case "invoice.finalized": {
        const invoice = event.data.object;
        log("invoice.finalized", { invoiceId: invoice.id, customer: invoice.customer });

        await applyCompanyToInvoice(stripe, invoice.id, invoice.customer);
        break;
      }

      // =====================================================
      // 4) Spätestens hier existiert die endgültige Rechnung sicher
      // =====================================================
      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        log("invoice.payment_succeeded", { invoiceId: invoice.id, customer: invoice.customer });

        await applyCompanyToInvoice(stripe, invoice.id, invoice.customer);
        break;
      }

      default:
        // andere Events ignorieren wir bewusst, aber loggen knapp
        // log("ignore event", event.type);
        break;
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    err("webhook handler error:", e);
    // 5xx -> Stripe schickt erneut; gewollt
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
