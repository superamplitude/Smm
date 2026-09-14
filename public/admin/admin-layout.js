(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  const validPages = new Set($$('.admin-section').map(section => section.id));

  function showPage(hash) {
    const id = String(hash || location.hash || '#overview').replace(/^#/, '');
    const targetId = validPages.has(id) ? id : 'overview';

    $$('.admin-section').forEach(section => section.classList.toggle('active-page', section.id === targetId));
    $$('.nav-item').forEach(link => link.classList.toggle('active', link.getAttribute('href') === `#${targetId}`));

    const section = document.getElementById(targetId);
    const title = section?.dataset.page || $(`.nav-item[href="#${targetId}"]`)?.dataset.title || 'Dashboard';
    const titleEl = $('#currentPageTitle');
    if (titleEl) titleEl.textContent = title;
    document.title = `${title} — SMM SuperAmplitude`;

    document.body.classList.remove('sidebar-open');
    $('#sidebar')?.classList.remove('open');
    $('#sidebarBackdrop')?.classList.remove('show');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function openSidebar() {
    $('#sidebar')?.classList.add('open');
    $('#sidebarBackdrop')?.classList.add('show');
  }

  function closeSidebar() {
    $('#sidebar')?.classList.remove('open');
    $('#sidebarBackdrop')?.classList.remove('show');
  }

  $$('.nav-item').forEach(link => link.addEventListener('click', () => setTimeout(() => showPage(link.hash), 0)));
  $('#openSidebar')?.addEventListener('click', openSidebar);
  $('#closeSidebar')?.addEventListener('click', closeSidebar);
  $('#sidebarBackdrop')?.addEventListener('click', closeSidebar);
  window.addEventListener('hashchange', () => showPage(location.hash));
  window.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar(); });

  showPage(location.hash || '#overview');
})();
