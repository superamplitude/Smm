const { pool } = require('./db');

const AI_ENABLED = String(process.env.AI_ENABLED || 'true').toLowerCase() === 'true';
let schedulerStarted = false;

async function callAI({ system, input, temperature = 0.2 }) {
  if (!AI_ENABLED) return { ok: false, reason: 'AI_DISABLED' };
  const base = (process.env.AI_API_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
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
  const system = `Você é o núcleo operacional de um painel SMM legítimo. Sua função é reduzir fraude, abuso, spam, compra de engajamento inautêntico e violações de plataforma. Nunca recomende criação de contas falsas, bots de engajamento, manipulação artificial de métricas, scraping de credenciais ou contorno de limites. Responda apenas JSON com: risk_score de 0 a 100, decision em approve|review|reject, reasons array, notes string.`;
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
  const candidates = catalog
    .filter(service => maxBudget <= 0 || Number(service.price_per_unit) <= maxBudget)
    .slice(0, 3);
  return candidates.map((service, index) => ({
    service_id: Number(service.id),
    title: service.name,
    reason: 'Serviço ativo do catálogo compatível com uma estratégia de marketing legítima.',
    priority: index === 0 ? 'high' : 'medium',
    estimated_budget: Number(service.price_per_unit)
  }));
}

async function recommendServices({ userId, goal, budget, network }) {
  const [catalog] = await pool.query(
    'SELECT id,category,name,description,unit_label,min_qty,max_qty,price_per_unit FROM services WHERE active=1 ORDER BY category,name'
  );
  const publicCatalog = catalog.map(service => ({
    id: Number(service.id),
    category: service.category,
    name: service.name,
    description: service.description,
    unit_label: service.unit_label,
    min_qty: Number(service.min_qty),
    max_qty: Number(service.max_qty),
    price_per_unit: Number(service.price_per_unit)
  }));
  const system = `Você é um consultor de marketing digital dentro do SMM SuperAmplitude. Recomende apenas serviços autênticos e compatíveis com políticas de plataformas: criação de conteúdo, gestão de anúncios, planejamento editorial, SEO social, edição, design, calendário, monitoramento, atendimento e analytics. Nunca recomende seguidores falsos, curtidas falsas, comentários artificiais ou automação enganosa. Escolha somente serviços existentes no catálogo fornecido e use o id real. Responda JSON com: recommendations array contendo service_id, title, reason, priority em high|medium|low e estimated_budget numérico; strategy string.`;
  const input = { goal, budget, network, catalog: publicCatalog };
  const result = await callAI({ system, input, temperature: 0.4 });
  const allowedIds = new Set(publicCatalog.map(service => Number(service.id)));
  let output;

  if (result.ok) {
    const rawRecommendations = Array.isArray(result.data?.recommendations) ? result.data.recommendations : [];
    const recommendations = rawRecommendations
      .map(item => ({
        service_id: Number(item.service_id),
        title: String(item.title || ''),
        reason: String(item.reason || ''),
        priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
        estimated_budget: Number(item.estimated_budget || 0)
      }))
      .filter(item => allowedIds.has(item.service_id))
      .slice(0, 6);
    output = {
      recommendations: recommendations.length ? recommendations : fallbackRecommendations(publicCatalog, budget),
      strategy: String(result.data?.strategy || 'Estratégia baseada no catálogo ativo.')
    };
  } else {
    output = {
      recommendations: fallbackRecommendations(publicCatalog, budget),
      strategy: 'IA externa indisponível; o sistema retornou opções válidas do catálogo para revisão humana.'
    };
  }

  await logDecision({ userId, type: 'service_recommendation', input, output, status: result.ok ? 'completed' : 'fallback' });
  return output;
}

async function operationalBrief() {
  const [[orders]] = await pool.query("SELECT COUNT(*) total, SUM(status='pending') pending, SUM(status='processing') processing, SUM(status='completed') completed, SUM(status='cancelled') cancelled, SUM(status IN ('pending','processing') AND created_at<DATE_SUB(NOW(),INTERVAL 24 HOUR)) stalled FROM orders");
  const [[payments]] = await pool.query("SELECT COUNT(*) total, SUM(status='approved') approved, SUM(status='failed') failed, COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0) revenue FROM payments");
  const [[wallet]] = await pool.query("SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE 0 END),0) credits, COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END),0) debits, COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) refunds FROM wallet_transactions");
  const [[users]] = await pool.query("SELECT COUNT(*) total, SUM(status='active') active, SUM(status='blocked') blocked FROM users");
  const [[ai]] = await pool.query('SELECT COUNT(*) total, SUM(reviewed_at IS NULL) unreviewed FROM ai_decisions');
  const [recent] = await pool.query('SELECT id,service_id,quantity,amount,status,created_at FROM orders ORDER BY id DESC LIMIT 20');
  const input = { orders, payments, wallet, users, ai, recent };
  const system = `Você é a IA gestora operacional de um SaaS de marketing digital. Analise indicadores, identifique gargalos, risco operacional e oportunidades. Dê prioridade a pedidos parados, falhas de pagamento e decisões de IA ainda não revisadas. Não autorize movimentações financeiras, reembolsos, bloqueios ou alterações de saldo. Responda JSON com: health em good|attention|critical, summary string, alerts array, recommended_actions array.`;
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
  const timer = setInterval(() => {
    operationalBrief().catch(error => console.error('AI scheduler:', error.message));
  }, minutes * 60 * 1000);
  timer.unref();
}

module.exports = { callAI, analyzeOrder, recommendServices, operationalBrief, startAiScheduler };