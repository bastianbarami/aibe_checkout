// api/stripe-webhook.js
import { buffer } from "micro";

export const runtime = 'nodejs';
export const config = {
  api: {
    bodyParser: false, // Stripe braucht raw body
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret   = process.env.STRIPE_SECRET_KEY;
  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    console.error("[WH] Missing env STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
    return res.status(500).json({ error: "missing_env" });
  }

  const stripe = (await import("stripe")).default(stripeSecret);

  // --- Event verifizieren
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      // A) Unmittelbar nach erfolgreichem Checkout
      case "checkout.session.completed": {
        const session = event.data.object;
        const customerId = session.customer;
        if (!customerId) break;

        // Custom-Felder aus der Session lesen
        const findTextField = (key) => {
          const f = (session.custom_fields || []).find((x) => x.key === key);
          return f?.text?.value || null;
        };
        const companyName = findTextField("company_name");
        const taxId       = findTextField("company_tax_number") || findTextField("tax_id");

        const customFields = [];
        if (companyName) customFields.push({ name: "Company", value: companyName });
        if (taxId)       customFields.push({ name: "Tax ID",  value: taxId });

        const update = {
          metadata: {
            ...(companyName ? { company_name: companyName } : {}),
            ...(taxId ? { vat_or_tax_id: taxId } : {}),
          },
        };
        if (companyName) update.name = companyName; // <-- Customer-Name auf Firma setzen
        if (customFields.length) {
          update.invoice_settings = { custom_fields: customFields };
        }

        if (Object.keys(update).length > 0) {
          await stripe.customers.update(customerId, update);
        }
        break;
      }

      // B) Erste Rechnung erstellen -> Firma SOFORT in den Adressblock
      case "invoice.created": {
        const invoice = event.data.object;

        if (!invoice.customer) break;
        const cust = await stripe.customers.retrieve(invoice.customer);

        const cf = cust?.invoice_settings?.custom_fields || [];
        const companyFromCF = cf.find(x => (x.name || "").toLowerCase() === "company")?.value;
        const companyFromMeta = cust?.metadata?.company_name;
        const fallbacks = [companyFromCF, companyFromMeta, cust?.name].filter(Boolean);
        const company = fallbacks[0];

        const upd = {};
        if (company) upd.customer_name = company;
        // Falls du die gleichen Custom Fields auf die Rechnung spiegeln willst:
        if (cf?.length) upd.custom_fields = cf;

        if (Object.keys(upd).length) {
          await stripe.invoices.update(invoice.id, upd);
        }
        break;
      }

      // (optional) Prüfung nach Finalisierung
      case "invoice.finalized": {
        // Hier brauchst du nichts zu tun, weil wir bereits bei invoice.created gesetzt haben.
        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
