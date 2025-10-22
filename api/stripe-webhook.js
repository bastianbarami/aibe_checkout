// api/stripe-webhook.js
import { buffer } from "micro";

// Vercel: Node.js Runtime & raw body für Stripe
export const runtime = 'nodejs';
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

  // Hilfsfunktionen
  const getTextCF = (session, key) => {
    const f = (session?.custom_fields || []).find((x) => x.key === key);
    return f?.text?.value || null;
  };
  const pickCompanyFromCustomer = (cust) => {
    // 1) aus invoice_settings.custom_fields
    const cf = cust?.invoice_settings?.custom_fields || [];
    const fromCF =
      cf.find((x) => (x?.name || "").toLowerCase() === "company")?.value ||
      cf.find((x) => (x?.name || "").toLowerCase() === "firmenname")?.value;
    if (fromCF) return fromCF;
    // 2) aus metadata
    if (cust?.metadata?.company_name) return cust.metadata.company_name;
    // 3) fallback: customer.name (nicht ideal)
    return cust?.name || null;
  };

  // Event verifizieren
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
      // 1) Checkout fertig: neu erzeugten Customer pflegen
      case "checkout.session.completed": {
        const session = event.data.object;

        const customerId = session.customer;
        if (!customerId) break;

        // Werte aus unseren Checkout-Custom-Feldern
        const companyName = getTextCF(session, "company_name");
        const taxNumber   = getTextCF(session, "company_tax_number");

        const update = {
          // Wenn Firmenname vorhanden: sofort Customer-Name = Firma
          ...(companyName ? { name: companyName } : {}),
          metadata: {
            ...(companyName ? { company_name: companyName } : {}),
            ...(taxNumber ? { vat_or_tax_id: taxNumber } : {}),
          },
        };

        // Custom-Fields auf künftigen Rechnungen anzeigen
        const cf = [];
        if (companyName) cf.push({ name: "Company", value: companyName });
        if (taxNumber)   cf.push({ name: "Tax ID",  value: taxNumber });
        if (cf.length) update.invoice_settings = { custom_fields: cf };

        if (Object.keys(update).length) {
          await stripe.customers.update(customerId, update);
        }
        break;
      }

      // 2) Rechnung erstellt (noch nicht final) → Adresse (Kopf) **jetzt** überschreiben
      case "invoice.created": {
        const invoice = event.data.object;

        if (!invoice.customer) break;
        const cust = await stripe.customers.retrieve(invoice.customer);

        const company = pickCompanyFromCustomer(cust);
        const updateInvoice = {};

        if (company) {
          // *** Hier wird der Adress-Name im Rechnungs-Kopf ersetzt ***
          updateInvoice.customer_name = company;
        }

        // die gleichen benutzerdefinierten Felder wie am Customer (optional)
        const cf = cust?.invoice_settings?.custom_fields || [];
        if (cf?.length && !invoice.custom_fields?.length) {
          updateInvoice.custom_fields = cf;
        }

        if (Object.keys(updateInvoice).length) {
          await stripe.invoices.update(invoice.id, updateInvoice);
        }

        break;
      }

      // 3) Optionales Sicherheitsnetz – falls created-Update zu spät käme
      case "invoice.finalized": {
        const invoice = event.data.object;
        if (!invoice.customer) break;

        // Wenn schon ein Firmenname im Kopf steht → nichts tun
        if (invoice.customer_name) break;

        const cust = await stripe.customers.retrieve(invoice.customer);
        const company = pickCompanyFromCustomer(cust);
        if (company) {
          try {
            await stripe.invoices.update(invoice.id, { customer_name: company });
          } catch (_) {
            // finalized kann je nach Zustand „nicht mehr editierbar“ sein → ok zu ignorieren
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
    // 5xx → Stripe stellt mit Backoff erneut zu
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
