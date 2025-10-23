// api/stripe-webhook.js
import { buffer } from "micro";

export const config = {
  api: {
    bodyParser: false, // raw body für Stripe-Signatur
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    console.error("[WH] Missing env STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
    return res.status(500).json({ error: "missing_env" });
  }

  const stripe = (await import("stripe")).default(stripeSecret);

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ---- Helper --------------------------------------------------------------
  const getCompanyFromCust = (cust) => {
    const fromCF =
      cust?.invoice_settings?.custom_fields?.find(f => f?.name === "Company")?.value?.trim() || "";
    const fromMeta = cust?.metadata?.company_name?.trim() || "";
    return fromCF || fromMeta;
  };

  const getTaxFromCust = (cust) => {
    const fromCF =
      cust?.invoice_settings?.custom_fields?.find(f => f?.name === "Tax ID")?.value?.trim() || "";
    const fromMeta = cust?.metadata?.vat_or_tax_id?.trim() || "";
    return fromCF || fromMeta;
  };

  try {
    switch (event.type) {
      // 1) Direkt nach dem Checkout: wir speichern nur Werte am Customer,
      //    ändern aber NICHT den customer.name (Personenname soll bleiben)
      case "checkout.session.completed": {
        const session = event.data.object;

        if (!session.customer) break;

        const getCF = (key) => {
          const f = (session.custom_fields || []).find(x => x.key === key);
          return f?.text?.value?.trim() || "";
        };
        const company = getCF("company_name");
        const taxno   = getCF("company_tax_number");

        // Zusammenbauen, was wir am Customer persistieren möchten
        const metadata = {
          ...(company ? { company_name: company } : {}),
          ...(taxno   ? { vat_or_tax_id: taxno }   : {}),
        };

        const custom_fields = [
          ...(company ? [{ name: "Company", value: company }] : []),
          ...(taxno   ? [{ name: "Tax ID",  value: taxno   }] : []),
        ];

        const update = {};
        if (Object.keys(metadata).length) update.metadata = metadata;
        if (custom_fields.length) {
          update.invoice_settings = { custom_fields };
        }

        if (Object.keys(update).length) {
          await stripe.customers.update(session.customer, update);
        }
        break;
      }

      // 2) Sobald eine Rechnung erzeugt wird:
      //    - Wenn Firmenname vorhanden → setze ihn als customer_name auf der Rechnung
      //    - Custom-Fields (Company/Tax ID) auf der Rechnung setzen, falls noch leer
      case "invoice.created":
      case "invoice.finalized": {
        const invoice = event.data.object;

        if (!invoice.customer) break;

        const cust = await stripe.customers.retrieve(invoice.customer);
        const company = getCompanyFromCust(cust);
        const taxno   = getTaxFromCust(cust);

        const patch = {};

        // a) Firmenname NUR setzen, wenn tatsächlich vorhanden
        if (company) {
          patch.customer_name = company;
        }

        // b) Custom-Fields nur ergänzen, wenn auf Rechnung noch nicht gesetzt
        if (!invoice.custom_fields?.length) {
          const cfs = [];
          if (company) cfs.push({ name: "Company", value: company });
          if (taxno)   cfs.push({ name: "Tax ID",  value: taxno   });
          if (cfs.length) patch.custom_fields = cfs;
        }

        if (Object.keys(patch).length) {
          await stripe.invoices.update(invoice.id, patch);
        }
        break;
      }

      default:
        // andere Events ignorieren
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
