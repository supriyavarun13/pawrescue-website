const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let amount, donationType;
  try {
    const body = JSON.parse(event.body);
    amount       = parseInt(body.amount, 10);
    donationType = body.donationType || 'once';
  } catch {
    return { statusCode: 400, body: 'Invalid request body' };
  }

  if (!amount || amount < 1) {
    return { statusCode: 400, body: 'Amount must be at least 1' };
  }

  const siteUrl = process.env.URL || 'http://localhost:8888';

  try {
    let session;

    if (donationType === 'monthly') {
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        line_items: [{
          price_data: {
            currency: 'gbp',
            product_data: { name: 'PawRescue Monthly Gift', description: 'Your monthly gift supports animal rescue and rehoming.' },
            unit_amount: amount * 100,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        }],
        success_url: `${siteUrl}/thank-you.html?session_id={CHECKOUT_SESSION_ID}&type=monthly`,
        cancel_url:  `${siteUrl}/#give`,
        metadata: { donation_type: 'monthly', site: 'pawrescue' },
        billing_address_collection: 'required',
        customer_creation: 'always',
      });
    } else {
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'gbp',
            product_data: { name: 'PawRescue Donation', description: 'Your donation supports animal rescue and rehoming.' },
            unit_amount: amount * 100,
          },
          quantity: 1,
        }],
        success_url: `${siteUrl}/thank-you.html?session_id={CHECKOUT_SESSION_ID}&type=once`,
        cancel_url:  `${siteUrl}/#give`,
        metadata: { donation_type: 'once', site: 'pawrescue' },
        billing_address_collection: 'required',
        submit_type: 'donate',
      });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('Stripe error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not create checkout session.' }),
    };
  }
};
