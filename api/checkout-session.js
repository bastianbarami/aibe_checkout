// api/checkout-session.js

export default async function handler(req, res) {
  // CORS: nur von deinen Domains
  const ALLOWED = [
    "https://ai-business-engine.com",
    "https://www.ai-business-engine.com",
    "https://baramiai-c98bd4c508b71b1b1c91ae95c029fc.webflow.io",
  ];
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });

  // Stripe SDK dynamisch importieren (Node Runtime)
const stripe = (await import("stripe")).default(stripeSecret);

  try {
    const { plan = "one_time", email = "", name = "", thankYouUrl } = await readJson(req);

    // Preis-IDs aus Umgebungsvariablen (wie gehabt)
    const PRICE_ONE_TIME = process.env.PRICE_ONE_TIME;
    const PRICE_SPLIT_2  = process.env.PRICE_SPLIT_2;
    const PRICE_SPLIT_3  = process.env.PRICE_SPLIT_3;

    const map = {
      one_time:     PRICE_ONE_TIME,
      split_2:      PRICE_SPLIT_2,
      split_3:      PRICE_SPLIT_3,
      aibe_pif:     PRICE_ONE_TIME,
      aibe_split_2: PRICE_SPLIT_2,
      aibe_split_3: PRICE_SPLIT_3,
    };
    const totals = { aibe_pif: 499, aibe_split_2: 515, aibe_split_3: 525 };

    const price = map[plan];
    if (!price) return res.status(400).json({ error: "Unknown plan" });

    const isSub = ["split_2", "aibe_split_2", "split_3", "aibe_split_3"].includes(plan);
    const mode  = isSub ? "subscription" : "payment";

    // Bestehenden Customer wiederverwenden (Prefill Email/Name)
    let customerId;
    if (email) {
      const found = await stripe.customers.list({ email, limit: 1 });
      if (found.data.length) {
        customerId = found.data[0].id;
        if (name && !found.data[0].name) {
          await stripe.customers.update(customerId, { name });
        }
      } else {
        const created = await stripe.customers.create({ email, name });
        customerId = created.id;
      }
    }

    // Embedded Checkout Session OHNE Tax-ID-Collection / OHNE „Business“-Switch
    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode,
      line_items: [{ price, quantity: 1 }],

      // Erfolgreich zurück
      return_url: `${thankYouUrl || "https://ai-business-engine.com/thank-you"}?plan=${encodeURIComponent(plan)}&total=${totals[plan] || ""}&session_id={CHECKOUT_SESSION_ID}`,

      // Rechnungsadresse: weiterhin Pflicht (für Beleg); Telefon aus
      billing_address_collection: "required",
      phone_number_collection: { enabled: false },

      // Optionale Custom-Felder (Firmennamen & Steuer-Nr. nur als Freitext, kein Zwang):
      custom_fields: [
        {
          key: "company_name",
          label: { type: "custom", custom: "Firmenname" },
          type: "text",
          optional: true,
        },
        {
          key: "tax_number",
          label: { type: "custom", custom: "Deine (Umsatz-)Steuernummer" },
          type: "text",
          optional: true,
        },
      ],

      // Wichtig: Keine Rechnung automatisch erzeugen
      // (invoice_creation bewusst NICHT setzen)

      // Prefill
      customer: customerId || undefined,
      customer_email: customerId ? undefined : (email || undefined),

      // Metadaten landen auf PaymentIntent / Subscription
      payment_intent_data: {
        metadata: {
          plan,
          form_email: email || "",
          form_name:  name  || "",
        },
      },
      // Für Subscriptions landen Metadaten auf der Subscription:
      subscription_data: isSub
        ? {
            metadata: {
              plan,
              form_email: email || "",
              form_name:  name  || "",
            },
          }
        : undefined,
    });

    return res.status(200).json({ client_secret: session.client_secret });
  } catch (e) {
    console.error("session error", e);
    return res.status(500).json({ error: e?.message || "session_error" });
  }
}

// Robust für Node & (falls mal nötig) Edge-ähnliche Umgebungen
async function readJson(req) {
  // Falls der Request ein .text() hat (Edge/Fetch-API)
  if (typeof req.text === "function") {
    const t = await req.text();
    return t ? JSON.parse(t) : {};
  }
  // Node/Serverless-Standard
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
