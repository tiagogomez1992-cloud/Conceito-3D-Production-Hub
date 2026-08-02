const byId = (id) => document.getElementById(id);
let latest = { printers: [], spools: [], assignments: {}, filaments: [] };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function text(value, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : escapeHtml(value);
}

function statusClass(status) {
  const normalized = String(status || 'UNKNOWN').toLowerCase();
  if (normalized === 'printing') return 'printing';
  if (['idle', 'finished', 'online', 'paused'].includes(normalized)) return 'online';
  return 'offline';
}

function progressFor(printer) {
  const value = Number(printer.job_progress || 0);
  return value * (value <= 1 ? 100 : 1);
}

function spoolMaterial(spool) {
  const filament = spool.filament || {};
  return {
    material: filament.material || filament.name || spool.material || 'Material não definido',
    color: filament.color_hex || filament.color || spool.color_hex || '#6f747a',
    vendor: filament.vendor?.name || spool.vendor?.name || 'Sem fabricante',
  };
}

function assignedSpool(printerId) {
  const assignment = latest.assignments?.[String(printerId)];
  return assignment ? latest.spools.find((spool) => Number(spool.id) === Number(assignment.spool_id)) : null;
}

function spoolOptions(selectedId) {
  return ['<option value="">Sem bobine atribuída</option>', ...latest.spools.map((spool) => {
    const { material } = spoolMaterial(spool);
    const remaining = Math.round(Number(spool.remaining_weight || 0));
    const selected = Number(selectedId) === Number(spool.id) ? ' selected' : '';
    return `<option value="${Number(spool.id)}"${selected}>#${Number(spool.id)} · ${escapeHtml(material)} · ${remaining} g</option>`;
  })].join('');
}

function renderPrinters(printers) {
  const container = byId('printer-list');
  if (!printers.length) {
    container.innerHTML = '<p class="empty">Ainda não há impressoras configuradas.</p>';
    return;
  }
  container.innerHTML = printers.map((printer) => {
    const status = printer.status || 'UNKNOWN';
    const progress = progressFor(printer);
    return `<div class="printer-row"><span class="status ${statusClass(status)}"></span><div class="printer-name"><strong>${text(printer.name, 'Sem nome')}</strong><small>${text(printer.model || printer.type, 'Impressora')}</small></div><div class="job"><strong>${text(printer.job_name, 'Sem trabalho ativo')}</strong><small>${progress ? `${Math.round(progress)}%` : text(status)}</small></div><span class="badge ${statusClass(status)}">${text(status)}</span></div>`;
  }).join('');
}

function renderPrinterGrid(printers) {
  const container = byId('printer-grid');
  if (!printers.length) {
    container.innerHTML = '<p class="empty">Ainda não há impressoras configuradas. Usa o botão “Adicionar impressora”.</p>';
    return;
  }
  container.innerHTML = printers.map((printer) => {
    const status = printer.status || 'UNKNOWN';
    const progress = progressFor(printer);
    const spool = assignedSpool(printer.id);
    const assignment = latest.assignments?.[String(printer.id)];
    const spoolName = spool ? `#${spool.id} · ${spoolMaterial(spool).material} · ${Math.round(Number(spool.remaining_weight || 0))} g` : 'Não atribuída';
    return `<article class="machine-card"><div class="machine-top"><div><span class="status ${statusClass(status)}"></span><strong>${text(printer.name, 'Sem nome')}</strong></div><span class="badge ${statusClass(status)}">${text(status)}</span></div><dl><div><dt>Modelo</dt><dd>${text(printer.model)}</dd></div><div><dt>Material carregado</dt><dd>${[printer.loaded_material, printer.loaded_color].filter(Boolean).map(escapeHtml).join(' · ') || 'Não definido'}</dd></div><div><dt>Trabalho</dt><dd>${text(printer.job_name, 'Sem trabalho ativo')}</dd></div><div><dt>Progresso</dt><dd>${progress ? `${Math.round(progress)}%` : '—'}</dd></div><div><dt>Bobine atribuída</dt><dd>${escapeHtml(spoolName)}</dd></div></dl><div class="machine-actions"><label>Trocar bobine<select class="assignment-select" data-printer-id="${Number(printer.id)}">${spoolOptions(assignment?.spool_id)}</select></label><button class="compact" data-save-assignment="${Number(printer.id)}">Guardar</button>${spool ? `<button class="compact secondary" data-consume-printer="${Number(printer.id)}" data-spool-id="${Number(spool.id)}">Registar consumo</button>` : ''}</div></article>`;
  }).join('');
}

function renderSpools(spools) {
  const container = byId('spool-grid');
  if (!spools.length) {
    container.innerHTML = '<p class="empty">Ainda não há bobines no Spoolman. Adiciona a primeira através de “Adicionar bobine”.</p>';
    return;
  }
  container.innerHTML = spools.map((spool) => {
    const { material, color, vendor } = spoolMaterial(spool);
    const remaining = Number(spool.remaining_weight || 0);
    const low = remaining > 0 && remaining < 200;
    const printers = latest.printers.filter((printer) => Number(latest.assignments?.[String(printer.id)]?.spool_id) === Number(spool.id)).map((printer) => printer.name).join(', ');
    return `<article class="spool-card"><div class="spool-swatch" style="background:${escapeHtml(color)}"></div><div><p class="eyebrow">BOBINE #${Number(spool.id)}</p><h2>${escapeHtml(material)}</h2><p>${escapeHtml(vendor)}${printers ? ` · Em: ${escapeHtml(printers)}` : ''}</p></div><div class="spool-weight ${low ? 'low' : ''}"><strong>${remaining ? `${Math.round(remaining)} g` : 'Sem peso'}</strong><small>${low ? 'Abaixo de 200 g' : 'Disponível'}</small></div></article>`;
  }).join('');
}

function statusLabel(status) { return escapeHtml(String(status || 'unknown').replace(/_/g, ' ')); }

function renderProduction(projects, jobs) {
  const orderedProjects = [...projects].sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  byId('jobs-count').textContent = `${jobs.length} total`;
  byId('projects-count').textContent = `${projects.length} total`;
  byId('job-list').innerHTML = jobs.length ? jobs.slice(0, 12).map((job) => `<div class="data-row"><div><strong>${text(job.part_name || job.name, `Trabalho #${job.id}`)}</strong><small>${text(job.printer_name, 'Impressora não atribuída')}</small></div><span class="badge ${statusClass(job.status)}">${statusLabel(job.status)}</span></div>`).join('') : '<p class="empty">Ainda não existem trabalhos na fila.</p>';
  byId('project-list').innerHTML = orderedProjects.length ? orderedProjects.slice(0, 12).map((project) => `<div class="data-row"><div><strong>${text(project.name, `Projeto #${project.id}`)}</strong><small>${text(project.description, 'Sem descrição')}</small></div><span class="badge ${Number(project.priority) > 1 ? 'printing' : statusClass(project.status)}">${Number(project.priority) > 1 ? 'urgente' : statusLabel(project.status)}</span></div>`).join('') : '<p class="empty">Ainda não existem projetos criados.</p>';
}

function toast(message, kind = 'success') {
  const element = byId('toast');
  element.textContent = message;
  element.className = `toast show ${kind}`;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => { element.className = 'toast'; }, 4500);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'O pedido não foi aceite.');
  return payload;
}

async function populateFilaments() {
  try {
    const filaments = await request('/api/filaments');
    latest.filaments = filaments;
    byId('filament-select').innerHTML = ['<option value="">Selecionar filamento</option>', ...filaments.map((filament) => {
      const label = [filament.vendor?.name, filament.name || filament.material, filament.color_name || filament.color_hex].filter(Boolean).join(' · ');
      return `<option value="${Number(filament.id)}">${escapeHtml(label || `Filamento #${filament.id}`)}</option>`;
    })].join('');
  } catch (_) {
    byId('filament-select').innerHTML = '<option value="">Spoolman indisponível</option>';
  }
}

async function update() {
  const refresh = byId('refresh');
  refresh.disabled = true;
  try {
    const response = await fetch('/api/summary', { cache: 'no-store' });
    if (!response.ok) throw new Error('Não foi possível obter o resumo');
    const data = await response.json();
    latest = { printers: data.printers.items, spools: data.spools.items, assignments: data.assignments || {}, filaments: latest.filaments };
    byId('printers-total').textContent = data.printers.total;
    byId('printers-online').textContent = `${data.printers.online} online`;
    byId('printers-printing').textContent = data.printers.printing;
    byId('spools-total').textContent = data.spools.total;
    byId('spools-low').textContent = data.spools.low ? `${data.spools.low} abaixo de 200 g` : 'Sem alertas de peso';
    const services = [data.services.printFarmManager, data.services.spoolman].filter(Boolean).length;
    byId('services-status').textContent = `${services}/2`;
    byId('live-dot').className = services === 2 ? 'connected' : 'warning';
    byId('last-update').textContent = `Atualizado às ${new Date(data.generatedAt).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}`;
    renderPrinters(latest.printers);
    renderPrinterGrid(latest.printers);
    renderSpools(latest.spools);
    renderProduction(data.production.projects, data.production.jobs);
  } catch (_) {
    byId('live-dot').className = 'warning';
    byId('last-update').textContent = 'Não foi possível contactar os serviços';
  } finally { refresh.disabled = false; }
}

byId('refresh').addEventListener('click', update);
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === tab.dataset.view));
}));
document.addEventListener('click', async (event) => {
  const open = event.target.closest('[data-open-form]');
  const close = event.target.closest('[data-close-form]');
  if (open) byId(open.dataset.openForm).classList.remove('hidden');
  if (close) byId(close.dataset.closeForm).classList.add('hidden');
  const save = event.target.closest('[data-save-assignment]');
  if (save) {
    const printerId = Number(save.dataset.saveAssignment);
    const select = document.querySelector(`.assignment-select[data-printer-id="${printerId}"]`);
    try {
      if (!select.value) await fetch(`/api/assignments/${printerId}`, { method: 'DELETE' });
      else await request('/api/assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printer_id: printerId, spool_id: Number(select.value) }) });
      toast('Bobine atribuída à impressora.');
      update();
    } catch (error) { toast(error.message, 'error'); }
  }
  const consume = event.target.closest('[data-consume-printer]');
  if (consume) {
    const grams = window.prompt('Quantos gramas foram consumidos?', '0');
    if (!grams || Number(grams) <= 0) return;
    try {
      await request('/api/consume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printer_id: Number(consume.dataset.consumePrinter), spool_id: Number(consume.dataset.spoolId), grams: Number(grams) }) });
      toast('Consumo registado no Spoolman.');
      update();
    } catch (error) { toast(error.message, 'error'); }
  }
});

byId('printer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await request('/api/printers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(form.entries())) });
    event.currentTarget.reset(); event.currentTarget.classList.add('hidden'); toast('Impressora adicionada.'); update();
  } catch (error) { toast(error.message, 'error'); }
});
byId('project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.currentTarget).entries()); form.priority = Number(form.priority);
  try {
    await request('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    event.currentTarget.reset(); event.currentTarget.classList.add('hidden'); toast('Projeto criado e colocado na fila.'); update();
  } catch (error) { toast(error.message, 'error'); }
});
byId('spool-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await request('/api/spools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    event.currentTarget.reset(); event.currentTarget.classList.add('hidden'); toast('Bobine criada no Spoolman.'); update();
  } catch (error) { toast(error.message, 'error'); }
});

populateFilaments();
update();
setInterval(update, 15000);
