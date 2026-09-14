async function createMercadoPagoCheckout({ amount, description, email, externalReference }) {
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) throw new Error('Mercado Pago não configurado');
  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      items: [{ title: description, quantity: 1, currency_id: 'BRL', unit_price: Number(amount) }],
      payer: email ? { email } : undefined,
      external_reference: String(externalReference),
      back_urls: {
        success: `${process.env.APP_URL}/?payment=success`,
        pending: `${process.env.APP_URL}/?payment=pending`,
        failure: `${process.env.APP_URL}/?payment=failure`
      },
      auto_return: 'approved',
      notification_url: `${process.env.APP_URL}/api/webhooks/mercadopago`
    })
  });
  if (!response.ok) throw new Error(`Mercado Pago HTTP ${response.status}`);
  const data = await response.json();
  return { externalId: data.id, checkoutUrl: data.init_point || data.sandbox_init_point };
}

async function paypalAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PayPal não configurado');
  const base = process.env.PAYPAL_MODE === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error(`PayPal auth HTTP ${response.status}`);
  const data = await response.json();
  return { base, token: data.access_token };
}

async function createPayPalCheckout({ amount, description, externalReference }) {
  const { base, token } = await paypalAccessToken();
  const response = await fetch(`${base}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `smm-${externalReference}`
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: String(externalReference),
        description,
        amount: { currency_code: 'BRL', value: Number(amount).toFixed(2) }
      }],
      application_context: {
        return_url: `${process.env.APP_URL}/?payment=success`,
        cancel_url: `${process.env.APP_URL}/?payment=cancelled`
      }
    })
  });
  if (!response.ok) throw new Error(`PayPal HTTP ${response.status}`);
  const data = await response.json();
  const approval = (data.links || []).find(link => link.rel === 'approve');
  return { externalId: data.id, checkoutUrl: approval?.href || null };
}

module.exports = { createMercadoPagoCheckout, createPayPalCheckout };
