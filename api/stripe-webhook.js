// api/stripe-webhook.js
import { buffer } from "micro";

export const config = {
  api: {
    bodyParser: false, // wichtig: raw body für Stripe-Signatur
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

  // 1) Event verifizieren
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const raw = await buffer(req);
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Wir verarbeiten ausschliesslich checkout.session.completed
    if (event.type !== "checkout.session.completed") {
      // andere Events: OK zurückgeben, damit Stripe nicht retried
      return res.status(200).json({ received: true, ignored: event.type });
    }

    const session = event.data.object;

    // Hilfen
    const getTextField = (key) => {
      const f = (session.custom_fields || []).find((x) => x.key === key);
      return f?.text?.value?.trim() || "";
    };

    const companyName = getTextField("company_name");      // Key muss dem Checkout-Feld entsprechen
    const companyTax  = getTextField("company_tax_number"); // Key muss dem Checkout-Feld entsprechen

    // Der Customer der Session
    const customerId = session.customer;
    if (!customerId) {
      console.warn("[WH] checkout.session.completed ohne customer – nichts zu tun.");
      return res.status(200).json({ received: true });
    }

    // Optional: Name/Adresse vom Checkout übernehmen (falls noch nicht am Customer vorhanden)
    // session.customer_details enthält name, email, address falls eingegeben
    const cd = session.customer_details || {};
    const customerUpdate = {};

    if (cd?.name) {
      customerUpdate.name = cd.name;
    }
    if (cd?.address && Object.keys(cd.address).length) {
      customerUpdate.address = cd.address;
    }

    // Custom Fields für Rechnungen vorbereiten (nur setzen, wenn vorhanden)
    const invoiceCustom = [];
    if (companyName) invoiceCustom.push({ name: "Company", value: companyName });
    if (companyTax)  invoiceCustom.push({ name: "Tax ID", value: companyTax });

    if (invoiceCustom.length) {
      customerUpdate.invoice_settings = { custom_fields: invoiceCustom };
    }

    // Metadata (nice-to-have, hilft in der Übersicht)
    const md = {};
    if (companyName) md.company_name = companyName;
    if (companyTax)  md.vat_or_tax_id = companyTax;
    if (Object.keys(md).length) customerUpdate.metadata = md;

    if (Object.keys(customerUpdate).length) {
      await stripe.customers.update(customerId, customerUpdate);
      console.log("[WH] Customer updated:", customerId, JSON.stringify(customerUpdate));
    } else {
      console.log("[WH] Keine Customer-Updates nötig.");
    }

    // Ab hier nichts mehr tun:
    // * Wir fassen invoice.* NICHT an (kein 500er mehr)
    // * Die nächste/soeben erzeugte Rechnung liest Felder aus customer.invoice_settings

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    // 500 zurück -> Stripe retried. Bei dauerhaften Fehlern Logs prüfen.
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
