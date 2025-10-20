// api/stripe-webhook.js
import { buffer } from "micro";

export const config = {
  api: {
    bodyParser: false, // WICHTIG: Stripe verlangt den "raw" Body
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeSecret || !webhookSecret) {
    return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET" });
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

  try {
    switch (event.type) {
      // 1) Nach abgeschlossenem Checkout: Customer/Felder aktualisieren
      case "checkout.session.completed": {
        const session = event.data.object;

        const customerId = session.customer;
        if (!customerId) break;

        // Custom-Felder aus der Checkout-Session lesen
        const findTextField = (key) => {
          const f = (session.custom_fields || []).find((x) => x.key === key);
          return f?.text?.value || null;
        };
        const companyName = findTextField("company_name"); // dein Custom-Feld-Key
        const taxId       = findTextField("tax_id");       // dein Custom-Feld-Key

        // Stripe hat über customer_update "name" / "address" bereits automatisch gepflegt.
        // Wir ergänzen: sichtbar auf Rechnung (invoice_settings.custom_fields) + Metadata.
        const customFields = [];
        if (companyName) customFields.push({ name: "Company", value: companyName });
        if (taxId)       customFields.push({ name: "Tax ID",  value: taxId });

        const update = {
          metadata: {
            ...(companyName ? { company_name: companyName } : {}),
            ...(taxId ? { vat_or_tax_id: taxId } : {}),
          },
        };
        if (customFields.length) {
          update.invoice_settings = { custom_fields: customFields };
        }

        if (Object.keys(update).length > 0) {
          await stripe.customers.update(customerId, update);
        }

        break;
      }

      // 2) Sicherheitsnetz: Falls erste Rechnung schon erstellt/finalized ist,
      //    bevor wir den Customer updaten konnten, schreiben wir die Felder
      //    direkt in die Rechnung.
      case "invoice.finalized": {
        const invoice = event.data.object;

        // Wenn es bereits Custom Fields auf der Rechnung gibt: nichts tun
        if (invoice.custom_fields?.length) break;

        if (invoice.customer) {
          const cust = await stripe.customers.retrieve(invoice.customer);

          const cf = cust?.invoice_settings?.custom_fields || [];
          if (cf.length) {
            await stripe.invoices.update(invoice.id, {
              custom_fields: cf,
            });
          }
        }
        break;
      }

      default:
        // andere Events ignorieren wir bewusst
        break;
    }

    // Stripe muss 2xx sehen, sonst retried es
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    // 2xx NICHT senden, damit Stripe mit Backoff erneut zustellt
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
