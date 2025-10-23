// api/stripe-webhook.js
import { buffer } from "micro";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    console.error("[WH] Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
    return res.status(500).json({ error: "missing_env" });
  }

  const stripe = (await import("stripe")).default(stripeSecret);

  // -------- helpers ----------
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error("[WH step error]", e); } };

  const extractField = (session, key) => {
    const cf = (session.custom_fields || []).find((f) => f.key === key);
    return cf?.text?.value?.trim() || "";
  };

  const normalizeEuVat = (raw) => {
    if (!raw) return "";
    let v = raw.trim().toUpperCase().replace(/\s+/g, "");
    // Falls Nutzer z.B. "123456789" eingibt → "DE123456789"
    if (/^[0-9A-Z]+$/.test(v) && !/^[A-Z]{2}/.test(v)) v = "DE" + v;
    return v;
  };

  const ensureCustomerTaxId = async (customerId, value) => {
    if (!customerId || !value) return;
    const val = normalizeEuVat(value);
    if (!val) return;

    // Prüfen, ob bereits vorhanden
    const existing = await stripe.customers.listTaxIds(customerId, { limit: 20 });
    const already = existing.data.find((t) => (t.type === "eu_vat") && (t.value || "").toUpperCase() === val);
    if (already) return;

    await stripe.customers.createTaxId(customerId, { type: "eu_vat", value: val });
  };

  // Käuferadresse/Firma auf der Rechnung sichtbar machen
  const updateInvoiceCustomerFace = async ({ invoiceId, company, taxId, fallbackName }) => {
    if (!invoiceId) return;
    const inv = await stripe.invoices.retrieve(invoiceId);

    // Nur änderbar bevor bezahlt/voided (status draft/open/uncollectible ok)
    if (!["draft", "open", "uncollectible"].includes(inv.status)) return;

    const patch = {};
    // „Bill to“ → Firma, sonst Name
    if (company || fallbackName) patch.customer_name = company || fallbackName;

    // Hinweis: custom_fields auf der Rechnung sind Verkäufer-Felder (linke Spalte oben).
    // Käufer-Steuernummer gehört als Customer Tax ID → das rendern wir über ensureCustomerTaxId().
    await stripe.invoices.update(invoiceId, patch);
  };

  // ---------------- verify stripe event ---------------
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const raw = await buffer(req);
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (err) {
    console.error("Invalid signature:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ---------------- handle events ---------------------
  try {
    switch (event.type) {
      /**
       * 1) Direkt nach dem Checkout:
       *    - Firma + Steuernummer aus custom_fields lesen
       *    - Customer.name = Firma (wenn vorhanden)
       *    - Customer.metadata speichern (für Folge-Rechnungen)
       *    - Customer Tax ID anlegen (eu_vat), damit auf Rechnung sichtbar
       *    - Falls es schon eine Rechnung gibt (Einmalzahlung) → sofort patchen
       */
      case "checkout.session.completed": {
        const s = event.data.object;

        const company = extractField(s, "company_name");
        const taxNo = extractField(s, "company_tax_number");
        const customerId = s.customer || null;

        if (!customerId) break;

        await safe(async () => {
          // Customer updaten (Name auf Firma setzen, wenn Firma vorhanden)
          const update = {
            metadata: {
              ...(company ? { company_name: company } : {}),
              ...(taxNo ? { vat_or_tax_id: taxNo } : {}),
            },
          };
          if (company) update.name = company; // sorgt dafür, dass künftige Invoices die Firma übernehmen
          await stripe.customers.update(customerId, update);

          // Käufer-Steuer-ID (sichtbar unter „Bill to“) anlegen
          if (taxNo) await ensureCustomerTaxId(customerId, taxNo);

          // Falls diese Session bereits eine Rechnung erzeugt hat (One-Time)
          if (s.invoice) {
            const fallbackName = s.customer_details?.name || "";
            await updateInvoiceCustomerFace({
              invoiceId: s.invoice,
              company,
              taxId: taxNo,
              fallbackName,
            });
          }
        });

        break;
      }

      /**
       * 2) Wenn eine Rechnung erstellt wird (z.B. Abo-erste Rechnung):
       *    - Firma/Tax aus Customer.metadaten lesen
       *    - „Bill to“ -> Firma
       *    - sicherstellen, dass Tax ID am Customer hängt
       */
      case "invoice.created": {
        const inv = event.data.object;
        if (!inv.customer) break;

        await safe(async () => {
          const cust = await stripe.customers.retrieve(inv.customer);
          const company = cust?.metadata?.company_name || "";
          const taxNo = cust?.metadata?.vat_or_tax_id || "";
          if (taxNo) await ensureCustomerTaxId(inv.customer, taxNo);

          const fallbackName = cust?.name || inv.customer_name || "";
          await updateInvoiceCustomerFace({
            invoiceId: inv.id,
            company,
            taxId: taxNo,
            fallbackName,
          });
        });

        break;
      }

      /**
       * 3) Kurz vorm Bezahlen finalisiert Stripe oft die Rechnung.
       *    Falls die Firma noch nicht als „Bill to“ gesetzt wurde, holen wir das jetzt nach.
       */
      case "invoice.finalized": {
        const inv = event.data.object;
        await safe(async () => {
          const cust = inv.customer ? await stripe.customers.retrieve(inv.customer) : null;
          const company = cust?.metadata?.company_name || "";
          const taxNo = cust?.metadata?.vat_or_tax_id || "";
          if (taxNo && inv.customer) await ensureCustomerTaxId(inv.customer, taxNo);

          const fallbackName = cust?.name || inv.customer_name || "";
          await updateInvoiceCustomerFace({
            invoiceId: inv.id,
            company,
            taxId: taxNo,
            fallbackName,
          });
        });
        break;
      }

      case "invoice.payment_succeeded":
        console.log("💰 payment ok", event.data.object.id);
        break;

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(200).json({ received: true, soft_error: err.message });
  }
}
