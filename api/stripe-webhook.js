// api/stripe-webhook.js
import { buffer } from "micro";

// Vercel / Next: raw body erzwingen (Stripe Signatur)
export const runtime = 'nodejs';
export const config = {
  api: {
    bodyParser: false, // wichtig: Stripe verlangt den "raw" Body
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

  // --- Helper ---
  const findTextField = (obj, key) => {
    const f = (obj?.custom_fields || []).find(x => x.key === key);
    return f?.text?.value || null;
  };

  // --- Stripe-Event verifizieren ---
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
      // 1) Checkout fertig: Customer updaten + (NEU) Name = Firmenname
      case "checkout.session.completed": {
        const session = event.data.object;
        const customerId = session.customer;
        if (!customerId) break;

        // Deine optionalen Felder aus dem Embedded Checkout
        const companyName = findTextField(session, "company_name");       // Textfeld "Firmenname (optional)"
        const taxNumber   = findTextField(session, "company_tax_number"); // Textfeld "Steuernummer / VAT (optional)"

        // a) Customer-Name auf Firma setzen -> erscheint im Adressblock der Rechnung
        if (companyName) {
          await stripe.customers.update(customerId, { name: companyName });
        }

        // b) Zusatz: als Custom-Fields / Metadata am Customer ablegen (bleibt wie gehabt)
        const customFields = [];
        if (companyName) customFields.push({ name: "Company", value: companyName });
        if (taxNumber)   customFields.push({ name: "Tax ID",  value: taxNumber });

        const update = {
          metadata: {
            ...(companyName ? { company_name: companyName } : {}),
            ...(taxNumber   ? { vat_or_tax_id: taxNumber }   : {}),
          },
        };
        if (customFields.length) {
          update.invoice_settings = { custom_fields: customFields };
        }
        if (Object.keys(update).length) {
          await stripe.customers.update(customerId, update);
        }

        // (Optional) Wenn du echte Tax IDs nutzen willst, hier anlegen:
        // if (taxNumber) {
        //   await stripe.customers.createTaxId(customerId, { type: "eu_vat", value: taxNumber });
        // }

        break;
      }

      // 2) Falls der Rechnungsentwurf schon existiert, bevor der Customer-Name gesetzt wurde:
      //    Firmenname direkt in den Entwurf schreiben, damit er in der Adresszeile landet.
      case "invoice.created": {
        const invoice = event.data.object; // draft
        const customerId = invoice.customer;
        if (!customerId) break;

        const cust = await stripe.customers.retrieve(customerId);

        // Priorität: explizit gespeicherte Firma
        const companyFromMeta    = cust.metadata?.company_name || null;
        const companyFromFields  = (cust.invoice_settings?.custom_fields || [])
          .find(cf => (cf.name || "").toLowerCase() === "company")?.value || null;

        const companyName = companyFromMeta || companyFromFields;
        if (companyName) {
          await stripe.invoices.update(invoice.id, { customer_name: companyName });
        }
        break;
      }

      // 3) Optionales "Sicherheitsnetz": Wenn finalized und noch keine Custom-Felder drauf sind,
      //    kopiere sie vom Customer auf die Rechnung.
      case "invoice.finalized": {
        const invoice = event.data.object;
        if (invoice.custom_fields?.length) break;

        if (invoice.customer) {
          const cust = await stripe.customers.retrieve(invoice.customer);
          const cf = cust?.invoice_settings?.custom_fields || [];
          if (cf.length) {
            await stripe.invoices.update(invoice.id, { custom_fields: cf });
          }
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
    // 5xx senden => Stripe versucht erneut zuzustellen
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
