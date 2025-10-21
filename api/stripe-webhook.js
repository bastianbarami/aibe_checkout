// api/stripe-webhook.js
// ------------------------------------------------------------
// Stripe Webhook-Handler (Vercel / Next.js API Route)
// - bodyParser muss AUS sein (raw body für die Signaturprüfung)
// - Setzt nach Checkout die gewünschten Felder am Customer:
//     * invoice_settings.custom_fields => Firma + Steuernummer
//     * Name-Logik: Wenn Firma angegeben, Customer-Name = Firmenname
// - Fallback: Wenn zum Zeitpunkt der Rechnungs-Finalisierung (invoice.finalized)
//   die Custom-Felder noch nicht auf der Rechnung sind, kopieren wir sie
//   1:1 vom Customer auf die Rechnung.
// ------------------------------------------------------------
import { buffer } from "micro";

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
    return res
      .status(500)
      .json({ error: "Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET" });
  }

  const stripe = (await import("stripe")).default(stripeSecret);

  // ----- Stripe-Event verifizieren -----
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Kleines Helper: Logging mit Event-Type
  const log = (...args) => console.log(`[WH ${event?.type}]`, ...args);

  try {
    switch (event.type) {
      // =====================================================================
      // 1) Nach abgeschlossenem Checkout: Customer aktualisieren
      // =====================================================================
      case "checkout.session.completed": {
        const session = event.data.object;
        const customerId = session.customer;

        log("session id:", session?.id, "customer:", customerId);

        if (!customerId) {
          log("No customer on session, skipping.");
          break;
        }

        // Helper: Text aus Custom-Feld holen (aus der Checkout-Session).
        // WICHTIG: Keys müssen mit denen aus der Checkout-Session übereinstimmen.
        // (In deinem Checkout-Code: "company_name" und "company_tax_number")
        const getTextField = (key) => {
          const f = (session.custom_fields || []).find((x) => x.key === key);
          return f?.text?.value?.trim() || "";
        };

        const companyName = getTextField("company_name");          // z.B. "KONKEL LLC"
        const taxNumber   = getTextField("company_tax_number");    // z.B. "DE123456789"

        // Wir bauen die "Custom Fields", die auf der Rechnung unten angezeigt werden.
        // (Labels frei wählbar – erscheinen exakt so auf der Rechnung)
        const customFields = [];
        if (companyName) customFields.push({ name: "Firma", value: companyName });
        if (taxNumber)   customFields.push({ name: "Steuernummer / VAT", value: taxNumber });

        // Update-Objekt für den Customer
        const update = {
          // Für die Buchhaltung zusätzlich in die Metadata schreiben
          metadata: {
            ...(companyName ? { company_name: companyName } : {}),
            ...(taxNumber   ? { vat_or_tax_id: taxNumber   } : {}),
          },
        };

        // Name-Logik:
        // Wenn Firma angegeben, soll der **Customer-Name** die Firma sein,
        // damit Rechnung/Zahlungsbeleg oben die Firma tragen (statt Vor-/Nachname).
        if (companyName) {
          update.name = companyName;
        }

        // Custom-Felder nur setzen, wenn vorhanden
        if (customFields.length) {
          update.invoice_settings = { custom_fields: customFields };
        }

        if (Object.keys(update).length) {
          log("Updating customer with:", update);
          await stripe.customers.update(customerId, update);
        } else {
          log("Nothing to update on customer.");
        }

        break;
      }

      // =====================================================================
      // 2) Fallback: Wenn Rechnung finalized, aber (noch) keine custom_fields hat
      //    → Kopiere sie vom Customer auf die Rechnung
      // =====================================================================
      case "invoice.finalized": {
        const invoice = event.data.object;
        log("invoice id:", invoice?.id, "customer:", invoice?.customer);

        //  Guard 1: Ohne Customer kein Update
        if (!invoice?.customer) {
          log("No customer on invoice, skipping.");
          break;
        }

        //  Guard 2: Falls die Rechnung bereits Custom Fields hat → nichts tun
        if (invoice.custom_fields?.length) {
          log("Invoice already has custom_fields, skipping.");
          break;
        }

        try {
          // Customer abrufen und seine evtl. gesetzten Custom Fields lesen
          const cust = await stripe.customers.retrieve(invoice.customer);
          const cf = cust?.invoice_settings?.custom_fields || [];

          if (cf.length) {
            log("Copying customer.custom_fields to invoice:", cf);
            await stripe.invoices.update(invoice.id, { custom_fields: cf });
          } else {
            log("Customer has no invoice_settings.custom_fields to copy.");
          }
        } catch (err) {
          // Wichtig: Fehler hier **nicht** nach oben werfen, sonst 500 → Stripe retried ewig.
          console.error("[invoice.finalized] copy custom_fields failed:", err.message);
        }

        break;
      }

      default:
        // Andere Events ignorieren wir bewusst
        log("ignored");
        break;
    }

    // Stripe muss 2xx sehen, sonst retried es
    return res.status(200).json({ received: true });
  } catch (err) {
    // Nur „letzte Verteidigungslinie“. Oben möglichst einzeln try/catchen,
    // damit wir hier nicht in ein 500-Retry-Loch geraten.
    console.error("❌ Webhook handler error:", err);
    // 2xx NICHT senden, damit Stripe mit Backoff erneut zustellt
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
