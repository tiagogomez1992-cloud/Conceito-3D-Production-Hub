const $ = (id) => document.getElementById(id);
let latest = { printers: [], spools: [], assignments: {}, orders: [] };
let customers = [];
let libraryFiles = [];
let libraryParts = [];
let templatePreview = null;
let templateFields = [];
let templateDrag = null;
let editingPrinterId = null;
const escape = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const value = (v, fallback = '—') => v === undefined || v === null || v === '' ? fallback : escape(v);
const statusClass = (v) => String(v || '').toLowerCase() === 'printing' ? 'printing' : ['idle', 'finished', 'online', 'paused', 'completed'].includes(String(v || '').toLowerCase()) ? 'online' : 'offline';
const spoolInfo = (spool) => ({ material: spool?.filament?.material || spool?.filament?.name || 'Material não definido', remaining: Math.round(Number(spool?.remaining_weight || 0)) });
const customModelValue = '__custom__';
const printerCatalog = Object.freeze({
  Anycubic: ['Kobra S1 Max', 'Kobra S1', 'Kobra X', 'Kobra 3', 'Kobra 3 Combo', 'Kobra 2 Max', 'Kobra 2 Pro', 'Kobra 2 Plus', 'Kobra 2 Neo', 'Kobra 2', 'Vyper'],
  'Bambu Lab': ['H2D', 'H2S', 'X1 Carbon', 'X1E', 'P1S', 'P1P', 'A1', 'A1 mini'],
  Creality: ['K2 Plus', 'K1 Max', 'K1C', 'K1', 'Ender-5 Max', 'Ender-3 V3', 'Ender-3 V3 KE', 'Ender-3 V3 SE', 'Ender-3 S1 Pro', 'CR-10 Smart Pro'],
  Elegoo: ['OrangeStorm Giga', 'Centauri Carbon', 'Centauri', 'Neptune 4 Max', 'Neptune 4 Plus', 'Neptune 4 Pro', 'Neptune 4'],
  Flashforge: ['Adventurer 5M Pro', 'Adventurer 5M', 'Creator 4', 'Guider 3 Plus'],
  Prusa: ['CORE One', 'XL', 'MK4S', 'MK4', 'MINI+'],
  QIDI: ['Q1 Pro', 'X-Max 3', 'X-Plus 3', 'X-Smart 3'],
  RatRig: ['V-Core 4', 'V-Core 3.1', 'V-Core 3'],
  Sovol: ['SV08', 'SV07 Plus', 'SV07', 'SV06 Plus', 'SV06'],
  Voron: ['2.4', 'Trident', 'V0.2'],
  'Outra / personalizada': [],
});
function setCustomPrinterModel(active) {
  const wrap = $('printer-custom-model-wrap'); const input = $('printer-custom-model');
  wrap.classList.toggle('hidden', !active); input.disabled = !active; input.required = active;
  if (!active) input.value = '';
}
function updatePrinterModelOptions(selectedModel = '') {
  const brand = $('printer-brand').value; const models = printerCatalog[brand] || [];
  const model = $('printer-model');
  model.innerHTML = ['<option value="">Selecionar modelo</option>', ...models.map((entry) => `<option value="${escape(`${brand} ${entry}`)}">${escape(entry)}</option>`), `<option value="${customModelValue}">Outro modelo / perfil personalizado</option>`].join('');
  if (selectedModel && [...model.options].some((option) => option.value === selectedModel)) model.value = selectedModel;
  else if (selectedModel) { model.value = customModelValue; $('printer-custom-model').value = selectedModel; }
  setCustomPrinterModel(model.value === customModelValue);
}
function setPrinterCatalogSelection(brand = '', model = '') {
  const brandInput = $('printer-brand');
  brandInput.value = brand && Object.hasOwn(printerCatalog, brand) ? brand : '';
  updatePrinterModelOptions(model);
}
function setupPrinterCatalog() {
  const brand = $('printer-brand'); const model = $('printer-model');
  brand.innerHTML = ['<option value="">Selecionar marca</option>', ...Object.keys(printerCatalog).map((entry) => `<option value="${escape(entry)}">${escape(entry)}</option>`)].join('');
  updatePrinterModelOptions();
  brand.addEventListener('change', () => updatePrinterModelOptions());
  model.addEventListener('change', () => setCustomPrinterModel(model.value === customModelValue));
}
function resetPrinterFormMode() {
  editingPrinterId = null;
  const form = $('printer-form');
  form.querySelector('button[type="submit"]').textContent = 'Adicionar impressora';
}
function openPrinterEditor(printerId) {
  const printer = latest.printers.find((item) => Number(item.id) === Number(printerId));
  if (!printer) return toast('Não foi possível localizar esta impressora.', 'error');
  const form = $('printer-form');
  editingPrinterId = Number(printer.id);
  form.querySelector('[name="name"]').value = printer.name || '';
  form.querySelector('[name="ip"]').value = printer.ip || '';
  form.querySelector('[name="type"]').value = printer.type || 'klipper';
  form.querySelector('[name="api_key"]').value = printer.api_key || '';
  form.querySelector('[name="group_name"]').value = printer.group_name || '';
  setPrinterCatalogSelection(printer.brand || 'Outra / personalizada', printer.model || '');
  form.querySelector('button[type="submit"]').textContent = 'Guardar alterações';
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function toast(message, kind = 'success') { const t = $('toast'); t.textContent = message; t.className = `toast show ${kind}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.className = 'toast'; }, 4200); }
async function api(url, options = {}) { const r = await fetch(url, options); const body = await r.json().catch(() => ({})); if (!r.ok) throw new Error(body.error || 'O pedido não foi aceite.'); return body; }
function selectOptions(selected) { return ['<option value="">Sem bobine atribuída</option>', ...latest.spools.map((s) => `<option value="${s.id}" ${Number(selected) === Number(s.id) ? 'selected' : ''}>#${s.id} · ${escape(spoolInfo(s).material)} · ${spoolInfo(s).remaining} g</option>`)].join(''); }

function assigned(printerId) {
  const spoolId = latest.assignments?.[String(printerId)]?.spool_id;
  return latest.spools.find((spool) => Number(spool.id) === Number(spoolId)) || null;
}

function renderPrinters(items) {
  $('printer-list').innerHTML = items.length ? items.map((p) => {
    const progress = Number(p.job_progress || 0) * (Number(p.job_progress || 0) <= 1 ? 100 : 1);
    return `<div class="printer-row"><span class="status ${statusClass(p.status)}"></span><div class="printer-name"><strong>${value(p.name, 'Sem nome')}</strong><small>${value(p.model || p.type, 'Impressora')}</small></div><div class="job"><strong>${value(p.job_name, 'Sem trabalho ativo')}</strong><small>${progress ? `${Math.round(progress)}%` : value(p.status)}</small></div><span class="badge ${statusClass(p.status)}">${value(p.status)}</span></div>`;
  }).join('') : '<p class="empty">Ainda não há impressoras configuradas.</p>';
  $('printer-grid').innerHTML = items.length ? items.map((p) => {
    const spool = assigned(p.id); const assignment = latest.assignments?.[String(p.id)];
    return `<article class="machine-card"><div class="machine-top"><div><span class="status ${statusClass(p.status)}"></span><strong>${value(p.name, 'Sem nome')}</strong></div><span class="badge ${statusClass(p.status)}">${value(p.status)}</span></div><dl><div><dt>Marca</dt><dd>${value(p.brand, 'Não indicada')}</dd></div><div><dt>Modelo</dt><dd>${value(p.model)}</dd></div><div><dt>Ligação</dt><dd>${escape(p.type || '—')}</dd></div><div><dt>Trabalho</dt><dd>${value(p.job_name, 'Sem trabalho ativo')}</dd></div><div><dt>Bobine</dt><dd>${spool ? `#${spool.id} · ${escape(spoolInfo(spool).material)} · ${spoolInfo(spool).remaining} g` : 'Não atribuída'}</dd></div></dl><div class="machine-actions"><label>Trocar bobine<select data-printer="${p.id}">${selectOptions(assignment?.spool_id)}</select></label><button class="compact" data-save-assignment="${p.id}">Guardar</button>${spool ? `<button class="compact secondary" data-consume="${p.id}" data-spool="${spool.id}">Registar consumo</button>` : ''}<button class="compact secondary" data-edit-printer="${p.id}">Editar</button><button class="compact danger" data-delete-printer="${p.id}" data-printer-name="${escape(p.name)}">Remover</button></div></article>`;
  }).join('') : '<p class="empty">Ainda não há impressoras configuradas.</p>';
}
function renderDiscovery(data) {
  const box = $('discovery-results'); box.classList.remove('hidden');
  const networks = (data.networks || []).map((network) => `${network.subnet}.0/24`).join(', ');
  box.innerHTML = `<div class="discovery-heading"><div><p class="eyebrow">DESCOBERTA LOCAL</p><h2>${data.printers?.length || 0} impressora(s) encontrada(s)</h2><p>Rede analisada: ${escape(networks || 'não identificada')}</p></div></div>${data.printers?.length ? `<div class="discovery-grid">${data.printers.map((printer) => `<article class="discovery-card"><span class="status online"></span><div><strong>${escape(printer.detected_as)}</strong><small>${escape(printer.ip)}${printer.port !== 80 ? `:${printer.port}` : ''}</small></div><button class="compact" data-add-discovered='${escape(JSON.stringify(printer))}'>Preparar adição</button></article>`).join('')}</div>` : '<p class="empty">Não foram encontrados serviços Moonraker, OctoPrint ou PrusaLink nesta rede. Impressoras sem API local terão de ser adicionadas manualmente.</p>'}`;
}
function renderSpools() { $('spool-grid').innerHTML = latest.spools.length ? latest.spools.map((s) => { const info = spoolInfo(s); const low = info.remaining > 0 && info.remaining < 200; return `<article class="spool-card"><div class="spool-swatch" style="background:${escape(s.filament?.color_hex || '#6f747a')}"></div><div><p class="eyebrow">BOBINE #${s.id}</p><h2>${escape(info.material)}</h2><p>${escape(s.filament?.vendor?.name || 'Sem fabricante')}</p></div><div class="spool-weight ${low ? 'low' : ''}"><strong>${info.remaining || 'Sem peso'}${info.remaining ? ' g' : ''}</strong><small>${low ? 'Abaixo de 200 g' : 'Disponível'}</small></div></article>`; }).join('') : '<p class="empty">Ainda não há bobines registadas no portal.</p>'; }
function renderProduction(projects, jobs) { $('jobs-count').textContent = `${jobs.length} total`; $('projects-count').textContent = `${projects.length} total`; $('job-list').innerHTML = jobs.length ? jobs.slice(0, 12).map((j) => `<div class="data-row"><div><strong>${value(j.part_name || j.name, `Trabalho #${j.id}`)}</strong><small>${value(j.printer_name, 'Impressora não atribuída')}</small></div><span class="badge ${statusClass(j.status)}">${value(j.status)}</span></div>`).join('') : '<p class="empty">Ainda não existem trabalhos.</p>'; $('project-list').innerHTML = projects.length ? projects.slice(0, 12).map((p) => `<div class="data-row"><div><strong>${value(p.name, `Projeto #${p.id}`)}</strong><small>${value(p.description, 'Sem descrição')}</small></div><span class="badge ${Number(p.priority) > 1 ? 'printing' : statusClass(p.status)}">${Number(p.priority) > 1 ? 'urgente' : value(p.status)}</span></div>`).join('') : '<p class="empty">Ainda não existem projetos.</p>'; }
function renderOrders() { $('orders-total').textContent = latest.orders.filter((o) => o.status !== 'completed').length; $('orders-urgent').textContent = `${latest.orders.filter((o) => Number(o.priority) === 2 && o.status !== 'completed').length} urgentes`; $('order-board').innerHTML = latest.orders.length ? latest.orders.map((o) => { const file = o.files?.[0]; const meta = file?.metadata; const source = o.document?.file_name ? `<span>PDF: ${escape(o.document.file_name)}${o.document.ocr_used ? ' · OCR' : ''}</span>` : ''; const items = o.items?.length ? `<span>${o.items.length} linha(s) lida(s) no PDF</span>` : ''; const printerOptions = ['<option value="">Atribuir impressora</option>', ...latest.printers.map((p) => `<option value="${p.id}" ${Number(o.printer_id) === Number(p.id) ? 'selected' : ''}>${escape(p.name)}</option>`)].join(''); return `<article class="order-card ${Number(o.priority) === 2 ? 'urgent' : ''}"><div class="order-top"><div><p class="eyebrow">${escape(o.id)}</p><h2>${escape(o.title)}</h2><p>${escape(o.customer || 'Sem cliente')} · ${o.due_date ? escape(o.due_date) : 'Sem prazo'}</p></div><span class="badge ${o.status === 'completed' ? 'online' : Number(o.priority) === 2 ? 'printing' : 'offline'}">${escape(o.status)}</span></div><div class="order-meta">${source}${items}${meta ? `<span>${meta.valid ? '✓ Metadados validados' : `⚠ Falta: ${escape(meta.missing.join(', '))}`}</span><span>${meta.quantity || '—'} peças · ${escape(meta.material || '—')} · bico ${meta.nozzle || '—'} mm</span>` : '<span>Sem G-code</span>'}</div><div class="order-actions"><label>Impressora<select data-order-printer="${escape(o.id)}">${printerOptions}</select></label><label class="file-upload">G-code<input type="file" accept=".gcode,.gco" data-file-order="${escape(o.id)}"><span>Enviar G-code</span></label>${o.status !== 'completed' ? `<button class="compact" data-complete-order="${escape(o.id)}">Concluir</button>` : ''}</div></article>`; }).join('') : '<p class="empty">Ainda não existem encomendas.</p>'; }
function renderOrderRemovalButtons() { document.querySelectorAll('#order-board .order-card').forEach((card, index) => { const order = latest.orders[index]; const actions = card.querySelector('.order-actions'); if (order && actions) actions.insertAdjacentHTML('beforeend', `<button class="compact danger" data-delete-order="${escape(order.id)}">Remover</button>`); }); }
function renderOrderLibrarySelectors() { document.querySelectorAll('#order-board .order-card').forEach((card, index) => { const order = latest.orders[index]; const actions = card.querySelector('.order-actions'); if (!order || !actions) return; card.querySelector('.file-upload')?.remove(); const selected = order.library_file_id || ''; const options = ['<option value="">Associar G-code da biblioteca</option>', ...libraryFiles.map((file) => `<option value="${file.id}" ${file.id === selected ? 'selected' : ''}>${escape(file.original_name)} · ${escape(file.metadata?.material || '—')} ${escape(file.metadata?.color || '')}</option>`)].join(''); actions.insertAdjacentHTML('beforeend', `<label>G-code<select data-order-library-file="${escape(order.id)}">${options}</select></label>`); const file = libraryFiles.find((entry) => entry.id === selected); if (file) card.querySelector('.order-meta')?.insertAdjacentHTML('afterbegin', `<span>G-code: ${escape(file.original_name)} · ${escape(file.metadata?.quantity)} peças · ${escape(file.metadata?.material)} ${escape(file.metadata?.color)}</span>`); }); }
function printerModelChoices(selected = '') {
  const models = [...new Set(latest.printers.map((printer) => String(printer.model || '').trim()).filter(Boolean))].sort();
  return `<option value="">Selecionar perfil</option>${models.map((model) => `<option value="${escape(model)}" ${model === selected ? 'selected' : ''}>${escape(model)}</option>`).join('')}`;
}
function libraryGcodeEditor(file) {
  const meta = file.metadata || {};
  return `<article class="library-gcode-row ${file.active === false ? 'inactive' : ''}"><img src="${escape(file.thumbnail?.url || '')}" alt="Pré-visualização de ${escape(file.original_name)}"><div class="library-gcode-main"><div class="library-gcode-title"><div><strong>${escape(file.original_name)}</strong><small>${Math.max(1, Math.round(Number(file.size_bytes || 0) / 1024))} KB · ${file.active === false ? 'Inativo' : 'Ativo'}</small></div><button class="compact danger" data-delete-file="${escape(file.id)}">Remover</button></div><form class="gcode-edit-form" data-edit-gcode="${escape(file.id)}"><label>Impressora / perfil<input name="printer_model" required list="printer-model-list" value="${escape(file.printer_model || '')}" placeholder="Ex.: Bambu Lab P1S"></label><label>Material<input name="material" required value="${escape(meta.material || '')}" placeholder="PETG"></label><label>Cor<input name="color" required value="${escape(meta.color || '')}" placeholder="Preto"></label><label>Bico (mm)<input name="nozzle" required type="number" min="0.1" max="2" step="0.1" value="${escape(meta.nozzle || '')}"></label><label>Peças por impressão<input name="quantity" required type="number" min="1" step="1" value="${escape(meta.quantity || 1)}"></label><label>Utilização<select name="active"><option value="true" ${file.active !== false ? 'selected' : ''}>Ativo</option><option value="false" ${file.active === false ? 'selected' : ''}>Inativo</option></select></label><button class="compact secondary" type="submit">Guardar dados</button></form></div></article>`;
}
function renderFiles() {
  $('file-grid').innerHTML = libraryParts.length ? libraryParts.map((part) => `<article class="library-part-card"><header class="library-part-header"><div><p class="eyebrow">PEÇA · ${part.gcodes?.length || 0} G-CODE(S)</p><h2>${escape(part.name)}</h2><p>${escape(part.description || 'Sem descrição')}</p></div>${part.gcodes?.length ? '' : `<button class="compact danger" data-delete-library-part="${escape(part.id)}">Remover peça</button>`}</header><div class="library-gcode-list">${part.gcodes?.length ? part.gcodes.map(libraryGcodeEditor).join('') : '<p class="empty">Adiciona o primeiro G-code desta peça.</p>'}</div><form class="part-upload-form" data-upload-part="${escape(part.id)}"><label>Ficheiro G-code<input name="gcode" type="file" accept=".gcode,.gco" required></label><label>Impressora / perfil<input name="printer_model" required list="printer-model-list" placeholder="Ex.: Bambu Lab P1S"></label><label>Material<input name="material" required placeholder="PETG"></label><label>Cor<input name="color" required placeholder="Preto"></label><label>Bico (mm)<input name="nozzle" type="number" min="0.1" max="2" step="0.1" required value="0.4"></label><label>Peças por impressão<input name="quantity" type="number" min="1" step="1" required value="1"></label><button class="compact" type="submit">Adicionar G-code</button><small>O G-code fica associado a ${escape(part.name)} e disponível para encomendas e produção.</small></form></article>`).join('') : '<p class="empty">Ainda não existem peças. Cria a primeira peça e adiciona as variantes G-code.</p>';
  if (!$('printer-model-list')) document.body.insertAdjacentHTML('beforeend', `<datalist id="printer-model-list">${[...new Set(latest.printers.map((printer) => String(printer.model || '').trim()).filter(Boolean))].sort().map((model) => `<option value="${escape(model)}"></option>`).join('')}</datalist>`);
}

function renderCustomers() {
  $('customer-grid').innerHTML = customers.length ? customers.map((customer) => { const fields = customer.template?.fields || []; const label = fields.length ? `${fields.length} área(s) configurada(s)` : 'Sem áreas OCR'; return `<article class="customer-card"><p class="eyebrow">${escape(label)}</p><h2>${escape(customer.name)}</h2><p>${escape(customer.template?.sample_name || 'Sem PDF tipo')}</p><small>${escape(customer.email || customer.phone || 'Sem contacto registado')}</small><button class="compact secondary" data-delete-customer="${customer.id}">Remover</button></article>`; }).join('') : '<p class="empty">Ainda não existem clientes. Adiciona um PDF tipo para configurar a leitura por áreas.</p>';
  $('order-customer-select').innerHTML = ['<option value="">Detetar automaticamente</option>', ...customers.map((customer) => `<option value="${customer.id}">${escape(customer.name)}${customer.template?.fields?.length ? ' · modelo OCR' : ''}</option>`)].join('');
}
function renderTemplateFields() {
  const canvas = $('pdf-canvas'); canvas.querySelectorAll('.template-area').forEach((node) => node.remove());
  templateFields.forEach((field, index) => { const area = document.createElement('div'); area.className = 'template-area'; area.style.left = `${field.left}%`; area.style.top = `${field.top}%`; area.style.width = `${field.width}%`; area.style.height = `${field.height}%`; area.dataset.label = field.field; canvas.append(area); });
  $('template-fields-list').innerHTML = templateFields.length ? templateFields.map((field, index) => `<span class="template-field-chip">${escape(templateFieldLabel(field.field))}<button type="button" data-remove-template-field="${index}" aria-label="Remover área">×</button></span>`).join('') : '<span class="empty">Ainda não marcaste nenhuma área.</span>';
}
function templateFieldLabel(field) { return ({ customer: 'Nome do cliente', order_number: 'N.º encomenda', part_code: 'Referências', quantity: 'Quantidades' })[field] || field; }
function resetTemplateForm() { templatePreview = null; templateFields = []; $('template-workspace').classList.add('hidden'); $('template-preview').removeAttribute('src'); $('template-fields-list').innerHTML = ''; }

async function populateFilaments() { return []; }
async function refreshCustomers() { try { customers = await api('/api/customers'); renderCustomers(); } catch { $('customer-grid').innerHTML = '<p class="empty">Não foi possível carregar os clientes.</p>'; } }
async function refreshFiles() { try { libraryParts = await api('/api/library-parts'); libraryFiles = libraryParts.flatMap((part) => part.gcodes || []); renderFiles(); if (latest.orders.length) { renderOrders(); renderOrderLibrarySelectors(); renderOrderRemovalButtons(); } } catch { $('file-grid').innerHTML = '<p class="empty">Não foi possível carregar a biblioteca.</p>'; } }
async function update() { $('refresh').disabled = true; try { const data = await api('/api/summary'); latest = { printers: data.printers.items, spools: data.spools.items, assignments: data.assignments || {}, orders: data.production.orders || [] }; $('printers-total').textContent = data.printers.total; $('printers-online').textContent = `${data.printers.online} online`; $('printers-printing').textContent = data.printers.printing; $('spools-total').textContent = data.spools.total; $('spools-low').textContent = data.spools.low ? `${data.spools.low} abaixo de 200 g` : 'Sem alertas'; $('live-dot').className = data.services.productionHub ? 'connected' : 'warning'; $('last-update').textContent = `Atualizado às ${new Date(data.generatedAt).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}`; $('system-host').textContent = data.system.hostname; $('system-up').textContent = `${Math.floor(data.system.uptime_seconds / 3600)} h ativo`; $('system-memory').textContent = `${data.system.memory_used_mb} MB`; $('system-load').textContent = data.system.cpu_load_1m; renderPrinters(latest.printers); renderSpools(); renderProduction(data.production.projects, data.production.jobs); renderOrders(); renderOrderLibrarySelectors(); renderOrderRemovalButtons(); } catch { $('last-update').textContent = 'Não foi possível contactar os serviços'; $('live-dot').className = 'warning'; } finally { $('refresh').disabled = false; } }

$('refresh').onclick = update;
$('discover-printers').onclick = async () => { const button = $('discover-printers'); button.disabled = true; button.textContent = 'A analisar…'; try { renderDiscovery(await api('/api/printers/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subnet: $('discovery-subnet').value }) })); } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; button.textContent = 'Analisar rede local'; } };
document.querySelectorAll('.tab').forEach((tab) => tab.onclick = () => { document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab)); document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === tab.dataset.view)); });
renderOrderRemovalButtons = function renderActiveOrderRemovalButtons() {
  document.querySelectorAll('#order-board .order-card').forEach((card, index) => {
    const order = latest.orders.filter((item) => item.status !== 'completed')[index]; const actions = card.querySelector('.order-actions');
    if (order && actions) actions.insertAdjacentHTML('beforeend', `<button class="compact danger" data-delete-order="${escape(order.id)}">Remover</button>`);
  });
};
const historyTab = document.createElement('button');
historyTab.className = 'tab'; historyTab.dataset.view = 'history'; historyTab.textContent = 'Histórico';
document.querySelector('.tabs').insertBefore(historyTab, document.querySelector('[data-view="system"]'));
const historyView = document.createElement('section');
historyView.className = 'view'; historyView.id = 'history';
historyView.innerHTML = '<div class="section-heading"><div><p class="eyebrow">ARQUIVO</p><h1>Histórico de encomendas</h1><p>Encomendas concluídas, respetivos G-codes e quantidades produzidas.</p></div></div><div id="history-board" class="history-board"><p class="empty">A carregar histórico…</p></div>';
document.querySelector('main.shell').insertBefore(historyView, $('files'));
historyTab.onclick = () => { document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === historyTab)); document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view === historyView)); };
document.addEventListener('click', async (event) => {
  const open = event.target.closest('[data-open-form]'), close = event.target.closest('[data-close-form]');
  if (open) { $(open.dataset.openForm).classList.remove('hidden'); if (open.dataset.openForm === 'printer-form') { $('printer-form').reset(); resetPrinterFormMode(); setPrinterCatalogSelection(); } }
  if (close) { $(close.dataset.closeForm).classList.add('hidden'); if (close.dataset.closeForm === 'customer-form') resetTemplateForm(); if (close.dataset.closeForm === 'printer-form') { $('printer-form').reset(); resetPrinterFormMode(); setPrinterCatalogSelection(); } }
  const removeArea = event.target.closest('[data-remove-template-field]'); if (removeArea) { templateFields.splice(Number(removeArea.dataset.removeTemplateField), 1); renderTemplateFields(); }
  if (event.target.id === 'clear-template-fields') { templateFields = []; renderTemplateFields(); }
  const discovered = event.target.closest('[data-add-discovered]'); if (discovered) { try { const printer = JSON.parse(discovered.dataset.addDiscovered); const form = $('printer-form'); form.reset(); resetPrinterFormMode(); form.querySelector('[name="name"]').value = `${printer.detected_as} ${printer.ip}`; form.querySelector('[name="ip"]').value = printer.port && Number(printer.port) !== 7125 ? `${printer.ip}:${printer.port}` : printer.ip; form.querySelector('[name="type"]').value = printer.type; form.querySelector('[name="group_name"]').value = printer.detected_as; setPrinterCatalogSelection(); form.classList.remove('hidden'); $('printer-brand').focus(); toast('Dados preenchidos. Seleciona a marca e o modelo antes de confirmar.'); } catch { toast('Não foi possível preparar esta impressora.', 'error'); } }
  const editPrinter = event.target.closest('[data-edit-printer]'); if (editPrinter) openPrinterEditor(editPrinter.dataset.editPrinter);
  const deletePrinter = event.target.closest('[data-delete-printer]'); if (deletePrinter && confirm(`Remover a impressora ${deletePrinter.dataset.printerName}? Esta ação não altera a impressora física.`)) try { await api(`/api/printers/${deletePrinter.dataset.deletePrinter}`, { method: 'DELETE' }); toast('Impressora removida do portal.'); update(); } catch (error) { toast(error.message, 'error'); }
  const deleteCustomer = event.target.closest('[data-delete-customer]'); if (deleteCustomer && confirm('Remover este cliente e o respetivo modelo?')) try { await api(`/api/customers/${deleteCustomer.dataset.deleteCustomer}`, { method: 'DELETE' }); toast('Cliente removido.'); refreshCustomers(); } catch (error) { toast(error.message, 'error'); }
  const deleteFile = event.target.closest('[data-delete-file]'); if (deleteFile && confirm('Remover este G-code da biblioteca?')) try { await api(`/api/files/${deleteFile.dataset.deleteFile}`, { method: 'DELETE' }); toast('G-code removido.'); refreshFiles(); } catch (error) { toast(error.message, 'error'); }
  const deletePart = event.target.closest('[data-delete-library-part]'); if (deletePart && confirm('Remover esta peça vazia da biblioteca?')) try { await api(`/api/library-parts/${deletePart.dataset.deleteLibraryPart}`, { method: 'DELETE' }); toast('Peça removida.'); refreshFiles(); } catch (error) { toast(error.message, 'error'); }
  const deleteOrder = event.target.closest('[data-delete-order]'); if (deleteOrder && confirm('Remover esta encomenda? Os G-codes anexados a ela também serão eliminados.')) try { await api(`/api/orders/${deleteOrder.dataset.deleteOrder}`, { method: 'DELETE' }); toast('Encomenda removida.'); update(); } catch (error) { toast(error.message, 'error'); }
  const save = event.target.closest('[data-save-assignment]'); if (save) { const id = save.dataset.saveAssignment, selected = document.querySelector(`[data-printer="${id}"]`).value; try { if (selected) await api('/api/assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printer_id: id, spool_id: selected }) }); else await fetch(`/api/assignments/${id}`, { method: 'DELETE' }); toast('Bobine atualizada.'); update(); } catch (error) { toast(error.message, 'error'); } }
  const use = event.target.closest('[data-consume]'); if (use) { const grams = prompt('Gramas consumidos:', '0'); if (Number(grams) > 0) try { await api('/api/consume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printer_id: use.dataset.consume, spool_id: use.dataset.spool, grams: Number(grams) }) }); toast('Consumo registado.'); update(); } catch (error) { toast(error.message, 'error'); } }
  const complete = event.target.closest('[data-complete-order]'); if (complete) try { const result = await api(`/api/orders/${complete.dataset.completeOrder}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast(result.consumed_grams ? `Concluída; ${result.consumed_grams} g descontados.` : 'Encomenda concluída.'); update(); } catch (error) { toast(error.message, 'error'); }
});
document.addEventListener('change', async (event) => {
  if (event.target.matches('[data-order-library-file]')) try { await api(`/api/orders/${event.target.dataset.orderLibraryFile}/library-file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: event.target.value }) }); toast(event.target.value ? 'G-code associado à encomenda.' : 'G-code removido da encomenda.'); update(); } catch (error) { toast(error.message, 'error'); }
  if (event.target.matches('[data-order-printer]')) try { const printer = latest.printers.find((item) => String(item.id) === String(event.target.value)); await api(`/api/orders/${event.target.dataset.orderPrinter}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printer_id: event.target.value || null, printer_model: printer?.model || null, status: event.target.value ? 'queued' : 'received' }) }); toast('Impressora atribuída.'); update(); } catch (error) { toast(error.message, 'error'); }
  if (event.target.matches('[data-file-order]') && event.target.files[0]) { const form = new FormData(); form.append('gcode', event.target.files[0]); const q = prompt('Quantidade de peças:', ''); const material = prompt('Material:', ''); const color = prompt('Cor:', ''); const nozzle = prompt('Bico em mm, ex.: 0.4:', ''); if (q) form.append('quantity', q); if (material) form.append('material', material); if (color) form.append('color', color); if (nozzle) form.append('nozzle', nozzle); try { const result = await api(`/api/orders/${event.target.dataset.fileOrder}/files`, { method: 'POST', body: form }); toast(result.metadata.valid ? 'G-code validado.' : `G-code guardado; falta: ${result.metadata.missing.join(', ')}.`, result.metadata.valid ? 'success' : 'error'); update(); } catch (error) { toast(error.message, 'error'); } }
  if (event.target.name === 'sample_pdf' && event.target.files[0]) { const form = new FormData(); form.append('pdf', event.target.files[0]); try { templatePreview = await api('/api/customers/template-preview', { method: 'POST', body: form }); templateFields = []; $('template-preview').src = templatePreview.image; $('template-workspace').classList.remove('hidden'); renderTemplateFields(); toast('PDF tipo preparado. Agora marca as áreas de leitura.'); } catch (error) { toast(error.message, 'error'); } }
});

['pointerdown', 'pointermove', 'pointerup'].forEach((name) => $('pdf-canvas').addEventListener(name, (event) => {
  const image = $('template-preview'); if (!templatePreview || !image.complete || !image.naturalWidth) return;
  const rect = image.getBoundingClientRect(); const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)); const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
  if (name === 'pointerdown') { templateDrag = { x, y }; $('pdf-canvas').setPointerCapture?.(event.pointerId); }
  if (name === 'pointermove' && templateDrag) { const field = { field: $('template-field').value, left: Math.min(templateDrag.x, x), top: Math.min(templateDrag.y, y), width: Math.abs(x - templateDrag.x), height: Math.abs(y - templateDrag.y) }; renderTemplateFields(); if (field.width > .2 && field.height > .2) { const area = document.createElement('div'); area.className = 'template-area preview'; area.style.left = `${field.left}%`; area.style.top = `${field.top}%`; area.style.width = `${field.width}%`; area.style.height = `${field.height}%`; area.dataset.label = field.field; $('pdf-canvas').append(area); } }
  if (name === 'pointerup' && templateDrag) { const field = { field: $('template-field').value, left: Math.min(templateDrag.x, x), top: Math.min(templateDrag.y, y), width: Math.abs(x - templateDrag.x), height: Math.abs(y - templateDrag.y) }; templateDrag = null; if (field.width < 1 || field.height < 1) return toast('A área marcada é demasiado pequena.', 'error'); templateFields.push(field); renderTemplateFields(); }
}));

for (const id of ['order-form', 'project-form', 'printer-form', 'spool-form', 'customer-form', 'library-part-form']) $(id).addEventListener('submit', async (event) => {
  const formElement = event.currentTarget;
  event.preventDefault(); const values = new FormData(formElement); const form = Object.fromEntries(values.entries()); const endpoint = id === 'order-form' ? '/api/orders' : id === 'project-form' ? '/api/projects' : id === 'printer-form' ? `/api/printers${editingPrinterId ? `/${editingPrinterId}` : ''}` : id === 'spool-form' ? '/api/spools' : id === 'customer-form' ? '/api/customers' : '/api/library-parts'; const method = id === 'printer-form' && editingPrinterId ? 'PUT' : 'POST'; const wasEditingPrinter = id === 'printer-form' && Boolean(editingPrinterId);
  try {
    if (id === 'customer-form') { if (!templatePreview) throw new Error('Seleciona uma encomenda PDF tipo.'); if (!templateFields.length) throw new Error('Marca pelo menos uma área de leitura no PDF.'); form.template = { sample_name: templatePreview.file_name, fields: templateFields }; delete form.sample_pdf; }
    if (id === 'printer-form') { if (form.model === customModelValue) form.model = String(form.custom_model || '').trim(); delete form.custom_model; if (!form.model) throw new Error('Seleciona um modelo ou indica um perfil personalizado.'); }
    if (id === 'order-form') { const pdf = values.get('order_pdf'); delete form.order_pdf; if (pdf instanceof File && pdf.size) { const upload = new FormData(); upload.append('pdf', pdf); if (form.customer_id) upload.append('customer_id', form.customer_id); const draft = await api('/api/orders/import-pdf', { method: 'POST', body: upload }); form.title = form.title || (draft.order_number ? `Encomenda ${draft.order_number}` : pdf.name.replace(/\.pdf$/i, '')); form.customer = form.customer || draft.customer || ''; form.customer_id = draft.customer_id || form.customer_id || ''; form.items = draft.items || []; form.document = { file_name: draft.file_name, order_number: draft.order_number || null, ocr_used: Boolean(draft.ocr_used), template_used: Boolean(draft.template_used), imported_at: new Date().toISOString() }; if (draft.warnings?.length) form.notes = [form.notes, `PDF: ${draft.warnings.join(' ')}`].filter(Boolean).join('\n'); toast(draft.template_used ? 'PDF lido com o modelo do cliente.' : draft.ocr_used ? 'PDF lido por OCR.' : 'Texto do PDF lido automaticamente.'); } if (!String(form.title || '').trim()) throw new Error('Indica um nome ou seleciona um PDF com referência.'); }
    const result = await api(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    formElement.reset(); if (id === 'printer-form') { resetPrinterFormMode(); setPrinterCatalogSelection(); } formElement.classList.add('hidden'); if (id === 'customer-form') { resetTemplateForm(); await refreshCustomers(); } if (id === 'library-part-form') await refreshFiles(); toast(id === 'customer-form' ? 'Cliente e modelo guardados.' : id === 'library-part-form' ? 'Peça criada. Agora adiciona os G-codes.' : id === 'printer-form' ? wasEditingPrinter ? 'Impressora atualizada.' : 'Impressora adicionada ao Production Hub.' : id === 'spool-form' ? 'Bobine adicionada ao inventário do portal.' : 'Registo criado.'); update();
  } catch (error) { toast(error.message, 'error'); }
});
document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!form.matches('.part-upload-form, .gcode-edit-form')) return;
  event.preventDefault();
  try {
    if (form.matches('.part-upload-form')) {
      const values = new FormData(form); values.append('part_id', form.dataset.uploadPart);
      await api('/api/files', { method: 'POST', body: values });
      toast('G-code associado à peça.');
    } else {
      const values = Object.fromEntries(new FormData(form).entries());
      await api(`/api/files/${form.dataset.editGcode}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      toast('Dados técnicos atualizados.');
    }
    await refreshFiles();
  } catch (error) { toast(error.message, 'error'); }
});

function bestGcodeForQuantity(files, quantity, printerModel = '') {
  const active = [...files].filter((file) => file.active !== false);
  const matching = printerModel ? active.filter((file) => file.printer_model === printerModel) : [];
  return (matching.length ? matching : active).sort((left, right) => {
    const leftYield = Math.max(1, Number(left.metadata?.quantity || 1)); const rightYield = Math.max(1, Number(right.metadata?.quantity || 1));
    const leftRuns = Math.ceil(quantity / leftYield); const rightRuns = Math.ceil(quantity / rightYield);
    return (leftRuns * leftYield - quantity) - (rightRuns * rightYield - quantity) || leftRuns - rightRuns;
  })[0];
}
function orderPartLinks(order) {
  return (Array.isArray(order.library_parts) ? order.library_parts : []).map((link) => {
    const part = libraryParts.find((entry) => entry.id === link.part_id);
    if (!part) return { ...link, missing: true };
    const requested = Math.max(1, Number(link.requested_quantity || 1));
    const variants = (part.gcodes || []).filter((file) => file.active !== false);
    const file = variants.find((entry) => entry.id === link.selected_file_id) || bestGcodeForQuantity(variants, requested, order.printer_model);
    if (!file) return { ...link, part, requested, missingGcode: true };
    const piecesPerRun = Math.max(1, Number(file.metadata?.quantity || 1)); const runs = Math.ceil(requested / piecesPerRun);
    return { ...link, part, file, variants, requested, piecesPerRun, runs, produced: runs * piecesPerRun, excess: runs * piecesPerRun - requested };
  });
}
renderOrders = function renderOrdersWithPieces() {
  $('orders-total').textContent = latest.orders.filter((o) => o.status !== 'completed').length;
  $('orders-urgent').textContent = `${latest.orders.filter((o) => Number(o.priority) === 2 && o.status !== 'completed').length} urgentes`;
  const activeOrders = latest.orders.filter((o) => o.status !== 'completed');
  $('order-board').innerHTML = activeOrders.length ? activeOrders.map((o) => {
    const source = o.document?.file_name ? `<span>PDF: ${escape(o.document.file_name)}${o.document.ocr_used ? ' · OCR' : ''}</span>` : '';
    const items = o.items?.length ? `<span>${o.items.length} linha(s) lida(s) no PDF</span>` : '';
    const printerOptions = ['<option value="">Atribuir impressora</option>', ...latest.printers.map((p) => `<option value="${p.id}" ${Number(o.printer_id) === Number(p.id) ? 'selected' : ''}>${escape(p.name)}</option>`)].join('');
    return `<article class="order-card ${Number(o.priority) === 2 ? 'urgent' : ''}"><div class="order-top"><div><p class="eyebrow">${escape(o.id)}</p><h2>${escape(o.title)}</h2><p>${escape(o.customer || 'Sem cliente')} · ${o.due_date ? escape(o.due_date) : 'Sem prazo'}</p></div><span class="badge ${o.status === 'completed' ? 'online' : Number(o.priority) === 2 ? 'printing' : 'offline'}">${escape(o.status)}</span></div><div class="order-meta">${source}${items}<span class="order-gcode-summary">Sem peças/G-codes associados.</span></div><div class="order-actions"><label>Impressora<select data-order-printer="${escape(o.id)}">${printerOptions}</select></label>${o.status !== 'completed' ? `<button class="compact" data-complete-order="${escape(o.id)}">Concluir</button>` : ''}</div></article>`;
  }).join('') : '<p class="empty">Não existem encomendas ativas na fila.</p>';
  renderHistory();
};
function renderHistory() {
  const completed = latest.orders.filter((order) => order.status === 'completed');
  const board = $('history-board'); if (!board) return;
  board.innerHTML = completed.length ? completed.map((order) => {
    const pieces = orderPartLinks(order);
    const summary = pieces.length ? pieces.map((piece) => piece.missing ? 'Peça removida' : piece.missingGcode ? `${escape(piece.part.name)} · sem G-code ativo` : `${escape(piece.part.name)} · ${piece.requested} peça(s) · ${escape(piece.file.original_name)}`).join('<br>') : 'Sem peça associada';
    const finished = order.updated_at ? new Date(order.updated_at).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : '—';
    return `<article class="history-card"><div><p class="eyebrow">${escape(order.id)}</p><h2>${escape(order.title)}</h2><p>${escape(order.customer || 'Sem cliente')}</p></div><div><strong>Concluída</strong><small>${escape(finished)}</small></div><div class="history-pieces">${summary}</div></article>`;
  }).join('') : '<p class="empty">Ainda não existem encomendas concluídas.</p>';
}
renderOrderLibrarySelectors = function renderOrderPieces() {
  document.querySelectorAll('#order-board .order-card').forEach((card, index) => {
    const order = latest.orders.filter((item) => item.status !== 'completed')[index]; const actions = card.querySelector('.order-actions'); if (!order || !actions) return;
    const links = orderPartLinks(order);
    const rows = links.length ? links.map((link) => link.missing
      ? `<div class="order-file-row broken"><span>Peça removida da biblioteca</span><button class="compact danger" data-remove-order-part="${escape(order.id)}" data-library-part-id="${escape(link.part_id)}">Retirar</button></div>`
      : link.missingGcode ? `<div class="order-file-row broken"><span>${escape(link.part.name)} · sem G-code ativo</span><button class="compact danger" data-remove-order-part="${escape(order.id)}" data-library-part-id="${escape(link.part.id)}">Retirar</button></div>`
      : `<div class="order-file-row order-part-row"><div><strong>${escape(link.part.name)}</strong><small>${link.requested} pedidas · ${link.runs} impressão(ões) · ${link.produced} produzidas${link.excess ? ` · excedente ${link.excess}` : ''}</small></div><label>G-code de produção<select data-order-part-gcode="${escape(order.id)}" data-library-part-id="${escape(link.part.id)}"><option value="">Automático · menor excedente</option>${link.variants.map((file) => `<option value="${escape(file.id)}" ${file.id === link.selected_file_id ? 'selected' : ''}>${escape(file.original_name)} · ${escape(file.printer_model || 'sem perfil')} · ${escape(file.metadata?.material || '—')} ${escape(file.metadata?.color || '')} · ${escape(file.metadata?.nozzle || '—')} mm · ${escape(file.metadata?.quantity || 1)} un.</option>`).join('')}</select></label><button class="compact danger" data-remove-order-part="${escape(order.id)}" data-library-part-id="${escape(link.part.id)}">Retirar</button></div>`
    ).join('') : '<p class="empty">Ainda não foram associadas peças a esta encomenda.</p>';
    const selectedIds = new Set(links.map((link) => link.part_id));
    const options = ['<option value="">Selecionar peça</option>', ...libraryParts.filter((part) => !selectedIds.has(part.id) && part.gcodes?.some((file) => file.active !== false)).map((part) => `<option value="${part.id}">${escape(part.name)} · ${part.gcodes.filter((file) => file.active !== false).length} variante(s)</option>`)].join('');
    actions.insertAdjacentHTML('beforeend', `<div class="order-file-links"><strong>Peças pedidas e G-code de produção</strong><div class="order-file-list">${rows}</div><div class="order-file-add"><label>Peça<select data-order-add-part="${escape(order.id)}">${options}</select></label><label>Quantidade pedida<input type="number" min="1" step="1" value="1" data-order-part-quantity="${escape(order.id)}"></label><button class="compact" data-add-order-part="${escape(order.id)}">Adicionar peça</button></div></div>`);
    const summary = card.querySelector('.order-gcode-summary'); if (summary) summary.textContent = links.length ? `${links.length} peça(s) · ${links.reduce((sum, link) => sum + (link.requested || 0), 0)} unidade(s) pedida(s).` : 'Sem peças associadas.';
  });
};
document.addEventListener('click', async (event) => {
  const add = event.target.closest('[data-add-order-part]');
  if (add) {
    const id = add.dataset.addOrderPart;
    const partId = document.querySelector(`[data-order-add-part="${id}"]`)?.value;
    const quantity = document.querySelector(`[data-order-part-quantity="${id}"]`)?.value;
    try { await api(`/api/orders/${id}/library-parts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ part_id: partId, requested_quantity: quantity }) }); toast('Peça associada à encomenda.'); update(); } catch (error) { toast(error.message, 'error'); }
  }
  const remove = event.target.closest('[data-remove-order-part]');
  if (remove && confirm('Retirar esta peça da encomenda? A biblioteca não será alterada.')) {
    try { await api(`/api/orders/${remove.dataset.removeOrderPart}/library-parts/${remove.dataset.libraryPartId}`, { method: 'DELETE' }); toast('Peça retirada da encomenda.'); update(); } catch (error) { toast(error.message, 'error'); }
  }
});
document.addEventListener('change', async (event) => {
  const selector = event.target.closest('[data-order-part-gcode]');
  if (!selector) return;
  try {
    await api(`/api/orders/${selector.dataset.orderPartGcode}/library-parts/${selector.dataset.libraryPartId}/gcode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: selector.value }) });
    toast(selector.value ? 'G-code de produção selecionado.' : 'Seleção automática ativada.'); await update();
  } catch (error) { toast(error.message, 'error'); }
});
let selectedFarmProjectId = null;
let selectedFarmProject = null;

function projectEditorIdFromPath() {
  const match = window.location.pathname.match(/^\/projetos\/(\d+)\/?$/);
  return match ? Number(match[1]) : null;
}
function isProjectEditorPage() { return Boolean(projectEditorIdFromPath()); }
function showProjectEditorPage(projectId) {
  selectedFarmProjectId = Number(projectId);
  document.body.classList.add('project-editor-page');
  const productionTab = document.querySelector('[data-view="production"]');
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === productionTab));
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === 'production'));
}
function openProjectEditorPage(projectId) {
  window.location.assign(`/projetos/${encodeURIComponent(projectId)}`);
}

function projectStatusLabel(status) {
  return ({ draft: 'Rascunho', active: 'Ativo', paused: 'Pausado', completed: 'Concluído' })[String(status || '').toLowerCase()] || value(status);
}
function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  if (!total) return '—';
  const hours = Math.floor(total / 3600); const minutes = Math.round((total % 3600) / 60);
  return hours ? `${hours} h ${minutes} m` : `${minutes} min`;
}
function farmModelOptions(selected = '', excluded = []) {
  const blocked = new Set(excluded.map((model) => String(model || '').trim()));
  const models = [...new Set(latest.printers.map((printer) => String(printer.model || '').trim()).filter(Boolean))].filter((model) => !blocked.has(model)).sort();
  return ['<option value="">Selecionar modelo</option>', ...models.map((model) => `<option value="${escape(model)}" ${model === selected ? 'selected' : ''}>${escape(model)}</option>`)].join('');
}
function libraryFileOptions() {
  return ['<option value="">Selecionar G-code da biblioteca</option>', ...libraryFiles.map((file) => `<option value="${escape(file.id)}">${escape(file.original_name)} · ${escape(file.metadata?.quantity || '—')} peças · ${escape(file.metadata?.material || '—')} ${escape(file.metadata?.color || '')}</option>`)].join('');
}
function libraryPartOptions() {
  return ['<option value="">Selecionar peça da biblioteca</option>', ...libraryParts.filter((part) => part.gcodes?.some((file) => file.active !== false)).map((part) => `<option value="${escape(part.id)}">${escape(part.name)} · ${part.gcodes.filter((file) => file.active !== false).length} G-code(s)</option>`)].join('');
}
function setupProjectWorkspace() {
  const projectPanel = $('project-list')?.closest('.table-panel');
  if (!projectPanel || $('project-workspace')) return;
  const workspace = document.createElement('section');
  workspace.className = 'project-workspace hidden';
  workspace.id = 'project-workspace';
  projectPanel.insertAdjacentElement('afterend', workspace);
}
async function refreshSelectedProject() {
  if (!selectedFarmProjectId) return;
  selectedFarmProject = await api(`/api/projects/${encodeURIComponent(selectedFarmProjectId)}/details`);
  renderProjectWorkspace();
}
function closeProjectWorkspace() {
  if (isProjectEditorPage()) { window.location.assign('/'); return; }
  selectedFarmProjectId = null; selectedFarmProject = null;
  const workspace = $('project-workspace'); if (workspace) { workspace.classList.add('hidden'); workspace.innerHTML = ''; }
}
function projectActions(project) {
  const status = String(project.status || 'draft').toLowerCase();
  const controls = [];
  if (status === 'draft' || status === 'paused') controls.push('<button class="compact" data-project-action="activate">Ativar fila</button>');
  if (status === 'active') controls.push('<button class="compact secondary" data-project-action="pause">Pausar fila</button>');
  if (status !== 'completed') controls.push('<button class="compact secondary" data-project-action="complete">Concluir agora</button>');
  if (status === 'completed') controls.push('<button class="compact" data-project-action="reactivate">Reativar</button>');
  controls.push('<button class="compact secondary" data-project-action="duplicate">Duplicar</button>');
  if (status === 'draft') controls.push(`<button class="compact danger" data-delete-project="${escape(project.id)}" data-project-name="${escape(project.name || `Projeto #${project.id}`)}">Apagar</button>`);
  return controls.join('');
}
function partGcodeRows(part) {
  if (!part.gcodes?.length) return '<p class="empty compact-empty">Ainda não existe G-code associado a esta peça.</p>';
  return `<div class="farm-gcode-list">${part.gcodes.map((gcode) => `<div class="farm-gcode-row"><div><strong>${escape(gcode.filename)}</strong><small>${escape(gcode.printer_model)} · ${gcode.parts_per_plate} peça(s)/execução · ${formatDuration(gcode.est_print_secs)} · ${gcode.material_grams || '—'} g</small></div><button class="compact danger" data-delete-farm-gcode="${gcode.id}">Retirar</button></div>`).join('')}</div>`;
}
function renderProjectWorkspace() {
  const workspace = $('project-workspace'); if (!workspace) return;
  if (!selectedFarmProject) { workspace.classList.add('hidden'); return; }
  const { project, parts } = selectedFarmProject;
  const target = parts.reduce((sum, part) => sum + (Number(part.target_qty) || 0), 0);
  const done = parts.reduce((sum, part) => sum + (Number(part.completed_qty) || 0), 0);
  const active = parts.reduce((sum, part) => sum + (Number(part.active_qty) || 0), 0);
  const percent = target ? Math.min(100, Math.round((done / target) * 100)) : 0;
  workspace.classList.remove('hidden');
  workspace.innerHTML = `<article class="project-console"><div class="project-console-header"><div><button class="text-button" data-close-project>← Projetos</button><p class="eyebrow">PROJETO #${escape(project.id)}</p><h2>${escape(project.name)}</h2><p>${escape(project.description || 'Sem descrição')}</p></div><div class="project-status"><span class="badge ${statusClass(project.status)}">${projectStatusLabel(project.status)}</span><strong>${done} / ${target} peças</strong><small>${active} em produção · ${percent}% concluído</small></div></div><div class="project-progress"><span style="width:${percent}%"></span></div><div class="project-action-bar">${projectActions(project)}</div><form id="project-edit-form" class="project-edit-form"><label>Nome do projeto<input name="name" required maxlength="120" value="${escape(project.name || '')}"></label><label>Descrição<input name="description" maxlength="500" value="${escape(project.description || '')}" placeholder="Notas de produção, cliente ou prazo"></label><button class="compact secondary" type="submit">Guardar alterações</button></form><form id="project-filament-form" class="project-defaults-form"><input type="hidden" name="project_id" value="${escape(project.id)}"><label>Material padrão<input name="required_material" value="${escape(project.required_material || '')}" placeholder="Ex.: PETG"></label><label>Cor padrão<input name="required_color" value="${escape(project.required_color || '')}" placeholder="Ex.: Preto"></label><button class="compact secondary" type="submit">Guardar requisitos</button><small>Estes valores são usados por defeito no despacho automático.</small></form></article><article class="project-parts-panel"><div class="panel-heading"><div><p class="eyebrow">PLANO DE PRODUÇÃO</p><h2>Peças do projeto</h2></div><span>${parts.length} peça(s)</span></div><form id="project-part-form" class="project-part-form"><label>Nova peça<input name="name" required maxlength="120" placeholder="Ex.: Suporte lateral"></label><label>Quantidade a produzir<input name="target_qty" type="number" min="1" step="1" required value="1"></label><button class="compact" type="submit">Adicionar peça</button></form><div class="project-parts-list">${parts.length ? parts.map((part) => {
    const remaining = Math.max(0, Number(part.target_qty || 0) - Number(part.completed_qty || 0));
    const dispatch = part.dispatch || {}; const notes = [...(dispatch.reasons || []), ...(dispatch.notes || [])];
    return `<article class="project-part-card"><div class="part-heading"><div><p class="eyebrow">PEÇA #${escape(part.id)}</p><h3>${escape(part.name)}</h3><p>${part.completed_qty} concluídas · ${part.active_qty || 0} em produção · faltam ${remaining}</p></div><div><span class="badge ${part.status === 'open' ? 'printing' : 'online'}">${part.status === 'open' ? 'Aberta' : 'Fechada'}</span><button class="compact danger" data-delete-part="${part.id}" data-part-name="${escape(part.name)}">Apagar</button></div></div><div class="part-meter"><span style="width:${Math.min(100, (Number(part.completed_qty || 0) / Math.max(1, Number(part.target_qty || 1))) * 100)}%"></span></div><form class="part-edit-form" data-edit-part="${part.id}"><label>Meta<input name="target_qty" type="number" min="1" step="1" value="${escape(part.target_qty)}"></label><label>Peças boas concluídas<input name="completed_qty" type="number" min="0" step="1" value="${escape(part.completed_qty)}"></label><button class="compact secondary" type="submit">Atualizar quantidades</button></form><div class="dispatch-state ${dispatch.dispatchable ? 'ready' : 'blocked'}"><strong>${dispatch.dispatchable ? 'Pronta para despacho automático' : 'A aguardar condições para despacho'}</strong>${notes.length ? `<ul>${notes.map((note) => `<li>${escape(note)}</li>`).join('')}</ul>` : '<small>Existe pelo menos uma impressora compatível e livre.</small>'}</div><section class="part-gcodes"><div class="part-subheading"><h4>G-codes na farm</h4><span>um por modelo de impressora</span></div>${partGcodeRows(part)}<form class="part-gcode-form" data-part-gcode="${part.id}"><label>G-code da biblioteca<select name="file_id" required>${libraryFileOptions()}</select></label><label>Modelo de impressora<select name="printer_model" required>${farmModelOptions('', (part.gcodes || []).map((gcode) => gcode.printer_model))}</select></label><label>Peças por execução<input name="parts_per_plate" type="number" min="1" step="1" value="1" required></label><button class="compact" type="submit">Adicionar variante</button><small>Seleciona um modelo ainda sem G-code; o ficheiro original mantém-se na Biblioteca.</small></form></section></article>`;
  }).join('') : '<p class="empty">Adiciona a primeira peça e define a quantidade a produzir.</p>'}</div></article>`;
}
function filenameAsPartName(file) {
  return String(file?.original_name || '').replace(/\.(gcode|gco)$/i, '').replace(/[_-]+/g, ' ').trim();
}
function projectPartFormMarkup() {
  return `<form id="project-part-form" class="project-part-form library-production-form"><label>Peça da biblioteca<select name="library_part_id" required>${libraryPartOptions()}</select></label><label>Quantidade a produzir<input name="target_qty" type="number" min="1" step="1" required value="1"></label><button class="compact" type="submit">Adicionar peça à produção</button><small>Todos os G-codes ativos da peça são copiados para a farm. O sistema poderá usar qualquer variante compatível.</small></form>`;
}
const renderProjectWorkspaceBase = renderProjectWorkspace;
renderProjectWorkspace = function renderProjectWorkspaceFromLibrary() {
  renderProjectWorkspaceBase();
  const workspace = $('project-workspace');
  const oldForm = workspace?.querySelector('#project-part-form');
  if (oldForm) oldForm.outerHTML = projectPartFormMarkup();
};
renderProduction = function renderProductionWithFarmProjects(projects, jobs) {
  $('jobs-count').textContent = `${jobs.length} total`;
  $('projects-count').textContent = `${projects.length} total`;
  $('job-list').innerHTML = jobs.length ? jobs.slice(0, 12).map((job) => `<div class="data-row"><div><strong>${value(job.part_name || job.name, `Trabalho #${job.id}`)}</strong><small>${value(job.printer_name, 'Impressora não atribuída')}</small></div><span class="badge ${statusClass(job.status)}">${value(job.status)}</span></div>`).join('') : '<p class="empty">Ainda não existem trabalhos.</p>';
  $('project-list').innerHTML = projects.length ? projects.map((project, index) => `<div class="data-row project-row ${Number(project.id) === Number(selectedFarmProjectId) ? 'selected' : ''}"><div><strong>${value(project.name, `Projeto #${project.id}`)}</strong><small>${value(project.description, 'Sem descrição')}</small></div><div class="project-row-actions"><span class="badge ${statusClass(project.status)}">${projectStatusLabel(project.status)}</span><button class="compact secondary" data-move-project="${project.id}" data-move-direction="up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="compact secondary" data-move-project="${project.id}" data-move-direction="down" ${index === projects.length - 1 ? 'disabled' : ''}>↓</button><button class="compact" data-open-project="${project.id}">Editar</button>${String(project.status || 'draft') === 'draft' ? `<button class="compact danger" data-delete-project="${escape(project.id)}" data-project-name="${escape(project.name || `Projeto #${project.id}`)}">Apagar</button>` : ''}</div></div>`).join('') : '<p class="empty">Ainda não existem projetos.</p>';
};
document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!form.matches('#project-part-form, #project-edit-form, #project-filament-form, .part-edit-form, .part-gcode-form')) return;
  event.preventDefault();
  if (!selectedFarmProject) return;
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.id === 'project-part-form') await api(`/api/projects/${selectedFarmProject.project.id}/library-part`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    if (form.id === 'project-edit-form') await api(`/api/projects/${selectedFarmProject.project.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    if (form.id === 'project-filament-form') await api(`/api/projects/${selectedFarmProject.project.id}/filament`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    if (form.matches('.part-edit-form')) {
      if (!confirm('Confirmas as quantidades concluídas? Esta alteração pode reabrir ou fechar a peça na fila.')) return;
      await api(`/api/parts/${form.dataset.editPart}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    }
    if (form.matches('.part-gcode-form')) await api(`/api/projects/${selectedFarmProject.project.id}/parts/${form.dataset.partGcode}/library-gcode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    toast(form.matches('.part-gcode-form') ? 'Nova variante de G-code copiada para a farm.' : form.id === 'project-part-form' ? 'Peça criada a partir da Biblioteca.' : 'Projeto atualizado.');
    await refreshSelectedProject(); await update();
  } catch (error) { toast(error.message, 'error'); }
});
document.addEventListener('click', async (event) => {
  const openProject = event.target.closest('[data-open-project]');
  const closeProject = event.target.closest('[data-close-project]');
  const removeProject = event.target.closest('[data-delete-project]');
  const moveProject = event.target.closest('[data-move-project]');
  const action = event.target.closest('[data-project-action]');
  const removePart = event.target.closest('[data-delete-part]');
  const removeFarmGcode = event.target.closest('[data-delete-farm-gcode]');
  try {
    if (openProject) { openProjectEditorPage(openProject.dataset.openProject); return; }
    if (closeProject) { closeProjectWorkspace(); return; }
    if (removeProject) {
      const name = removeProject.dataset.projectName || 'este projeto';
      if (!confirm(`Apagar ${name}? Esta ação remove as peças, os G-codes e os trabalhos associados.`)) return;
      await api(`/api/projects/${encodeURIComponent(removeProject.dataset.deleteProject)}`, { method: 'DELETE' });
      if (Number(removeProject.dataset.deleteProject) === Number(selectedFarmProjectId)) closeProjectWorkspace();
      toast('Projeto apagado.'); await update(); return;
    }
    if (moveProject) {
      const projects = [...document.querySelectorAll('#project-list [data-open-project]')].map((button) => Number(button.dataset.openProject));
      const index = projects.indexOf(Number(moveProject.dataset.moveProject)); const next = index + (moveProject.dataset.moveDirection === 'up' ? -1 : 1);
      if (index < 0 || next < 0 || next >= projects.length) return;
      [projects[index], projects[next]] = [projects[next], projects[index]];
      await api('/api/projects/reorder', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: projects }) }); toast('Prioridade da fila atualizada.'); await update(); return;
    }
    if (action && selectedFarmProject) {
      const projectId = selectedFarmProject.project.id; const kind = action.dataset.projectAction;
      if (kind === 'activate') { await api(`/api/projects/${projectId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }) }); await api('/api/scheduler/dispatch', { method: 'POST' }); toast('Projeto ativado e fila analisada.'); }
      if (kind === 'pause') { await api(`/api/projects/${projectId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'paused' }) }); toast('Projeto pausado. Não serão enviados novos trabalhos.'); }
      if (kind === 'complete') { if (!confirm('Concluir o projeto agora? As peças por completar serão fechadas e trabalhos ainda na fila serão cancelados.')) return; await api(`/api/projects/${projectId}/complete`, { method: 'POST' }); toast('Projeto concluído.'); }
      if (kind === 'reactivate') { await api(`/api/projects/${projectId}/reactivate`, { method: 'POST' }); toast('Projeto reativado.'); }
      if (kind === 'duplicate') { const name = prompt('Nome da cópia:', `Cópia de ${selectedFarmProject.project.name}`); if (name === null) return; const result = await api(`/api/projects/${projectId}/duplicate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); selectedFarmProjectId = result.project?.id || selectedFarmProjectId; toast('Projeto duplicado como rascunho.'); }
      await refreshSelectedProject(); await update(); return;
    }
    if (removePart) { if (!confirm(`Apagar a peça ${removePart.dataset.partName}? Os trabalhos e G-codes desta peça serão removidos.`)) return; await api(`/api/parts/${removePart.dataset.deletePart}`, { method: 'DELETE' }); toast('Peça apagada.'); await refreshSelectedProject(); await update(); return; }
    if (removeFarmGcode) { if (!confirm('Retirar este G-code da farm? O ficheiro original permanece na Biblioteca.')) return; await api(`/api/gcodes/${removeFarmGcode.dataset.deleteFarmGcode}`, { method: 'DELETE' }); toast('G-code retirado da farm.'); await refreshSelectedProject(); await update(); }
  } catch (error) { toast(error.message, 'error'); }
});
function setupOverviewLayout() {
  const overview = $('overview');
  const fleet = overview?.querySelector('.fleet');
  const actions = overview?.querySelector('.actions');
  if (!overview || !fleet || !actions || $('overview-order-queue')) return;

  fleet.classList.add('overview-printers-panel');
  fleet.querySelector('.panel-heading').innerHTML = '<div><p class="eyebrow">FARM</p><h2>Impressoras ativas</h2></div><span class="integration-label">Ver todas</span>';

  const queue = document.createElement('article');
  queue.className = 'panel overview-queue-panel';
  queue.innerHTML = '<div class="panel-heading"><div><p class="eyebrow">PRODUCAO</p><h2>Fila de producao</h2></div><span class="integration-label">Encomendas ativas</span></div><div class="overview-queue-head"><span>Referencia</span><span>Encomenda</span><span>Cliente</span><span>Estado</span></div><div id="overview-order-queue"></div>';
  fleet.insertAdjacentElement('afterend', queue);

  actions.classList.add('overview-sidebar');
  actions.innerHTML = '<section class="overview-side-panel"><div class="panel-heading"><div><p class="eyebrow">INVENTARIO</p><h2>Alertas de material</h2></div><span class="integration-label">Stock</span></div><div id="overview-material-alerts"></div></section><section class="overview-side-panel"><div class="panel-heading"><div><p class="eyebrow">SISTEMA</p><h2>Estado do sistema</h2></div></div><div id="overview-system-status"></div></section>';
}

function overviewPrinterCard(printer) {
  const rawProgress = Number(printer.job_progress || 0);
  const progress = rawProgress * (rawProgress <= 1 ? 100 : 1);
  const state = statusClass(printer.status);
  return `<article class="overview-printer-card ${state}"><div class="overview-printer-title"><div><strong>${value(printer.name, 'Sem nome')}</strong><small>${state === 'printing' ? 'A imprimir' : value(printer.status, 'Offline')}</small></div><span class="status ${state}"></span></div><div class="overview-printer-preview" aria-hidden="true"><span></span><i></i></div><p>${value(printer.job_name, 'Sem trabalho ativo')}</p><div class="overview-progress"><span style="width:${Math.max(0, Math.min(100, progress || (state === 'printing' ? 4 : 0)))}%"></span></div><div class="overview-printer-footer"><small>${progress ? `${Math.round(progress)}% concluido` : value(printer.model || printer.type, 'Impressora')}</small><small>${state === 'printing' ? 'Em curso' : 'Livre'}</small></div></article>`;
}

function renderOverviewFromCurrent() {
  const printerList = $('printer-list');
  if (printerList) {
    const printers = latest.printers.slice(0, 5);
    printerList.innerHTML = printers.length ? printers.map(overviewPrinterCard).join('') : '<p class="empty overview-empty">Ainda nao existem impressoras configuradas. Adiciona a primeira no menu Impressoras.</p>';
  }

  const queue = $('overview-order-queue');
  if (queue) {
    const orders = latest.orders.filter((order) => order.status !== 'completed').slice(0, 5);
    queue.innerHTML = orders.length ? orders.map((order) => `<div class="overview-queue-row"><span>${escape(order.id)}</span><strong>${escape(order.title)}</strong><small>${escape(order.customer || 'Sem cliente')}</small><em class="${Number(order.priority) === 2 ? 'urgent' : ''}">${Number(order.priority) === 2 ? 'Urgente' : escape(order.status || 'Recebida')}</em></div>`).join('') : '<p class="empty overview-empty">Nao existem encomendas ativas na fila.</p>';
  }

  const alerts = $('overview-material-alerts');
  if (alerts) {
    const low = latest.spools.filter((spool) => { const grams = spoolInfo(spool).remaining; return grams > 0 && grams < 200; }).slice(0, 5);
    alerts.innerHTML = low.length ? low.map((spool) => { const info = spoolInfo(spool); return `<div class="overview-alert-row"><span class="alert-symbol">!</span><div><strong>${escape(info.material)}</strong><small>Bobine #${spool.id}</small></div><span>${info.remaining} g</span><em>Baixo stock</em></div>`; }).join('') : '<p class="empty overview-empty">Sem alertas de material.</p>';
  }

  const system = $('overview-system-status');
  if (system) {
    const connected = $('live-dot')?.classList.contains('connected');
    system.innerHTML = `<div class="overview-system-icons"><span></span><span></span><span></span><span></span></div><div class="overview-system-row"><span>Rede</span><strong class="${connected ? 'is-online' : 'is-warning'}">${connected ? 'Online' : 'Verificar'}</strong></div><div class="overview-system-row"><span>Servidor</span><strong>${escape($('system-host')?.textContent || 'LattePanda')}</strong></div><div class="overview-system-row"><span>Memoria</span><strong>${escape($('system-memory')?.textContent || '-')}</strong></div>`;
  }
}

setupOverviewLayout();
setupProjectWorkspace();
setupPrinterCatalog();
const initialProjectEditorId = projectEditorIdFromPath();
if (initialProjectEditorId) showProjectEditorPage(initialProjectEditorId);
populateFilaments(); refreshCustomers(); refreshFiles(); update().finally(async () => {
  renderOverviewFromCurrent();
  if (initialProjectEditorId) {
    try { await refreshSelectedProject(); } catch (error) { toast(error.message, 'error'); }
  }
}); setInterval(() => update().finally(renderOverviewFromCurrent), 15000);
