const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  token: localStorage.getItem('smm_token') || '',
  user: null,
  dashboard: null,
  services: [],
  orders: [],
  payments: [],
  wallet: [],
  orderStatus: 'all'
};

const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
const number = value => Number(value || 0).toLocaleString('pt-BR');
const dateTime = value => value ? new Date(value).toLocaleString('pt-BR') : '—';
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const short = (value, max = 58) => String(value || '').length > max ? `${String(value).slice(0, max - 1)}…` : String(value || '');

async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) {
    localStorage.removeItem('smm_token');
    location.replace('/?login=1');
    throw new Error('Sessão expirada.');
  }
  if (!response.ok) throw new Error(data.error || data.detail || 'Falha na operação.');
  return data;
}

function statusPill(status) {
  const value = String(status || 'pending').toLowerCase();
  const labels = { pending: 'Aguardando', processing: 'Processando', completed: 'Concluído', partial: 'Parcial', cancelled: 'Cancelado', refunded: 'Reembolsado', approved: 'Aprovado', created: 'Criado', failed: 'Falhou' };
  return `<span class="status status-${escapeHtml(value)}">${escapeHtml(labels[value] || value)}</span>`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function showMessage(element, message, kind = '') {
  element.textContent = message;
  element.classList.remove('hidden', 'good', 'bad');
  if (kind) element.classList.add(kind);
}

function iconFor(category) {
  const key = String(category || '').toLowerCase();
  if (key.includes('instagram')) return '◎';
  if (key.includes('facebook')) return 'f';
  if (key.includes('tiktok')) return '♪';
  if (key.includes('youtube')) return '▶';
  if (key.includes('telegram')) return '➤';
  if (key.includes('spotify')) return '●';
  return '◆';
}

function showPage(hash = location.hash) {
  const requested = String(hash || '#dashboard').replace('#', '');
  const section = document.getElementById(requested) || $('#dashboard');
  $$('.panel-page').forEach(item => item.classList.toggle('active-page', item === section));
  $$('[data-page-link]').forEach(link => link.classList.toggle('active', link.dataset.pageLink === section.id));
  $('#userNav').classList.remove('open');
  document.title = `${section.dataset.title || 'Painel'} — SMM SuperAmplitude`;
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (section.id === 'orders') renderOrders();
}

async function loadMe() {
  if (!state.token) return location.replace('/?login=1');
  state.user = await api('/api/me');
  $('#headerBalance').textContent = money(state.user.balance);
  $('#headerName').textContent = state.user.name;
  $('#headerEmail').textContent = state.user.email;
  $('#userAvatar').textContent = String(state.user.name || 'U').trim().charAt(0).toUpperCase();
  $('#adminLink').classList.toggle('hidden', state.user.role !== 'admin');
}

async function loadDashboard() {
  state.dashboard = await api('/api/dashboard');
  const data = state.dashboard;
  $('#metricBalance').textContent = money(data.account.balance);
  $('#headerBalance').textContent = money(data.account.balance);
  $('#metricDeposits').textContent = money(data.deposits.last_7_days);
  $('#metricDepositsMeta').textContent = `${money(data.deposits.year_total)} no ano`;
  $('#metricOrders').textContent = number(data.orders.total);
  $('#metricOrdersMeta').textContent = `${number(Number(data.orders.pending || 0) + Number(data.orders.processing || 0))} em andamento`;
}

async function loadServices() {
  state.services = await api('/api/services');
  const categories = [...new Set(state.services.map(service => service.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  $('#categorySelect').innerHTML = '<option value="">Selecione a categoria</option>' + categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  renderServiceOptions();
}

function renderServiceOptions() {
  const category = $('#categorySelect').value;
  const list = category ? state.services.filter(item => item.category === category) : state.services;
  $('#serviceSelect').innerHTML = '<option value="">Selecione o serviço</option>' + list.map(service => `<option value="${service.id}">${escapeHtml(service.name)} — ${money(service.price_per_unit)}/${escapeHtml(service.unit_label || 'unidade')}</option>`).join('');
  renderServiceDescription();
}

function selectedService() {
  return state.services.find(item => Number(item.id) === Number($('#serviceSelect').value));
}

function updateEstimate() {
  const service = selectedService();
  const quantity = Number($('#quantityInput').value || 0);
  $('#estimatedPrice').value = service ? money(Number(service.price_per_unit) * quantity) : money(0);
}

function renderServiceDescription() {
  const service = selectedService();
  if (!service) {
    $('#serviceDescription').className = 'service-empty';
    $('#serviceDescription').innerHTML = '<div class="big-icon">▤</div><p>Selecione um serviço para visualizar detalhes, limites e preço.</p>';
    updateEstimate();
    return;
  }
  $('#quantityInput').min = service.min_qty;
  $('#quantityInput').max = service.max_qty;
  if (!$('#quantityInput').value || Number($('#quantityInput').value) < Number(service.min_qty)) $('#quantityInput').value = service.min_qty;
  $('#serviceDescription').className = 'service-details';
  $('#serviceDescription').innerHTML = `
    <div class="service-title"><div class="big-icon">${escapeHtml(iconFor(service.category))}</div><div><small>${escapeHtml(service.category)}</small><strong>${escapeHtml(service.name)}</strong></div></div>
    <div class="detail-grid">
      <div class="detail-box"><small>Mínimo</small><strong>${number(service.min_qty)}</strong></div>
      <div class="detail-box"><small>Máximo</small><strong>${number(service.max_qty)}</strong></div>
      <div class="detail-box"><small>Preço / ${escapeHtml(service.unit_label || 'unidade')}</small><strong>${money(service.price_per_unit)}</strong></div>
      <div class="detail-box"><small>Serviço</small><strong>#${service.id}</strong></div>
    </div>
    <div class="service-description-text">${escapeHtml(service.description || 'Serviço processado automaticamente pelo fornecedor configurado na plataforma.')}</div>`;
  updateEstimate();
}

async function loadOrders() {
  state.orders = await api('/api/orders');
  renderRecentOrders();
  renderOrders();
}

function renderRecentOrders() {
  const rows = state.orders.slice(0, 6);
  $('#recentOrders').innerHTML = rows.length ? `<table><thead><tr><th>Pedido</th><th>Serviço</th><th>Valor</th><th>Status</th><th>Data</th></tr></thead><tbody>${rows.map(order => `<tr><td><b>#${order.id}</b><small>Fornecedor ${escapeHtml(order.provider_order_id || '—')}</small></td><td>${escapeHtml(short(order.service, 44))}</td><td>${money(order.amount)}</td><td>${statusPill(order.status)}</td><td>${dateTime(order.created_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Você ainda não possui pedidos.</div>';
}

function renderOrders() {
  const query = String($('#orderSearch')?.value || '').trim().toLowerCase();
  const rows = state.orders.filter(order => {
    const statusOk = state.orderStatus === 'all' || order.status === state.orderStatus;
    const haystack = `${order.id} ${order.service} ${order.target_url} ${order.provider_order_id || ''}`.toLowerCase();
    return statusOk && (!query || haystack.includes(query));
  });
  $('#ordersCount').textContent = `${rows.length} pedido${rows.length === 1 ? '' : 's'}`;
  $('#ordersTable').innerHTML = rows.length ? `<table><thead><tr><th>Pedido</th><th>Detalhes</th><th>Preço</th><th>Contador inicial</th><th>Restante</th><th>Data</th><th>Status</th></tr></thead><tbody>${rows.map(order => `
    <tr>
      <td><b>#${order.id}</b><small>Fornecedor #${escapeHtml(order.provider_order_id || '—')}</small></td>
      <td><b>${escapeHtml(short(order.service, 50))}</b><small>${number(order.quantity)} · <a href="${escapeHtml(order.target_url)}" target="_blank" rel="noopener">${escapeHtml(short(order.target_url, 52))}</a></small></td>
      <td>${money(order.amount)}</td>
      <td>${order.start_counter === null || order.start_counter === undefined ? '—' : number(order.start_counter)}</td>
      <td>${order.remains === null || order.remains === undefined ? '—' : number(order.remains)}</td>
      <td>${dateTime(order.created_at)}<small>${order.last_provider_sync_at ? `sync ${dateTime(order.last_provider_sync_at)}` : ''}</small></td>
      <td>${statusPill(order.status)}${order.provider_status ? `<small>${escapeHtml(order.provider_status)}</small>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum pedido encontrado neste filtro.</div>';
}

async function loadPayments() {
  state.payments = await api('/api/payments');
  $('#paymentsTable').innerHTML = state.payments.length ? `<table><thead><tr><th>#</th><th>Gateway</th><th>Valor</th><th>Status</th><th>Data</th></tr></thead><tbody>${state.payments.slice(0, 20).map(payment => `<tr><td>#${payment.id}</td><td>${escapeHtml(payment.gateway)}</td><td>${money(payment.amount)}</td><td>${statusPill(payment.status)}</td><td>${dateTime(payment.created_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum depósito registrado.</div>';
}

async function loadWallet() {
  state.wallet = await api('/api/wallet');
  $('#walletTable').innerHTML = state.wallet.length ? `<table><thead><tr><th>#</th><th>Tipo</th><th>Descrição</th><th>Valor</th><th>Data</th></tr></thead><tbody>${state.wallet.map(item => `<tr><td>#${item.id}</td><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.description || '—')}</td><td>${money(item.amount)}</td><td>${dateTime(item.created_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhuma movimentação na carteira.</div>';
}

function paymentReturnNotice() {
  const payment = new URLSearchParams(location.search).get('payment');
  if (!payment) return;
  const banner = $('#paymentBanner');
  const messages = {
    success: ['good', 'Pagamento confirmado. O saldo será atualizado conforme a confirmação registrada.'],
    pending: ['warn', 'Pagamento em processamento. O painel será atualizado após a confirmação do gateway.'],
    failure: ['bad', 'Não foi possível confirmar o pagamento. Nenhum crédito foi liberado.']
  };
  const [kind, text] = messages[payment] || messages.pending;
  banner.className = `notice ${kind}`;
  banner.textContent = text;
  history.replaceState({}, '', `/panel/${location.hash || ''}`);
}

$('#categorySelect').addEventListener('change', renderServiceOptions);
$('#serviceSelect').addEventListener('change', renderServiceDescription);
$('#quantityInput').addEventListener('input', updateEstimate);

$('#orderForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const original = button.textContent;
  try {
    button.disabled = true;
    button.textContent = 'Enviando ao fornecedor…';
    const result = await api('/api/orders', { method: 'POST', body: JSON.stringify({ service_id: Number(data.get('service_id')), target_url: data.get('target_url'), quantity: Number(data.get('quantity')) }) });
    showMessage($('#orderResult'), `Pedido #${result.id} enviado ao fornecedor. ID remoto: ${result.provider_order_id}.`, 'good');
    form.reset();
    renderServiceOptions();
    await Promise.all([loadMe(), loadDashboard(), loadOrders(), loadWallet()]);
    toast('Pedido enviado diretamente ao fornecedor.');
  } catch (error) {
    showMessage($('#orderResult'), error.message, 'bad');
    await Promise.all([loadMe(), loadDashboard(), loadWallet()]).catch(() => {});
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

$('#paymentForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const original = button.textContent;
  try {
    button.disabled = true;
    button.textContent = 'Abrindo checkout…';
    const result = await api('/api/payments/checkout', { method: 'POST', body: JSON.stringify({ amount: Number(data.get('amount')), gateway: data.get('gateway') }) });
    showMessage($('#paymentResult'), 'Checkout criado. Redirecionando…', 'good');
    location.assign(result.checkout_url);
  } catch (error) {
    showMessage($('#paymentResult'), error.message, 'bad');
    button.disabled = false;
    button.textContent = original;
  }
});

$('#aiForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const original = button.textContent;
  try {
    button.disabled = true;
    button.textContent = 'Analisando…';
    const result = await api('/api/ai/recommend', { method: 'POST', body: JSON.stringify({ network: data.get('network'), budget: Number(data.get('budget') || 0), goal: data.get('goal') }) });
    const recommendations = Array.isArray(result.recommendations) ? result.recommendations : [];
    $('#aiResult').innerHTML = `<div class="ai-strategy">${escapeHtml(result.strategy || 'Recomendação baseada no catálogo ativo.')}</div>${recommendations.length ? recommendations.map(item => `<div class="recommendation"><span>✦</span><div><b>${escapeHtml(item.title || `Serviço #${item.service_id}`)}</b><small>${escapeHtml(item.reason || '')}</small></div><em>${money(item.estimated_budget || 0)}</em></div>`).join('') : '<div class="empty">Nenhuma recomendação disponível.</div>'}`;
  } catch (error) {
    $('#aiResult').innerHTML = `<div class="message bad">${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

$('#orderTabs').addEventListener('click', event => {
  const button = event.target.closest('[data-status]');
  if (!button) return;
  state.orderStatus = button.dataset.status;
  $$('#orderTabs button').forEach(item => item.classList.toggle('active', item === button));
  renderOrders();
});
$('#orderSearch').addEventListener('input', renderOrders);
$('#refreshOrders').addEventListener('click', async () => { await loadOrders(); toast('Pedidos atualizados.'); });
$('#refreshWallet').addEventListener('click', async () => { await loadWallet(); toast('Extrato atualizado.'); });
$('#logoutBtn').addEventListener('click', () => { localStorage.removeItem('smm_token'); location.replace('/'); });
$('#mobileMenuBtn').addEventListener('click', () => $('#userNav').classList.toggle('open'));
$$('[data-page-link]').forEach(link => link.addEventListener('click', () => setTimeout(() => showPage(link.hash), 0)));
window.addEventListener('hashchange', () => showPage(location.hash));

(async function boot() {
  try {
    paymentReturnNotice();
    await loadMe();
    await Promise.all([loadDashboard(), loadServices(), loadOrders(), loadPayments(), loadWallet()]);
    showPage(location.hash || '#dashboard');
  } catch (error) {
    console.error(error);
  }
})();