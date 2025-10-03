// api/checkout-session.js
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function monthsFromNow(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return Math.floor(d.getTime() / 1000);
}

module.exports = async (req, res) => {
  // CORS für deine Domain erlauben
  res.setHeader('Access-Control-Allow-Origin', 'https://ai-business-engine.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  try {
    const { plan } = req.body || {};
    if (!plan) return res.status(400).json({ error: 'Missing plan' });

    // Basis-Parameter für Embedded Checkout
    const params = {
      ui_mode: 'embedded',
      // Wir geben Plan & Gesamtsumme mit, damit deine Thank-You das Pixel korrekt setzt
      return_url: 'https://ai-business-engine.com/thank-you?plan=' + plan +
                  '&total=' + (
                    plan === 'one_time' ? 499 :
                    plan === 'split_2' ? 515 :
                    plan === 'split_3' ? 525 : 0
                  ) +
                  '&session_id={CHECKOUT_SESSION_ID}',
    };

    if (plan === 'one_time') {
      params.mode = 'payment';
      params.line_items = [{ price: process.env.PRICE_ONE_TIME, quantity: 1 }];
    } else if (plan === 'split_2') {
      params.mode = 'subscription';
      params.line_items = [{ price: process.env.PRICE_SPLIT_2, quantity: 1 }];
      params.subscription_data = { cancel_at: monthsFromNow(2) }; // endet automatisch nach 2 Monaten
    } else if (plan === 'split_3') {
      params.mode = 'subscription';
      params.line_items = [{ price: process.env.PRICE_SPLIT_3, quantity: 1 }];
      params.subscription_data = { cancel_at: monthsFromNow(3) }; // endet automatisch nach 3 Monaten
    } else {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const session = await stripe.checkout.sessions.create(params);
    return res.status(200).json({ client_secret: session.client_secret });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
