const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const express = require('express');
const { installTimelapseRoutes } = require('../timelapse');

const hubDir = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:18991';
let hub; let backend; let dataDir; let address;
let config; let mode; let writes; let authHeaders;
async function api(route, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}
async function start() {
  hub = spawn(process.execPath, ['server.js'], { cwd: hubDir, env: { ...process.env, PORT: '18991', DATA_DIR: dataDir, HUB_AUTH_USER: '', HUB_AUTH_PASSWORD: '' }, stdio: 'ignore' });
  for (let n = 0; n < 80; n++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Hub did not start');
}
async function stop() { const exited = once(hub, 'exit'); hub.kill(); await exited; }
async function printer(type = 'klipper') {
  const result = await api('/api/printers', 'POST', { name: `${type}-${crypto.randomUUID()}`, model: 'Test printer', ip: address, type, api_key: 'test-key' });
  assert.equal(result.status, 201);
  return { id: result.data.id, route: `/api/printers/${result.data.id}/timelapse`, record: result.data };
}
const saved = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'portal-state.json'), 'utf8'));

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(hubDir, '.test-timelapse-'));
  backend = http.createServer(async (req, res) => {
    if (req.url === '/camera') { res.setHeader('Content-Type', 'image/jpeg'); res.end(Buffer.from([255, 216, 255, 217])); return; }
    res.setHeader('Content-Type', 'application/json');
    authHeaders.push(req.headers['x-api-key']);
    if (mode === 'missing' || mode === 'denied' || mode === 'offline') { res.statusCode = mode === 'missing' ? 404 : mode === 'denied' ? 403 : 503; res.end('{}'); return; }
    if (mode === 'malformed') { res.end('{"result":{}}'); return; }
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); writes.push(body);
      if (mode === 'refused') { res.statusCode = 403; res.end('{}'); return; }
      if (mode === 'delayed') await new Promise((resolve) => setTimeout(resolve, 150));
      if (mode !== 'ignored') Object.assign(config, body);
    }
    res.end(JSON.stringify(req.url === '/api/timelapse' ? { config } : { result: config }));
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  address = `127.0.0.1:${backend.address().port}`;
  await start();
});
test.beforeEach(() => { config = { enabled: false, blockedsettings: [], parkhead: false }; mode = 'ok'; writes = []; authHeaders = []; });
test.after(async () => { if (hub) await stop(); backend?.closeAllConnections(); await new Promise((resolve) => backend?.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('confirmed Moonraker preference persists across restart, stays isolated and survives printer edits', async () => {
  const first = await printer(); const second = await printer();
  assert.equal((await api(first.route)).data.preference, null);
  assert.deepEqual(writes, []);
  const on = await api(first.route, 'PUT', { enabled: true });
  assert.equal(on.status, 200); assert.equal(on.data.enabled, true); assert.equal(on.data.preference, true);
  assert.deepEqual(writes, [{ enabled: true }]); assert.equal(config.parkhead, false);
  assert.ok(authHeaders.every((value) => value === 'test-key'));
  assert.equal(saved().printers.find((p) => p.id === second.id).timelapse_enabled, undefined);
  const edited = await api(`/api/printers/${first.id}`, 'PUT', { ...first.record, name: 'Renamed printer' });
  assert.equal(edited.data.timelapse_enabled, true);
  await stop(); await start();
  assert.equal((await api(first.route)).data.preference, true);
  config.enabled = false;
  const drift = (await api(first.route)).data;
  assert.equal(drift.enabled, false); assert.equal(drift.preference, true);
  assert.equal(writes.length, 1, 'read does not change the printer');
  assert.equal((await api(first.route, 'PUT', { enabled: false })).data.preference, false);
});

test('invalid requests, missing printers and unsupported integrations never send commands', async () => {
  assert.equal((await api('/api/printers/999999/timelapse')).status, 404);
  const p = await printer();
  for (const enabled of ['false', 0, null, {}, []]) assert.equal((await api(p.route, 'PUT', { enabled })).status, 400);
  for (const type of ['bambu', 'prusa', 'elegoo-centauri']) {
    const unsupported = await printer(type);
    assert.equal((await api(unsupported.route)).data.supported, false);
    assert.equal((await api(unsupported.route, 'PUT', { enabled: true })).status, 409);
  }
  assert.deepEqual(writes, []);
});

test('missing component, fixed configuration and connection errors do not overwrite preferences', async () => {
  const p = await printer('creality');
  assert.equal((await api(p.route, 'PUT', { enabled: true })).status, 200);
  writes = [];
  config.blockedsettings = ['enabled'];
  assert.equal((await api(p.route)).data.supported, false);
  assert.equal((await api(p.route, 'PUT', { enabled: false })).status, 409);
  for (const failure of ['missing', 'denied', 'offline', 'malformed']) {
    mode = failure;
    const read = await api(p.route);
    assert.equal(read.status, failure === 'missing' ? 200 : 502);
    assert.equal((await api(p.route, 'PUT', { enabled: false })).status, failure === 'missing' ? 409 : 502);
  }
  assert.equal(saved().printers.find((item) => item.id === p.id).timelapse_enabled, true);
  assert.deepEqual(writes, []);
});

test('failed or unconfirmed writes preserve the last saved preference', async () => {
  const p = await printer('anycubic');
  assert.equal((await api(p.route, 'PUT', { enabled: true })).status, 200);
  for (const failure of ['refused', 'ignored']) {
    mode = failure;
    assert.equal((await api(p.route, 'PUT', { enabled: false })).status, 502);
    assert.equal(saved().printers.find((item) => item.id === p.id).timelapse_enabled, true);
  }
});

test('parallel requests are serialized per printer without losing unrelated state changes', async () => {
  const p = await printer(); mode = 'delayed';
  const pending = api(p.route, 'PUT', { enabled: true });
  while (!writes.length) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await api(p.route, 'PUT', { enabled: false })).status, 409);
  const other = await printer();
  assert.equal((await pending).status, 200);
  assert.ok(saved().printers.some((item) => item.id === other.id));
});

test('OctoPrint saves configuration and restores the previous capture mode', async () => {
  const p = await printer('octoprint');
  config = { type: 'zchange', fps: 30, postRoll: 5, retractionZHop: 0.4, minDelay: 2 };
  const original = { ...config };
  assert.equal((await api(p.route, 'PUT', { enabled: false })).status, 200);
  assert.deepEqual(writes[0], { type: 'off', save: true });
  assert.equal((await api(p.route, 'PUT', { enabled: true })).status, 200);
  assert.deepEqual(writes[1], { ...original, save: true });
  assert.match((await api(p.route)).data.reason, /próxima impressão/);
  const fresh = await printer('octoprint'); config = { type: 'off' };
  assert.equal((await api(fresh.route, 'PUT', { enabled: true })).status, 200);
  assert.equal(writes.at(-1).interval, 10); assert.equal(writes.at(-1).save, true);
});

test('camera proxy, Bambu validation and UI version remain operational', async () => {
  const p = await printer('creality');
  await api(`/api/printers/${p.id}`, 'PUT', { ...p.record, camera_url: `http://${address}/camera` });
  const camera = await fetch(`${base}/api/printers/${p.id}/camera`);
  assert.equal(camera.status, 200); assert.equal(camera.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await camera.arrayBuffer()), Buffer.from([255, 216, 255, 217]));
  const bambu = await printer('bambu');
  await api(`/api/printers/${bambu.id}`, 'PUT', { ...bambu.record, api_key: '' });
  assert.equal((await api(`/api/printers/${bambu.id}/camera?snapshot=1`)).status, 400);
  const html = await (await fetch(base + `/impressoras/${p.id}`)).text();
  assert.match(html, /UI v0\.7\.1/); assert.match(html, /src="\/timelapse\.js/);
});

test('Creality tries Moonraker port 4408 when 7125 has no component', async () => {
  const urls = []; const app = express();
  installTimelapseRoutes(app, {
    client: { get: async (url) => { urls.push(url); if (url.includes(':7125')) throw { response: { status: 404 } }; return { data: { result: { enabled: true } } }; } },
    state: () => ({}), save: () => {}, getManagedPrinter: () => ({ id: 1, type: 'creality' }),
    printerEndpoint: (_printer, endpoint, port) => `http://printer:${port}${endpoint}`,
  });
  const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  try {
    const status = await (await fetch(`http://127.0.0.1:${listener.address().port}/api/printers/1/timelapse`)).json();
    assert.equal(status.supported, true); assert.equal(status.enabled, true);
    assert.deepEqual(urls, ['http://printer:7125/machine/timelapse/settings', 'http://printer:4408/machine/timelapse/settings']);
  } finally { listener.closeAllConnections(); await new Promise((resolve) => listener.close(resolve)); }
});
