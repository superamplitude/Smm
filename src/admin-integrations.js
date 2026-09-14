const express = require('express');
const { pool } = require('./db');
const { authRequired, adminRequired } = require('./auth');
const { encryptSecret } = require('./secrets');
const {
  syncSupplierCatalog,
  testSupplierConnection,
  refreshSupplierBalance,
  repriceLinkedServices,
  publishSupplierCatalog
} = require('./suppliers');
const { categorizeSupplierCatalog, testAiIntegration, aiConfigured } = require('./ai');

const router = express.Router();
router.use(authRequired, adminRequired);

const bool = value => value === true || value === 1 || value === '1' || value === 'true';
const text = (value, max = 500) => String(value || '').trim().slice(0, max);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

async function audit(req, action, payload = {}) {
  await pool.query(
    'INSERT INTO audit_logs (user_id,action,payload,ip) VALUES (?,?,?,?)',
    [req.user?.id || null, action, JSON.stringify(payload), req.ip]
  ).catch(() => {});
}

router.get('/integrations/status', async (req, res) => {
  const [[suppliers]] = await pool.query('SELECT COUNT(*) total,SUM(active=1) active,SUM(active=1 AND is_primary=1) primary_count,COALESCE(SUM(balance),0) provider_balance FROM supplier_servers');
  const [[ais]] = await pool.query('SELECT COUNT(*) total,SUM(enabled=1) active,SUM(enabled=1 AND is_primary=1) primary_count FROM ai_integrations');
  res.json({ suppliers, ais, ai_configured: await aiConfigured() });
});

router.get('/suppliers', async (req, res) => {
  const [rows] = await pool.query(`SELECT id,name,api_type,base_url,services_endpoint,orders_endpoint,status_endpoint,balance_endpoint,webhook_url,balance,currency,conversion_rate,markup_percent,rate_divisor,auto_price_sync,active,is_primary,last_test_status,last_test_at,last_sync_at,last_balance_at,created_at,updated_at,(api_key_enc IS NOT NULL AND api_key_enc<>'') api_key_configured FROM supplier_servers ORDER BY is_primary DESC,active DESC,id DESC`);
  res.json(rows.map(row => ({
    ...row,
    active: Boolean(row.active),
    is_primary: Boolean(row.is_primary),
    auto_price_sync: Boolean(row.auto_price_sync),
    api_key_configured: Boolean(row.api_key_configured)
  })));
});

router.post('/suppliers', async (req, res) => {
  const name = text(req.body.name, 120);
  const apiType = ['smm_v2', 'generic_json'].includes(req.body.api_type) ? req.body.api_type : 'smm_v2';
  const baseUrl = text(req.body.base_url, 500);
  const apiKey = String(req.body.api_key || '').trim();
  const conversionRate = number(req.body.conversion_rate, 1);
  const markupPercent = number(req.body.markup_percent, 30);
  const rateDivisor = Math.max(1, Math.round(number(req.body.rate_divisor, 1000)));
  const autoPriceSync = req.body.auto_price_sync === undefined ? true : bool(req.body.auto_price_sync);
  if (!name || !/^https?:\/\//i.test(baseUrl) || !apiKey) return res.status(400).json({ error: 'Nome, URL do servidor e API Key são obrigatórios.' });
  if (!(conversionRate > 0) || markupPercent <= -100) return res.status(400).json({ error: 'Conversão e margem do fornecedor são inválidas.' });
  const isPrimary = bool(req.body.is_primary);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (isPrimary) await conn.query('UPDATE supplier_servers SET is_primary=0');
    const [result] = await conn.query(
      `INSERT INTO supplier_servers (name,api_type,base_url,api_key_enc,services_endpoint,orders_endpoint,status_endpoint,balance_endpoint,webhook_url,conversion_rate,markup_percent,rate_divisor,auto_price_sync,active,is_primary)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        name, apiType, baseUrl, encryptSecret(apiKey),
        text(req.body.services_endpoint,255) || null,
        text(req.body.orders_endpoint,255) || null,
        text(req.body.status_endpoint,255) || null,
        text(req.body.balance_endpoint,255) || null,
        text(req.body.webhook_url,500) || null,
        conversionRate, markupPercent, rateDivisor, autoPriceSync ? 1 : 0,
        req.body.active === false ? 0 : 1, isPrimary ? 1 : 0
      ]
    );
    await conn.commit();
    await audit(req, 'supplier_created', { supplierId: result.insertId, name, apiType, conversionRate, markupPercent, rateDivisor });
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: 'Não foi possível cadastrar o servidor.' });
  } finally { conn.release(); }
});

router.patch('/suppliers/:id', async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.query('SELECT * FROM supplier_servers WHERE id=? LIMIT 1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Servidor não encontrado.' });
  const current = rows[0];
  const next = {
    name: req.body.name !== undefined ? text(req.body.name,120) : current.name,
    api_type: req.body.api_type !== undefined && ['smm_v2','generic_json'].includes(req.body.api_type) ? req.body.api_type : current.api_type,
    base_url: req.body.base_url !== undefined ? text(req.body.base_url,500) : current.base_url,
    services_endpoint: req.body.services_endpoint !== undefined ? text(req.body.services_endpoint,255) : current.services_endpoint,
    orders_endpoint: req.body.orders_endpoint !== undefined ? text(req.body.orders_endpoint,255) : current.orders_endpoint,
    status_endpoint: req.body.status_endpoint !== undefined ? text(req.body.status_endpoint,255) : current.status_endpoint,
    balance_endpoint: req.body.balance_endpoint !== undefined ? text(req.body.balance_endpoint,255) : current.balance_endpoint,
    webhook_url: req.body.webhook_url !== undefined ? text(req.body.webhook_url,500) : current.webhook_url,
    conversion_rate: req.body.conversion_rate !== undefined ? number(req.body.conversion_rate, Number(current.conversion_rate || 1)) : Number(current.conversion_rate || 1),
    markup_percent: req.body.markup_percent !== undefined ? number(req.body.markup_percent, Number(current.markup_percent || 0)) : Number(current.markup_percent || 0),
    rate_divisor: req.body.rate_divisor !== undefined ? Math.max(1, Math.round(number(req.body.rate_divisor, Number(current.rate_divisor || 1000)))) : Number(current.rate_divisor || 1000),
    auto_price_sync: req.body.auto_price_sync !== undefined ? (bool(req.body.auto_price_sync) ? 1 : 0) : current.auto_price_sync,
    active: req.body.active !== undefined ? (bool(req.body.active) ? 1 : 0) : current.active,
    is_primary: req.body.is_primary !== undefined ? (bool(req.body.is_primary) ? 1 : 0) : current.is_primary,
    api_key_enc: String(req.body.api_key || '').trim() ? encryptSecret(String(req.body.api_key).trim()) : current.api_key_enc
  };
  if (!next.name || !/^https?:\/\//i.test(next.base_url)) return res.status(400).json({ error: 'Nome e URL do servidor são obrigatórios.' });
  if (!(next.conversion_rate > 0) || next.markup_percent <= -100) return res.status(400).json({ error: 'Conversão e margem do fornecedor são inválidas.' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (next.is_primary) await conn.query('UPDATE supplier_servers SET is_primary=0 WHERE id<>?', [id]);
    await conn.query(
      `UPDATE supplier_servers SET name=?,api_type=?,base_url=?,api_key_enc=?,services_endpoint=?,orders_endpoint=?,status_endpoint=?,balance_endpoint=?,webhook_url=?,conversion_rate=?,markup_percent=?,rate_divisor=?,auto_price_sync=?,active=?,is_primary=? WHERE id=?`,
      [
        next.name,next.api_type,next.base_url,next.api_key_enc,next.services_endpoint||null,next.orders_endpoint||null,
        next.status_endpoint||null,next.balance_endpoint||null,next.webhook_url||null,next.conversion_rate,next.markup_percent,
        next.rate_divisor,next.auto_price_sync,next.active,next.is_primary,id
      ]
    );
    await conn.commit();
    await audit(req, 'supplier_updated', { supplierId: id, name: next.name, active: next.active, primary: next.is_primary, conversionRate: next.conversion_rate, markupPercent: next.markup_percent });
    res.json({ ok: true, id });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: 'Não foi possível atualizar o servidor.' });
  } finally { conn.release(); }
});

router.post('/suppliers/:id/test', async (req, res) => {
  const result = await testSupplierConnection(Number(req.params.id));
  await audit(req, 'supplier_connection_tested', { supplierId: Number(req.params.id), ok: result.ok });
  res.status(result.ok ? 200 : 502).json(result);
});

router.post('/suppliers/:id/balance', async (req, res) => {
  try {
    const result = await refreshSupplierBalance(Number(req.params.id));
    await audit(req, 'supplier_balance_updated', result);
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error.message || 'Falha ao consultar saldo do fornecedor.' });
  }
});

router.post('/suppliers/:id/reprice', async (req, res) => {
  try {
    const markup = req.body.markup_percent === undefined ? null : number(req.body.markup_percent, 0);
    const result = await repriceLinkedServices(Number(req.params.id), markup);
    await audit(req, 'supplier_prices_updated', result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Falha ao atualizar preços.' });
  }
});

router.post('/suppliers/:id/sync', async (req, res) => {
  try {
    const supplierId = Number(req.params.id);
    const sync = await syncSupplierCatalog(supplierId);
    const categorization = await categorizeSupplierCatalog(supplierId);
    let balance = null;
    try { balance = await refreshSupplierBalance(supplierId); } catch (_) {}
    await audit(req, 'supplier_catalog_synced', { supplierId, imported: sync.imported, repriced: sync.repriced, processed: categorization.processed, ai: categorization.ai });
    res.json({ ok: true, ...sync, categorization, balance });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Falha ao sincronizar catálogo.' });
  }
});

router.post('/suppliers/:id/publish', async (req, res) => {
  try {
    const markupPercent = req.body.markup_percent === undefined ? null : number(req.body.markup_percent, 0);
    const result = await publishSupplierCatalog(Number(req.params.id), { markupPercent });
    await audit(req, 'supplier_catalog_published', result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Falha ao publicar catálogo.' });
  }
});

router.get('/suppliers/:id/catalog', async (req, res) => {
  const supplierId = Number(req.params.id);
  const [categories] = await pool.query(`SELECT COALESCE(NULLIF(category,''),'Sem categoria') category,COUNT(*) total,SUM(processed_by_ai=1) processed_by_ai FROM supplier_catalog WHERE supplier_id=? AND active=1 GROUP BY category ORDER BY total DESC,category`, [supplierId]);
  const [items] = await pool.query(`SELECT id,supplier_service_code,raw_name,clean_name,category,description,min_qty,max_qty,supplier_cost,processed_by_ai,updated_at FROM supplier_catalog WHERE supplier_id=? AND active=1 ORDER BY category,clean_name,raw_name LIMIT 1000`, [supplierId]);
  res.json({ categories, items });
});

router.get('/ai-integrations', async (req, res) => {
  const [rows] = await pool.query(`SELECT id,name,provider_type,base_url,model,prompt_base,enabled,is_primary,settings_json,last_test_status,last_test_at,created_at,updated_at,(api_key_enc IS NOT NULL AND api_key_enc<>'') api_key_configured FROM ai_integrations ORDER BY is_primary DESC,enabled DESC,id DESC`);
  res.json(rows.map(row => ({ ...row, enabled: Boolean(row.enabled), is_primary: Boolean(row.is_primary), api_key_configured: Boolean(row.api_key_configured) })));
});

router.post('/ai-integrations', async (req, res) => {
  const name = text(req.body.name,120);
  const providerType = ['gemini','openai_compatible'].includes(req.body.provider_type) ? req.body.provider_type : 'gemini';
  const model = text(req.body.model,190);
  const apiKey = String(req.body.api_key || '').trim();
  if (!name || !model || !apiKey) return res.status(400).json({ error: 'Nome, modelo e API Key da IA são obrigatórios.' });
  const isPrimary = bool(req.body.is_primary);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (isPrimary) await conn.query('UPDATE ai_integrations SET is_primary=0');
    const [result] = await conn.query(
      `INSERT INTO ai_integrations (name,provider_type,base_url,api_key_enc,model,prompt_base,enabled,is_primary,settings_json) VALUES (?,?,?,?,?,?,?,?,?)`,
      [name,providerType,text(req.body.base_url,500)||null,encryptSecret(apiKey),model,String(req.body.prompt_base||'').slice(0,12000),req.body.enabled===false?0:1,isPrimary?1:0,JSON.stringify(req.body.settings||{})]
    );
    await conn.commit();
    await audit(req, 'ai_integration_created', { aiIntegrationId: result.insertId, name, providerType, model });
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: 'Não foi possível cadastrar a IA.' });
  } finally { conn.release(); }
});

router.patch('/ai-integrations/:id', async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.query('SELECT * FROM ai_integrations WHERE id=? LIMIT 1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Integração de IA não encontrada.' });
  const current = rows[0];
  const next = {
    name: req.body.name !== undefined ? text(req.body.name,120) : current.name,
    provider_type: req.body.provider_type !== undefined && ['gemini','openai_compatible'].includes(req.body.provider_type) ? req.body.provider_type : current.provider_type,
    base_url: req.body.base_url !== undefined ? text(req.body.base_url,500) : current.base_url,
    model: req.body.model !== undefined ? text(req.body.model,190) : current.model,
    prompt_base: req.body.prompt_base !== undefined ? String(req.body.prompt_base||'').slice(0,12000) : current.prompt_base,
    enabled: req.body.enabled !== undefined ? (bool(req.body.enabled)?1:0) : current.enabled,
    is_primary: req.body.is_primary !== undefined ? (bool(req.body.is_primary)?1:0) : current.is_primary,
    api_key_enc: String(req.body.api_key||'').trim() ? encryptSecret(String(req.body.api_key).trim()) : current.api_key_enc,
    settings_json: req.body.settings !== undefined ? JSON.stringify(req.body.settings||{}) : current.settings_json
  };
  if (!next.name || !next.model) return res.status(400).json({ error: 'Nome e modelo são obrigatórios.' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (next.is_primary) await conn.query('UPDATE ai_integrations SET is_primary=0 WHERE id<>?', [id]);
    await conn.query(`UPDATE ai_integrations SET name=?,provider_type=?,base_url=?,api_key_enc=?,model=?,prompt_base=?,enabled=?,is_primary=?,settings_json=? WHERE id=?`,
      [next.name,next.provider_type,next.base_url||null,next.api_key_enc,next.model,next.prompt_base,next.enabled,next.is_primary,next.settings_json,id]);
    await conn.commit();
    await audit(req, 'ai_integration_updated', { aiIntegrationId: id, name: next.name, enabled: next.enabled, primary: next.is_primary });
    res.json({ ok: true, id });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: 'Não foi possível atualizar a IA.' });
  } finally { conn.release(); }
});

router.post('/ai-integrations/:id/test', async (req, res) => {
  const result = await testAiIntegration(Number(req.params.id));
  await audit(req, 'ai_connection_tested', { aiIntegrationId: Number(req.params.id), ok: result.ok });
  res.status(result.ok ? 200 : 502).json(result);
});

module.exports = router;