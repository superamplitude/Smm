const { pool } = require('./db');
const { decryptSecret } = require('./secrets');

const AI_ENABLED = String(process.env.AI_ENABLED || 'true').toLowerCase() === 'true';
let schedulerStarted = false;

function defaultGeminiBase() {
  return 'https://generativelanguage.googleapis.com/v1beta/openai';
}

async function getAiRuntimeConfig(id = null) {
  let row = null;
  try {
    const [rows] = id
      ? await pool.query('SELECT * FROM ai_integrations WHERE id=? LIMIT 1', [Number(id)])
      : await pool.query('SELECT * FROM ai_integrations WHERE enabled=1 ORDER BY is_primary DESC,id ASC LIMIT 1');
    row = rows[0] || null;
  } catch (_) {}

  if (row) {
    return {
      id: row.id,
      name: row.name,
      provider_type: row.provider_type,
      base_url: row.base_url || (row.provider_type === 'gemini' ? defaultGeminiBase() : ''),
      api_key: decryptSecret(row.api_key_enc || ''),
      model: row.model,
      prompt_base: row.prompt_base || '',
      enabled: Boolean(row.enabled)
    };
  }

  return {
    id: null,
    name: 'Environment AI',
    provider_type: 'openai_compatible',
    base_url: process.env.AI_API_BASE_URL || '',
    api_key: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
    prompt_base: '',
    enabled: AI_ENABLED
  };
}

async function aiConfigured() {
  const config = await getAiRuntimeConfig();
  return Boolean(AI_ENABLED && config.enabled && config.base_url && config.api_key && config.model);
}

async function callAIWithConfig(config, { system, input, temperature = 0.2 }) {
  if (!AI_ENABLED || !config?.enabled) return { ok: false, reason: 'AI_DISABLED' };
  const base = String(config.base_url || '').replace(/\/$/, '');
  const key = config.api_key;
  const model = config.model;
  if (!base || !key || !model) return { ok: false, reason: 'AI_NOT_CONFIGURED' };

  const payload = {
    model,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) }
    ],
    response_format: { type: 'json_object' }
  };

  try {
    let response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok && [400, 404, 422].includes(response.status)) {
      delete payload.response_format;
      response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (!response.ok) return { ok: false, reason: `AI_HTTP_${response.status}` };
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { text: raw }; }
    return { ok: true, data: parsed, usage: data.usage || null };
  } catch (error) {
    return { ok: false, reason: 'AI_UNAVAILABLE', error: error.message };
  }
}

async function callAI(args) {
  const config = await getAiRuntimeConfig();
  return callAIWithConfig(config, args);
}

async function testAiIntegration(id) {
  const config = await getAiRuntimeConfig(id);
  const result = await callAIWithConfig(config, {
    system: 'Responda somente JSON válido com {"ok":true,"message":"conexao ativa"}.',
    input: 'Teste de conexão da integração de IA.',
    temperature: 0
  });
  await pool.query('UPDATE ai_integrations SET last_test_status=?,last_test_at=NOW() WHERE id=?', [result.ok ? 'connected' : 'failed', Number(id)]).catch(() => {});
  return result.ok ? { ok: true, model: config.model, provider_type: config.provider_type } : { ok: false, error: result.reason || result.error || 'Falha na IA' };
}

async function logDecision({ userId = null, type, input, output, status = 'completed' }) {
  try {
    await pool.query(
      'INSERT INTO ai_decisions (user_id, decision_type, input_json, output_json, status) VALUES (?,?,?,?,?)',
      [userId, type, JSON.stringify(input || {}), JSON.stringify(output || {}), status]
    );
  } catch (error) {
    console.error('AI audit log:', error.message);
  }
}

async function analyzeOrder({ userId, service, quantity, targetUrl, amount }) {
  const system = `Você é o núcleo operacional de um painel de marketing digital. Sua função é reduzir fraude, abuso, spam e violações de plataforma. Nunca autorize ações ilegais, invasão de contas, coleta de credenciais ou contorno de limites. Responda apenas JSON com: risk_score de 0 a 100, decision em approve|review|reject, reasons array, notes string.`;
  const input = { service, quantity, targetUrl, amount };
  const result = await callAI({ system, input });
  const output = result.ok ? result.data : {
    risk_score: 50,
    decision: 'review',
    reasons: [result.reason || 'AI indisponível'],
    notes: 'Revisão humana necessária.'
  };
  if (!['approve', 'review', 'reject'].includes(output.decision)) output.decision = 'review';
  if (!Number.isFinite(Number(output.risk_score))) output.risk_score = 50;
  output.risk_score = Math.max(0, Math.min(100, Number(output.risk_score)));
  if (!Array.isArray(output.reasons)) output.reasons = [];
  await logDecision({ userId, type: 'order_risk', input, output, status: result.ok ? 'completed' : 'fallback' });
  return output;
}

function fallbackRecommendations(catalog, budget) {
  const maxBudget = Number(budget || 0);
  const candidates = catalog.filter(service => maxBudget <= 0 || Number(service.price_per_unit) <= maxBudget).slice(0, 3);
  return candidates.map((service, index) => ({
    service_id: Number(service.id),
    title: service.name,
    reason: 'Serviço ativo do catálogo compatível com o objetivo informado.',
    priority: index === 0 ? 'high' : 'medium',
    estimated_budget: Number(service.price_per_unit)
  }));
}

async function recommendServices({ userId, goal, budget, network }) {
  const [catalog] = await pool.query('SELECT id,category,name,description,unit_label,min_qty,max_qty,price_per_unit FROM services WHERE active=1 ORDER BY category,name');
  const publicCatalog = catalog.map(service => ({
    id: Number(service.id), category: service.category, name: service.name, description: service.description,
    unit_label: service.unit_label, min_qty: Number(service.min_qty), max_qty: Number(service.max_qty), price_per_unit: Number(service.price_per_unit)
  }));
  const system = `Você é um consultor de marketing digital dentro do SMM SuperAmplitude. Escolha somente serviços existentes no catálogo fornecido e use o id real. Não invente serviços. Responda JSON com: recommendations array contendo service_id, title, reason, priority em high|medium|low e estimated_budget numérico; strategy string.`;
  const input = { goal, budget, network, catalog: publicCatalog };
  const result = await callAI({ system, input, temperature: 0.4 });
  const allowedIds = new Set(publicCatalog.map(service => Number(service.id)));
  let output;
  if (result.ok) {
    const rawRecommendations = Array.isArray(result.data?.recommendations) ? result.data.recommendations : [];
    const recommendations = rawRecommendations.map(item => ({
      service_id: Number(item.service_id), title: String(item.title || ''), reason: String(item.reason || ''),
      priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
      estimated_budget: Number(item.estimated_budget || 0)
    })).filter(item => allowedIds.has(item.service_id)).slice(0, 6);
    output = { recommendations: recommendations.length ? recommendations : fallbackRecommendations(publicCatalog, budget), strategy: String(result.data?.strategy || 'Estratégia baseada no catálogo ativo.') };
  } else {
    output = { recommendations: fallbackRecommendations(publicCatalog, budget), strategy: 'IA externa indisponível; o sistema retornou opções válidas do catálogo.' };
  }
  await logDecision({ userId, type: 'service_recommendation', input, output, status: result.ok ? 'completed' : 'fallback' });
  return output;
}

function heuristicCategory(name) {
  const text = String(name || '').toLowerCase();
  const groups = [
    ['Instagram', ['instagram',' ig ','ig-','reels']], ['Facebook', ['facebook','fb ','fb-']], ['TikTok', ['tiktok','tik tok']],
    ['YouTube', ['youtube','yt ','yt-','shorts']], ['Telegram', ['telegram']], ['Spotify', ['spotify']], ['X / Twitter', ['twitter',' x ']],
    ['LinkedIn', ['linkedin']], ['Tráfego', ['traffic','tráfego','visits','website']], ['Comentários', ['comment','comentário']],
    ['Visualizações', ['views','visualiza']], ['Seguidores', ['followers','seguidores']], ['Curtidas', ['likes','curtidas']]
  ];
  for (const [category, needles] of groups) if (needles.some(needle => text.includes(needle))) return category;
  return 'Outros';
}

async function categorizeSupplierCatalog(supplierId) {
  const [rows] = await pool.query(
    'SELECT supplier_service_code,raw_name,min_qty,max_qty,supplier_cost FROM supplier_catalog WHERE supplier_id=? AND active=1 ORDER BY id LIMIT 500',
    [Number(supplierId)]
  );
  if (!rows.length) return { ok: true, processed: 0, ai: false };

  const allowedCodes = new Set(rows.map(row => String(row.supplier_service_code)));
  const system = `Você organiza textos de catálogo recebidos de um fornecedor. Não invente produtos, códigos, quantidades, preços ou recursos. Limpe apenas o nome, identifique uma categoria curta e escreva uma descrição objetiva baseada somente no texto recebido. Preserve source_code exatamente. Responda JSON com items array: source_code, clean_name, category, description.`;
  const config = await getAiRuntimeConfig();
  const prompt = config.prompt_base ? `${config.prompt_base}\n\n${system}` : system;
  let processed = [];

  for (let offset = 0; offset < rows.length; offset += 40) {
    const batch = rows.slice(offset, offset + 40).map(row => ({ source_code: String(row.supplier_service_code), text: row.raw_name }));
    const result = await callAIWithConfig(config, { system: prompt, input: { items: batch }, temperature: 0.1 });
    if (result.ok && Array.isArray(result.data?.items)) {
      processed.push(...result.data.items.filter(item => allowedCodes.has(String(item.source_code))).map(item => ({
        source_code: String(item.source_code), clean_name: String(item.clean_name || '').trim(), category: String(item.category || '').trim(), description: String(item.description || '').trim(), ai: true
      })));
    } else {
      processed.push(...batch.map(item => ({ source_code: item.source_code, clean_name: item.text, category: heuristicCategory(item.text), description: '', ai: false })));
    }
  }

  const map = new Map(processed.map(item => [item.source_code, item]));
  for (const row of rows) {
    const item = map.get(String(row.supplier_service_code)) || { clean_name: row.raw_name, category: heuristicCategory(row.raw_name), description: '', ai: false };
    await pool.query(
      'UPDATE supplier_catalog SET clean_name=?,category=?,description=?,processed_by_ai=? WHERE supplier_id=? AND supplier_service_code=?',
      [item.clean_name || row.raw_name, item.category || 'Outros', item.description || '', item.ai ? 1 : 0, Number(supplierId), String(row.supplier_service_code)]
    );
  }
  await logDecision({ type: 'supplier_catalog_categorization', input: { supplier_id: Number(supplierId), count: rows.length }, output: { processed: rows.length, categories: [...new Set(processed.map(item => item.category))] }, status: processed.some(item => item.ai) ? 'completed' : 'fallback' });
  return { ok: true, processed: rows.length, ai: processed.some(item => item.ai) };
}

async function operationalBrief() {
  const [[orders]] = await pool.query("SELECT COUNT(*) total, SUM(status='pending') pending, SUM(status='processing') processing, SUM(status='completed') completed, SUM(status='cancelled') cancelled, SUM(status IN ('pending','processing') AND created_at<DATE_SUB(NOW(),INTERVAL 24 HOUR)) stalled FROM orders");
  const [[payments]] = await pool.query("SELECT COUNT(*) total, SUM(status='approved') approved, SUM(status='failed') failed, COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0) revenue FROM payments");
  const [[wallet]] = await pool.query("SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE 0 END),0) credits, COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END),0) debits, COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) refunds FROM wallet_transactions");
  const [[users]] = await pool.query("SELECT COUNT(*) total, SUM(status='active') active, SUM(status='blocked') blocked FROM users");
  const [[ai]] = await pool.query('SELECT COUNT(*) total, SUM(reviewed_at IS NULL) unreviewed FROM ai_decisions');
  const [recent] = await pool.query('SELECT id,service_id,quantity,amount,status,created_at FROM orders ORDER BY id DESC LIMIT 20');
  const input = { orders, payments, wallet, users, ai, recent };
  const system = `Você é a IA gestora operacional de um SaaS de marketing digital. Analise indicadores, identifique gargalos, risco operacional e oportunidades. Não autorize movimentações financeiras, reembolsos, bloqueios ou alterações de saldo. Responda JSON com: health em good|attention|critical, summary string, alerts array, recommended_actions array.`;
  const result = await callAI({ system, input });
  const output = result.ok ? result.data : {
    health: Number(orders.stalled || 0) > 0 || Number(payments.failed || 0) > 0 ? 'attention' : 'good',
    summary: 'IA externa indisponível; o painel continua usando indicadores determinísticos e revisão humana.',
    alerts: Number(orders.stalled || 0) > 0 ? [`${orders.stalled} pedido(s) há mais de 24h em aberto.`] : [],
    recommended_actions: Number(ai.unreviewed || 0) > 0 ? [`Revisar ${ai.unreviewed} decisão(ões) de IA pendente(s).`] : []
  };
  await logDecision({ type: 'operational_brief', input, output, status: result.ok ? 'completed' : 'fallback' });
  return output;
}

function startAiScheduler() {
  if (schedulerStarted || !AI_ENABLED) return;
  schedulerStarted = true;
  const minutes = Math.max(15, Number(process.env.AI_OPS_INTERVAL_MINUTES || 60));
  const timer = setInterval(() => operationalBrief().catch(error => console.error('AI scheduler:', error.message)), minutes * 60 * 1000);
  timer.unref();
}

module.exports = {
  callAI,
  analyzeOrder,
  recommendServices,
  operationalBrief,
  categorizeSupplierCatalog,
  testAiIntegration,
  getAiRuntimeConfig,
  aiConfigured,
  startAiScheduler
};
