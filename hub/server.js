const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const port = Number(process.env.PORT || 8080);
const farmUrl = (process.env.PRINT_FARM_URL || 'http://print-farm-manager:3000').replace(/\/$/, '');
const spoolmanUrl = (process.env.SPOOLMAN_URL || 'http://spoolman:8000').replace(/\/$/, '');
const client = axios.create({ timeout: 5000 });
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const stateFile = path.join(dataDir, 'portal-state.json');
const authUser = process.env.HUB_AUTH_USER || '';
const authPassword = process.env.HUB_AUTH_PASSWORD || '';

fs.mkdirSync(uploadsDir, { recursive: true });
app.use(express.json({ limit: '256kb' }));

function state() { try { return { assignments: {}, consumption: [], orders: [], ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { return { assignments: {}, consumption: [], orders: [] }; } }
function save(value) { fs.writeFileSync(stateFile, JSON.stringify(value, null, 2)); }
function clean(value, max = 500) { return String(value || '').trim().slice(0, max); }
function number(value) { const n = Number(String(value || '').replace(',', '.')); return Number.isFinite(n) ? n : null; }
function orderId() { return `C3D-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`; }
function getOrder(value, id) { return value.orders.find((item) => item.id === id); }

function authentication(req, res, next) {
  if (!authUser || !authPassword) return next();
  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  const [user, password] = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString('utf8').split(':') : [];
  if (user === authUser && password === authPassword) return next();
  res.set('WWW-Authenticate', 'Basic realm="Conceito 3D Production Hub"');
  return res.status(401).send('Autenticação necessária.');
}
app.use(authentication);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => done(null, uploadsDir),
    filename: (_req, file, done) => done(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, done) => {
    const accepted = ['.gcode', '.gco'].includes(path.extname(file.originalname).toLowerCase());
    done(accepted ? null : new Error('Apenas são aceites ficheiros G-code (.gcode ou .gco).'), accepted);
  },
});

function gcodeMetadata(contents, supplied = {}) {
  const find = (patterns) => patterns.map((pattern) => contents.match(pattern)?.[1]?.trim()).find(Boolean) || null;
  const quantity = number(supplied.quantity) || number(find([/(?:quantidade|quantity|copies|pieces|peças|objects?)\s*[:=]\s*(\d+)/im]));
  const material = clean(supplied.material || find([/(?:filament[_ ]?(?:type|material)|material|tipo de filamento)\s*[:=]\s*([^\r\n;]+)/im]), 80) || null;
  const nozzle = number(supplied.nozzle) || number(find([/(?:nozzle[_ ]?(?:diameter|size)?|bico(?:[_ ]?(?:diameter|size))?)\s*[:=]\s*([0-9]+(?:[\.,][0-9]+)?)/im]));
  const filament = number(find([/(?:total filament used \[g\]|filament used \[g\]|filament_weight_total)\s*[:=]\s*([0-9]+(?:[\.,][0-9]+)?)/im]));
  const missing = []; if (!quantity) missing.push('quantidade de peças'); if (!material) missing.push('tipo de material'); if (!nozzle) missing.push('tamanho do bico');
  return { quantity, material, nozzle, filament_grams: filament, valid: !missing.length, missing };
}

async function safeGet(url) { try { const response = await client.get(url); return { ok: true, data: response.data }; } catch (error) { return { ok: false, error: error.message }; } }
async function safeRequest(method, url, data) { try { const response = await client.request({ method, url, data }); return { ok: true, data: response.data }; } catch (error) { return { ok: false, status: error.response?.status || 502, error: error.response?.data?.error || error.response?.data?.detail || error.message }; } }
function forwarded(res, result, status = 201) { return result.ok ? res.status(status).json(result.data) : res.status(result.status || 502).json({ error: result.error || 'O serviço não aceitou o pedido.' }); }

app.get('/api/summary', async (_req, res) => {
  const [health, printers, spools, projects, jobs] = await Promise.all([safeGet(`${farmUrl}/api/health`), safeGet(`${farmUrl}/api/printers`), safeGet(`${spoolmanUrl}/api/v1/spool`), safeGet(`${farmUrl}/api/projects`), safeGet(`${farmUrl}/api/jobs`)]);
  const printerItems = Array.isArray(printers.data) ? printers.data : [];
  const spoolItems = Array.isArray(spools.data) ? spools.data : [];
  const saved = state(); const online = new Set(['IDLE', 'PRINTING', 'FINISHED', 'PAUSED', 'ONLINE']);
  const orders = [...saved.orders].sort((a, b) => Number(b.priority) - Number(a.priority) || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
  res.json({ generatedAt: new Date().toISOString(), services: { printFarmManager: health.ok, spoolman: spools.ok }, system: { hostname: os.hostname(), uptime_seconds: os.uptime(), memory_total_mb: Math.round(os.totalmem() / 1048576), memory_used_mb: Math.round((os.totalmem() - os.freemem()) / 1048576), cpu_load_1m: Number(os.loadavg()[0].toFixed(2)) }, printers: { total: printerItems.length, online: printerItems.filter((item) => online.has(String(item.status || '').toUpperCase())).length, printing: printerItems.filter((item) => String(item.status || '').toUpperCase() === 'PRINTING').length, items: printerItems }, spools: { total: spoolItems.length, low: spoolItems.filter((item) => Number(item.remaining_weight || 0) > 0 && Number(item.remaining_weight || 0) < 200).length, items: spoolItems }, production: { projects: Array.isArray(projects.data) ? projects.data : [], jobs: Array.isArray(jobs.data) ? jobs.data : [], orders }, assignments: saved.assignments, consumption: saved.consumption.slice(0, 20) });
});

app.get('/api/orders', (_req, res) => res.json(state().orders));
app.post('/api/orders', (req, res) => {
  if (!clean(req.body?.title, 120)) return res.status(400).json({ error: 'O nome da encomenda é obrigatório.' });
  const saved = state(); const item = { id: orderId(), title: clean(req.body.title, 120), customer: clean(req.body.customer, 120), due_date: clean(req.body.due_date, 20) || null, priority: Math.min(2, Math.max(0, Number(req.body.priority) || 0)), notes: clean(req.body.notes, 1000), status: 'received', printer_id: null, files: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  saved.orders.unshift(item); save(saved); res.status(201).json(item);
});
app.patch('/api/orders/:id', (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id); if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  for (const key of ['status', 'printer_id', 'due_date', 'notes']) if (req.body?.[key] !== undefined) item[key] = req.body[key];
  if (req.body?.priority !== undefined) item.priority = Math.min(2, Math.max(0, Number(req.body.priority) || 0));
  item.updated_at = new Date().toISOString(); save(saved); res.json(item);
});
app.post('/api/orders/:id/files', upload.single('gcode'), (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id); if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  if (!req.file) return res.status(400).json({ error: 'Seleciona um ficheiro G-code.' });
  const metadata = gcodeMetadata(fs.readFileSync(req.file.path, 'utf8').slice(0, 1024 * 1024), req.body || {});
  const file = { id: crypto.randomUUID(), original_name: clean(req.file.originalname, 255), stored_name: req.file.filename, size_bytes: req.file.size, uploaded_at: new Date().toISOString(), metadata };
  item.files.push(file); item.updated_at = new Date().toISOString(); save(saved); res.status(201).json(file);
});
app.post('/api/orders/:id/complete', async (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id); if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  const file = item.files.find((candidate) => candidate.id === req.body?.file_id) || item.files[0]; const spoolId = saved.assignments[String(item.printer_id)]?.spool_id; const grams = Number(file?.metadata?.filament_grams || 0);
  if (spoolId && grams > 0) { const spool = await safeGet(`${spoolmanUrl}/api/v1/spool/${spoolId}`); if (!spool.ok) return res.status(502).json({ error: 'Não foi possível obter a bobine atribuída.' }); const result = await safeRequest('patch', `${spoolmanUrl}/api/v1/spool/${spoolId}`, { used_weight: Number(spool.data.used_weight || 0) + grams }); if (!result.ok) return res.status(502).json({ error: 'Não foi possível atualizar o peso no Spoolman.' }); saved.consumption.unshift({ spool_id: spoolId, grams, printer_id: item.printer_id, order_id: item.id, automatic: true, created_at: new Date().toISOString() }); }
  item.status = 'completed'; item.updated_at = new Date().toISOString(); save(saved); res.json({ order: item, consumed_grams: grams || null });
});

app.post('/api/printers', async (req, res) => forwarded(res, await safeRequest('post', `${farmUrl}/api/printers`, req.body)));
app.post('/api/projects', async (req, res) => forwarded(res, await safeRequest('post', `${farmUrl}/api/projects`, req.body)));
app.post('/api/spools', async (req, res) => { const { filament_id, remaining_weight } = req.body || {}; if (!filament_id) return res.status(400).json({ error: 'Seleciona um filamento antes de criar a bobine.' }); forwarded(res, await safeRequest('post', `${spoolmanUrl}/api/v1/spool`, { filament_id: Number(filament_id), used_weight: 0, ...(remaining_weight ? { initial_weight: Number(remaining_weight) } : {}) })); });
app.get('/api/filaments', async (_req, res) => { const result = await safeGet(`${spoolmanUrl}/api/v1/filament`); result.ok ? res.json(Array.isArray(result.data) ? result.data : []) : res.status(502).json({ error: 'Não foi possível obter os filamentos do Spoolman.' }); });
app.post('/api/assignments', (req, res) => { const { printer_id, spool_id } = req.body || {}; if (!printer_id || !spool_id) return res.status(400).json({ error: 'Impressora e bobine são obrigatórias.' }); const saved = state(); saved.assignments[String(printer_id)] = { spool_id: Number(spool_id), assigned_at: new Date().toISOString() }; save(saved); res.status(201).json(saved.assignments[String(printer_id)]); });
app.delete('/api/assignments/:printerId', (req, res) => { const saved = state(); delete saved.assignments[String(req.params.printerId)]; save(saved); res.status(204).end(); });
app.post('/api/consume', async (req, res) => { const spoolId = Number(req.body?.spool_id); const grams = Number(req.body?.grams); if (!spoolId || !Number.isFinite(grams) || grams <= 0) return res.status(400).json({ error: 'Indica uma bobine e uma quantidade válida em gramas.' }); const spool = await safeGet(`${spoolmanUrl}/api/v1/spool/${spoolId}`); if (!spool.ok) return res.status(404).json({ error: 'Bobine não encontrada.' }); const result = await safeRequest('patch', `${spoolmanUrl}/api/v1/spool/${spoolId}`, { used_weight: Number(spool.data.used_weight || 0) + grams }); if (!result.ok) return res.status(502).json({ error: 'Não foi possível atualizar o peso no Spoolman.' }); const saved = state(); saved.consumption.unshift({ spool_id: spoolId, grams, printer_id: req.body?.printer_id || null, order_id: req.body?.order_id || null, automatic: false, created_at: new Date().toISOString() }); save(saved); res.json({ spool: result.data }); });

app.use((error, _req, res, _next) => res.status(400).json({ error: error.message || 'Não foi possível processar o ficheiro.' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.4.0' }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`Conceito 3D Production Hub listening on ${port}`));
