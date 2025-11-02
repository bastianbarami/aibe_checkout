// api/checkout-session.js
export default async function handler(req, res) {
  try {
    // --- CORS (robust + garantiert JSON) ---
    const ALLOWED = new Set([
      "https://ai-business-engine.com",
      "https://www.ai-business-engine.com",
      "https://baramiai-c98bd4c508b71b1b1c91ae95c029fc.webflow.io",
    ]);
    const origin = req.headers.origin || "";
    if (ALLOWED.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
    if (req.method !== "POST")  return res.status(405).json({ error: "Method Not Allowed" });

    // --- Stripe init (TEST) ---
    const stripeSecret = process.env.STRIPE_SECRET_KEY || "sk_test_51KYNYQGB35pnerjHY39T9ADmFiIIHZMDP4gycSycCSuonlSmLiIB8MKJWjv9BimNadES2MJosVI6Mru0zbxEwbFO00yeeJrdaL";
    if (!stripeSecret) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    const stripe = (await import("stripe")).default(stripeSecret, { apiVersion: "2020-08-27" });

    // --- Body lesen ---
    const body = await readJson(req);
    const plan           = (body.plan || "one_time").trim();
    const thankYouUrl    = (body.thankYouUrl || "https://ai-business-engine.com/thank-you").trim();
    const companyName    = trimOrNull(body.companyName);   // wird im Checkout erfasst; hier nur zur Vollständigkeit
    const taxNumber      = trimOrNull(body.taxNumber);     // dto.
    const promotionCode  = trimOrNull(body.promotionCode);

    // --- Prices (Test-Mode Fallbacks) ---
    const PRICE_ONE_TIME = process.env.PRICE_ONE_TIME || "price_1SEoGeGB35pnerjHSWvzb2Ws";
    const PRICE_SPLIT_2  = process.env.PRICE_SPLIT_2  || "test_aibe_split_2";
    const PRICE_SPLIT_3  = process.env.PRICE_SPLIT_3  || "test_aibe_split_3";

    const priceMap = {
      one_time:      PRICE_ONE_TIME,
      split_2:       PRICE_SPLIT_2,
      split_3:       PRICE_SPLIT_3,
      aibe_pif:      PRICE_ONE_TIME,
      aibe_split_2:  PRICE_SPLIT_2,
      aibe_split_3:  PRICE_SPLIT_3,
    };
    const totals = { aibe_pif: 499, aibe_split_2: 515, aibe_split_3: 525 };

    const price = priceMap[plan];
    if (!price) return res.status(400).json({ error: "Unknown plan" });

    const isSub = ["split_2", "aibe_split_2", "split_3", "aibe_split_3"].includes(plan);

    // --- Custom Fields (UI) ---
    const customFields = [
      { key: "company_name",       label: { type:"custom", custom:"Firmenname (optional)" },         type:"text", optional:true },
      { key: "company_tax_number", label: { type:"custom", custom:"Steuernummer / VAT (optional)" }, type:"text", optional:true },
    ];

    // =====================================================================
    // SUBSCRIPTION (SETUP MODE – keine Rechnung im Checkout)
    // =====================================================================
    if (isSub) {
      const customer = await stripe.customers.create({
        metadata: { created_via: "aibe_embedded_checkout", plan_hint: plan },
      });

      const sessionParams = {
        ui_mode: "embedded",
        mode: "setup", // Zahlungsmethode erfassen; Invoice/Subscription später im Webhook/Backend
        customer: customer.id,
        return_url: `${thankYouUrl}?plan=${encodeURIComponent(plan)}&session_id={CHECKOUT_SESSION_ID}`,
        billing_address_collection: "required",
        phone_number_collection: { enabled: false },
        tax_id_collection: { enabled: false },
        custom_fields: customFields,
        metadata: { plan, intent: "create_subscription_schedule" },
      };

      delete sessionParams.customer_email; // SOP: niemals senden

      const session = await stripe.checkout.sessions.create(sessionParams);
      return res.status(200).json({
        client_secret: session.client_secret,
        ver: "subs-setup-no-invoice-no-subscription",
      });
    }

    // =====================================================================
    // ONE-TIME PAYMENT (Entwurfsrechnung + spätere Finalisierung per Webhook)
    // =====================================================================
    const sessionParams = {
      ui_mode: "embedded",
      mode: "payment",
      line_items: [{ price, quantity: 1 }],
      return_url: `${thankYouUrl}?plan=${encodeURIComponent(plan)}&total=${totals[plan] || ""}&session_id={CHECKOUT_SESSION_ID}`,
      billing_address_collection: "required",
      tax_id_collection: { enabled: false },
      phone_number_collection: { enabled: false },
      allow_promotion_codes: true,
      custom_fields: customFields,

      // >>>>>>> DRAFT-HANDLING (SOP-konform, ohne auto_advance) <<<<<<<<
      invoice_creation: {
        enabled: true,
        invoice_data: {
          footer: "Reverse Charge – Die Steuerschuldnerschaft liegt beim Leistungsempfänger.",
          metadata: { plan },
          // ⚠️ KEIN auto_advance hier (SOP: unknown parameter in 2020-08-27)
        },
      },

      payment_intent_data: { metadata: { plan } },
      customer_creation: "always", // stellt sicher, dass es einen Customer gibt
    };

    // Guards (SOP)
    delete sessionParams.customer_email;
    delete sessionParams.customer; // im Payment-Flow keinen bestehenden Customer pinnen

    // Optional: Promotion Code
    if (promotionCode) {
      const pcs = await stripe.promotionCodes.list({ code: promotionCode, active: true, limit: 1 });
      const pc = pcs.data?.[0];
      if (pc?.id) sessionParams.discounts = [{ promotion_code: pc.id }];
    }

    // --- Session erstellen ---
    const session = await stripe.checkout.sessions.create(sessionParams);

    return res.status(200).json({
      client_secret: session.client_secret,
      ver: "pif-payment-draft-invoice",
    });

  } catch (e) {
    console.error("[session] error", e);
    const msg = e?.message || "session_error";
    return res.status(500).json({ error: msg, code: e?.type || null });
  }
}

// --- Helpers ---
function trimOrNull(v) { const s = (v ?? "").toString().trim(); return s.length ? s : null; }
async function readJson(req) {
  const chunks = [];
  for await (const x of req) chunks.push(x);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw);
}
