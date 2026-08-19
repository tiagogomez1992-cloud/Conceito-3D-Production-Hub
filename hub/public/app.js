const $ = (id) => document.getElementById(id);
let latest = { printers: [], spools: [], assignments: {}, orders: [] };
let customers = [];
let libraryFiles = [];
let templatePreview = null;
let templateFields = [];
let templateDrag = null;
const escape = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const value = (v, fallback = '—') => v === undefined || v === null || v === '' ? fallback : escape(v);
const statusClass = (v) => String(v || '').toLowerCase() === 'printing' ? 'printing' : ['idle', 'finished', 'online', 'paused', 'completed'].includes(String(v || '').toLowerCase()) ? 'online' : 'offline';
const spoolInfo = (spool) => ({ material: spool?.filament?.material || spool?.filament?.name || 'Material não definido', remaining: Math.round(Number(spool?.remaining_weight || 0)) });
function toast(message, kind = 'success') { const t = $('toast'); t.textContent = message; t.className = `toast show ${kind}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.className = 'toast'; }, 4200); }
async function api(url, options = {}) { const r = await fetch(url, options); const body = await r.json().catch(() => ({})); if (!r.ok) throw new Error(body.error || 'O pedido não foi aceite.'); return body; }
function selectOptions(selected) { return ['<option value="">Sem bobine atribuída</option>', ...latest.spools.map((s) => `<option value="${s.id}" ${Number(selected) === Number(s.id) ? 'selected' : ''}>#${s.id} · ${escape(spoolInfo(s).material)} · ${spoolInfo(s).remaining} g</option>`)].join(''); }

function renderPrinters(items) {
  $('printer-list').innerHTML = items.length ? items.map((p) => { const progress = Number(p.job_progress || 0) * (Number(p.job_progress || 0) <= 1 ? 100 : 1); return `<div class="printer-row"><span class="status ${statusClass(p.status)}"></span><div class="printer-name"><strong>${value(p.name, 'Sem nome')}</strong><small>${value(p.model || p.type, 'Impressora')}</small></div><div class="job"><strong>${value(p.job_name, 'Sem trabalho ativo')}</strong><small>${progress ? `${Math.round(progress)}%` : value(p.status)}</small></div><span class="badge ${statusClass(p.status)}">${value(p.status)}</span></div>`; }).join('') : '<p class="empty">Ainda não há impressoras configuradas.</p>';
  $('printer-grid').innerHTML = items.length ? items.map((p) => { const spool = assigned(p.id); const a = latest.assignments?.[String(p.id)]; return `<article class="machine-card"><div class="machine-top"><div><span class="status ${statusClass(p.status)}"></span><strong>${value(p.name, 'Sem nome')}</strong></div><span class="badge ${statusClass(p.status)}">${value(p.status)}</span></div><dl><div><dt>Modelo</dt><dd>${value(p.model)}</dd></div><div><dt>Trabalho</dt><dd>${value(p.job_name, 'Sem trabalho ativo')}</dd></div><div><dt>Bobine</dt><dd>${spool ? `#${spool.id} · ${escape(spoolInfo(spool).material)} · ${spoolInfo(spool).remaining} g` : 'Não atribuída'}</dd></div></dl><div class="machine-actions"><label>Trocar bobine<select data-printer="${p.id}">${selectOptions(a?.spool_id)}</select></label><button class="compact" data-save-assignment="${p.id}">Guardar</button>${spool ? `<button class="compact secondary" data-consume="${p.id}" data-spool="${spool.id}">Registar consumo</button>` : ''}</div></article>`; }).join('') : '<p class="empty">Ainda não há impressoras configuradas.</p>';
}
function renderDiscovery(data) {
  const box = $('discovery-results'); box.classList.remove('hidden');
  const networks = (data.networks || []).map((network) => `${network.subnet}.0/24`).join(', ');
  box.innerHTML = `<div class="discovery-heading"><div><p class="eyebrow">DESCOBERTA LOCAL</p><h2>${data.printers?.length || 0} impressora(s) encontrada(s)</h2><p>Rede analisada: ${escape(networks || 'não identificada')}</p></div></div>${data.printers?.length ? `<div class="discovery-grid">${data.printers.map((printer) => `<article class="discovery-card"><span class="status online"></span><div><strong>${escape(printer.detected_as)}</strong><small>${escape(printer.ip)}${printer.port !== 80 ? `:${printer.port}` : ''}</small></div><button class="compact" data-add-discovered='${escape(JSON.stringify(printer))}'>Preparar adição</button></article>`).join('')}</div>` : '<p class="empty">Não foram encontrados serviços Moonraker, OctoPrint ou PrusaLink nesta rede. Impressoras sem API local terão de ser adicionadas manualmente.</p>'}`;
}
function renderSpools() { $('spool-grid').innerHTML = latest.spools.length ? latest.spools.map((s) => { const info = spoolInfo(s); const low = info.remaining > 0 && info.remaining < 200; return `<article class="spool-card"><div class="spool-swatch" style="background:${escape(s.filament?.color_hex || '#6f747a')}"></div><div><p class="eyebrow">BOBINE #${s.id}</p><h2>${escape(info.material)}</h2><p>${escape(s.filament?.vendor?.name || 'Sem fabricante')}</p></div><div class="spool-weight ${low ? 'low' : ''}"><strong>${info.remaining || 'Sem peso'}${info.remaining ? ' g' : ''}</strong><small>${low ? 'Abaixo de 200 g' : 'Disponível'}</small></div></article>`; }).join('') : '<p class="empty">Ainda não há bobines no Spoolman.</p>'; }
function renderProduction(projects, jobs) { $('jobs-count').textContent = `${jobs.length} total`; $('projects-count').textContent = `${projects.length} total`; $('job-list').innerHTML = jobs.length ? jobs.slice(0, 12).map((j) => `<div class="data-row"><div><strong>${value(j.part_name || j.name, `Trabalho #${j.id}`)}</strong><small>${value(j.printer_name, 'Impressora não atribuída')}</small></div><span class="badge ${statusClass(j.status)}">${value(j.status)}</span></div>`).join('') : '<p class="empty">Ainda não existem trabalhos.</p>'; $('project-list').innerHTML = projects.length ? projects.slice(0, 12).map((p) => `<div class="data-row"><div><strong>${value(p.name, `Projeto #${p.id}`)}</strong><small>${value(p.description, 'Sem descrição')}</small></div><span class="badge ${Number(p.priority) > 1 ? 'printing' : statusClass(p.status)}">${Number(p.priority) > 1 ? 'urgente' : value(p.status)}</span></div>`).join('') : '<p class="empty">Ainda não existem projetos.</p>'; }
function renderOrders() { $('orders-total').textContent = latest.orders.filter((o) => o.status !== 'completed').length; $('orders-urgent').textContent = `${latest.orders.filter((o) => Number(o.priority) === 2 && o.status !== 'completed').length} urgentes`; $('order-board').innerHTML = latest.orders.length ? latest.orders.map((o) => { const file = o.files?.[0]; const meta = file?.metadata; const source = o.document?.file_name ? `<span>PDF: ${escape(o.document.file_name)}${o.document.ocr_used ? ' · OCR' : ''}</span>` : ''; const items = o.items?.length ? `<span>${o.items.length} linha(s) lida(s) no PDF</span>` : ''; const printerOptions = ['<option value="">Atribuir impressora</option>', ...latest.printers.map((p) => `<option value="${p.id}" ${Number(o.printer_id) === Number(p.id) ? 'selected' : ''}>${escape(p.name)}</option>`)].join(''); return `<article class="order-card ${Number(o.priority) === 2 ? 'urgent' : ''}"><div class="order-top"><div><p class="eyebrow">${escape(o.id)}</p><h2>${escape(o.title)}</h2><p>${escape(o.customer || 'Sem cliente')} · ${o.due_date ? escape(o.due_date) : 'Sem prazo'}</p></div><span class="badge ${o.status === 'completed' ? 'online' : Number(o.priority) === 2 ? 'printing' : 'offline'}">${escape(o.status)}</span></div><div class="order-meta">${source}${items}${meta ? `<span>${meta.valid ? '✓ Metadados validados' : `⚠ Falta: ${escape(meta.missing.join(', '))}`}</span><span>${meta.quantity || '—'} peças · ${escape(meta.material || '—')} · bico ${meta.nozzle || '—'} mm</span>` : '<span>Sem G-code</span>'}</div><div class="order-actions"><label>Impressora<select data-order-printer="${escape(o.id)}">${printerOptions}</select></label><label class="file-upload">G-code<input type="file" accept=".gcode,.gco" data-file-order="${escape(o.id)}"><span>Enviar G-code</span></label>${o.status !== 'completed' ? `<button class="compact" data-complete-order="${escape(o.id)}">Concluir</button>` : ''}</div></article>`; }).join('') : '<p class="empty">Ainda não existem encomendas.</p>'; }
function renderOrderRemovalButtons() { document.querySelectorAll('#order-board .order-card').forEach((card, index) => { const order = latest.orders[index]; const actions = card.querySelector('.order-actions'); if (order && actions) actions.insertAdjacentHTML('beforeend', `<button class="compact danger" data-delete-order="${escape(order.id)}">Remover</button>`); }); }
function renderOrderLibrarySelectors() { document.querySelectorAll('#order-board .order-card').forEach((card, index) => { const order = latest.orders[index]; const actions = card.querySelector('.order-actions'); if (!order || !actions) return; card.querySelector('.file-upload')?.remove(); const selected = order.library_file_id || ''; const options = ['<option value="">Associar G-code da biblioteca</option>', ...libraryFiles.map((file) => `<option value="${file.id}" ${file.id === selected ? 'selected' : ''}>${escape(file.original_name)} · ${escape(file.metadata?.material || '—')} ${escape(file.metadata?.color || '')}</option>`)].join(''); actions.insertAdjacentHTML('beforeend', `<label>G-code<select data-order-library-file="${escape(order.id)}">${options}</select></label>`); const file = libraryFiles.find((entry) => entry.id === selected); if (file) card.querySelector('.order-meta')?.insertAdjacentHTML('afterbegin', `<span>G-code: ${escape(file.original_name)} · ${escape(file.metadata?.quantity)} peças · ${escape(file.metadata?.material)} ${escape(file.metadata?.color)}</span>`); }); }
function renderFiles() { $('file-grid').innerHTML = libraryFiles.length ? libraryFiles.map((file) => { const meta = file.metadata || {}; return `<article class="file-card"><img src="${escape(file.thumbnail?.url || '')}" alt="Thumbnail de ${escape(file.original_name)}"><div class="file-card-body"><p class="eyebrow">${file.thumbnail?.embedded ? 'PREVIEW DO SLICER' : 'FICHEIRO G-CODE'}</p><h2>${escape(file.original_name)}</h2><p>${escape(meta.material || '—')} · ${escape(meta.color || '—')}</p><dl><div><dt>Peças</dt><dd>${escape(meta.quantity || '—')}</dd></div><div><dt>Bico</dt><dd>${escape(meta.nozzle || '—')} mm</dd></div><div><dt>Tamanho</dt><dd>${Math.max(1, Math.round(Number(file.size_bytes || 0) / 1024))} KB</dd></div></dl><button class="compact secondary" data-delete-file="${file.id}">Remover</button></div></article>`; }).join('') : '<p class="empty">Ainda não existem G-codes guardados.</p>'; }

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

async function populateFilaments() { try { const data = await api('/api/filaments'); $('filament-select').innerHTML = ['<option value="">Selecionar filamento</option>', ...data.map((f) => `<option value="${f.id}">${escape([f.vendor?.name, f.name || f.material, f.color_name || f.color_hex].filter(Boolean).join(' · '))}</option>`)].join(''); } catch { $('filament-select').innerHTML = '<option>Spoolman indisponível</option>'; } }
async function refreshCustomers() { try { customers = await api('/api/customers'); renderCustomers(); } catch { $('customer-grid').innerHTML = '<p class="empty">Não foi possível carregar os clientes.</p>'; } }
async function refreshFiles() { try { libraryFiles = await api('/api/files'); renderFiles(); if (latest.orders.length) { renderOrders(); renderOrderLibrarySelectors(); renderOrderRemovalButtons(); } } catch { $('file-grid').innerHTML = '<p class="empty">Não foi possível carregar a biblioteca.</p>'; } }
async function update() { $('refresh').disabled = true; try { const data = await api('/api/summary'); latest = { printers: data.printers.items, spools: data.spools.items, assignments: data.assignments || {}, orders: data.production.orders || [] }; $('printers-total').textContent = data.printers.total; $('printers-online').textContent = `${data.printers.online} online`; $('printers-printing').textContent = data.printers.printing; $('spools-total').textContent = data.spools.total; $('spools-low').textContent = data.spools.low ? `${data.spools.low} abaixo de 200 g` : 'Sem alertas'; $('live-dot').className = data.services.printFarmManager && data.services.spoolman ? 'connected' : 'warning'; $('last-update').textContent = `Atualizado às ${new Date(data.generatedAt).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}`; $('system-host').textContent = data.system.hostname; $('system-up').textContent = `${Math.floor(data.system.uptime_seconds / 3600)} h ativo`; $('system-memory').textContent = `${data.system.memory_used_mb} MB`; $('system-load').textContent = data.system.cpu_load_1m; renderPrinters(latest.printers); renderSpools(); renderProduction(data.production.projects, data.production.jobs); renderOrders(); renderOrderLibrarySelectors(); renderOrderRemovalButtons(); } catch { $('last-update').textContent = 'Não foi possível contactar os serviços'; $('live-dot').className = 'warning'; } finally { $('refresh').disabled = false; } }

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
  if (open) $(open.dataset.openForm).classList.remove('hidden');
  if (close) { $(close.dataset.closeForm).classList.add('hidden'); if (close.dataset.closeForm === 'customer-form') resetTemplateForm(); }
  const removeArea = event.target.closest('[data-remove-template-field]'); if (removeArea) { templateFields.splice(Number(removeArea.dataset.removeTemplateField), 1); renderTemplateFields(); }
  if (event.target.id === 'clear-template-fields') { templateFields = []; renderTemplateFields(); }
  const discovered = event.target.closest('[data-add-discovered]'); if (discovered) { try { const printer = JSON.parse(discovered.dataset.addDiscovered); const form = $('printer-form'); form.querySelector('[name="name"]').value = `${printer.detected_as} ${printer.ip}`; form.querySelector('[name="ip"]').value = printer.ip; form.querySelector('[name="type"]').value = printer.type; form.querySelector('[name="group_name"]').value = printer.detected_as; form.classList.remove('hidden'); form.querySelector('[name="model"]').focus(); toast('Dados preenchidos. Indica o modelo registado e confirma.'); } catch { toast('Não foi possível preparar esta impressora.', 'error'); } }
  const deleteCustomer = event.target.closest('[data-delete-customer]'); if (deleteCustomer && confirm('Remover este cliente e o respetivo modelo?')) try { await api(`/api/customers/${deleteCustomer.dataset.deleteCustomer}`, { method: 'DELETE' }); toast('Cliente removido.'); refreshCustomers(); } catch (error) { toast(error.message, 'error'); }
  const deleteFile = event.target.closest('[data-delete-file]'); if (deleteFile && confirm('Remover este G-code da biblioteca?')) try { await api(`/api/files/${deleteFile.dataset.deleteFile}`, { method: 'DELETE' }); toast('G-code removido.'); refreshFiles(); } catch (error) { toast(error.message, 'error'); }
  const deleteOrder = event.target.closest('[data-delete-order]'); if (deleteOrder && confirm('Remover esta encomenda? Os G-codes anexados a ela também serão eliminados.')) try { await api(`/api/orders/${deleteOrder.dataset.deleteOrder}`, { method: 'DELETE' }); toast('Encomenda removida.'); update(); } catch (error) { toast(error.message, 'error'); }
  const save = event.target.closest('[data-save-assignment]'); if (save) { const id = save.dataset.saveAssignment, selected = document.querySelector(`[data-printer="${id}"]`).value; try { if (selected) await api('/api/assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printer_id: id, spool_id: selected }) }); else await fetch(`/api/assignments/${id}`, { method: 'DELETE' }); toast('Bobine atualizada.'); update(); } catch (error) { toast(error.message, 'error'); } }
  const use = event.target.closest('[data-consume]'); if (use) { const grams = prompt('Gramas consumidos:', '0'); if (Number(grams) > 0) try { await api('/api/consume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printer_id: use.dataset.consume, spool_id: use.dataset.spool, grams: Number(grams) }) }); toast('Consumo registado.'); update(); } catch (error) { toast(error.message, 'error'); } }
  const complete = event.target.closest('[data-complete-order]'); if (complete) try { const result = await api(`/api/orders/${complete.dataset.completeOrder}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast(result.consumed_grams ? `Concluída; ${result.consumed_grams} g descontados.` : 'Encomenda concluída.'); update(); } catch (error) { toast(error.message, 'error'); }
});
document.addEventListener('change', async (event) => {
  if (event.target.matches('[data-order-library-file]')) try { await api(`/api/orders/${event.target.dataset.orderLibraryFile}/library-file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: event.target.value }) }); toast(event.target.value ? 'G-code associado à encomenda.' : 'G-code removido da encomenda.'); update(); } catch (error) { toast(error.message, 'error'); }
  if (event.target.matches('[data-order-printer]')) try { await api(`/api/orders/${event.target.dataset.orderPrinter}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printer_id: event.target.value || null, status: event.target.value ? 'queued' : 'received' }) }); toast('Impressora atribuída.'); update(); } catch (error) { toast(error.message, 'error'); }
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

for (const id of ['order-form', 'project-form', 'printer-form', 'spool-form', 'customer-form', 'file-form']) $(id).addEventListener('submit', async (event) => {
  event.preventDefault(); const values = new FormData(event.currentTarget); const form = Object.fromEntries(values.entries()); const endpoint = id === 'order-form' ? '/api/orders' : id === 'project-form' ? '/api/projects' : id === 'printer-form' ? '/api/printers' : id === 'spool-form' ? '/api/spools' : id === 'customer-form' ? '/api/customers' : '/api/files';
  try {
    if (id === 'customer-form') { if (!templatePreview) throw new Error('Seleciona uma encomenda PDF tipo.'); if (!templateFields.length) throw new Error('Marca pelo menos uma área de leitura no PDF.'); form.template = { sample_name: templatePreview.file_name, fields: templateFields }; delete form.sample_pdf; }
    if (id === 'order-form') { const pdf = values.get('order_pdf'); delete form.order_pdf; if (pdf instanceof File && pdf.size) { const upload = new FormData(); upload.append('pdf', pdf); if (form.customer_id) upload.append('customer_id', form.customer_id); const draft = await api('/api/orders/import-pdf', { method: 'POST', body: upload }); form.title = form.title || (draft.order_number ? `Encomenda ${draft.order_number}` : pdf.name.replace(/\.pdf$/i, '')); form.customer = form.customer || draft.customer || ''; form.customer_id = draft.customer_id || form.customer_id || ''; form.items = draft.items || []; form.document = { file_name: draft.file_name, order_number: draft.order_number || null, ocr_used: Boolean(draft.ocr_used), template_used: Boolean(draft.template_used), imported_at: new Date().toISOString() }; if (draft.warnings?.length) form.notes = [form.notes, `PDF: ${draft.warnings.join(' ')}`].filter(Boolean).join('\n'); toast(draft.template_used ? 'PDF lido com o modelo do cliente.' : draft.ocr_used ? 'PDF lido por OCR.' : 'Texto do PDF lido automaticamente.'); } if (!String(form.title || '').trim()) throw new Error('Indica um nome ou seleciona um PDF com referência.'); }
    if (id === 'file-form') { await api(endpoint, { method: 'POST', body: values }); } else { await api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }); }
    event.currentTarget.reset(); event.currentTarget.classList.add('hidden'); if (id === 'customer-form') { resetTemplateForm(); await refreshCustomers(); } if (id === 'file-form') await refreshFiles(); toast(id === 'customer-form' ? 'Cliente e modelo guardados.' : id === 'file-form' ? 'G-code guardado na biblioteca.' : 'Registo criado.'); update();
  } catch (error) { toast(error.message, 'error'); }
});

function orderGcodeLinks(order) {
  const links = Array.isArray(order.library_files) ? order.library_files : (order.library_file_id ? [{ file_id: order.library_file_id, requested_quantity: null }] : []);
  return links.map((link) => {
    const file = libraryFiles.find((entry) => entry.id === link.file_id);
    if (!file) return { ...link, missing: true };
    const piecesPerRun = Math.max(1, Number(file.metadata?.quantity || 1));
    const requested = Math.max(1, Number(link.requested_quantity || piecesPerRun));
    return { ...link, file, requested, piecesPerRun, runs: Math.ceil(requested / piecesPerRun) };
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
    const pieces = orderGcodeLinks(order);
    const summary = pieces.length ? pieces.map((piece) => piece.missing ? 'G-code removido' : `${escape(piece.file.original_name)} · ${piece.requested} peça(s)`).join('<br>') : 'Sem G-code associado';
    const finished = order.updated_at ? new Date(order.updated_at).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : '—';
    return `<article class="history-card"><div><p class="eyebrow">${escape(order.id)}</p><h2>${escape(order.title)}</h2><p>${escape(order.customer || 'Sem cliente')}</p></div><div><strong>Concluída</strong><small>${escape(finished)}</small></div><div class="history-pieces">${summary}</div></article>`;
  }).join('') : '<p class="empty">Ainda não existem encomendas concluídas.</p>';
}
renderOrderLibrarySelectors = function renderOrderPieces() {
  document.querySelectorAll('#order-board .order-card').forEach((card, index) => {
    const order = latest.orders.filter((item) => item.status !== 'completed')[index]; const actions = card.querySelector('.order-actions'); if (!order || !actions) return;
    const links = orderGcodeLinks(order);
    const rows = links.length ? links.map((link) => link.missing
      ? `<div class="order-file-row broken"><span>G-code removido da biblioteca</span><button class="compact danger" data-remove-order-file="${escape(order.id)}" data-library-file-id="${escape(link.file_id)}">Retirar</button></div>`
      : `<div class="order-file-row"><div><strong>${escape(link.file.original_name)}</strong><small>${escape(link.file.metadata?.material || '—')} ${escape(link.file.metadata?.color || '')} · ${link.piecesPerRun} peça(s)/execução</small></div><span>${link.requested} pedidas<br><small>${link.runs} execução(ões)</small></span><button class="compact danger" data-remove-order-file="${escape(order.id)}" data-library-file-id="${escape(link.file.id)}">Retirar</button></div>`
    ).join('') : '<p class="empty">Ainda não foram associadas peças a esta encomenda.</p>';
    const selectedIds = new Set(links.map((link) => link.file_id));
    const options = ['<option value="">Selecionar G-code</option>', ...libraryFiles.filter((file) => !selectedIds.has(file.id)).map((file) => `<option value="${file.id}">${escape(file.original_name)} · ${escape(file.metadata?.material || '—')} ${escape(file.metadata?.color || '')}</option>`)].join('');
    actions.insertAdjacentHTML('beforeend', `<div class="order-file-links"><strong>Peças e G-codes</strong><div class="order-file-list">${rows}</div><div class="order-file-add"><label>G-code<select data-order-add-file="${escape(order.id)}">${options}</select></label><label>Quantidade pedida<input type="number" min="1" step="1" value="1" data-order-file-quantity="${escape(order.id)}"></label><button class="compact" data-add-order-file="${escape(order.id)}">Adicionar peça</button></div></div>`);
    const summary = card.querySelector('.order-gcode-summary'); if (summary) summary.textContent = links.length ? `${links.length} G-code(s) associado(s) · ${links.reduce((sum, link) => sum + (link.requested || 0), 0)} peça(s) pedida(s).` : 'Sem peças/G-codes associados.';
  });
};
document.addEventListener('click', async (event) => {
  const add = event.target.closest('[data-add-order-file]');
  if (add) {
    const id = add.dataset.addOrderFile;
    const fileId = document.querySelector(`[data-order-add-file="${id}"]`)?.value;
    const quantity = document.querySelector(`[data-order-file-quantity="${id}"]`)?.value;
    try { await api(`/api/orders/${id}/library-files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId, requested_quantity: quantity }) }); toast('Peça associada à encomenda.'); update(); } catch (error) { toast(error.message, 'error'); }
  }
  const remove = event.target.closest('[data-remove-order-file]');
  if (remove && confirm('Retirar este G-code desta encomenda? O ficheiro mantém-se na biblioteca.')) {
    try { await api(`/api/orders/${remove.dataset.removeOrderFile}/library-files/${remove.dataset.libraryFileId}`, { method: 'DELETE' }); toast('G-code retirado da encomenda.'); update(); } catch (error) { toast(error.message, 'error'); }
  }
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
populateFilaments(); refreshCustomers(); refreshFiles(); update().finally(renderOverviewFromCurrent); setInterval(() => update().finally(renderOverviewFromCurrent), 15000);
