const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const port = 18981;
const moonrakerPort = 18982;
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let moonraker;
let dataDir;

async function json(url, options = {}) {
  const response = await fetch(`${baseUrl}${url}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('O servidor de teste não iniciou.');
}
function gcodeForm(partId, filename, quantity, printerModel, color) {
  const form = new FormData();
  form.append('part_id', partId);
  form.append('printer_model', printerModel);
  form.append('quantity', String(quantity));
  form.append('material', 'PETG');
  form.append('color', color);
  form.append('nozzle', '0.4');
  form.append('gcode', new Blob([`; generated test\n; filament used [g] = 12\nG28\n`], { type: 'text/plain' }), filename);
  return form;
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(process.cwd(), '.test-data-'));
  moonraker = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/printer/objects/query?mmu')) {
      response.end(JSON.stringify({ result: { status: { mmu: { num_gates: 4, gate_status: [1, 1, 0, 0], gate_material: ['PETG', 'PLA', '', ''], gate_color: ['FF6A00', '008BFF', '', ''], gate_spool_id: [10, 20, -1, -1] } } } }));
      return;
    }
    if (request.url.startsWith('/printer/objects/query?print_stats')) {
      response.end(JSON.stringify({ result: { status: { print_stats: { state: 'idle', filename: null }, virtual_sdcard: { progress: 0 }, display_status: { progress: 0 } } } }));
      return;
    }
    response.end(JSON.stringify({ result: { value: {} } }));
  });
  await new Promise((resolve) => moonraker.listen(moonrakerPort, '127.0.0.1', resolve));
  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, DISPLAY_API_TOKEN: 'test-display-token' }, stdio: 'pipe' });
  await waitForServer();
});
test.after(() => {
  server?.kill('SIGTERM');
  moonraker?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('peça agrega variantes e a encomenda escolhe um G-code', async () => {
  const createdPart = await json('/api/library-parts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'suporte lateral', description: 'Teste' }) });
  assert.equal(createdPart.response.status, 201);
  assert.equal(createdPart.body.name, 'SUPORTE LATERAL');

  const duplicate = await json('/api/library-parts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'SUPORTE LATERAL' }) });
  assert.equal(duplicate.response.status, 409);

  const first = await json('/api/files', { method: 'POST', body: gcodeForm(createdPart.body.id, 'suporte-p1s.gcode', 4, 'P1S', 'Preto') });
  const second = await json('/api/files', { method: 'POST', body: gcodeForm(createdPart.body.id, 'suporte-a1.gcode', 6, 'A1', 'Branco') });
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);

  const parts = await json('/api/library-parts');
  assert.equal(parts.body.length, 1);
  assert.equal(parts.body[0].gcodes.length, 2);

  const order = await json('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Encomenda teste' }) });
  assert.equal(order.response.status, 201);
  const linked = await json(`/api/orders/${order.body.id}/library-parts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ part_id: createdPart.body.id, requested_quantity: 10 }) });
  assert.equal(linked.response.status, 201);
  assert.equal(linked.body.plan[0].requested_quantity, 10);

  const selected = await json(`/api/orders/${order.body.id}/library-parts/${createdPart.body.id}/gcode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: second.body.id }) });
  assert.equal(selected.response.status, 200);
  assert.equal(selected.body.plan[0].file.id, second.body.id);
  assert.equal(selected.body.plan[0].runs, 2);
  assert.equal(selected.body.plan[0].produced_quantity, 12);
  assert.equal(selected.body.plan[0].excess_quantity, 2);

  const pdfOrder = await json('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Encomenda PDF', document: { file_name: 'pedido.pdf' }, ai_draft: { items: [{ part_code: 'SUPORTE-LATERAL', description: 'Suporte lateral', quantity: 7 }] }, items: [{ part_code: 'SUPORTE-LATERAL', description: 'Suporte lateral', quantity: 7 }] }) });
  assert.equal(pdfOrder.response.status, 201);
  assert.equal(pdfOrder.body.status, 'draft');
  assert.equal(pdfOrder.body.library_parts.length, 0);
  assert.equal(pdfOrder.body.draft_lines.length, 1);
  const reviewed = await json(`/api/orders/${pdfOrder.body.id}/draft-lines/${pdfOrder.body.draft_lines[0].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ library_part_id: createdPart.body.id, quantity: 7 }) });
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.body.draft_lines[0].review_status, 'confirmed');
  const approved = await json(`/api/orders/${pdfOrder.body.id}/approve-draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.order.status, 'received');
  assert.equal(approved.body.order.library_parts[0].part_id, createdPart.body.id);
  assert.equal(approved.body.order.library_parts[0].requested_quantity, 7);

  const protectedFile = await json(`/api/files/${second.body.id}`, { method: 'DELETE' });
  assert.equal(protectedFile.response.status, 409);
});

test('impressora, bobine e projeto são guardados pelo próprio portal', async () => {
  const printer = await json('/api/printers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'S1 MAX', ip: '127.0.0.1', model: 'ANYCUBIC S1 MAX', type: 'klipper' }) });
  assert.equal(printer.response.status, 201);

  const spool = await json('/api/spools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ material: 'PETG', color: 'Preto', brand: 'Pro3DWorld', remaining_weight: 1000 }) });
  assert.equal(spool.response.status, 201);
  assert.equal(spool.body.filament.material, 'PETG');

  const acePrinter = await json('/api/printers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'S1 MAX ACE', ip: '127.0.0.1', brand: 'Anycubic', model: 'Anycubic Kobra S1 Max', type: 'klipper', material_system: 'ace', material_slot_count: 4 }) });
  assert.equal(acePrinter.response.status, 201);
  assert.equal(acePrinter.body.material_system, 'ace');
  const slot = await json(`/api/printers/${acePrinter.body.id}/material-slots/1`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spool_id: spool.body.id }) });
  assert.equal(slot.response.status, 200);
  assert.equal(slot.body.system, 'ace');
  assert.equal(slot.body.slots[0].spool_id, spool.body.id);
  assert.equal(slot.body.slots.length, 4);
  const materialProfile = await json(`/api/printers/${acePrinter.body.id}/materials`);
  assert.equal(materialProfile.response.status, 200);
  assert.equal(materialProfile.body.slots[0].material, 'PETG');

  const mmuPrinter = await json('/api/printers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'S1 MAX MMU', ip: `127.0.0.1:${moonrakerPort}`, brand: 'Anycubic', model: 'Anycubic Kobra S1 Max', type: 'klipper', material_system: 'ace', material_slot_count: 4 }) });
  assert.equal(mmuPrinter.response.status, 201);
  const mmuProfile = await json(`/api/printers/${mmuPrinter.body.id}/materials`);
  assert.equal(mmuProfile.response.status, 200);
  assert.equal(mmuProfile.body.slots[0].material, 'PETG');
  assert.equal(mmuProfile.body.slots[0].color_hex, '#FF6A00');
  assert.equal(mmuProfile.body.slots[0].mmu_gate, 0);
  assert.equal(mmuProfile.body.slots[1].mmu_gate, 1);
  assert.equal(mmuProfile.body.slots[2].material, '');

  const project = await json('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Teste standalone' }) });
  assert.equal(project.response.status, 201);

  const summary = await json('/api/summary');
  assert.equal(summary.response.status, 200);
  assert.equal(summary.body.printers.total, 3);
  assert.equal(summary.body.spools.total, 1);
  assert.equal(summary.body.production.projects.length, 1);
  assert.equal(summary.body.printers.items.find((item) => item.id === acePrinter.body.id).material_profile.slots[0].spool_id, spool.body.id);

  const deniedDisplay = await json('/api/display/status');
  assert.equal(deniedDisplay.response.status, 401);
  const display = await json('/api/display/status', { headers: { 'X-Display-Token': 'test-display-token' } });
  assert.equal(display.response.status, 200);
  assert.equal(display.body.services.length, 5);
  assert.equal(display.body.resources.memory.total_mb > 0, true);
  assert.equal(Array.isArray(display.body.resources.disks), true);
});
