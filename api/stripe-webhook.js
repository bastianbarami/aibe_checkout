// api/stripe-webhook.js
import { buffer } from "micro";

export const runtime = "nodejs";          // Vercel: Edge vermeiden (wir brauchen raw body)
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret  = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    console.error("[WH] Missing env STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
    // 2xx NICHT senden? → Stripe würde endlos retryn. Hier sicher 500.
    return res.status(500).json({ error: "missing_env" });
  }

  const stripe = (await import("stripe")).default(stripeSecret);

  // ---------- helpers ----------
  const doNothing = () => {};
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error("[WH] step error:", e?.message || e); } };

  const setCustomerFromCompany = async (customerId, companyName, taxId) => {
    if (!customerId) return;

    // Metadaten + Rechnungskopf-Felder am Customer pflegen (Quelle für zukünftige Rechnungen)
    const update = {
      metadata: {
        ...(companyName ? { company_name: companyName } : {}),
        ...(taxId ?       { vat_or_tax_id: taxId }      : {}),
      },
      invoice_settings: {
        custom_fields: [
          ...(companyName ? [{ name: "Company", value: companyName }] : []),
          ...(taxId ?       [{ name: "Tax ID",  value: taxId }]       : []),
        ],
      },
    };

    // Falls Firma gesetzt ist, gewünschten Anzeige-Namen auf Ebene Customer hinterlegen
    if (companyName) update.name = companyName;

    await stripe.customers.update(customerId, update);
  };

  const setDraftInvoiceFields = async (invoiceId, companyName, taxId, customerNameFallback) => {
    if (!invoiceId) return;
    // Nur solange die Rechnung NICHT final ist, kann der "Bill to" Name direkt gesetzt werden
    const inv = await stripe.invoices.retrieve(invoiceId);
    if (inv.status === "draft" || inv.status === "open" || inv.status === "uncollectible") {
      const upd = {
        // "Bill to" Name – wenn Firma vorhanden → Firma, sonst der vorhandene Personen-Name
        ...(companyName || customerNameFallback
          ? { customer_name: companyName || customerNameFallback }
          : {}),
        // Sichtbare Custom-Fields auf der Rechnung
        custom_fields: [
          ...(companyName ? [{ name: "Company", value: companyName }] : []),
          ...(taxId ?       [{ name: "Tax ID",  value: taxId }]       : []),
        ],
      };
      await stripe.invoices.update(invoiceId, upd);
    }
  };

  const ensureFinalizedInvoiceHasCustomFields = async (invoiceId, fromCustomerId) => {
    if (!invoiceId) return;
    const inv = await stripe.invoices.retrieve(invoiceId);
    if (inv.status !== "paid" && inv.status !== "void" && inv.status !== "open" && inv.status !== "uncollectible") return;

    // Wenn bereits Custom Fields vorhanden → fertig
    if (Array.isArray(inv.custom_fields) && inv.custom_fields.length) return;

    // Fallback: aus Customer lesen und wenigstens Custom-Fields nachziehen
    if (fromCustomerId) {
      const cust = await stripe.customers.retrieve(fromCustomerId);
      const cf = cust?.invoice_settings?.custom_fields || [];
      if (cf.length) {
        await stripe.invoices.update(invoiceId, { custom_fields: cf });
      }
    }
  };

  // ---------- verify & parse ----------
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const raw = await buffer(req);
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ---------- handle ----------
  try {
    switch (event.type) {
      /**
       * 1) AFTER CHECKOUT: Wir lesen die Custom-Felder (company_name, company_tax_number)
       *    aus der Checkout-Session und schreiben sie auf den Customer (inkl. invoice_settings).
       *    → So greifen künftige Rechnungen automatisch; und wir mindern Race Conditions.
       */
      case "checkout.session.completed": {
        const session = event.data.object;
        // custom_fields kommen NUR hier sicher an
        const findText = (key) => {
          const f = (session.custom_fields || []).find((x) => x.key === key);
          return f?.text?.value?.trim() || "";
        };
        const company = findText("company_name");
        const taxId   = findText("company_tax_number") || findText("tax_id") || findText("company_vat") || "";

        await safe(async () => {
          await setCustomerFromCompany(session.customer, company, taxId);
          // Falls bereits eine Rechnung erzeugt wurde (Einmalzahlung mit invoice_creation),
          // versuchen wir – wenn sie noch "draft" ist – sofort Name/CF zu setzen.
          if (session.invoice) {
            await setDraftInvoiceFields(session.invoice, company, taxId, session.customer_details?.name || "");
          }
        });
        break;
      }

      /**
       * 2) INVOICE CREATED (Draft): Hier gibt's die letzte Chance, den "Bill to"-Namen
       *    und Custom-Fields VOR dem Finalisieren zu setzen. Quelle: Customer-Meta/Invoice-Settings.
       */
      case "invoice.created": {
        const invoice = event.data.object;

        await safe(async () => {
          if (!invoice.customer) return;
          const cust = await stripe.customers.retrieve(invoice.customer);
          const company = cust?.metadata?.company_name || "";
          const taxId   = cust?.metadata?.vat_or_tax_id || "";

          const personNameFallback = cust?.name || invoice.customer_name || "";
          await setDraftInvoiceFields(invoice.id, company, taxId, personNameFallback);
        });

        break;
      }

      /**
       * 3) INVOICE FINALIZED (paid/open): Falls Custom-Fields wider Erwarten fehlen,
       *    ziehen wir sie nach (Name lässt sich jetzt nicht mehr umschreiben).
       */
      case "invoice.finalized": {
        const invoice = event.data.object;
        await safe(async () => {
          await ensureFinalizedInvoiceHasCustomFields(invoice.id, invoice.customer);
        });
        break;
      }

      /**
       * 4) OPTIONAL: payment_succeeded – hier machen wir nur Logging / Housekeeping,
       *    aber keine mutierenden Operationen mehr (alles sollte vorher sitzen).
       */
      case "invoice.payment_succeeded": {
        doNothing();
        break;
      }

      default:
        // bewusst ignorieren
        break;
    }

    // Immer zügig 200 senden, damit Stripe nicht retried
    return res.status(200).json({ received: true });
  } catch (err) {
    // Safety net – trotzdem 200, damit keine Endlos-Retries entstehen
    console.error("❌ Webhook handler error (nonfatal):", err?.message || err);
    return res.status(200).json({ received: true, soft_error: true });
  }
}
