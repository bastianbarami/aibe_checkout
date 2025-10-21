// api/stripe-webhook.js
import { buffer } from "micro";

// Force Node.js runtime (not Edge)
export const runtime = "nodejs";

// IMPORTANT: raw body for Stripe signature verification
export const config = {
  api: {
    bodyParser: false,
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

  // 1) Verify event with raw body
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err?.message || "invalid"}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        const customerId = session.customer;
        if (!customerId) break;

        const findTextField = (key) => {
          const f = (session.custom_fields || []).find((x) => x.key === key);
          return f?.text?.value || null;
        };

        const companyName = findTextField("company_name");
        const taxIdCustom = findTextField("company_tax_number"); // your custom input

        const customFields = [];
        if (companyName) customFields.push({ name: "Company", value: companyName });
        if (taxIdCustom) customFields.push({ name: "Tax ID", value: taxIdCustom });

        const update = {
          metadata: {
            ...(companyName ? { company_name: companyName } : {}),
            ...(taxIdCustom ? { vat_or_tax_id: taxIdCustom } : {}),
          },
        };
        if (customFields.length) {
          update.invoice_settings = { custom_fields: customFields };
        }

        if (Object.keys(update).length > 0) {
          await stripe.customers.update(customerId, update);
        }
        break;
      }

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

      // Optional: observe success
      case "invoice.payment_succeeded":
      case "invoice.created":
        // no-op
        break;

      default:
        // ignore others
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    // return 500 so Stripe retries
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}
