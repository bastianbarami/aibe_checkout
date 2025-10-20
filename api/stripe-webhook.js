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
    return res
      .status(500)
      .json({ error: "Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET" });
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

        // -------- Custom-Felder aus der Checkout-Session lesen --------
        const findTextField = (key) => {
          const f = (session.custom_fields || []).find((x) => x.key === key);
          return f?.text?.value || null;
        };
        const companyName =
          findTextField("company_name") || null; // Firmenname aus optionalem Feld
        const taxNumber =
          findTextField("company_tax_number") ||
          findTextField("tax_id") ||
          null;

        // -------- Customer vorbereiten & aktualisieren --------
        const update = {
          metadata: {
            ...(companyName ? { company_name: companyName } : {}),
            ...(taxNumber ? { vat_or_tax_id: taxNumber } : {}),
          },
        };

        // Sichtbar im PDF als Zeilen am Fuß
        const customFields = [];
        if (companyName) customFields.push({ name: "Firma", value: companyName });
        if (taxNumber) customFields.push({ name: "USt-/VAT", value: taxNumber });
        if (customFields.length) {
          update.invoice_settings = { custom_fields: customFields };
        }

        // Wenn Firmenname angegeben wurde, soll er *oben* im Adressblock stehen
        if (companyName) {
          update.name = companyName;
        }

        if (
          update.name ||
          (update.invoice_settings && update.invoice_settings.custom_fields?.length) ||
          (update.metadata && Object.keys(update.metadata).length)
        ) {
          await stripe.customers.update(customerId, update);
          console.log("✅ Customer updated:", customerId, update);
        }

        // -------- Falls Sub: Rechnung direkt nachziehen (Name & Felder) --------
        if (session.mode === "subscription" && companyName) {
          try {
            // Neueste Rechnung der Sub beziehen
            const sub = await stripe.subscriptions.retrieve(session.subscription, {
              expand: ["latest_invoice"],
            });
            const latest = sub.latest_invoice;
            const invoiceId =
              typeof latest === "string" ? latest : latest?.id || null;

            if (invoiceId) {
              const invUpdate = {
                customer_name: companyName, // Kopfzeile der Rechnung überschreiben
              };

              // Falls wir hier sicherstellen wollen, dass die Fuß-Fields schon auf der Rechnung landen:
              if (customFields.length) {
                invUpdate.custom_fields = customFields;
              }

              await stripe.invoices.update(invoiceId, invUpdate);
              console.log("🧾 Invoice updated from session:", invoiceId, invUpdate);
            }
          } catch (e) {
            console.warn("Invoice immediate update from session failed:", e.message);
          }
        }

        break;
      }

      // 2) Fallback/Sicherheitsnetz: Falls Rechnung bereits finalisiert,
      //    überschreiben wir zusätzlich den sichtbaren customer_name
      //    und hängen Custom Fields an, falls am Customer vorhanden.
      case "invoice.finalized": {
        const invoice = event.data.object;

        if (!invoice.customer) break;

        const cust = await stripe.customers.retrieve(invoice.customer);

        const companyName =
          cust?.metadata?.company_name || // bevorzugt aus Metadata
          cust?.name ||                   // oder bereits zugewiesener Name
          null;

        const cf =
          cust?.invoice_settings?.custom_fields && cust.invoice_settings.custom_fields.length
            ? cust.invoice_settings.custom_fields
            : (() => {
                // aus Metadata ableiten, falls keine Custom Fields vorhanden
                const derived = [];
                if (cust?.metadata?.company_name)
                  derived.push({ name: "Firma", value: cust.metadata.company_name });
                if (cust?.metadata?.vat_or_tax_id)
                  derived.push({ name: "USt-/VAT", value: cust.metadata.vat_or_tax_id });
                return derived;
              })();

        const invUpdate = {};
        // Nur setzen, wenn wir wirklich einen Firmennamen haben und er auf der Rechnung
        // (noch) nicht steht
        if (companyName && invoice.customer_name !== companyName) {
          invUpdate.customer_name = companyName;
        }
        if (cf?.length && !(invoice.custom_fields?.length)) {
          invUpdate.custom_fields = cf;
        }

        if (Object.keys(invUpdate).length) {
          await stripe.invoices.update(invoice.id, invUpdate);
          console.log("🧾 Invoice updated on finalized:", invoice.id, invUpdate);
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
