const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  token: localStorage.getItem('smm_token') || '',
  user: null,
  services: []
};

const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
const dateTime = value => value ? new Date(value).toLocaleString('pt-BR') : '—';
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const short = (value, max = 90) => String(value || '').length > max ? `${String(value).slice(0, max - 1)}…` : String(value || '');

async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Falha na operação');
  return data;
}

function show(element, text, kind = '') {
  element.textContent = text;
  element.classList.remove('hidden', 'good', 'bad');
  if (kind) element.classList.add(kind);
}

function hide(element) {
  element.classList.add('hidden');
}

function jsonValue(value) {
  if (value && typeof value === 'object') return value;
  if (!value) return {};
  try { return JSON.parse(value); } catch { return { text: String(value) }; }
}

function statusPill(status) {
  const normalized = String(status || 'unknown').toLowerCase();
  return `<span class="status-pill status-${escapeHtml(normalized)}">${escapeHtml(normalized)}</span>`;
}

async function loadServices() {
  try {
    state.services = await api('/api/services');
    const grid = $('#servicesGrid');
    const select = $('#serviceSelect');
    if (!state.services.length) {
      grid.innerHTML = '<div class="empty">Nenhum serviço cadastrado ainda.</div>';
      select.innerHTML = '<option value="">Nenhum serviço disponível</option>';
      return;
    }
    grid.innerHTML = state.services.map(service => `
      <article class="card">
        <span class="category">${escapeHtml(service.category)}</span>
        <h3>${escapeHtml(service.name)}</h3>
        <p>${escapeHtml(service.description || 'Serviço gerenciado pelo painel SMM.')}</p>
        <div class="price">${money(service.price_per_unit)} / ${escapeHtml(service.unit_label || 'unidade')}</div>
      </article>
    `).join('');
    select.innerHTML = '<option value="">Selecione…</option>' + state.services.map(service =>
      `<option value="${service.id}">${escapeHtml(service.category)} — ${escapeHtml(service.name)} (${money(service.price_per_unit)}/${escapeHtml(service.unit_label)})</option>`
    ).join('');
    syncQuantityLimits();
  } catch (error) {
    $('#servicesGrid').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function syncQuantityLimits() {
  const id = Number($('#serviceSelect').value);
  const service = state.services.find(item => Number(item.id) === id);
  const input = $('#orderForm [name="quantity"]');
  if (!service) return;
  input.min = service.min_qty;
  input.max = service.max_qty;
  if (!input.value || Number(input.value) < service.min_qty) input.value = service.min_qty;
}

function setAuthMode(mode) {
  const register = mode === 'register';
  $('#authTitle').textContent = register ? 'Criar conta' : 'Entrar';
  $('#nameField').classList.toggle('hidden', !register);
  $('#loginTab').classList.toggle('active', !register);
  $('#registerTab').classList.toggle('active', register);
  $('#authForm').dataset.mode = mode;
  hide($('#authResult'));
}

function openAuth(mode = 'login') {
  setAuthMode(mode);
  $('#authDialog').showModal();
}

async function loadMe() {
  if (!state.token) {
    renderSession();
    return;
  }
  try {
    state.user = await api('/api/me');
    renderSession();
    await Promise.all([loadOrders(), loadWallet()]);
    if (state.user.role === 'admin') await loadAdmin();
  } catch {
    localStorage.removeItem('smm_token');
    state.token = '';
    state.user = null;
    renderSession();
  }
}

function renderSession() {
  const logged = Boolean(state.user);
  $('#guestPanel').classList.toggle('hidden', logged);
  $('#userPanel').classList.toggle('hidden', !logged);
  $('#authBtn').textContent = logged ? 'Sair' : 'Entrar';
  $('#userBadge').textContent = logged ? state.user.email : 'Não autenticado';
  if (!logged) return;
  $('#balance').textContent = money(state.user.balance);
  $('#accountName').textContent = state.user.name;
  $('#accountRole').textContent = state.user.role === 'admin' ? 'Administrador' : 'Cliente';
  $('#adminPanel').classList.toggle('hidden', state.user.role !== 'admin');
}

async function loadOrders() {
  if (!state.user) return;
  try {
    const rows = await api('/api/orders');
    $('#ordersTable').innerHTML = rows.length ? `
      <div class="table-scroll"><table><thead><tr><th>#</th><th>Serviço</th><th>Qtd.</th><th>Valor</th><th>Status</th><th>Data</th></tr></thead><tbody>
      ${rows.map(order => `<tr><td>${order.id}</td><td>${escapeHtml(order.service)}</td><td>${order.quantity}</td><td>${money(order.amount)}</td><td>${statusPill(order.status)}</td><td>${dateTime(order.created_at)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Você ainda não possui pedidos.</div>';
  } catch (error) {
    $('#ordersTable').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadWallet() {
  if (!state.user) return;
  try {
    const rows = await api('/api/wallet');
    $('#walletTable').innerHTML = rows.length ? `
      <div class="table-scroll"><table><thead><tr><th>#</th><th>Tipo</th><th>Descrição</th><th>Valor</th><th>Data</th></tr></thead><tbody>
      ${rows.map(item => `<tr><td>${item.id}</td><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.description || '—')}</td><td>${money(item.amount)}</td><td>${dateTime(item.created_at)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Nenhuma movimentação na carteira.</div>';
  } catch (error) {
    $('#walletTable').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadAdminOverview() {
  const data = await api('/api/admin/overview');
  $('#adminUsers').textContent = Number(data.users?.total || 0).toLocaleString('pt-BR');
  $('#adminUsersMeta').textContent = `${Number(data.users?.active || 0)} ativos • ${Number(data.users?.blocked || 0)} bloqueados`;
  $('#adminOrders').textContent = Number(data.orders?.total || 0).toLocaleString('pt-BR');
  $('#adminOrdersMeta').textContent = `${Number(data.orders?.pending || 0)} pendentes • ${Number(data.orders?.processing || 0)} em execução`;
  $('#adminRevenue').textContent = money(data.payments?.approved_value || 0);
  $('#adminRevenueMeta').textContent = `${money(data.payments?.approved_today || 0)} hoje`;
  $('#adminAi').textContent = data.ai_configured ? 'Conectada' : 'Fallback';
  $('#adminAiMeta').textContent = `${Number(data.ai?.unreviewed || 0)} decisões sem revisão`;
}

async function loadAdminOrders() {
  try {
    const rows = await api('/api/admin/orders');
    const options = ['pending', 'processing', 'completed', 'partial', 'cancelled', 'refunded'];
    $('#adminOrdersTable').innerHTML = rows.length ? `<table><thead><tr><th>#</th><th>Cliente</th><th>Serviço</th><th>Valor</th><th>Status</th><th>Ação</th></tr></thead><tbody>${rows.map(order => `
      <tr>
        <td><b>#${order.id}</b><small>${dateTime(order.created_at)}</small></td>
        <td>${escapeHtml(order.user_name)}<small>${escapeHtml(order.user_email)}</small></td>
        <td>${escapeHtml(order.service)}<small>${order.quantity} × ${escapeHtml(order.category)}</small></td>
        <td>${money(order.amount)}${order.funds_refunded ? '<small>valor devolvido</small>' : ''}</td>
        <td><select class="mini-select" data-order-status="${order.id}">${options.map(status => `<option value="${status}" ${status === order.status ? 'selected' : ''}>${status}</option>`).join('')}</select></td>
        <td><button class="btn btn-small" data-order-save="${order.id}">Salvar</button></td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum pedido encontrado.</div>';
  } catch (error) {
    $('#adminOrdersTable').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadAdminUsers() {
  try {
    const rows = await api('/api/admin/users');
    $('#adminUsersTable').innerHTML = rows.length ? `<table><thead><tr><th>Cliente</th><th>Saldo</th><th>Uso</th><th>Status</th><th>Ação</th></tr></thead><tbody>${rows.map(user => `
      <tr>
        <td><b>${escapeHtml(user.name)}</b><small>#${user.id} • ${escapeHtml(user.email)} • ${escapeHtml(user.role)}</small></td>
        <td>${money(user.balance)}</td>
        <td>${Number(user.orders_count || 0)} pedidos<small>${Number(user.payments_count || 0)} pagamentos</small></td>
        <td>${statusPill(user.status)}</td>
        <td>${Number(user.id) === Number(state.user.id) ? '<span class="muted">conta atual</span>' : `<button class="btn btn-ghost btn-small" data-user-status="${user.id}" data-next-status="${user.status === 'active' ? 'blocked' : 'active'}">${user.status === 'active' ? 'Bloquear' : 'Reativar'}</button>`}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum cliente encontrado.</div>';
  } catch (error) {
    $('#adminUsersTable').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadAdminPayments() {
  try {
    const rows = await api('/api/admin/payments');
    $('#adminPaymentsTable').innerHTML = rows.length ? `<table><thead><tr><th>#</th><th>Cliente</th><th>Gateway</th><th>Valor</th><th>Status</th><th>Data</th></tr></thead><tbody>${rows.map(payment => `
      <tr><td>#${payment.id}</td><td>${escapeHtml(payment.user_name)}<small>${escapeHtml(payment.user_email)}</small></td><td>${escapeHtml(payment.gateway)}</td><td>${money(payment.amount)}</td><td>${statusPill(payment.status)}</td><td>${dateTime(payment.created_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum pagamento registrado.</div>';
  } catch (error) {
    $('#adminPaymentsTable').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function decisionSummary(row) {
  const output = jsonValue(row.output_json);
  if (output.decision) return `${output.decision} • risco ${Number(output.risk_score || 0)}`;
  if (output.health) return `${output.health} • ${short(output.summary || '', 55)}`;
  if (output.strategy) return short(output.strategy, 70);
  return short(output.text || JSON.stringify(output), 70);
}

async function loadAdminAi() {
  try {
    const rows = await api('/api/admin/ai/decisions');
    $('#adminAiTable').innerHTML = rows.length ? `<table><thead><tr><th>#</th><th>Tipo</th><th>Resultado</th><th>Execução</th><th>Revisão</th></tr></thead><tbody>${rows.map(row => `
      <tr><td>#${row.id}<small>${dateTime(row.created_at)}</small></td><td>${escapeHtml(row.decision_type)}</td><td>${escapeHtml(decisionSummary(row))}</td><td>${statusPill(row.status)}</td><td>${row.reviewed_at ? `<span class="status-pill status-active">revisada</span><small>${dateTime(row.reviewed_at)}</small>` : `<button class="btn btn-ghost btn-small" data-ai-review="${row.id}">Marcar revisada</button>`}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhuma decisão de IA registrada.</div>';
  } catch (error) {
    $('#adminAiTable').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadAdminServices() {
  try {
    const rows = await api('/api/admin/services');
    $('#adminServicesTable').innerHTML = rows.length ? `<table><thead><tr><th>Serviço</th><th>Preço</th><th>Faixa</th><th>Status</th><th>Ação</th></tr></thead><tbody>${rows.map(service => `
      <tr><td><b>${escapeHtml(service.name)}</b><small>${escapeHtml(service.category)} • ${escapeHtml(service.unit_label)}</small></td><td>${money(service.price_per_unit)}</td><td>${service.min_qty}–${service.max_qty}</td><td>${statusPill(service.active ? 'active' : 'inactive')}</td><td><button class="btn btn-ghost btn-small" data-service-toggle="${service.id}" data-next-active="${service.active ? '0' : '1'}">${service.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum serviço cadastrado.</div>';
  } catch (error) {
    $('#adminServicesTable').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadAdminAudit() {
  try {
    const rows = await api('/api/admin/audit');
    $('#adminAuditTable').innerHTML = rows.length ? `<table><thead><tr><th>#</th><th>Ação</th><th>Usuário</th><th>Detalhes</th><th>Data</th></tr></thead><tbody>${rows.map(row => {
      const payload = jsonValue(row.payload);
      return `<tr><td>#${row.id}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.user_name || 'Sistema')}<small>${escapeHtml(row.user_email || row.ip || '—')}</small></td><td>${escapeHtml(short(JSON.stringify(payload), 100))}</td><td>${dateTime(row.created_at)}</td></tr>`;
    }).join('')}</tbody></table>` : '<div class="empty">Nenhum evento de auditoria.</div>';
  } catch (error) {
    $('#adminAuditTable').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadAdmin() {
  if (state.user?.role !== 'admin') return;
  await Promise.all([
    loadAdminOverview(),
    loadAdminOrders(),
    loadAdminUsers(),
    loadAdminPayments(),
    loadAdminAi(),
    loadAdminServices(),
    loadAdminAudit()
  ]);
}

$$('[data-open-auth]').forEach(button => button.addEventListener('click', () => openAuth(button.dataset.openAuth)));

$('#authBtn').addEventListener('click', () => {
  if (state.user) {
    state.token = '';
    state.user = null;
    localStorage.removeItem('smm_token');
    renderSession();
  } else {
    openAuth('login');
  }
});

$('#loginTab').addEventListener('click', event => { event.preventDefault(); setAuthMode('login'); });
$('#registerTab').addEventListener('click', event => { event.preventDefault(); setAuthMode('register'); });

$('#authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const mode = form.dataset.mode || 'login';
  const body = { email: data.get('email'), password: data.get('password') };
  if (mode === 'register') body.name = data.get('name');
  try {
    const result = await api(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(body) });
    state.token = result.token;
    localStorage.setItem('smm_token', state.token);
    state.user = result.user;
    $('#authDialog').close();
    renderSession();
    await loadMe();
  } catch (error) {
    show($('#authResult'), error.message, 'bad');
  }
});

$('#aiForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.user) return openAuth('login');
  const data = new FormData(event.currentTarget);
  const output = $('#aiResult');
  show(output, 'Analisando…');
  try {
    const result = await api('/api/ai/recommend', {
      method: 'POST',
      body: JSON.stringify({ network: data.get('network'), budget: Number(data.get('budget') || 0), goal: data.get('goal') })
    });
    show(output, formatAI(result), 'good');
  } catch (error) {
    show(output, error.message, 'bad');
  }
});

function formatAI(data) {
  const lines = [];
  if (data.strategy) lines.push(`Estratégia: ${data.strategy}`);
  if (Array.isArray(data.recommendations)) {
    data.recommendations.forEach((item, index) => lines.push(`${index + 1}. ${item.title || 'Recomendação'} — ${item.reason || ''}${item.estimated_budget ? ` | referência: ${money(item.estimated_budget)}` : ''}`));
  }
  return lines.join('\n') || 'A IA retornou a análise.';
}

$('#serviceSelect').addEventListener('change', syncQuantityLimits);

$('#orderForm').addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const output = $('#orderResult');
  show(output, 'Enviando para análise da IA…');
  try {
    const result = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ service_id: Number(data.get('service_id')), quantity: Number(data.get('quantity')), target_url: data.get('target_url') })
    });
    show(output, `Pedido #${result.id} criado. Valor: ${money(result.amount)}. Decisão IA: ${result.ai?.decision || 'review'}.`, 'good');
    await loadMe();
  } catch (error) {
    show(output, error.message, 'bad');
  }
});

$('#paymentForm').addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const output = $('#paymentResult');
  show(output, 'Abrindo checkout…');
  try {
    const result = await api('/api/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ amount: Number(data.get('amount')), gateway: data.get('gateway') })
    });
    show(output, 'Checkout criado. Você será redirecionado.', 'good');
    if (result.checkout_url) window.location.href = result.checkout_url;
  } catch (error) {
    show(output, error.message, 'bad');
  }
});

$('#serviceForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    await api('/api/admin/services', { method: 'POST', body: JSON.stringify(Object.fromEntries(data.entries())) });
    form.reset();
    form.elements.unit_label.value = 'unidade';
    form.elements.min_qty.value = '1';
    form.elements.max_qty.value = '1000';
    await Promise.all([loadServices(), loadAdminServices(), loadAdminOverview(), loadAdminAudit()]);
    alert('Serviço cadastrado.');
  } catch (error) {
    alert(error.message);
  }
});

$('#loadAiBrief').addEventListener('click', async () => {
  const output = $('#aiBrief');
  output.textContent = 'A IA está analisando a operação…';
  try {
    const brief = await api('/api/admin/ai/brief');
    output.innerHTML = `<div class="brief-head"><h3>Saúde: ${escapeHtml(brief.health || '—')}</h3>${statusPill(brief.health || 'attention')}</div><p>${escapeHtml(brief.summary || '')}</p><div class="brief-columns"><div><h4>Alertas</h4><p>${escapeHtml((brief.alerts || []).join(' • ') || 'Nenhum alerta.')}</p></div><div><h4>Ações recomendadas</h4><p>${escapeHtml((brief.recommended_actions || []).join(' • ') || 'Nenhuma ação.')}</p></div></div>`;
    await Promise.all([loadAdminAi(), loadAdminOverview()]);
  } catch (error) {
    output.textContent = error.message;
  }
});

$('#adminPanel').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.orderSave) {
      const id = button.dataset.orderSave;
      const select = $(`[data-order-status="${id}"]`);
      await api(`/api/admin/orders/${id}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) });
      await Promise.all([loadAdminOrders(), loadAdminOverview(), loadAdminUsers(), loadAdminAudit()]);
      await loadMe();
      return;
    }
    if (button.dataset.userStatus) {
      await api(`/api/admin/users/${button.dataset.userStatus}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.nextStatus }) });
      await Promise.all([loadAdminUsers(), loadAdminOverview(), loadAdminAudit()]);
      return;
    }
    if (button.dataset.aiReview) {
      await api(`/api/admin/ai/decisions/${button.dataset.aiReview}/review`, { method: 'PATCH', body: '{}' });
      await Promise.all([loadAdminAi(), loadAdminOverview(), loadAdminAudit()]);
      return;
    }
    if (button.dataset.serviceToggle) {
      await api(`/api/admin/services/${button.dataset.serviceToggle}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.nextActive === '1' }) });
      await Promise.all([loadAdminServices(), loadServices(), loadAdminAudit()]);
    }
  } catch (error) {
    alert(error.message);
  }
});

$('#reloadServices').addEventListener('click', loadServices);
$('#refreshOrders').addEventListener('click', loadOrders);
$('#refreshWallet').addEventListener('click', loadWallet);
$('#refreshAdmin').addEventListener('click', loadAdmin);

const paymentState = new URLSearchParams(location.search).get('payment');
if (paymentState) {
  const messages = {
    success: 'Pagamento confirmado. O saldo será atualizado automaticamente.',
    pending: 'Pagamento pendente de confirmação.',
    failure: 'Não foi possível confirmar o pagamento.',
    cancelled: 'Pagamento cancelado.'
  };
  setTimeout(() => alert(messages[paymentState] || 'Retorno de pagamento recebido.'), 250);
  history.replaceState({}, '', location.pathname + location.hash);
}

loadServices();
loadMe();