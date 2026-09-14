require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { pool, initDatabase } = require('./src/db');
const { signUser, authRequired, adminRequired } = require('./src/auth');
const { analyzeOrder, recommendServices, operationalBrief } = require('./src/ai');
const {
  createMercadoPagoCheckout,
  createPayPalCheckout,
  capturePayPalOrder,
  fetchMercadoPagoPayment,
  verifyPayPalWebhook
} = require('./src/payments');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.APP_URL || true }));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const emailOf = value => String(value || '').trim().toLowerCase();
const asMoney = value => Math.round(Number(value) * 100) / 100;

async function audit(req, action, payload = {}) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (user_id,action,payload,ip) VALUES (?,?,?,?)',
      [req.user?.id || null, action, JSON.stringify(payload), req.ip]
    );
  } catch (_) {}
}

async function creditApprovedPayment(localPaymentId, externalId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM payments WHERE id=? FOR UPDATE', [localPaymentId]);
    if (!rows.length) throw new Error('Pagamento local não encontrado');
    const payment = rows[0];
    if (payment.status !== 'approved') {
      await conn.query('UPDATE payments SET status="approved", external_id=COALESCE(?,external_id) WHERE id=?', [externalId || null, payment.id]);
      await conn.query('UPDATE users SET balance=balance+? WHERE id=?', [payment.amount, payment.user_id]);
    }
    await conn.commit();
    return payment;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'superamplitude-smm', ai: process.env.AI_ENABLED !== 'false', time: new Date().toISOString() });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = emailOf(req.body.email);
    const password = String(req.body.password || '');
    if (name.length < 2 || !email.includes('@') || password.length < 10) {
      return res.status(400).json({ error: 'Nome, e-mail e senha com pelo menos 10 caracteres são obrigatórios.' });
    }
    const [exists] = await pool.query('SELECT id FROM users WHERE email=? LIMIT 1', [email]);
    if (exists.length) return res.status(409).json({ error: 'E-mail já cadastrado.' });
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)', [name, email, hash]);
    const user = { id: result.insertId, name, email, role: 'customer', balance: 0 };
    await audit({ ...req, user }, 'register', { email });
    res.status(201).json({ token: signUser(user), user });
  } catch (error) {
    res.status(500).json({ error: 'Não foi possível criar a conta.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = emailOf(req.body.email);
  const password = String(req.body.password || '');
  const [rows] = await pool.query('SELECT * FROM users WHERE email=? LIMIT 1', [email]);
  const user = rows[0];
  if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Credenciais inválidas.' });
  }
  const safe = { id: user.id, name: user.name, email: user.email, role: user.role, balance: user.balance };
  await audit({ ...req, user: safe }, 'login');
  res.json({ token: signUser(safe), user: safe });
});

app.get('/api/me', authRequired, async (req, res) => {
  const [rows] = await pool.query('SELECT id,name,email,role,balance,status,created_at FROM users WHERE id=? LIMIT 1', [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.json(rows[0]);
});

app.get('/api/services', async (req, res) => {
  const [rows] = await pool.query('SELECT id,category,name,description,unit,min_qty,max_qty,price_per_1000 FROM services WHERE active=1 ORDER BY category,name');
  res.json(rows);
});

app.post('/api/ai/recommend', authRequired, async (req, res) => {
  const result = await recommendServices({
    userId: req.user.id,
    goal: String(req.body.goal || '').slice(0, 1000),
    budget: Number(req.body.budget || 0),
    network: String(req.body.network || '').slice(0, 120)
  });
  res.json(result);
});

app.get('/api/orders', authRequired, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT o.id,o.target_url,o.quantity,o.amount,o.status,o.created_at,s.name service,s.category FROM orders o JOIN services s ON s.id=o.service_id WHERE o.user_id=? ORDER BY o.id DESC LIMIT 100',
    [req.user.id]
  );
  res.json(rows);
});

app.post('/api/orders', authRequired, async (req, res) => {
  try {
    const serviceId = Number(req.body.service_id);
    const quantity = Number(req.body.quantity);
    const targetUrl = String(req.body.target_url || '').trim();
    const [rows] = await pool.query('SELECT * FROM services WHERE id=? AND active=1 LIMIT 1', [serviceId]);
    const service = rows[0];
    if (!service) return res.status(404).json({ error: 'Serviço indisponível.' });
    if (!Number.isInteger(quantity) || quantity < service.min_qty || quantity > service.max_qty) {
      return res.status(400).json({ error: `Quantidade deve ficar entre ${service.min_qty} e ${service.max_qty}.` });
    }
    if (!/^https?:\/\//i.test(targetUrl)) return res.status(400).json({ error: 'Informe uma URL válida.' });
    const amount = asMoney((Number(service.price_per_1000) * quantity) / 1000);
    const ai = await analyzeOrder({ userId: req.user.id, service: { id: service.id, name: service.name, category: service.category }, quantity, targetUrl, amount });
    if (ai.decision === 'reject') {
      await audit(req, 'order_rejected_by_policy', { serviceId, quantity, risk: ai.risk_score });
      return res.status(422).json({ error: 'Pedido bloqueado pela política operacional.', ai });
    }
    const [result] = await pool.query(
      'INSERT INTO orders (user_id,service_id,target_url,quantity,amount,status) VALUES (?,?,?,?,?,?)',
      [req.user.id, serviceId, targetUrl, quantity, amount, 'pending']
    );
    await audit(req, 'order_created', { orderId: result.insertId, serviceId, quantity, amount, aiDecision: ai.decision });
    res.status(201).json({ id: result.insertId, amount, status: 'pending', ai });
  } catch (error) {
    res.status(500).json({ error: 'Não foi possível registrar o pedido.' });
  }
});

app.get('/api/payments', authRequired, async (req, res) => {
  const [rows] = await pool.query('SELECT id,gateway,amount,currency,status,checkout_url,created_at FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 100', [req.user.id]);
  res.json(rows);
});

app.post('/api/payments/checkout', authRequired, async (req, res) => {
  try {
    const gateway = String(req.body.gateway || '');
    const amount = asMoney(req.body.amount);
    if (!['mercadopago', 'paypal'].includes(gateway)) return res.status(400).json({ error: 'Gateway inválido.' });
    if (!Number.isFinite(amount) || amount < 10 || amount > 50000) return res.status(400).json({ error: 'Valor permitido: R$ 10,00 a R$ 50.000,00.' });
    const [payment] = await pool.query('INSERT INTO payments (user_id,gateway,amount,status) VALUES (?,?,?,"created")', [req.user.id, gateway, amount]);
    const localId = payment.insertId;
    const description = `Crédito SMM SuperAmplitude #${localId}`;
    const checkout = gateway === 'mercadopago'
      ? await createMercadoPagoCheckout({ amount, description, email: req.user.email, externalReference: localId })
      : await createPayPalCheckout({ amount, description, externalReference: localId });
    await pool.query('UPDATE payments SET external_id=?,checkout_url=?,status="pending" WHERE id=?', [checkout.externalId, checkout.checkoutUrl, localId]);
    await audit(req, 'payment_checkout_created', { paymentId: localId, gateway, amount });
    res.status(201).json({ payment_id: localId, gateway, amount, checkout_url: checkout.checkoutUrl });
  } catch (error) {
    res.status(502).json({ error: 'Não foi possível abrir o checkout do gateway.' });
  }
});

app.get('/api/payments/paypal/return', async (req, res) => {
  const orderId = String(req.query.token || '').trim();
  if (!orderId) return res.redirect('/?payment=failure');
  try {
    const [rows] = await pool.query('SELECT id FROM payments WHERE gateway="paypal" AND external_id=? LIMIT 1', [orderId]);
    if (!rows.length) return res.redirect('/?payment=failure');
    const capture = await capturePayPalOrder(orderId);
    if (capture.status === 'COMPLETED' || capture.name === 'ORDER_ALREADY_CAPTURED') {
      await creditApprovedPayment(rows[0].id, orderId);
      return res.redirect('/?payment=success');
    }
    return res.redirect('/?payment=pending');
  } catch (error) {
    console.error('PayPal return:', error.message);
    return res.redirect('/?payment=failure');
  }
});

app.post('/api/webhooks/mercadopago', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const paymentId = req.body?.data?.id || req.query?.['data.id'];
    if (!paymentId) return;
    const remote = await fetchMercadoPagoPayment(paymentId);
    const localId = Number(remote.external_reference);
    if (!localId) return;
    if (remote.status === 'approved') {
      await creditApprovedPayment(localId, String(paymentId));
    } else {
      const map = { pending: 'pending', in_process: 'pending', rejected: 'failed', cancelled: 'cancelled', refunded: 'refunded' };
      const status = map[remote.status];
      if (status) await pool.query('UPDATE payments SET status=?,external_id=? WHERE id=? AND status<>"approved"', [status, String(paymentId), localId]);
    }
  } catch (error) {
    console.error('Mercado Pago webhook:', error.message);
  }
});

app.post('/api/webhooks/paypal', async (req, res) => {
  try {
    const valid = await verifyPayPalWebhook(req.headers, req.body);
    if (!valid) return res.status(400).json({ error: 'Assinatura inválida.' });
    const type = req.body?.event_type;
    const resource = req.body?.resource || {};
    const orderId = resource?.supplementary_data?.related_ids?.order_id || resource?.id;
    if (type === 'PAYMENT.CAPTURE.COMPLETED' && orderId) {
      const [rows] = await pool.query('SELECT id FROM payments WHERE gateway="paypal" AND external_id=? LIMIT 1', [String(orderId)]);
      if (rows.length) await creditApprovedPayment(rows[0].id, String(orderId));
    }
    res.json({ received: true });
  } catch (error) {
    res.status(400).json({ error: 'Webhook PayPal rejeitado.' });
  }
});

app.get('/api/admin/overview', authRequired, adminRequired, async (req, res) => {
  const [[users]] = await pool.query('SELECT COUNT(*) total, COALESCE(SUM(balance),0) balances FROM users');
  const [[orders]] = await pool.query("SELECT COUNT(*) total, SUM(status='pending') pending, SUM(status='processing') processing, SUM(status='completed') completed FROM orders");
  const [[payments]] = await pool.query("SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0) approved_value FROM payments");
  res.json({ users, orders, payments });
});

app.get('/api/admin/ai/brief', authRequired, adminRequired, async (req, res) => {
  res.json(await operationalBrief());
});

app.get('/api/admin/ai/decisions', authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query('SELECT id,user_id,decision_type,status,output_json,reviewed_by,reviewed_at,created_at FROM ai_decisions ORDER BY id DESC LIMIT 100');
  res.json(rows);
});

app.post('/api/admin/services', authRequired, adminRequired, async (req, res) => {
  const category = String(req.body.category || '').trim();
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const unit = String(req.body.unit || '1000').trim();
  const minQty = Number(req.body.min_qty || 1);
  const maxQty = Number(req.body.max_qty || 100000);
  const price = Number(req.body.price_per_1000);
  if (!category || !name || !Number.isFinite(price) || price <= 0 || minQty < 1 || maxQty < minQty) return res.status(400).json({ error: 'Dados do serviço inválidos.' });
  const [result] = await pool.query('INSERT INTO services (category,name,description,unit,min_qty,max_qty,price_per_1000) VALUES (?,?,?,?,?,?,?)', [category, name, description, unit, minQty, maxQty, price]);
  await audit(req, 'service_created', { serviceId: result.insertId, category, name });
  res.status(201).json({ id: result.insertId });
});

app.patch('/api/admin/orders/:id', authRequired, adminRequired, async (req, res) => {
  const allowed = ['pending', 'processing', 'completed', 'partial', 'cancelled', 'refunded'];
  const status = String(req.body.status || '');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Status inválido.' });
  await pool.query('UPDATE orders SET status=? WHERE id=?', [status, Number(req.params.id)]);
  await audit(req, 'order_status_changed', { orderId: Number(req.params.id), status });
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const port = Number(process.env.PORT || 3008);
initDatabase()
  .then(() => app.listen(port, '127.0.0.1', () => console.log(`SMM SuperAmplitude online em 127.0.0.1:${port}`)))
  .catch(error => {
    console.error('Falha ao inicializar:', error);
    process.exit(1);
  });
