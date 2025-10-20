// api/stripe-webhook.js
import { buffer } from "micro";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret)
    return res.status(500).json({ error: "Missing Stripe secrets" });

  const stripe = (await import("stripe")).default(stripeSecret);
  let event;

  try {
    const sig = req.headers["stripe-signature"];
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Hilfsfunktion, um Textfelder zu finden
    const getTextField = (session, key) => {
      const f = (session.custom_fields || []).find((x) => x.key === key);
      return f?.text?.value || null;
    };

    switch (event.type) {
      // -------------------------------------
      // Nach Checkout: Customer aktualisieren
      // -------------------------------------
      case "checkout.session.completed": {
        const s = event.data.object;
        const cid = s.customer;
        if (!cid) break;

        const company = getTextField(s, "company_name");
        const tax = getTextField(s, "company_tax_number") || getTextField(s, "tax_id");

        const update = {
          metadata: {
            ...(company ? { company_name: company } : {}),
            ...(tax ? { vat_or_tax_id: tax } : {}),
          },
        };

        if (company) update.name = company;
        if (company || tax)
          update.invoice_settings = {
            custom_fields: [
              ...(company ? [{ name: "Firma", value: company }] : []),
              ...(tax ? [{ name: "USt-/VAT", value: tax }] : []),
            ],
          };

        await stripe.customers.update(cid, update);
        console.log("✅ Customer updated:", cid, update);
        break;
      }

      // -------------------------------------
      // Rechnung erzeugt → sofort aktualisieren
      // -------------------------------------
      case "invoice.created": {
        const inv = event.data.object;
        const cid = inv.customer;
        if (!cid) break;

        const cust = await stripe.customers.retrieve(cid);
        const company = cust.metadata?.company_name || null;
        const tax = cust.metadata?.vat_or_tax_id || null;

        if (!company && !tax) break;

        const cf = [];
        if (company) cf.push({ name: "Firma", value: company });
        if (tax) cf.push({ name: "USt-/VAT", value: tax });

        const invUpdate = {
          ...(company ? { customer_name: company } : {}),
          ...(cf.length ? { custom_fields: cf } : {}),
        };

        await stripe.invoices.update(inv.id, invUpdate);
        console.log("🧾 invoice.created updated:", inv.id, invUpdate);
        break;
      }

      // -------------------------------------
      // Sicherheitsnetz bei Finalisierung
      // -------------------------------------
      case "invoice.finalized": {
        const inv = event.data.object;
        const cid = inv.customer;
        if (!cid) break;

        const cust = await stripe.customers.retrieve(cid);
        const company = cust.metadata?.company_name || null;
        const tax = cust.metadata?.vat_or_tax_id || null;

        const cf =
          inv.custom_fields?.length
            ? inv.custom_fields
            : [
                ...(company ? [{ name: "Firma", value: company }] : []),
                ...(tax ? [{ name: "USt-/VAT", value: tax }] : []),
              ];

        const invUpdate = {};
        if (company && inv.customer_name !== company)
          invUpdate.customer_name = company;
        if (cf.length && !inv.custom_fields?.length)
          invUpdate.custom_fields = cf;

        if (Object.keys(invUpdate).length) {
          await stripe.invoices.update(inv.id, invUpdate);
          console.log("🧾 invoice.finalized updated:", inv.id, invUpdate);
        }
        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
