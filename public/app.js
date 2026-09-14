const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  token: localStorage.getItem('smm_token') || '',
  user: null,
  services: [],
  category: 'Todos'
};

const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.');
  return data;
}

function iconFor(category) {
  const key = String(category || '').toLowerCase();
  if (key.includes('instagram')) return '◎';
  if (key.includes('facebook')) return 'f';
  if (key.includes('tiktok')) return '♪';
  if (key.includes('youtube')) return '▶';
  if (key.includes('telegram')) return '➤';
  if (key.includes('spotify')) return '●';
  if (key.includes('twitter') || key === 'x') return 'X';
  if (key.includes('linkedin')) return 'in';
  if (key.includes('tráfego') || key.includes('traffic')) return '↗';
  return '◆';
}

function renderCatalog() {
  const categories = ['Todos', ...new Set(state.services.map(item => item.category).filter(Boolean))];
  $('#categoryStrip').innerHTML = categories.map(category => `<button class="category-pill ${category === state.category ? 'active' : ''}" type="button" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join('');
  const items = state.category === 'Todos' ? state.services : state.services.filter(item => item.category === state.category);
  $('#servicesGrid').innerHTML = items.length ? items.map(service => `
    <article class="service-card">
      <div class="service-top"><span class="social-icon">${escapeHtml(iconFor(service.category))}</span><div><small>${escapeHtml(service.category)}</small><strong>Serviço #${service.id}</strong></div></div>
      <h3>${escapeHtml(service.name)}</h3>
      <p>${escapeHtml(service.description || 'Serviço disponível no catálogo SMM SuperAmplitude.')}</p>
      <div class="service-meta"><span>Faixa<br><b>${Number(service.min_qty).toLocaleString('pt-BR')}–${Number(service.max_qty).toLocaleString('pt-BR')}</b></span><span>Preço<br><b>${money(service.price_per_unit)}</b> / ${escapeHtml(service.unit_label || 'unidade')}</span></div>
    </article>`).join('') : '<div class="empty-state">Nenhum serviço nessa categoria.</div>';
}

async function loadServices() {
  try {
    state.services = await api('/api/services');
    renderCatalog();
  } catch (error) {
    $('#servicesGrid').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function restoreSession() {
  if (!state.token) return;
  try {
    state.user = await api('/api/me');
    $('#panelLink').classList.remove('hidden');
    $('#loginBtn').classList.add('hidden');
    $('#registerBtn').textContent = 'Abrir painel';
    $('#registerBtn').dataset.gotoPanel = '1';
  } catch (_) {
    localStorage.removeItem('smm_token');
    state.token = '';
  }
}

function setAuthMode(mode) {
  const register = mode === 'register';
  $('#authTitle').textContent = register ? 'Criar sua conta' : 'Entrar no painel';
  $('#nameField').classList.toggle('hidden', !register);
  $('#nameField input').required = register;
  $('#loginTab').classList.toggle('active', !register);
  $('#registerTab').classList.toggle('active', register);
  $('#authForm').dataset.mode = mode;
  $('#authForm [name="password"]').autocomplete = register ? 'new-password' : 'current-password';
  $('#authResult').classList.add('hidden');
}

function openAuth(mode) {
  setAuthMode(mode);
  $('#authDialog').showModal();
}

function showMessage(text, good = false) {
  const element = $('#authResult');
  element.textContent = text;
  element.classList.remove('hidden', 'good', 'bad');
  element.classList.add(good ? 'good' : 'bad');
}

$$('[data-auth]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.gotoPanel === '1' || state.user) return location.assign('/panel/');
  openAuth(button.dataset.auth || 'login');
}));

$('#loginTab').addEventListener('click', () => setAuthMode('login'));
$('#registerTab').addEventListener('click', () => setAuthMode('register'));
$('#closeDialog').addEventListener('click', () => $('#authDialog').close());
$('#reloadServices').addEventListener('click', loadServices);
$('#categoryStrip').addEventListener('click', event => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  state.category = button.dataset.category;
  renderCatalog();
});

$('#authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const mode = form.dataset.mode || 'login';
  const body = { email: data.get('email'), password: data.get('password') };
  if (mode === 'register') body.name = data.get('name');
  const submit = form.querySelector('button[type="submit"]');
  const original = submit.textContent;
  try {
    submit.disabled = true;
    submit.textContent = mode === 'register' ? 'Criando conta…' : 'Entrando…';
    const result = await api(mode === 'register' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
    state.token = result.token;
    state.user = result.user;
    localStorage.setItem('smm_token', state.token);
    showMessage('Acesso confirmado. Abrindo seu painel…', true);
    setTimeout(() => location.assign('/panel/'), 300);
  } catch (error) {
    showMessage(error.message, false);
  } finally {
    submit.disabled = false;
    submit.textContent = original;
  }
});

(async function boot() {
  await Promise.all([loadServices(), restoreSession()]);
  const params = new URLSearchParams(location.search);
  if (params.get('login') === '1' && !state.user) openAuth('login');
  if (params.get('register') === '1' && !state.user) openAuth('register');
})();