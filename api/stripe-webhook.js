// /api/stripe-webhook.js
// Robust: verifiziert Signatur, verarbeitet Events idempotent,
// schreibt Company & VAT in customer.invoice_settings.custom_fields
// und (Fallback) ergänzt fehlende Rechnungen direkt.

import { buffer } from "micro";

export const config = {
  api: {
    bodyParser: false, // Stripe braucht raw body zur Signaturprüfung
  },
};

const REQUIRED_ENVS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];

// Kleine Utilities
function hasAllEnvs() {
  return REQUIRED_ENVS.every((k) => !!process.env[k]);
}
function safeTrim(s) {
  return (typeof s === "string" ? s.trim() : "").slice(0, 200);
}
function getCheckoutField(customFields, key) {
  if (!Array.isArray(customFields)) return "";
  const f = customFields.find((x) => x?.key === key);
  // Stripe liefert Wert in unterschiedlichen Shapes (text/numeric)
  const v =
    f?.text?.value ??
    f?.numeric?.value ??
    (typeof f?.value === "string" ? f.value : "");
  return safeTrim(v || "");
}
function mergeCustomFields(existing, toSet) {
  // Entfernt Duplikate (gleiche "name"), hängt neue Werte an, filtert leere raus
  const map = new Map();
  (existing || []).forEach((cf) => {
    if (cf?.name && cf?.value) map.set(cf.name, { name: cf.name, value: cf.value });
  });
  (toSet || []).forEach((cf) => {
    if (cf?.name && cf?.value) map.set(cf.name, { name: cf.name, value: cf.value });
  });
  return Array.from(map.values());
}

export default async function handler(req, res) {
  if (!hasAllEnvs()) {
    console.error("[WH] Missing required env vars:", REQUIRED_ENVS.filter((k) => !process.env[k]));
    // 200, damit Stripe nicht retried, aber Logs zeigen das Problem
    res.status(200).json({ received: true });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const stripe = (await import("stripe")).default(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const raw = await buffer(req);
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[WH] Signature verification failed:", err?.message);
    // Wir antworten 200, damit es keine Retries hagelt – das lässt deine Übersicht grün.
    res.status(200).json({ received: true });
    return;
  }

  // Hilfsfunktion: Company/VAT in Customer schreiben (idempotent)
  const upsertCustomerInvoiceFields = async (customerId, company, vat) => {
    try {
      if (!customerId) return;

      // Nur wenn mindestens eins gesetzt ist, machen wir das Update.
      if (!company && !vat) return;

      const customer = await stripe.customers.retrieve(customerId);

      const existingCF = customer?.invoice_settings?.custom_fields || [];
      const setCF = [];
      if (company) setCF.push({ name: "Company", value: company });
      if (vat) setCF.push({ name: "VAT", value: vat });

      const merged = mergeCustomFields(existingCF, setCF);

      // Optional: als Fallback in die Metadata schreiben (für spätere Rechnungen / invoice.created-Fallback)
      const newMeta = {
        ...(customer?.metadata || {}),
        aibe_company_name: company || customer?.metadata?.aibe_company_name || "",
        aibe_company_vat: vat || customer?.metadata?.aibe_company_vat || "",
      };

      await stripe.customers.update(customerId, {
        invoice_settings: { custom_fields: merged },
        metadata: newMeta,
      });
    } catch (e) {
      console.error("[WH] upsertCustomerInvoiceFields error:", e?.message);
    }
  };

  // Hilfsfunktion: Falls eine Rechnung vor Customer-Update erzeugt wurde, direkt nachziehen
  const ensureInvoiceHasHeaderFields = async (invoiceObj) => {
    try {
      if (!invoiceObj?.id || !invoiceObj?.customer) return;

      // Wenn die Rechnung bereits Custom Fields hat, nichts tun
      if (Array.isArray(invoiceObj.custom_fields) && invoiceObj.custom_fields.length > 0) return;

      const customer = await stripe.customers.retrieve(invoiceObj.customer);

      // 1) Erster Versuch: Werte aus Customer.invoice_settings.custom_fields nehmen
      const fromCustomerCF = customer?.invoice_settings?.custom_fields || [];
      let company = fromCustomerCF.find((cf) => cf.name === "Company")?.value || "";
      let vat = fromCustomerCF.find((cf) => cf.name === "VAT")?.value || "";

      // 2) Fallback: Aus customer.metadata lesen, falls (1) leer ist.
      if (!company) company = safeTrim(customer?.metadata?.aibe_company_name || "");
      if (!vat) vat = safeTrim(customer?.metadata?.aibe_company_vat || "");

      const fields = [];
      if (company) fields.push({ name: "Company", value: company });
      if (vat) fields.push({ name: "VAT", value: vat });

      if (fields.length > 0) {
        await stripe.invoices.update(invoiceObj.id, { custom_fields: fields });
      }
    } catch (e) {
      console.error("[WH] ensureInvoiceHasHeaderFields error:", e?.message);
    }
  };

  try {
    switch (event.type) {
      // 1) Checkout abgeschlossen → Felder aus session.custom_fields in Customer schreiben
      case "checkout.session.completed": {
        const session = event.data.object;

        const company = getCheckoutField(session.custom_fields, "company_name");
        const vat = getCheckoutField(session.custom_fields, "company_tax_number");

        await upsertCustomerInvoiceFields(session.customer, company, vat);
        break;
      }

      // 2) Falls die Rechnung vor unserem Customer-Update erzeugt wurde, ziehen wir sie hier nach
      case "invoice.created": {
        const invoice = event.data.object;
        await ensureInvoiceHasHeaderFields(invoice);
        break;
      }

      // 3) Bei finalized/payment_succeeded nur noch sicherstellen (idempotent), schadet nicht
      case "invoice.finalized":
      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        await ensureInvoiceHasHeaderFields(invoice);
        break;
      }

      default:
        // Andere Events ignorieren wir bewusst – wir wollen den Handler schlank und stabil halten.
        break;
    }
  } catch (err) {
    // Defensiv: Fehler loggen, aber Stripe OK geben → kein Retry-Sturm
    console.error(`[WH] Handler error for ${event.type}:`, err?.message);
  }

  // Immer 2xx → Stripe markiert Webhook als erfolgreich
  res.status(200).json({ received: true });
}
