const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios  = require('axios');

// ─── Salesforce helpers ──────────────────────────────────────────────────────

async function getSalesforceToken() {
  const params = new URLSearchParams({
    grant_type:    'password',
    client_id:     process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
    username:      process.env.SF_USERNAME,
    password:      process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN,
  });

  const response = await axios.post(
    `${process.env.SF_LOGIN_URL}/services/oauth2/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return { access_token: response.data.access_token, instance_url: response.data.instance_url };
}

async function upsertContact(sf, donor) {
  const { access_token, instance_url } = sf;
  const apiBase = `${instance_url}/services/data/v58.0`;
  const headers = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

  const email = donor.email.replace(/'/g, "\\'");
  const soql  = `SELECT Id FROM Contact WHERE Email = '${email}' LIMIT 1`;
  const searchRes = await axios.get(`${apiBase}/query?q=${encodeURIComponent(soql)}`, { headers });

  if (searchRes.data.totalSize > 0) {
    console.log(`Found existing Contact: ${searchRes.data.records[0].Id}`);
    return searchRes.data.records[0].Id;
  }

  const nameParts = (donor.name || 'Anonymous Donor').trim().split(/\s+/);
  const firstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : '';
  const lastName  = nameParts[nameParts.length - 1] || 'Donor';

  const createRes = await axios.post(
    `${apiBase}/sobjects/Contact`,
    { FirstName: firstName, LastName: lastName, Email: donor.email, LeadSource: 'Web', npsp__Do_Not_Contact__c: false },
    { headers }
  );

  console.log(`Created new Contact: ${createRes.data.id}`);
  return createRes.data.id;
}

async function createOpportunity(sf, contactId, payment) {
  const { access_token, instance_url } = sf;
  const apiBase = `${instance_url}/services/data/v58.0`;
  const headers = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

  const today  = new Date().toISOString().split('T')[0];
  const amount = payment.amountPence / 100;

  const oppPayload = {
    Name:                     `Online Donation — £${amount} — ${today}`,
    Amount:                   amount,
    StageName:                'Closed Won',
    CloseDate:                today,
    Type:                     'Donation',
    LeadSource:               'Web',
    Description:              `Stripe Payment Intent: ${payment.stripeId}`,
    npsp__Primary_Contact__c: contactId,
  };

  if (process.env.SF_DONATION_RECORD_TYPE_ID) {
    oppPayload.RecordTypeId = process.env.SF_DONATION_RECORD_TYPE_ID;
  }

  const res = await axios.post(`${apiBase}/sobjects/Opportunity`, oppPayload, { headers });
  console.log(`Created Opportunity: ${res.data.id}`);
  return res.data.id;
}

async function createRecurringDonation(sf, contactId, payment) {
  const { access_token, instance_url } = sf;
  const apiBase = `${instance_url}/services/data/v58.0`;
  const headers = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

  const today  = new Date().toISOString().split('T')[0];
  const amount = payment.amountPence / 100;

  const rdPayload = {
    Name:                         `Monthly Gift — ${payment.donorName || 'Anonymous'}`,
    npe03__Contact__c:            contactId,
    npe03__Amount__c:             amount,
    npe03__Installment_Period__c: 'Monthly',
    npe03__Date_Established__c:  today,
    npe03__Open_Ended_Status__c: 'Open',
  };

  const res = await axios.post(`${apiBase}/sobjects/npe03__Recurring_Donation__c`, rdPayload, { headers });
  console.log(`Created Recurring Donation: ${res.data.id}`);
  return res.data.id;
}

// ─── Webhook handler ─────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      event.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe signature failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const relevantEvents = ['checkout.session.completed', 'invoice.payment_succeeded'];
  if (!relevantEvents.includes(stripeEvent.type)) {
    return { statusCode: 200, body: JSON.stringify({ received: true, processed: false }) };
  }

  const session = stripeEvent.data.object;

  if (stripeEvent.type === 'invoice.payment_succeeded' && session.billing_reason !== 'subscription_create') {
    return { statusCode: 200, body: JSON.stringify({ received: true, processed: false }) };
  }

  const donor = {
    name:  session.customer_details?.name  || 'Anonymous',
    email: session.customer_details?.email || session.customer_email || '',
  };

  const payment = {
    stripeId:    session.payment_intent || session.subscription || session.id,
    amountPence: session.amount_total   || session.lines?.data?.[0]?.price?.unit_amount,
    donationType: session.metadata?.donation_type || 'once',
    donorName:   donor.name,
  };

  if (!donor.email) {
    console.error('No email in Stripe session');
    return { statusCode: 400, body: 'No email in session' };
  }

  try {
    const sf        = await getSalesforceToken();
    const contactId = await upsertContact(sf, donor);

    if (payment.donationType === 'monthly') {
      await createRecurringDonation(sf, contactId, payment);
    } else {
      await createOpportunity(sf, contactId, payment);
    }

    console.log(`✅ Processed £${payment.amountPence / 100} ${payment.donationType} from ${donor.email}`);
    return { statusCode: 200, body: JSON.stringify({ received: true, processed: true }) };

  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('Salesforce error:', detail);
    return { statusCode: 200, body: JSON.stringify({ received: true, processed: false, error: detail }) };
  }
};
