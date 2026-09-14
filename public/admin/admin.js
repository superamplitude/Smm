const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  token: localStorage.getItem('smm_token') || '',
  user: null,
  suppliers: [],
  ais: []
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
  if (!response.ok) throw new Error(data.error || data.detail || 'Falha na operação');
  return data;
}

function showMessage(element, text, kind = '') {
  element.textContent = text;
  element.classList.remove('hidden', 'good', 'bad');
  if (kind) element.classList.add(kind);
}

function statusPill(status) {
  const value = String(status || 'unknown').toLowerCase();
  return `<span class="status-pill status-${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

function setLoggedIn(logged) {
  $('#loginScreen').classList.toggle('hidden', logged);
  $('#adminApp').classList.toggle('hidden', !logged);
}

async function loadSession() {
  if (!state.token) return setLoggedIn(false);
  try {
    const user = await api('/api/me');
    if (user.role !== 'admin') throw new Error('Conta sem permissão administrativa');
    state.user = user;
    $('#adminName').textContent = user.name;
    $('#adminEmail').textContent = user.email;
    setLoggedIn(true);
    await loadAll();
  } catch (error) {
    localStorage.removeItem('smm_token');
    state.token = '';
    state.user = null;
    setLoggedIn(false);
    if (error.message && error.message !== 'Falha na operação') showMessage($('#loginMessage'), error.message, 'bad');
  }
}

$('#adminLoginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: data.get('email'), password: data.get('password') })
    });
    if (result.user?.role !== 'admin') throw new Error('Esta conta não é administradora.');
    state.token = result.token;
    localStorage.setItem('smm_token', state.token);
    await loadSession();
  } catch (error) {
    showMessage($('#loginMessage'), error.message, 'bad');
  }
});

$('#logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('smm_token');
  state.token = '';
  state.user = null;
  location.reload();
});

async function loadOverview() {
  const [overview, integrations] = await Promise.all([api('/api/admin/overview'), api('/api/admin/integrations/status')]);
  $('#metricUsers').textContent = Number(overview.users?.total || 0).toLocaleString('pt-BR');
  $('#metricUsersMeta').textContent = `${Number(overview.users?.active || 0)} ativos • ${Number(overview.users?.blocked || 0)} bloqueados`;
  $('#metricOrders').textContent = Number(overview.orders?.total || 0).toLocaleString('pt-BR');
  $('#metricOrdersMeta').textContent = `${Number(overview.orders?.processing || 0)} em processamento • ${Number(overview.orders?.pending || 0)} pendentes`;
  $('#metricRevenue').textContent = money(overview.payments?.approved_value || 0);
  $('#metricRevenueMeta').textContent = `${money(overview.payments?.approved_today || 0)} hoje`;
  const suppliers = Number(integrations.suppliers?.active || 0);
  const ais = Number(integrations.ais?.active || 0);
  $('#metricIntegrations').textContent = `${suppliers} + ${ais}`;
  $('#metricIntegrationsMeta').textContent = `${suppliers} servidor(es) • ${ais} IA(s)`;
  $('#systemStatus').textContent = overview.ai_configured ? '● sistema online • IA conectada' : '● sistema online • IA em fallback';
}

async function loadSuppliers() {
  state.suppliers = await api('/api/admin/suppliers');
  const table = $('#suppliersTable');
  if (!state.suppliers.length) {
    table.innerHTML = '<div class="empty">Nenhum servidor cadastrado. Use o formulário ao lado.</div>';
  } else {
    table.innerHTML = `<table><thead><tr><th>Servidor</th><th>Tipo</th><th>Conexão</th><th>Última sync</th><th>Ações</th></tr></thead><tbody>${state.suppliers.map(item => `
      <tr>
        <td><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.base_url)}${item.is_primary ? ' • principal' : ''}</small></td>
        <td>${escapeHtml(item.api_type)}<small>chave: ${item.api_key_configured ? 'configurada' : 'ausente'}</small></td>
        <td>${statusPill(item.last_test_status || (item.active ? 'active' : 'inactive'))}</td>
        <td>${dateTime(item.last_sync_at)}</td>
        <td class="row-actions"><button class="secondary tiny" data-supplier-test="${item.id}">Testar</button><button class="primary tiny" data-supplier-sync="${item.id}">Sincronizar + IA</button><button class="secondary tiny" data-supplier-toggle="${item.id}" data-next="${item.active ? '0' : '1'}">${item.active ? 'Desativar' : 'Ativar'}</button></td>
      </tr>`).join('')}</tbody></table>`;
  }
  const options = state.suppliers.filter(item => item.active).map(item => `<option value="${item.id}">${escapeHtml(item.name)}${item.is_primary ? ' — principal' : ''}</option>`).join('');
  const currentCatalog = $('#catalogSupplierSelect').value;
  $('#catalogSupplierSelect').innerHTML = `<option value="">Selecione um servidor</option>${options}`;
  $('#serviceSupplierSelect').innerHTML = `<option value="">Sem vínculo</option>${options}`;
  if (currentCatalog && state.suppliers.some(item => String(item.id) === currentCatalog)) $('#catalogSupplierSelect').value = currentCatalog;
}

async function loadAiIntegrations() {
  state.ais = await api('/api/admin/ai-integrations');
  $('#aiIntegrationsTable').innerHTML = state.ais.length ? `<table><thead><tr><th>IA</th><th>Modelo</th><th>Status</th><th>Ações</th></tr></thead><tbody>${state.ais.map(item => `
    <tr><td><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.provider_type)}${item.is_primary ? ' • principal' : ''}</small></td><td>${escapeHtml(item.model)}<small>chave: ${item.api_key_configured ? 'configurada' : 'ausente'}</small></td><td>${statusPill(item.last_test_status || (item.enabled ? 'active' : 'inactive'))}</td><td class="row-actions"><button class="secondary tiny" data-ai-test="${item.id}">Testar</button><button class="secondary tiny" data-ai-toggle="${item.id}" data-next="${item.enabled ? '0' : '1'}">${item.enabled ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhuma IA cadastrada. Adicione Gemini ou uma API compatível.</div>';
}

async function loadCatalog(supplierId) {
  if (!supplierId) {
    $('#categoryCards').innerHTML = '<div class="empty">Selecione e sincronize um servidor.</div>';
    $('#catalogTable').innerHTML = '';
    return;
  }
  const data = await api(`/api/admin/suppliers/${supplierId}/catalog`);
  const icons = {
    instagram: '◎', facebook: 'f', tiktok: '♪', youtube: '▶', telegram: '➤', spotify: '●',
    'x / twitter': 'X', linkedin: 'in', tráfego: '↗', comentários: '☵', visualizações: '◉', seguidores: '♟', curtidas: '♥', outros: '＋'
  };
  $('#categoryCards').innerHTML = data.categories.length ? data.categories.map(category => {
    const key = String(category.category || '').toLowerCase();
    return `<article class="category-card"><span class="category-icon">${escapeHtml(icons[key] || '◆')}</span><div><strong>${escapeHtml(category.category)}</strong><small>${Number(category.total || 0)} serviços</small></div></article>`;
  }).join('') : '<div class="empty">O catálogo ainda não foi sincronizado.</div>';

  $('#catalogTable').innerHTML = data.items.length ? `<table><thead><tr><th>Código</th><th>Texto recebido</th><th>Nome limpo</th><th>Categoria</th><th>IA</th></tr></thead><tbody>${data.items.map(item => `
    <tr><td>${escapeHtml(item.supplier_service_code)}</td><td title="${escapeHtml(item.raw_name)}">${escapeHtml(short(item.raw_name,80))}</td><td>${escapeHtml(item.clean_name || item.raw_name)}</td><td>${escapeHtml(item.category || 'Sem categoria')}</td><td>${item.processed_by_ai ? statusPill('completed') : statusPill('fallback')}</td></tr>`).join('')}</tbody></table>` : '';
}

async function loadServices() {
  const rows = await api('/api/admin/services');
  $('#servicesTable').innerHTML = rows.length ? `<table><thead><tr><th>Serviço</th><th>Preço</th><th>Fornecedor</th><th>Status</th></tr></thead><tbody>${rows.map(service => `
    <tr><td><b>${escapeHtml(service.name)}</b><small>${escapeHtml(service.category)} • ${escapeHtml(service.unit_label)}</small></td><td>${money(service.price_per_unit)}</td><td>${service.supplier_name ? `${escapeHtml(service.supplier_name)}<small>código ${escapeHtml(service.supplier_service_code || service.provider_code || '—')}</small>` : '<span class="muted">sem vínculo</span>'}</td><td>${statusPill(service.active ? 'active' : 'inactive')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum serviço cadastrado.</div>';
}

async function loadOrders() {
  const rows = await api('/api/admin/orders');
  const statuses = ['pending','processing','completed','partial','cancelled','refunded'];
  $('#ordersTable').innerHTML = rows.length ? `<table><thead><tr><th>#</th><th>Cliente</th><th>Serviço</th><th>Fornecedor</th><th>Status</th><th>Ação</th></tr></thead><tbody>${rows.map(order => `
    <tr><td><b>#${order.id}</b><small>${dateTime(order.created_at)}</small></td><td>${escapeHtml(order.user_name)}<small>${escapeHtml(order.user_email)}</small></td><td>${escapeHtml(order.service)}<small>${order.quantity} unidades • ${money(order.amount)}</small></td><td>${order.provider_order_id ? `#${escapeHtml(order.provider_order_id)}` : '<span class="muted">não enviado</span>'}</td><td><select class="mini-select" data-order-status="${order.id}">${statuses.map(status => `<option value="${status}" ${status===order.status?'selected':''}>${status}</option>`).join('')}</select></td><td><button class="primary tiny" data-order-save="${order.id}">Salvar</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum pedido.</div>';
}

async function loadClients() {
  const rows = await api('/api/admin/users');
  $('#clientsTable').innerHTML = rows.length ? `<table><thead><tr><th>Cliente</th><th>Saldo</th><th>Uso</th><th>Status</th><th>Ação</th></tr></thead><tbody>${rows.map(user => `
    <tr><td><b>${escapeHtml(user.name)}</b><small>${escapeHtml(user.email)} • ${escapeHtml(user.role)}</small></td><td>${money(user.balance)}</td><td>${Number(user.orders_count||0)} pedidos<small>${Number(user.payments_count||0)} pagamentos</small></td><td>${statusPill(user.status)}</td><td>${Number(user.id)===Number(state.user?.id)?'<span class="muted">conta atual</span>':`<button class="secondary tiny" data-user-status="${user.id}" data-next="${user.status==='active'?'blocked':'active'}">${user.status==='active'?'Bloquear':'Reativar'}</button>`}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum cliente.</div>';
}

async function loadPayments() {
  const rows = await api('/api/admin/payments');
  $('#paymentsTable').innerHTML = rows.length ? `<table><thead><tr><th>#</th><th>Cliente</th><th>Gateway</th><th>Valor</th><th>Status</th><th>Data</th></tr></thead><tbody>${rows.map(p => `<tr><td>#${p.id}</td><td>${escapeHtml(p.user_name)}<small>${escapeHtml(p.user_email)}</small></td><td>${escapeHtml(p.gateway)}</td><td>${money(p.amount)}</td><td>${statusPill(p.status)}</td><td>${dateTime(p.created_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum pagamento.</div>';
}

async function loadAiDecisions() {
  const rows = await api('/api/admin/ai/decisions');
  $('#aiDecisionsTable').innerHTML = rows.length ? `<table><thead><tr><th>#</th><th>Tipo</th><th>Status</th><th>Revisão</th><th>Data</th></tr></thead><tbody>${rows.map(row => `<tr><td>#${row.id}</td><td>${escapeHtml(row.decision_type)}</td><td>${statusPill(row.status)}</td><td>${row.reviewed_at ? `Revisada<small>${dateTime(row.reviewed_at)}</small>` : `<button class="secondary tiny" data-ai-review="${row.id}">Marcar revisada</button>`}</td><td>${dateTime(row.created_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhuma decisão registrada.</div>';
}

async function loadAudit() {
  const rows = await api('/api/admin/audit');
  $('#auditTable').innerHTML = rows.length ? `<table><thead><tr><th>#</th><th>Ação</th><th>Usuário</th><th>Detalhes</th><th>Data</th></tr></thead><tbody>${rows.map(row => `<tr><td>#${row.id}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.user_name || 'Sistema')}<small>${escapeHtml(row.user_email || row.ip || '—')}</small></td><td>${escapeHtml(short(typeof row.payload==='string'?row.payload:JSON.stringify(row.payload||{}),100))}</td><td>${dateTime(row.created_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum evento.</div>';
}

async function loadAll() {
  try {
    await Promise.all([loadOverview(), loadSuppliers(), loadAiIntegrations(), loadServices(), loadOrders(), loadClients(), loadPayments(), loadAiDecisions(), loadAudit()]);
    if ($('#catalogSupplierSelect').value) await loadCatalog($('#catalogSupplierSelect').value);
  } catch (error) {
    $('#systemStatus').textContent = `● erro: ${error.message}`;
  }
}

$('#supplierForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const body = Object.fromEntries(data.entries());
    body.is_primary = data.has('is_primary');
    await api('/api/admin/suppliers', { method: 'POST', body: JSON.stringify(body) });
    showMessage($('#supplierMessage'), 'Servidor cadastrado. Agora teste e sincronize o catálogo.', 'good');
    form.reset();
    await Promise.all([loadSuppliers(), loadOverview()]);
  } catch (error) { showMessage($('#supplierMessage'), error.message, 'bad'); }
});

$('#aiIntegrationForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const body = Object.fromEntries(data.entries());
    body.enabled = data.has('enabled');
    body.is_primary = data.has('is_primary');
    await api('/api/admin/ai-integrations', { method: 'POST', body: JSON.stringify(body) });
    showMessage($('#aiIntegrationMessage'), 'IA cadastrada. Use Testar para validar a chave e o modelo.', 'good');
    form.reset();
    form.elements.name.value = 'Gemini';
    form.elements.model.value = 'gemini-2.5-flash';
    form.elements.enabled.checked = true;
    form.elements.is_primary.checked = true;
    await Promise.all([loadAiIntegrations(), loadOverview()]);
  } catch (error) { showMessage($('#aiIntegrationMessage'), error.message, 'bad'); }
});

$('#serviceForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const body = Object.fromEntries(data.entries());
    body.supplier_id = body.supplier_id ? Number(body.supplier_id) : 0;
    await api('/api/admin/services', { method: 'POST', body: JSON.stringify(body) });
    showMessage($('#serviceMessage'), 'Serviço salvo e vínculo de fornecedor configurado.', 'good');
    form.reset();
    form.elements.unit_label.value = 'unidade';
    form.elements.min_qty.value = '1';
    form.elements.max_qty.value = '1000';
    await loadServices();
  } catch (error) { showMessage($('#serviceMessage'), error.message, 'bad'); }
});

$('#suppliersTable').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.supplierTest) {
      button.disabled = true; button.textContent = 'Testando…';
      const result = await api(`/api/admin/suppliers/${button.dataset.supplierTest}/test`, { method: 'POST', body: '{}' });
      alert(`Conexão ativa. ${result.count} serviço(s) encontrado(s).`);
    } else if (button.dataset.supplierSync) {
      button.disabled = true; button.textContent = 'Sincronizando…';
      const result = await api(`/api/admin/suppliers/${button.dataset.supplierSync}/sync`, { method: 'POST', body: '{}' });
      $('#catalogSupplierSelect').value = button.dataset.supplierSync;
      await loadCatalog(button.dataset.supplierSync);
      alert(`${result.imported} serviço(s) recebidos. ${result.categorization.processed} processados pela rotina de categorização.`);
    } else if (button.dataset.supplierToggle) {
      await api(`/api/admin/suppliers/${button.dataset.supplierToggle}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.next === '1' }) });
    }
  } catch (error) { alert(error.message); }
  await Promise.all([loadSuppliers(), loadOverview()]);
});

$('#aiIntegrationsTable').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.aiTest) {
      button.disabled = true; button.textContent = 'Testando…';
      const result = await api(`/api/admin/ai-integrations/${button.dataset.aiTest}/test`, { method: 'POST', body: '{}' });
      alert(`IA conectada. Modelo: ${result.model}`);
    } else if (button.dataset.aiToggle) {
      await api(`/api/admin/ai-integrations/${button.dataset.aiToggle}`, { method: 'PATCH', body: JSON.stringify({ enabled: button.dataset.next === '1' }) });
    }
  } catch (error) { alert(error.message); }
  await Promise.all([loadAiIntegrations(), loadOverview()]);
});

$('#ordersTable').addEventListener('click', async event => {
  const button = event.target.closest('[data-order-save]');
  if (!button) return;
  try {
    const id = button.dataset.orderSave;
    const status = $(`[data-order-status="${id}"]`).value;
    await api(`/api/admin/orders/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    await Promise.all([loadOrders(), loadOverview(), loadClients(), loadAudit()]);
  } catch (error) { alert(error.message); }
});

$('#clientsTable').addEventListener('click', async event => {
  const button = event.target.closest('[data-user-status]');
  if (!button) return;
  try {
    await api(`/api/admin/users/${button.dataset.userStatus}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.next }) });
    await Promise.all([loadClients(), loadOverview(), loadAudit()]);
  } catch (error) { alert(error.message); }
});

$('#aiDecisionsTable').addEventListener('click', async event => {
  const button = event.target.closest('[data-ai-review]');
  if (!button) return;
  try {
    await api(`/api/admin/ai/decisions/${button.dataset.aiReview}/review`, { method: 'PATCH', body: '{}' });
    await Promise.all([loadAiDecisions(), loadOverview(), loadAudit()]);
  } catch (error) { alert(error.message); }
});

$('#catalogSupplierSelect').addEventListener('change', event => loadCatalog(event.target.value).catch(error => alert(error.message)));
$('#refreshAll').addEventListener('click', loadAll);
$('#syncOrdersBtn').addEventListener('click', async () => {
  try {
    const result = await api('/api/admin/orders/sync-suppliers', { method: 'POST', body: '{}' });
    alert(`${result.synced} pedido(s) sincronizado(s) com os fornecedores.`);
    await Promise.all([loadOrders(), loadOverview(), loadClients()]);
  } catch (error) { alert(error.message); }
});

async function generateBrief() {
  const card = $('#briefCard');
  card.innerHTML = '<p>Analisando operação…</p>';
  try {
    const brief = await api('/api/admin/ai/brief');
    card.innerHTML = `<div class="panel-head"><div><span class="kicker">IA OPERACIONAL</span><h3>${escapeHtml(brief.health || '—')}</h3></div>${statusPill(brief.health || 'attention')}</div><p>${escapeHtml(brief.summary || '')}</p><div class="brief-columns"><div><b>Alertas</b><p>${escapeHtml((brief.alerts || []).join(' • ') || 'Nenhum alerta.')}</p></div><div><b>Ações sugeridas</b><p>${escapeHtml((brief.recommended_actions || []).join(' • ') || 'Nenhuma ação sugerida.')}</p></div></div>`;
    await loadAiDecisions();
  } catch (error) { card.innerHTML = `<p>${escapeHtml(error.message)}</p>`; }
}

$('#briefBtn').addEventListener('click', generateBrief);

$$('.sidebar .nav-item').forEach(link => link.addEventListener('click', () => {
  $$('.sidebar .nav-item').forEach(item => item.classList.remove('active'));
  link.classList.add('active');
}));

loadSession();
