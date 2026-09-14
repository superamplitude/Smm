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
  await logDecision({ userId, type: 'order_risk', input, output, status: result.ok ? 'completed' : 'fallback' });
  return output;
}

async function recommendServices({ userId, goal, budget, network }) {
  const system = `Você é um consultor de marketing digital. Recomende apenas serviços autênticos e compatíveis com políticas de plataformas: criação de conteúdo, gestão de anúncios, planejamento editorial, SEO social, edição, design, calendário, monitoramento, atendimento e analytics. Nunca recomende seguidores falsos, curtidas falsas, comentários artificiais ou automação enganosa. Responda JSON com: recommendations array contendo title, reason, priority e estimated_budget; strategy string.`;
  const input = { goal, budget, network };
  const result = await callAI({ system, input, temperature: 0.4 });
  const output = result.ok ? result.data : { recommendations: [], strategy: 'IA indisponível; análise manual necessária.' };
  await logDecision({ userId, type: 'service_recommendation', input, output, status: result.ok ? 'completed' : 'fallback' });
  return output;
}

async function operationalBrief() {
  const [[orders]] = await pool.query("SELECT COUNT(*) total, SUM(status='pending') pending, SUM(status='processing') processing, SUM(status='completed') completed, SUM(status='cancelled') cancelled FROM orders");
  const [[payments]] = await pool.query("SELECT COUNT(*) total, SUM(status='approved') approved, SUM(status='failed') failed, COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0) revenue FROM payments");
  const [[wallet]] = await pool.query("SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE 0 END),0) credits, COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END),0) debits FROM wallet_transactions");
  const [recent] = await pool.query('SELECT id,service_id,quantity,amount,status,created_at FROM orders ORDER BY id DESC LIMIT 20');
  const input = { orders, payments, wallet, recent };
  const system = `Você é a IA gestora operacional de um SaaS de marketing digital. Analise indicadores, identifique gargalos, risco operacional e oportunidades. Não autorize movimentações financeiras, reembolsos, bloqueios ou alterações de saldo. Responda JSON com: health em good|attention|critical, summary string, alerts array, recommended_actions array.`;
  const result = await callAI({ system, input });
  const output = result.ok ? result.data : { health: 'attention', summary: 'IA indisponível; operação continua sob regras determinísticas.', alerts: [], recommended_actions: [] };
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
