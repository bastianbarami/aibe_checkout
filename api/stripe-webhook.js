// api/stripe-webhook.js
import { buffer } from "micro";

// Vercel Functions: wir wollen Node.js (nicht edge) + rohen Body für Stripe-Signatur
export const runtime = "nodejs";
export const config = {
  api: {
    bodyParser: false, // WICHTIG: Stripe verlangt den "raw" Body
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

  // ──────────────────────────────────────────────────────────────────────────────
  // 1) Ereignis verifizieren
  // ──────────────────────────────────────────────────────────────────────────────
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // kleine Helper
  const safeArray = (x) => (Array.isArray(x) ? x : []);
  const getCustomField = (session, key) => {
    const f = safeArray(session?.custom_fields).find((x) => x.key === key);
    return f?.text?.value || null;
  };

  try {
    switch (event.type) {
      // ────────────────────────────────────────────────────────────────────────
      // A) Checkout beendet -> Firmenname sofort am Customer speichern
      //    => sorgt dafür, dass künftige Rechnungen/Belege den Firmennamen
      //       im Adressblock haben.
      // ────────────────────────────────────────────────────────────────────────
      case "checkout.session.completed": {
        const session    = event.data.object;
        const customerId = session.customer;
        if (!customerId) break;

        // Firmenname aus deinen Checkout-Custom-Fields
        const companyName = getCustomField(session, "company_name");
        const taxNumber   = getCustomField(session, "company_tax_number");

        if (companyName || taxNumber) {
          const update = {
            metadata: {
              ...(companyName ? { company_name: companyName } : {}),
              ...(taxNumber   ? { vat_or_tax_id: taxNumber } : {}),
            }
          };

          // WICHTIG: damit der Firmenname künftig im Adressblock steht
          if (companyName) update.name = companyName;

          await stripe.customers.update(customerId, update);
        }
        break;
      }

      // ────────────────────────────────────────────────────────────────────────
      // B) Rechnung wird erstellt (Draft) -> Sicherheitsnetz:
      //    - Falls Customer inzwischen eine Firma in den Metadaten hat,
      //      aber name noch nicht Firma ist, setzen wir Customer.name = Firma
      //      (wir beeinflussen damit künftige Dokumente sicher)
      //    - Außerdem ergänzen wir fehlende Custom Fields im Kopfbereich
      // ────────────────────────────────────────────────────────────────────────
      case "invoice.created": {
        const invoice = event.data.object;
        if (!invoice.customer) break;

        const cust = await stripe.customers.retrieve(invoice.customer);

        const companyName = cust?.metadata?.company_name || null;
        const taxId       = cust?.metadata?.vat_or_tax_id || null;

        // Adressblock zukünftig auf Firma stellen (Customer.name = Firma)
        if (companyName && cust?.name !== companyName) {
          try {
            await stripe.customers.update(invoice.customer, { name: companyName });
          } catch (e) {
            // falls parallel ein anderes Update läuft – unkritisch
            console.warn("[WH] customers.update(name) failed (race?):", e?.message || e);
          }
        }

        // Kopfbereich der Rechnung (Custom Fields) ergänzen, falls noch leer
        const cf = safeArray(invoice.custom_fields);
        const toAdd = [];
        if (companyName && !cf.find((x) => x.name === "Company")) {
          toAdd.push({ name: "Company", value: companyName });
        }
        if (taxId && !cf.find((x) => x.name === "Tax ID")) {
          toAdd.push({ name: "Tax ID", value: taxId });
        }
        if (toAdd.length) {
          try {
            await stripe.invoices.update(invoice.id, {
              custom_fields: [...cf, ...toAdd],
            });
          } catch (e) {
            console.warn("[WH] invoices.update(custom_fields) failed:", e?.message || e);
          }
        }

        break;
      }

      // ────────────────────────────────────────────────────────────────────────
      // C) Finalisierte Rechnung -> falls Kopfbereich noch leer ist, ziehen wir
      //    die (bereits gespeicherten) Customer-Custom-Fields nach.
      // ────────────────────────────────────────────────────────────────────────
      case "invoice.finalized": {
        const invoice = event.data.object;
        if (invoice.custom_fields?.length) break;

        if (invoice.customer) {
          const cust = await stripe.customers.retrieve(invoice.customer);
          const companyName = cust?.metadata?.company_name || null;
          const taxId       = cust?.metadata?.vat_or_tax_id || null;

          const cf = [];
          if (companyName) cf.push({ name: "Company", value: companyName });
          if (taxId)       cf.push({ name: "Tax ID",  value: taxId });

          if (cf.length) {
            try {
              await stripe.invoices.update(invoice.id, { custom_fields: cf });
            } catch (e) {
              console.warn("[WH] invoices.update on finalized failed:", e?.message || e);
            }
          }
        }
        break;
      }

      default:
        // andere Events ignorieren
        break;
    }

    // Stripe braucht 2xx, sonst retried
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    // Absichtlich kein 2xx -> Stripe wird den Event erneut zustellen
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
