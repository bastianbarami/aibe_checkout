// api/stripe-webhook.js
import { buffer } from "micro";

export const config = {
  api: { bodyParser: false }, // Stripe braucht den "raw" Body
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end("Method Not Allowed");
  }

  const stripeSecret   = process.env.STRIPE_SECRET_KEY;
  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeSecret || !webhookSecret) {
    return res
      .status(500)
      .json({ error: "Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET" });
  }

  const stripe = (await import("stripe")).default(stripeSecret);

  // ---------- Event verifizieren ----------
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err?.message);
    return res.status(400).send(`Webhook Error: ${err?.message}`);
  }

  // ---------- Hilfsfunktionen ----------
  const safeFindTextField = (session, key) => {
    try {
      const f = (session?.custom_fields || []).find((x) => x.key === key);
      return f?.text?.value || null;
    } catch {
      return null;
    }
  };

  const buildCustomFieldsFromCustomer = (customer) => {
    // Wir verwenden die Invoice-Vorlage NICHT, sondern hängen je Rechnung
    // die Felder an, wenn vorhanden.
    const out = [];
    const cf = customer?.invoice_settings?.custom_fields || [];
    if (Array.isArray(cf)) {
      for (const item of cf) {
        if (item?.name && item?.value) out.push({ name: item.name, value: item.value });
      }
    }
    return out;
  };

  const upsertCustomerInvoiceFields = async (customerId, { companyName, taxId }) => {
    try {
      const cust = await stripe.customers.retrieve(customerId);
      const existing = Array.isArray(cust?.invoice_settings?.custom_fields)
        ? [...cust.invoice_settings.custom_fields]
        : [];

      const set = (name, value) => {
        if (!value) return;
        const i = existing.findIndex((x) => x?.name === name);
        if (i >= 0) existing[i] = { name, value };
        else existing.push({ name, value });
      };

      if (companyName) set("Company", companyName);
      if (taxId)       set("Tax ID",  taxId);

      // außerdem „Wenn-Firmenname-dann-Name-ersetzen“
      const newName =
        companyName && typeof companyName === "string" && companyName.trim().length
          ? companyName.trim()
          : undefined;

      await stripe.customers.update(customerId, {
        ...(newName ? { name: newName } : {}),
        invoice_settings: { custom_fields: existing },
      });
    } catch (e) {
      console.error("⚠️ upsertCustomerInvoiceFields error:", e?.message);
    }
  };

  const applyCustomerFieldsToInvoice = async (invoiceId, customerId) => {
    try {
      const cust = await stripe.customers.retrieve(customerId);
      const cf = buildCustomFieldsFromCustomer(cust);
      if (!cf.length) return;

      // Nur ergänzen, wenn auf der Rechnung noch nichts steht
      const inv = await stripe.invoices.retrieve(invoiceId);
      if (inv?.custom_fields?.length) return;

      await stripe.invoices.update(invoiceId, { custom_fields: cf });
    } catch (e) {
      console.error("⚠️ applyCustomerFieldsToInvoice error:", e?.message);
    }
  };

  // ---------- Ereignisse behandeln ----------
  try {
    switch (event.type) {
      /**
       * 1) Checkout abgeschlossen (einmalig ODER Abo):
       *    - Firmenname/Steuernummer aus Custom Fields lesen
       *    - Beim Customer speichern (invoice_settings.custom_fields)
       *    - Wenn Firmenname vorhanden: Customer.name darauf setzen
       */
      case "checkout.session.completed": {
        const session = event.data.object;

        const customerId = session?.customer;
        if (!customerId) break;

        const companyName = safeFindTextField(session, "company_name");
        const taxId       = safeFindTextField(session, "company_tax_number");

        await upsertCustomerInvoiceFields(customerId, { companyName, taxId });

        break;
      }

      /**
       * 2) Erstellt eine Rechnung (Entwurf) – hier können wir Custom Fields
       *    zuverlässig an die Rechnung hängen, BEVOR finalisiert wird.
       */
      case "invoice.created": {
        const invoice = event.data.object;
        const customerId = invoice?.customer;
        const invoiceId  = invoice?.id;

        if (customerId && invoiceId) {
          await applyCustomerFieldsToInvoice(invoiceId, customerId);
        }
        break;
      }

      /**
       * 3) Sicherheitsnetz: falls ausnahmsweise schon finalisiert,
       *    versuchen wir es trotzdem (einige Accounts lassen das zu, andere nicht).
       *    Schlägt fehl? -> nur loggen (kein 500).
       */
      case "invoice.finalized": {
        const invoice = event.data.object;
        const customerId = invoice?.customer;
        const invoiceId  = invoice?.id;

        // nur wenn noch nichts vorhanden
        if (!invoice?.custom_fields?.length && customerId && invoiceId) {
          try {
            await applyCustomerFieldsToInvoice(invoiceId, customerId);
          } catch (e) {
            console.error("ℹ️ finalize apply skipped/failed:", e?.message);
          }
        }
        break;
      }

      default:
        // andere Events ignorieren
        break;
    }

    // Stripe will immer 2xx – sonst werden Events erneut zugestellt
    return res.status(200).json({ received: true });
  } catch (err) {
    // Falls wir hier landen, nicht zu viel verraten – aber loggen.
    console.error("❌ Webhook handler error (outer):", err);
    return res.status(500).json({ error: "server_error" });
  }
}
