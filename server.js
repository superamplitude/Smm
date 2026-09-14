require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { pool, initDatabase } = require('./src/db');
const { signUser, authRequired, adminRequired } = require('./src/auth');
const { analyzeOrder, recommendServices, operationalBrief, startAiScheduler } = require('./src/ai');
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
const aiConfigured = () => Boolean(
  String(process.env.AI_ENABLED || 'true').toLowerCase() === 'true' &&
  process.env.AI_API_BASE_URL && process.env.AI_API_KEY && process.env.AI_MODEL
);

function rateLimit({ windowMs = 60000, max = 60 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    if (buckets.size > 5000) {
      for (const [bucketKey, item] of buckets.entries()) {
        if (now > item.resetAt) buckets.delete(bucketKey);
      }
    }
    const item = buckets.get(key);
    if (!item || now > item.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    item.count += 1;
    if (item.count > max) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco e tente novamente.' });
    next();
  };
}

app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));
app.use('/api/ai', rateLimit({ windowMs: 60 * 1000, max: 20 }));

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
      await conn.query(
        'INSERT INTO wallet_transactions (user_id,type,amount,reference_type,reference_id,description) VALUES (?,"credit",?,"payment",?,?)',
        [payment.user_id, payment.amount, payment.id, `Crédito confirmado via ${payment.gateway}`]
      );
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
  res.json({
    ok: true,
    service: 'superamplitude-smm',
    ai_enabled: String(process.env.AI_ENABLED || 'true').toLowerCase() === 'true',
    ai_configured: aiConfigured(),
    time: new Date().toISOString()
  });
});

app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1 AS ok');
    res.json({
      ok: true,
      service: 'superamplitude-smm',
      database: 'ready',
      ai: aiConfigured() ? 'configured' : 'fallback',
      time: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({ ok: false, service: 'superamplitude-smm', database: 'unavailable' });
  }
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
  const [rows] = await pool.query('SELECT id,category,name,description,unit_label,min_qty,max_qty,price_per_unit FROM services WHERE active=1 ORDER BY category,name');
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

    const amount = asMoney(Number(service.price_per_unit) * quantity);
    const ai = await analyzeOrder({
      userId: req.user.id,
      service: { id: service.id, name: service.name, category: service.category, unit: service.unit_label },
      quantity,
      targetUrl,
      amount
    });
    if (ai.decision === 'reject') {
      await audit(req, 'order_rejected_by_policy', { serviceId, quantity, risk: ai.risk_score });
      return res.status(422).json({ error: 'Pedido bloqueado pela política operacional.', ai });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [users] = await conn.query('SELECT balance,status FROM users WHERE id=? FOR UPDATE', [req.user.id]);
      const user = users[0];
      if (!user || user.status !== 'active') {
        await conn.rollback();
        return res.status(403).json({ error: 'Conta indisponível.' });
      }
      if (Number(user.balance) < amount) {
        await conn.rollback();
        return res.status(402).json({ error: `Saldo insuficiente. Necessário ${amount.toFixed(2)}.` });
      }
      const [result] = await conn.query(
        'INSERT INTO orders (user_id,service_id,target_url,quantity,amount,status) VALUES (?,?,?,?,?,"pending")',
        [req.user.id, serviceId, targetUrl, quantity, amount]
      );
      await conn.query('UPDATE users SET balance=balance-? WHERE id=?', [amount, req.user.id]);
      await conn.query(
        'INSERT INTO wallet_transactions (user_id,type,amount,reference_type,reference_id,description) VALUES (?,"debit",?,"order",?,?)',
        [req.user.id, amount, result.insertId, `Pedido #${result.insertId}`]
      );
      await conn.commit();
      await audit(req, 'order_created', { orderId: result.insertId, serviceId, quantity, amount, aiDecision: ai.decision, risk: ai.risk_score });
      return res.status(201).json({ id: result.insertId, amount, status: 'pending', ai });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  } catch (error) {
    res.status(500).json({ error: 'Não foi possível registrar o pedido.' });
  }
});

app.get('/api/wallet', authRequired, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id,type,amount,reference_type,reference_id,description,created_at FROM wallet_transactions WHERE user_id=? ORDER BY id DESC LIMIT 100',
    [req.user.id]
  );
  res.json(rows);
});

app.get('/api/payments', authRequired, async (req, res) => {
  const [rows] = await pool.query('SELECT id,gateway,amount,currency,status,checkout_url,created_at FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 100', [req.user.id]);
  res.json(rows);
});

app.post('/api/payments/checkout', authRequired, async (req, res) => {
  let localId = null;
  try {
    const gateway = String(req.body.gateway || '');
    const amount = asMoney(req.body.amount);
    if (!['mercadopago', 'paypal'].includes(gateway)) return res.status(400).json({ error: 'Gateway inválido.' });
    if (!Number.isFinite(amount) || amount < 10 || amount > 50000) return res.status(400).json({ error: 'Valor permitido: R$ 10,00 a R$ 50.000,00.' });
    const [payment] = await pool.query('INSERT INTO payments (user_id,gateway,amount,status) VALUES (?,?,?,"created")', [req.user.id, gateway, amount]);
    localId = payment.insertId;
    const description = `Crédito SMM SuperAmplitude #${localId}`;
    const checkout = gateway === 'mercadopago'
      ? await createMercadoPagoCheckout({ amount, description, email: req.user.email, externalReference: localId })
      : await createPayPalCheckout({ amount, description, externalReference: localId });
    await pool.query('UPDATE payments SET external_id=?,checkout_url=?,status="pending" WHERE id=?', [checkout.externalId, checkout.checkoutUrl, localId]);
    await audit(req, 'payment_checkout_created', { paymentId: localId, gateway, amount });
    res.status(201).json({ payment_id: localId, gateway, amount, checkout_url: checkout.checkoutUrl });
  } catch (error) {
    if (localId) await pool.query('UPDATE payments SET status="failed" WHERE id=? AND status="created"', [localId]).catch(() => {});
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
      const map = { pending: 'pending', in_process: 'pending', rejected: 'failed', cancelled: 'cancelled' };
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
  const [[users]] = await pool.query("SELECT COUNT(*) total, SUM(status='active') active, SUM(status='blocked') blocked, COALESCE(SUM(balance),0) balances FROM users");
  const [[orders]] = await pool.query("SELECT COUNT(*) total, SUM(status='pending') pending, SUM(status='processing') processing, SUM(status='completed') completed, SUM(status='cancelled') cancelled, SUM(status='refunded') refunded, SUM(created_at>=CURDATE()) today FROM orders");
  const [[payments]] = await pool.query("SELECT COUNT(*) total, SUM(status='approved') approved, SUM(status='failed') failed, COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0) approved_value, COALESCE(SUM(CASE WHEN status='approved' AND created_at>=CURDATE() THEN amount ELSE 0 END),0) approved_today FROM payments");
  const [[wallet]] = await pool.query("SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE 0 END),0) credits, COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END),0) debits, COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) refunds FROM wallet_transactions");
  const [[ai]] = await pool.query('SELECT COUNT(*) total, SUM(reviewed_at IS NULL) unreviewed FROM ai_decisions');
  res.json({ users, orders, payments, wallet, ai, ai_configured: aiConfigured() });
});

app.get('/api/admin/orders', authRequired, adminRequired, async (req, res) => {
  const status = String(req.query.status || '').trim();
  const q = String(req.query.q || '').trim().slice(0, 120);
  const allowed = ['pending', 'processing', 'completed', 'partial', 'cancelled', 'refunded'];
  const where = [];
  const params = [];
  if (status && allowed.includes(status)) {
    where.push('o.status=?');
    params.push(status);
  }
  if (q) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR s.name LIKE ? OR CAST(o.id AS CHAR)=?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, q);
  }
  const sql = `SELECT o.id,o.target_url,o.quantity,o.amount,o.status,o.funds_refunded,o.provider_order_id,o.created_at,o.updated_at,u.id user_id,u.name user_name,u.email user_email,s.id service_id,s.name service,s.category FROM orders o JOIN users u ON u.id=o.user_id JOIN services s ON s.id=o.service_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT 200`;
  const [rows] = await pool.query(sql, params);
  res.json(rows);
});

app.get('/api/admin/users', authRequired, adminRequired, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const params = [];
  let where = '';
  if (q) {
    where = 'WHERE u.name LIKE ? OR u.email LIKE ? OR CAST(u.id AS CHAR)=?';
    params.push(`%${q}%`, `%${q}%`, q);
  }
  const [rows] = await pool.query(
    `SELECT u.id,u.name,u.email,u.role,u.balance,u.status,u.created_at,COUNT(DISTINCT o.id) orders_count,COUNT(DISTINCT p.id) payments_count FROM users u LEFT JOIN orders o ON o.user_id=u.id LEFT JOIN payments p ON p.user_id=u.id ${where} GROUP BY u.id ORDER BY u.id DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

app.patch('/api/admin/users/:id', authRequired, adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || '');
  if (!Number.isInteger(id) || id < 1 || !['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Dados inválidos.' });
  if (id === Number(req.user.id) && status === 'blocked') return res.status(409).json({ error: 'Você não pode bloquear sua própria conta administrativa.' });
  const [result] = await pool.query('UPDATE users SET status=? WHERE id=?', [status, id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Usuário não encontrado.' });
  await audit(req, 'user_status_changed', { userId: id, status });
  res.json({ ok: true, id, status });
});

app.get('/api/admin/payments', authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query('SELECT p.id,p.gateway,p.external_id,p.amount,p.currency,p.status,p.created_at,p.updated_at,u.id user_id,u.name user_name,u.email user_email FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 200');
  res.json(rows);
});

app.get('/api/admin/services', authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query('SELECT id,category,name,description,unit_label,min_qty,max_qty,price_per_unit,provider_code,active,created_at FROM services ORDER BY active DESC,category,name');
  res.json(rows);
});

app.post('/api/admin/services', authRequired, adminRequired, async (req, res) => {
  const category = String(req.body.category || '').trim();
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const unitLabel = String(req.body.unit_label || 'unidade').trim();
  const minQty = Number(req.body.min_qty || 1);
  const maxQty = Number(req.body.max_qty || 1000);
  const price = Number(req.body.price_per_unit);
  if (!category || !name || !unitLabel || !Number.isFinite(price) || price <= 0 || minQty < 1 || maxQty < minQty) return res.status(400).json({ error: 'Dados do serviço inválidos.' });
  const [result] = await pool.query(
    'INSERT INTO services (category,name,description,unit_label,min_qty,max_qty,price_per_unit) VALUES (?,?,?,?,?,?,?)',
    [category, name, description, unitLabel, minQty, maxQty, price]
  );
  await audit(req, 'service_created', { serviceId: result.insertId, category, name });
  res.status(201).json({ id: result.insertId });
});

app.patch('/api/admin/services/:id', authRequired, adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.query('SELECT * FROM services WHERE id=? LIMIT 1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Serviço não encontrado.' });
  const current = rows[0];
  const next = {
    category: req.body.category !== undefined ? String(req.body.category).trim() : current.category,
    name: req.body.name !== undefined ? String(req.body.name).trim() : current.name,
    description: req.body.description !== undefined ? String(req.body.description).trim() : current.description,
    unit_label: req.body.unit_label !== undefined ? String(req.body.unit_label).trim() : current.unit_label,
    min_qty: req.body.min_qty !== undefined ? Number(req.body.min_qty) : Number(current.min_qty),
    max_qty: req.body.max_qty !== undefined ? Number(req.body.max_qty) : Number(current.max_qty),
    price_per_unit: req.body.price_per_unit !== undefined ? Number(req.body.price_per_unit) : Number(current.price_per_unit),
    active: req.body.active !== undefined ? (req.body.active ? 1 : 0) : Number(current.active)
  };
  if (!next.category || !next.name || !next.unit_label || !Number.isFinite(next.price_per_unit) || next.price_per_unit <= 0 || next.min_qty < 1 || next.max_qty < next.min_qty) {
    return res.status(400).json({ error: 'Dados do serviço inválidos.' });
  }
  await pool.query('UPDATE services SET category=?,name=?,description=?,unit_label=?,min_qty=?,max_qty=?,price_per_unit=?,active=? WHERE id=?', [next.category, next.name, next.description, next.unit_label, next.min_qty, next.max_qty, next.price_per_unit, next.active, id]);
  await audit(req, 'service_updated', { serviceId: id, active: next.active, price: next.price_per_unit });
  res.json({ ok: true, id, ...next });
});

app.get('/api/admin/ai/brief', authRequired, adminRequired, async (req, res) => {
  res.json(await operationalBrief());
});

app.get('/api/admin/ai/decisions', authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query('SELECT id,user_id,decision_type,status,input_json,output_json,reviewed_by,reviewed_at,created_at FROM ai_decisions ORDER BY id DESC LIMIT 200');
  res.json(rows);
});

app.patch('/api/admin/ai/decisions/:id/review', authRequired, adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  const [result] = await pool.query('UPDATE ai_decisions SET reviewed_by=?,reviewed_at=NOW() WHERE id=?', [req.user.id, id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Decisão de IA não encontrada.' });
  await audit(req, 'ai_decision_reviewed', { decisionId: id });
  res.json({ ok: true, id });
});

app.get('/api/admin/audit', authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query('SELECT a.id,a.action,a.payload,a.ip,a.created_at,u.name user_name,u.email user_email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200');
  res.json(rows);
});

app.patch('/api/admin/orders/:id', authRequired, adminRequired, async (req, res) => {
  const allowed = ['pending', 'processing', 'completed', 'partial', 'cancelled', 'refunded'];
  const status = String(req.body.status || '');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Status inválido.' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM orders WHERE id=? FOR UPDATE', [Number(req.params.id)]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    const order = rows[0];
    if (order.funds_refunded && !['cancelled', 'refunded'].includes(status)) {
      await conn.rollback();
      return res.status(409).json({ error: 'Este pedido já teve os valores devolvidos e não pode ser reativado.' });
    }
    if (['cancelled', 'refunded'].includes(status) && !order.funds_refunded) {
      await conn.query('UPDATE users SET balance=balance+? WHERE id=?', [order.amount, order.user_id]);
      await conn.query(
        'INSERT INTO wallet_transactions (user_id,type,amount,reference_type,reference_id,description) VALUES (?,"refund",?,"order",?,?)',
        [order.user_id, order.amount, order.id, `Devolução do pedido #${order.id}`]
      );
      await conn.query('UPDATE orders SET status=?,funds_refunded=1 WHERE id=?', [status, order.id]);
    } else {
      await conn.query('UPDATE orders SET status=? WHERE id=?', [status, order.id]);
    }
    await conn.commit();
    await audit(req, 'order_status_changed', { orderId: order.id, status });
    res.json({ ok: true, id: order.id, status });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: 'Não foi possível atualizar o pedido.' });
  } finally {
    conn.release();
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const port = Number(process.env.PORT || 3008);
initDatabase()
  .then(() => {
    startAiScheduler();
    app.listen(port, '127.0.0.1', () => console.log(`SMM SuperAmplitude online em 127.0.0.1:${port}`));
  })
  .catch(error => {
    console.error('Falha ao inicializar:', error);
    process.exit(1);
  });