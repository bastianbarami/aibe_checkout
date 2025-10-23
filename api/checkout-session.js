// api/checkout-session.js
export default async function handler(req, res) {
  // --- CORS ---
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

  // --- Stripe init ---
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
  const stripe = (await import("stripe")).default(stripeSecret);

  try {
    const { plan = "one_time", email = "", name = "", thankYouUrl } = await readJson(req);

    // --- Preis-IDs ---
    const PRICE_ONE_TIME = process.env.PRICE_ONE_TIME;
    const PRICE_SPLIT_2  = process.env.PRICE_SPLIT_2;
    const PRICE_SPLIT_3  = process.env.PRICE_SPLIT_3;

    const map = {
      one_time:      PRICE_ONE_TIME,
      split_2:       PRICE_SPLIT_2,
      split_3:       PRICE_SPLIT_3,
      aibe_pif:      PRICE_ONE_TIME,
      aibe_split_2:  PRICE_SPLIT_2,
      aibe_split_3:  PRICE_SPLIT_3,
    };

    const totals = { one_time: 499, aibe_pif: 499, aibe_split_2: 515, aibe_split_3: 525 };
    const price = map[plan];
    if (!price) return res.status(400).json({ error: "Unknown plan" });

    const isSub = ["split_2", "aibe_split_2", "split_3", "aibe_split_3"].includes(plan);
    const mode = isSub ? "subscription" : "payment";

    // ----------------------------------------------------------------
    // WICHTIG für editierbares E-Mail-Feld:
    //   * KEIN 'customer' irgendwo setzen (auch nicht indirekt).
    //   * NUR 'customer_email' setzen -> vorbefüllt & editierbar.
    // ----------------------------------------------------------------
    const sessionParams = {
      ui_mode: "embedded",
      mode,
      line_items: [{ price, quantity: 1 }],
      return_url: `${
        thankYouUrl || "https://ai-business-engine.com/thank-you"
      }?plan=${encodeURIComponent(plan)}&total=${totals[plan] || ""}&session_id={CHECKOUT_SESSION_ID}`,

      // Vorbefüllen, aber editierbar:
      ...(email ? { customer_email: email } : {}),

      billing_address_collection: "required",
      tax_id_collection: { enabled: false },
      phone_number_collection: { enabled: false },

      custom_fields: [
        {
          key: "company_name",
          label: { type: "custom", custom: "Firmenname (optional)" },
          type: "text",
          optional: true,
        },
        {
          key: "company_tax_number",
          label: { type: "custom", custom: "Steuernummer / VAT (optional)" },
          type: "text",
          optional: true,
        },
      ],
    };

    if (mode === "payment") {
      // Für Einmalzahlung kann Stripe nach Abschluss automatisch einen Customer anlegen.
      // Das beeinflusst die Editierbarkeit NICHT, solange wir HIER keinen bestehenden customer binden.
      sessionParams.customer_creation = "always";

      // Rechnung erzeugen + Metadaten
      sessionParams.invoice_creation = {
        enabled: true,
        invoice_data: {
          footer:
            "Reverse Charge – Die Steuerschuldnerschaft liegt beim Leistungsempfänger.",
          metadata: {
            plan,
            form_email: email || "",
            form_name:  name  || "",
          },
        },
      };

      // Metadaten am Payment Intent (Auswertungen/Nachvollziehbarkeit)
      sessionParams.payment_intent_data = {
        metadata: {
          plan,
          form_email: email || "",
          form_name:  name  || "",
        },
      };
    } else {
      // Abo-Fall: Metadaten an Subscription
      sessionParams.subscription_data = {
        // KEIN 'customer' hier setzen!
        metadata: {
          plan,
          form_email: email || "",
          form_name:  name  || "",
        },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ client_secret: session.client_secret });
  } catch (e) {
    console.error("session error", e);
    return res.status(500).json({ error: e.message || "session_error" });
  }
}

async function readJson(req) {
  const c = [];
  for await (const x of req) c.push(x);
  return JSON.parse(Buffer.concat(c).toString("utf8") || "{}");
}
