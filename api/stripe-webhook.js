// api/stripe-webhook.js
import { buffer } from "micro";

export const config = {
  api: {
    // Stripe braucht den "raw" Body für die Signaturprüfung
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret   = process.env.STRIPE_SECRET_KEY;
  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeSecret || !webhookSecret) {
    return res
      .status(500)
      .json({ error: "Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET" });
  }

  const stripe = (await import("stripe")).default(stripeSecret);

  // ---------- Signatur prüfen ----------
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
      // =========================================================
      // A) Checkout beendet -> Kunde aktualisieren
      // =========================================================
      case "checkout.session.completed": {
        const session = event.data.object;
        console.log("[WH] checkout.session.completed:", {
          id: session?.id,
          customer: session?.customer,
        });

        const customerId = session.customer;
        if (!customerId) break;

        // ---- Custom-Felder aus der Session lesen ----
        const findTextField = (key) => {
          const f = (session.custom_fields || []).find((x) => x.key === key);
          return f?.text?.value || null;
        };

        const companyName = findTextField("company_name");        // ✅ KORREKTER KEY
        const taxNumber   = findTextField("company_tax_number");  // ✅ KORREKTER KEY

        // Stripe schreibt dank customer_update=name,address bereits Basisdaten.
        // Wir ergänzen jetzt: Firmenlogik + Custom Fields + Metadata.
        const customerUpdate = {
          metadata: {
            ...(companyName ? { company_name: companyName } : {}),
            ...(taxNumber   ? { company_tax_number: taxNumber } : {}),
          },
        };

        // Wenn Firmenname gesetzt ist -> Zeile 1 der Anschrift/Rechnung: Firmenname
        if (companyName) {
          customerUpdate.name = companyName;
        }

        // Custom Fields, die auf Rechnung & Beleg angezeigt werden
        const customFields = [];
        if (companyName) customFields.push({ name: "Company", value: companyName });
        if (taxNumber)   customFields.push({ name: "Tax ID",  value: taxNumber });

        if (customFields.length) {
          customerUpdate.invoice_settings = { custom_fields: customFields };
        }

        if (Object.keys(customerUpdate).length > 0) {
          console.log("[WH] Updating customer with:", customerUpdate);
          await stripe.customers.update(customerId, customerUpdate);
        } else {
          console.log("[WH] Nothing to update on customer.");
        }

        break;
      }

      // =========================================================
      // B) Rechnung wurde finalisiert -> falls Kunde schon
      //    aktualisiert ist, aber Rechnung noch nichts hat,
      //    kopieren wir die Felder auf die Rechnung.
      // =========================================================
      case "invoice.finalized": {
        const invoice = event.data.object;
        console.log("[WH] invoice.finalized:", { id: invoice?.id });

        // wenn Rechnung bereits Custom Fields hat -> nichts tun
        if (invoice.custom_fields?.length) {
          console.log("[WH] invoice already has custom_fields, skipping.");
          break;
        }
        if (!invoice.customer) break;

        const cust = await stripe.customers.retrieve(invoice.customer);
        const cf = cust?.invoice_settings?.custom_fields || [];

        if (cf.length) {
          console.log("[WH] Copying custom_fields from customer -> invoice:", cf);
          await stripe.invoices.update(invoice.id, { custom_fields: cf });
        } else {
          console.log("[WH] No customer custom_fields to copy.");
        }
        break;
      }

      // Andere Events bewusst ignorieren
      default:
        // console.log("[WH] Ignored event:", event.type);
        break;
    }

    // Stripe braucht 2xx, sonst wird erneut zugestellt
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    // Absichtlich kein 2xx -> Stripe retried mit Backoff
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
