const express = require('express');
const { pool } = require('./db');
const { authRequired, adminRequired } = require('./auth');
const { encryptSecret } = require('./secrets');
const { syncSupplierCatalog, testSupplierConnection } = require('./suppliers');
const { categorizeSupplierCatalog, testAiIntegration, aiConfigured } = require('./ai');

const router = express.Router();
router.use(authRequired, adminRequired);

const bool = value => value === true || value === 1 || value === '1' || value === 'true';
const text = (value, max = 500) => String(value || '').trim().slice(0, max);

async function audit(req, action, payload = {}) {
  await pool.query(
    'INSERT INTO audit_logs (user_id,action,payload,ip) VALUES (?,?,?,?)',
    [req.user?.id || null, action, JSON.stringify(payload), req.ip]
  ).catch(() => {});
}

router.get('/integrations/status', async (req, res) => {
  const [[suppliers]] = await pool.query('SELECT COUNT(*) total,SUM(active=1) active,SUM(active=1 AND is_primary=1) primary_count FROM supplier_servers');
  const [[ais]] = await pool.query('SELECT COUNT(*) total,SUM(enabled=1) active,SUM(enabled=1 AND is_primary=1) primary_count FROM ai_integrations');
  res.json({ suppliers, ais, ai_configured: await aiConfigured() });
});

router.get('/suppliers', async (req, res) => {
  const [rows] = await pool.query(`SELECT id,name,api_type,base_url,services_endpoint,orders_endpoint,status_endpoint,webhook_url,active,is_primary,last_test_status,last_test_at,last_sync_at,created_at,updated_at,(api_key_enc IS NOT NULL AND api_key_enc<>'') api_key_configured FROM supplier_servers ORDER BY is_primary DESC,active DESC,id DESC`);
  res.json(rows.map(row => ({ ...row, active: Boolean(row.active), is_primary: Boolean(row.is_primary), api_key_configured: Boolean(row.api_key_configured) })));
});

router.post('/suppliers', async (req, res) => {
  const name = text(req.body.name, 120);
  const apiType = ['smm_v2', 'generic_json'].includes(req.body.api_type) ? req.body.api_type : 'smm_v2';
  const baseUrl = text(req.body.base_url, 500);
  const apiKey = String(req.body.api_key || '').trim();
  if (!name || !/^https?:\/\//i.test(baseUrl) || !apiKey) return res.status(400).json({ error: 'Nome, URL do servidor e API Key são obrigatórios.' });
  const isPrimary = bool(req.body.is_primary);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (isPrimary) await conn.query('UPDATE supplier_servers SET is_primary=0');
    const [result] = await conn.query(
      `INSERT INTO supplier_servers (name,api_type,base_url,api_key_enc,services_endpoint,orders_endpoint,status_endpoint,webhook_url,active,is_primary)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [name, apiType, baseUrl, encryptSecret(apiKey), text(req.body.services_endpoint,255) || null, text(req.body.orders_endpoint,255) || null, text(req.body.status_endpoint,255) || null, text(req.body.webhook_url,500) || null, req.body.active === false ? 0 : 1, isPrimary ? 1 : 0]
    );
    await conn.commit();
    await audit(req, 'supplier_created', { supplierId: result.insertId, name, apiType });
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
    webhook_url: req.body.webhook_url !== undefined ? text(req.body.webhook_url,500) : current.webhook_url,
    active: req.body.active !== undefined ? (bool(req.body.active) ? 1 : 0) : current.active,
    is_primary: req.body.is_primary !== undefined ? (bool(req.body.is_primary) ? 1 : 0) : current.is_primary,
    api_key_enc: String(req.body.api_key || '').trim() ? encryptSecret(String(req.body.api_key).trim()) : current.api_key_enc
  };
  if (!next.name || !/^https?:\/\//i.test(next.base_url)) return res.status(400).json({ error: 'Nome e URL do servidor são obrigatórios.' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (next.is_primary) await conn.query('UPDATE supplier_servers SET is_primary=0 WHERE id<>?', [id]);
    await conn.query(`UPDATE supplier_servers SET name=?,api_type=?,base_url=?,api_key_enc=?,services_endpoint=?,orders_endpoint=?,status_endpoint=?,webhook_url=?,active=?,is_primary=? WHERE id=?`,
      [next.name,next.api_type,next.base_url,next.api_key_enc,next.services_endpoint||null,next.orders_endpoint||null,next.status_endpoint||null,next.webhook_url||null,next.active,next.is_primary,id]);
    await conn.commit();
    await audit(req, 'supplier_updated', { supplierId: id, name: next.name, active: next.active, primary: next.is_primary });
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

router.post('/suppliers/:id/sync', async (req, res) => {
  try {
    const supplierId = Number(req.params.id);
    const sync = await syncSupplierCatalog(supplierId);
    const categorization = await categorizeSupplierCatalog(supplierId);
    await audit(req, 'supplier_catalog_synced', { supplierId, imported: sync.imported, processed: categorization.processed, ai: categorization.ai });
    res.json({ ok: true, ...sync, categorization });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Falha ao sincronizar catálogo.' });
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
