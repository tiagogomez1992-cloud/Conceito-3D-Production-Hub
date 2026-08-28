const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = 18981;
const baseUrl = `http://127.0.0.1:${port}`;
let server;
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
  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: 'pipe' });
  await waitForServer();
});
test.after(() => {
  server?.kill('SIGTERM');
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

  const protectedFile = await json(`/api/files/${second.body.id}`, { method: 'DELETE' });
  assert.equal(protectedFile.response.status, 409);
});

test('impressora, bobine e projeto são guardados pelo próprio portal', async () => {
  const printer = await json('/api/printers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'S1 MAX', ip: '127.0.0.1', model: 'ANYCUBIC S1 MAX', type: 'klipper' }) });
  assert.equal(printer.response.status, 201);

  const spool = await json('/api/spools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ material: 'PETG', color: 'Preto', brand: 'Pro3DWorld', remaining_weight: 1000 }) });
  assert.equal(spool.response.status, 201);
  assert.equal(spool.body.filament.material, 'PETG');

  const project = await json('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Teste standalone' }) });
  assert.equal(project.response.status, 201);

  const summary = await json('/api/summary');
  assert.equal(summary.response.status, 200);
  assert.equal(summary.body.printers.total, 1);
  assert.equal(summary.body.spools.total, 1);
  assert.equal(summary.body.production.projects.length, 1);
});
