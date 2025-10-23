// api/stripe-webhook.js
import { buffer } from "micro";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    console.error("[WH] Missing env vars");
    return res.status(500).json({ error: "missing_env" });
  }

  const stripe = (await import("stripe")).default(stripeSecret);

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Invalid signature:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ---- helper ------------------------------------------------------------
  const safe = async (fn) => {
    try { await fn(); } catch (e) { console.error("[WH step error]", e.message); }
  };

  const extractField = (session, key) => {
    const field = (session.custom_fields || []).find((x) => x.key === key);
    return field?.text?.value?.trim() || "";
  };

  const updateInvoiceWithCompanyData = async (invoiceId, company, taxId, fallbackName) => {
    if (!invoiceId) return;

    const inv = await stripe.invoices.retrieve(invoiceId);

    // Nur wenn noch möglich (nicht bezahlt oder voided)
    if (["draft", "open", "uncollectible"].includes(inv.status)) {
      const patch = {};

      // Name auf Rechnung: Firma > Name
      if (company || fallbackName) {
        patch.customer_name = company || fallbackName;
      }

      // Sichtbare Custom Fields
      const cf = [];
      if (company) cf.push({ name: "Company", value: company });
      if (taxId) cf.push({ name: "Tax ID", value: taxId });
      if (cf.length) patch.custom_fields = cf;

      await stripe.invoices.update(invoiceId, patch);
      console.log("✅ Invoice updated with company data:", invoiceId);
    }
  };

  // ---- handle ------------------------------------------------------------
  try {
    switch (event.type) {
      // === Schritt 1: Nach dem Checkout, Custom-Felder übernehmen ====================
      case "checkout.session.completed": {
        const s = event.data.object;
        const company = extractField(s, "company_name");
        const taxId = extractField(s, "company_tax_number");

        if (!s.customer) break;

        await safe(async () => {
          // Daten auf Customer speichern, damit Folge-Rechnungen sie übernehmen
          await stripe.customers.update(s.customer, {
            metadata: {
              ...(company ? { company_name: company } : {}),
              ...(taxId ? { vat_or_tax_id: taxId } : {}),
            },
            invoice_settings: {
              custom_fields: [
                ...(company ? [{ name: "Company", value: company }] : []),
                ...(taxId ? [{ name: "Tax ID", value: taxId }] : []),
              ],
            },
          });

          // Wenn sofort Rechnung erstellt wurde (z. B. One-Time)
          if (s.invoice) {
            await updateInvoiceWithCompanyData(s.invoice, company, taxId, s.customer_details?.name);
          }
        });
        break;
      }

      // === Schritt 2: Wenn Rechnung neu erstellt wird ================================
      case "invoice.created": {
        const inv = event.data.object;
        if (!inv.customer) break;

        await safe(async () => {
          const cust = await stripe.customers.retrieve(inv.customer);
          const company = cust?.metadata?.company_name || "";
          const taxId = cust?.metadata?.vat_or_tax_id || "";
          const fallbackName = cust?.name || inv.customer_name || "";
          await updateInvoiceWithCompanyData(inv.id, company, taxId, fallbackName);
        });
        break;
      }

      // === Schritt 3: Wenn Rechnung finalisiert wird ================================
      case "invoice.finalized": {
        const inv = event.data.object;
        await safe(async () => {
          if (!inv.custom_fields?.length) {
            const cust = await stripe.customers.retrieve(inv.customer);
            const company = cust?.metadata?.company_name || "";
            const taxId = cust?.metadata?.vat_or_tax_id || "";
            const fallbackName = cust?.name || inv.customer_name || "";
            await updateInvoiceWithCompanyData(inv.id, company, taxId, fallbackName);
          }
        });
        break;
      }

      // === Optional: Zahlung erfolgreich (nur Logging) ==============================
      case "invoice.payment_succeeded":
        console.log("💰 Payment succeeded for invoice", event.data.object.id);
        break;

      default:
        break;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Handler error:", err.message);
    res.status(200).json({ received: true, soft_error: err.message });
  }
}
