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
        // erwartete Keys aus dem Embedded Checkout:
        // - company_name
        // - company_tax_number (Fallback: tax_id)
        const findTextField = (key) => {
          const f = (session.custom_fields || []).find((x) => x.key === key);
          // Stripe liefert bei text-Feldern .text.value
          return f?.text?.value || null;
        };

        const companyName =
          findTextField("company_name") /* bevorzugt */ || null;

        const taxNumber =
          findTextField("company_tax_number") ||
          findTextField("tax_id") || // Fallback, falls ältere Form
          null;

        // -------- Update-Objekt für den Customer vorbereiten --------
        // Falls Firmenname vorhanden: Name des Customers auf Firmenname setzen.
        const update = {
          metadata: {
            ...(companyName ? { company_name: companyName } : {}),
            ...(taxNumber ? { vat_or_tax_id: taxNumber } : {}),
          },
        };

        // Sichtbar im PDF am Fuß der Rechnung
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

        // Nur updaten, wenn wir wirklich etwas setzen
        if (
          update.name ||
          (update.invoice_settings && update.invoice_settings.custom_fields?.length) ||
          (update.metadata && Object.keys(update.metadata).length)
        ) {
          await stripe.customers.update(customerId, update);
          console.log("✅ Customer updated:", customerId, update);
        }

        break;
      }

      // 2) Sicherheitsnetz: Falls erste Rechnung schon erstellt/finalized ist,
      //    bevor wir den Customer updaten konnten, schreiben wir die Felder
      //    direkt in die Rechnung (Custom Fields sichtbar im PDF).
      case "invoice.finalized": {
        const invoice = event.data.object;

        // Wenn es bereits Custom Fields auf der Rechnung gibt: nichts tun
        if (invoice.custom_fields?.length) break;

        if (invoice.customer) {
          const cust = await stripe.customers.retrieve(invoice.customer);

          // Falls der Customer schon Custom Fields trägt, übernehme sie in die Rechnung
          const cf = cust?.invoice_settings?.custom_fields || [];

          // BONUS: Wenn wir Metadaten haben, aber noch keine Custom Fields,
          // bauen wir sie hier (sofern sinnvoll) dennoch zusammen.
          if (!cf.length) {
            const maybeCompany = cust?.metadata?.company_name || null;
            const maybeVat = cust?.metadata?.vat_or_tax_id || null;
            const derived = [];
            if (maybeCompany) derived.push({ name: "Firma", value: maybeCompany });
            if (maybeVat) derived.push({ name: "USt-/VAT", value: maybeVat });
            if (derived.length) {
              cf.push(...derived);
            }
          }

          if (cf.length) {
            await stripe.invoices.update(invoice.id, {
              custom_fields: cf,
            });
            console.log("🧾 Invoice custom_fields set via webhook:", invoice.id, cf);
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
