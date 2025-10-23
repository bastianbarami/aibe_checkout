// api/checkout-session.js
export default async function handler(req, res) {
  const ALLOWED = [
    "https://ai-business-engine.com",
    "https://www.ai-business-engine.com",
    "https://baramiai-c98bd4c508b71b1b1c91ae95c029fc.webflow.io"
  ];
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
  const stripe = (await import("stripe")).default(stripeSecret);

  try {
    const {
      plan = "aibe_pif",
      email = "",
      name = "",
      thankYouUrl
    } = await readJson(req);

    // --- Preise per ENV (falls wir gespeicherte Prices weiter nutzen wollen)
    const PRICE_ONE_TIME = process.env.PRICE_ONE_TIME;
    const PRICE_SPLIT_2  = process.env.PRICE_SPLIT_2;
    const PRICE_SPLIT_3  = process.env.PRICE_SPLIT_3;

    // --- Optional: Inline-Price-Data nutzen (versteckt Bilder/Beschreibung im Checkout)
    // Setze in Vercel ENV: USE_INLINE_PRICE_DATA=true um diese Variante zu aktivieren.
    const USE_INLINE_PRICE_DATA = String(process.env.USE_INLINE_PRICE_DATA || "")
      .toLowerCase() === "true";

    // Deine Beträge in Cent für inline price_data
    const INLINE = {
      aibe_pif:      { currency: "eur", unit_amount: 49900, mode: "payment" },
      aibe_split_2:  { currency: "eur", unit_amount: 25750, mode: "subscription", recurring: { interval: "month", interval_count: 1 } }, // 2 Monate manuell kündigen/automatisieren
      aibe_split_3:  { currency: "eur", unit_amount: 17500, mode: "subscription", recurring: { interval: "month", interval_count: 1 } }, // 3 Monate manuell kündigen/automatisieren
      one_time:      { currency: "eur", unit_amount: 49900, mode: "payment" },
      split_2:       { currency: "eur", unit_amount: 25750, mode: "subscription", recurring: { interval: "month", interval_count: 1 } },
      split_3:       { currency: "eur", unit_amount: 17500, mode: "subscription", recurring: { interval: "month", interval_count: 1 } },
    };

    const isSub = ["split_2", "aibe_split_2", "split_3", "aibe_split_3"].includes(plan);
    const mode  = isSub ? "subscription" : "payment";

    // Wir geben KEINEN customer & KEIN customer_email vor -> E-Mail ist im Checkout editierbar.
    const sessionParams = {
      ui_mode: "embedded",
      mode,
      return_url: `${thankYouUrl || "https://ai-business-engine.com/thank-you"}?plan=${encodeURIComponent(plan)}&session_id={CHECKOUT_SESSION_ID}`,

      // Adress- & Zusatzfelder
      billing_address_collection: "required",
      tax_id_collection: { enabled: false },
      phone_number_collection: { enabled: false },

      // Firma & Steuernummer vom Checkout erfassen
      custom_fields: [
        {
          key: "company_name",
          label: { type: "custom", custom: "Firmenname (optional)" },
          type: "text",
          optional: true
        },
        {
          key: "company_tax_number",
          label: { type: "custom", custom: "Steuernummer / VAT (optional)" },
          type: "text",
          optional: true
        }
      ],
    };

    // Linie-Items definieren
    if (USE_INLINE_PRICE_DATA) {
      const cfg = INLINE[plan];
      if (!cfg) return res.status(400).json({ error: "Unknown plan" });

      if (mode === "payment") {
        sessionParams.line_items = [{
          price_data: {
            currency: cfg.currency,
            unit_amount: cfg.unit_amount,
            product_data: {
              // KEINE images / description => nichts anzeigen im Checkout-Header
              name: "AI Business Engine"
            }
          },
          quantity: 1
        }];
      } else {
        sessionParams.line_items = [{
          price_data: {
            currency: cfg.currency,
            unit_amount: cfg.unit_amount,
            recurring: cfg.recurring,
            product_data: {
              name: "AI Business Engine"
            }
          },
          quantity: 1
        }];
      }
    } else {
      // Fallback: gespeicherte Stripe-Preise (zeigt evtl. Produktbild/Beschreibung an)
      const map = {
        one_time: PRICE_ONE_TIME,
        split_2:  PRICE_SPLIT_2,
        split_3:  PRICE_SPLIT_3,
        aibe_pif: PRICE_ONE_TIME,
        aibe_split_2: PRICE_SPLIT_2,
        aibe_split_3: PRICE_SPLIT_3,
      };
      const price = map[plan];
      if (!price) return res.status(400).json({ error: "Unknown plan" });
      sessionParams.line_items = [{ price, quantity: 1 }];
    }

    // WICHTIG: Customer im Checkout erstellen lassen (E-Mail bleibt editierbar)
    if (mode === "payment") {
      sessionParams.customer_creation ="always";
    }

    // Metadaten + Rechnungserstellung bei Einmalzahlungen
    if (mode === "payment") {
      sessionParams.invoice_creation = {
        enabled: true,
        invoice_data: {
          footer: "Reverse Charge – Die Steuerschuldnerschaft liegt beim Leistungsempfänger.",
          metadata: {
            plan,
            form_email: email || "",
            form_name:  name  || ""
          }
        }
      };
      sessionParams.payment_intent_data = {
        metadata: {
          plan,
          form_email: email || "",
          form_name:  name  || ""
        }
      };
    } else {
      sessionParams.subscription_data = {
        metadata: {
          plan,
          form_email: email || "",
          form_name:  name  || ""
        }
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
