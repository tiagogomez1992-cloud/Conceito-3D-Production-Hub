const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

function runReset(dataDir, farmUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['reset-library-projects.js', '--confirm'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATA_DIR: dataDir, PRINT_FARM_URL: farmUrl } });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => resolve({ code, output }));
  });
}

test('limpeza preserva configurações e cria backup antes de apagar', async () => {
  const dataDir = fs.mkdtempSync(path.join(process.cwd(), '.test-reset-'));
  const uploads = path.join(dataDir, 'uploads'); fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, 'part.gcode'), 'G28\n');
  fs.writeFileSync(path.join(dataDir, 'portal-state.json'), JSON.stringify({ customers: [{ id: 'customer-1' }], files: [{ id: 'file-1', stored_name: 'part.gcode', part_id: 'part-1' }], library_parts: [{ id: 'part-1', name: 'PECA' }], orders: [{ id: 'order-1', title: 'Mantida', files: [], library_parts: [{ part_id: 'part-1' }] }] }));
  const removed = [];
  const farm = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/projects') return res.end(JSON.stringify([{ id: 7, name: 'Antigo' }]));
    if (req.method === 'GET' && req.url === '/api/parts?project_id=7') return res.end(JSON.stringify([{ id: 8, project_id: 7, name: 'PECA' }]));
    if (req.method === 'GET' && req.url === '/api/gcodes?part_id=8') return res.end(JSON.stringify([{ id: 9, filename: 'part.gcode' }]));
    if (req.method === 'DELETE' && req.url === '/api/projects/7') { removed.push(7); res.statusCode = 204; return res.end(); }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => farm.listen(18984, '127.0.0.1', resolve));
  try {
    const result = await runReset(dataDir, 'http://127.0.0.1:18984');
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(removed, [7]);
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'portal-state.json'), 'utf8'));
    assert.deepEqual(state.customers, [{ id: 'customer-1' }]);
    assert.equal(state.orders[0].title, 'Mantida');
    assert.deepEqual(state.files, []); assert.deepEqual(state.library_parts, []); assert.deepEqual(state.orders[0].library_parts, []);
    assert.equal(fs.existsSync(path.join(uploads, 'part.gcode')), false);
    const backups = fs.readdirSync(path.join(dataDir, 'reset-backups'));
    assert.equal(backups.length, 1);
    assert.equal(fs.existsSync(path.join(dataDir, 'reset-backups', backups[0], 'portal-state.json')), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'reset-backups', backups[0], 'uploads', 'part.gcode')), true);
  } finally {
    await new Promise((resolve) => farm.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
