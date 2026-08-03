const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');

const app = express();
const port = Number(process.env.PORT || 8080);
const farmUrl = (process.env.PRINT_FARM_URL || 'http://print-farm-manager:3000').replace(/\/$/, '');
const spoolmanUrl = (process.env.SPOOLMAN_URL || 'http://spoolman:8000').replace(/\/$/, '');
const client = axios.create({ timeout: 5000 });
const discoveryClient = axios.create({ timeout: 1200, validateStatus: () => true, maxRedirects: 0 });
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const stateFile = path.join(dataDir, 'portal-state.json');
const authUser = process.env.HUB_AUTH_USER || '';
const authPassword = process.env.HUB_AUTH_PASSWORD || '';
const execFileAsync = promisify(execFile);

fs.mkdirSync(uploadsDir, { recursive: true });
app.use(express.json({ limit: '256kb' }));

function state() { try { return { assignments: {}, consumption: [], orders: [], customers: [], files: [], ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { return { assignments: {}, consumption: [], orders: [], customers: [], files: [] }; } }
function save(value) { fs.writeFileSync(stateFile, JSON.stringify(value, null, 2)); }
function clean(value, max = 500) { return String(value || '').trim().slice(0, max); }
function number(value) { const n = Number(String(value || '').replace(',', '.')); return Number.isFinite(n) ? n : null; }
function orderId() { return `C3D-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`; }
function getOrder(value, id) { return value.orders.find((item) => item.id === id); }
function getCustomer(value, id) { return value.customers.find((item) => item.id === id); }
function getLibraryFile(value, id) { return value.files.find((item) => item.id === id); }

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

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, done) => {
    const accepted = path.extname(file.originalname).toLowerCase() === '.pdf';
    done(accepted ? null : new Error('Seleciona um documento PDF vÃ¡lido.'), accepted);
  },
});

function gcodeMetadata(contents, supplied = {}) {
  const find = (patterns) => patterns.map((pattern) => contents.match(pattern)?.[1]?.trim()).find(Boolean) || null;
  const quantity = number(supplied.quantity) || number(find([/(?:quantidade|quantity|copies|pieces|peças|objects?)\s*[:=]\s*(\d+)/im]));
  const material = clean(supplied.material || find([/(?:filament[_ ]?(?:type|material)|material|tipo de filamento)\s*[:=]\s*([^\r\n;]+)/im]), 80) || null;
  const color = clean(supplied.color || find([/(?:filament[_ ]?color|cor(?: do filamento)?)\s*[:=]\s*([^\r\n;]+)/im]), 80) || null;
  const nozzle = number(supplied.nozzle) || number(find([/(?:nozzle[_ ]?(?:diameter|size)?|bico(?:[_ ]?(?:diameter|size))?)\s*[:=]\s*([0-9]+(?:[\.,][0-9]+)?)/im]));
  const filament = number(find([/(?:total filament used \[g\]|filament used \[g\]|filament_weight_total)\s*[:=]\s*([0-9]+(?:[\.,][0-9]+)?)/im]));
  const missing = []; if (!quantity) missing.push('quantidade de peças'); if (!material) missing.push('tipo de material'); if (!nozzle) missing.push('tamanho do bico');
  if (!color) missing.push('cor');
  return { quantity, material, color, nozzle, filament_grams: filament, valid: !missing.length, missing };
}

function svgThumbnail(name, metadata) {
  const safe = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#1b1e22"/><rect x="24" y="24" width="592" height="312" rx="18" fill="#252a2f" stroke="#f07f23"/><path d="M75 105h130v130H75zM95 125h90v90H95z" fill="#f07f23" opacity=".9"/><text x="235" y="132" fill="#f7f4ef" font-family="Arial,sans-serif" font-size="24" font-weight="700">${safe(name).slice(0, 34)}</text><text x="235" y="174" fill="#d2d5d8" font-family="Arial,sans-serif" font-size="18">${safe(metadata.material)} · ${safe(metadata.color)}</text><text x="235" y="208" fill="#f3a45f" font-family="Arial,sans-serif" font-size="18">${safe(metadata.quantity)} peças · bico ${safe(metadata.nozzle)} mm</text><text x="75" y="291" fill="#9ba0a5" font-family="Arial,sans-serif" font-size="16">Pré-visualização não incluída pelo slicer</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function gcodeThumbnail(contents, fileId, name, metadata) {
  const blocks = [...contents.matchAll(/;\s*thumbnail begin\s+(\d+)x(\d+)\s+\d+\s*\r?\n([\s\S]*?);\s*thumbnail end/gi)];
  const selected = blocks.sort((left, right) => Number(right[1]) * Number(right[2]) - Number(left[1]) * Number(left[2]))[0];
  if (!selected) return { url: svgThumbnail(name, metadata), embedded: false, stored_name: null };
  const encoded = selected[3].replace(/^\s*;\s?/gm, '').replace(/\s/g, '');
  try {
    const image = Buffer.from(encoded, 'base64');
    const isPng = image.subarray(1, 4).equals(Buffer.from('PNG')); const isJpeg = image.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]));
    if (image.length < 100 || (!isPng && !isJpeg)) throw new Error('invalid thumbnail');
    const extension = isJpeg ? '.jpg' : '.png'; const storedName = `thumbnail-${fileId}${extension}`;
    fs.writeFileSync(path.join(uploadsDir, storedName), image);
    return { url: `/uploads/${storedName}`, embedded: true, stored_name: storedName };
  } catch { return { url: svgThumbnail(name, metadata), embedded: false, stored_name: null }; }
}

function pdfValue(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return clean(match[1].replace(/\s+/g, ' '), 120);
  }
  return '';
}

function pdfItems(text) {
  const seen = new Set();
  return text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([A-Z0-9][A-Z0-9._/-]{1,})\s+(?:[^\d\n]{0,80}\s+)?(?:x|qtd\.?|qty\.?|quantidade\s*)?(\d{1,5})\s*$/i);
    if (!match) return [];
    const partCode = match[1].toUpperCase(); const quantity = Number(match[2]);
    const key = `${partCode}:${quantity}`;
    if (!quantity || seen.has(key)) return [];
    seen.add(key); return [{ part_code: partCode, quantity }];
  });
}

function draftFromPdfText(text) {
  const customer = pdfValue(text, [/(?:cliente|customer|company|empresa|destinat[aÃ¡]rio)\s*(?:n[.ÂºoÂ°]*)?\s*[:#-]\s*([^\r\n]{2,120})/i]);
  const orderNumber = pdfValue(text, [/(?:n[.ÂºoÂ°]*\s*)?(?:de\s*)?(?:encomenda|order(?:\s*(?:number|no\.?))?)\s*[:#-]\s*([a-z0-9][a-z0-9./_-]{1,})/i]);
  const items = pdfItems(text);
  const warnings = [];
  if (!customer) warnings.push('Cliente nÃ£o identificado automaticamente.');
  if (!orderNumber) warnings.push('NÃºmero de encomenda nÃ£o identificado automaticamente.');
  if (!items.length) warnings.push('NÃ£o foram identificadas referÃªncias e quantidades; confirme manualmente.');
  return { customer, order_number: orderNumber, items, warnings };
}

async function extractPdfOrder(pdf) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'c3d-order-pdf-'));
  const input = path.join(temporary, 'encomenda.pdf');
  fs.writeFileSync(input, pdf);
  try {
    let text = '';
    try { text = String((await execFileAsync('pdftotext', ['-layout', input, '-'], { maxBuffer: 4 * 1024 * 1024 })).stdout || ''); } catch { /* a digitalized PDF has no text layer */ }
    let draft = draftFromPdfText(text);
    let ocrUsed = false;
    const score = (value) => Number(Boolean(value.customer)) + Number(Boolean(value.order_number)) + value.items.length * 2;
    if (score(draft) < 3) {
      await execFileAsync('pdftoppm', ['-f', '1', '-l', '2', '-r', '180', '-png', input, path.join(temporary, 'page')], { maxBuffer: 4 * 1024 * 1024 });
      const pages = fs.readdirSync(temporary).filter((file) => /^page-\d+\.png$/i.test(file)).sort();
      const ocrText = (await Promise.all(pages.map(async (page) => String((await execFileAsync('tesseract', [path.join(temporary, page), 'stdout', '-l', 'por+eng'], { maxBuffer: 4 * 1024 * 1024 })).stdout || '')))).join('\n');
      const fromOcr = draftFromPdfText(ocrText);
      if (score(fromOcr) >= score(draft)) { draft = fromOcr; ocrUsed = true; }
    }
    return { ...draft, ocr_used: ocrUsed };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function pngDimensions(buffer) {
  if (buffer.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error('A pré-visualização do PDF não é válida.');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function renderPdfFirstPage(pdf, directory) {
  const input = path.join(directory, 'modelo.pdf');
  const prefix = path.join(directory, 'page');
  fs.writeFileSync(input, pdf);
  await execFileAsync('pdftoppm', ['-f', '1', '-l', '1', '-r', '144', '-png', input, prefix], { maxBuffer: 4 * 1024 * 1024 });
  const image = fs.readdirSync(directory).find((file) => /^page-1\.png$/i.test(file));
  if (!image) throw new Error('Não foi possível criar a pré-visualização da primeira página.');
  return path.join(directory, image);
}

function templateFields(value) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(['customer', 'order_number', 'part_code', 'quantity']);
  return value.filter((field) => allowed.has(field?.field)).map((field) => ({
    field: field.field,
    left: Math.max(0, Math.min(99.9, Number(field.left) || 0)),
    top: Math.max(0, Math.min(99.9, Number(field.top) || 0)),
    width: Math.max(0.5, Math.min(100, Number(field.width) || 0)),
    height: Math.max(0.5, Math.min(100, Number(field.height) || 0)),
  })).filter((field) => field.left + field.width <= 100.5 && field.top + field.height <= 100.5);
}

async function extractWithCustomerTemplate(pdf, customer) {
  const fields = templateFields(customer?.template?.fields);
  if (!fields.length) return null;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'c3d-customer-template-'));
  try {
    const page = await renderPdfFirstPage(pdf, temporary);
    const dimensions = pngDimensions(fs.readFileSync(page));
    const result = {};
    for (const [index, field] of fields.entries()) {
      const x = Math.round((field.left / 100) * dimensions.width);
      const y = Math.round((field.top / 100) * dimensions.height);
      const width = Math.max(1, Math.round((field.width / 100) * dimensions.width));
      const height = Math.max(1, Math.round((field.height / 100) * dimensions.height));
      const crop = path.join(temporary, `field-${index}.png`);
      await execFileAsync('convert', [page, '-crop', `${width}x${height}+${x}+${y}`, '+repage', crop], { maxBuffer: 4 * 1024 * 1024 });
      const text = clean(String((await execFileAsync('tesseract', [crop, 'stdout', '-l', 'por+eng', '--psm', '6'], { maxBuffer: 4 * 1024 * 1024 })).stdout || '').replace(/\s+/g, ' '), 500);
      if (!result[field.field]) result[field.field] = [];
      result[field.field].push(text);
    }
    const values = Object.fromEntries(Object.entries(result).map(([key, parts]) => [key, parts.filter(Boolean).join(' ')]));
    const codes = String(values.part_code || '').match(/[A-Z0-9][A-Z0-9._/-]{1,}/gi) || [];
    const quantities = (String(values.quantity || '').match(/\d{1,5}/g) || []).map(Number).filter(Boolean);
    const items = codes.slice(0, Math.min(codes.length, quantities.length, 100)).map((part_code, index) => ({ part_code: part_code.toUpperCase(), quantity: quantities[index] }));
    return {
      customer: customer.name,
      order_number: clean(values.order_number, 120),
      items,
      warnings: items.length ? [] : ['O modelo do cliente não identificou referências e quantidades; confirme manualmente.'],
      ocr_used: true,
      template_used: true,
    };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function localPrivateNetworks() {
  const privateAddress = (address) => {
    const values = address.split('.').map(Number);
    return values[0] === 10 || (values[0] === 172 && values[1] >= 16 && values[1] <= 31) || (values[0] === 192 && values[1] === 168);
  };
  return Object.values(os.networkInterfaces()).flat().filter((item) => item && item.family === 'IPv4' && !item.internal && privateAddress(item.address)).map((item) => ({ address: item.address, subnet: item.address.split('.').slice(0, 3).join('.') }));
}

function requestedPrivateNetwork(value) {
  const match = clean(value, 32).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(?:0|\d{1,3})(?:\/24)?$/);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number); if (parts.some((part) => part > 255)) return null;
  const privateNetwork = parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
  return privateNetwork ? { address: `${parts.join('.')}.0`, subnet: parts.join('.') } : null;
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }); let done = false;
    const finish = (open) => { if (done) return; done = true; socket.destroy(); resolve(open); };
    socket.setTimeout(250); socket.once('connect', () => finish(true)); socket.once('timeout', () => finish(false)); socket.once('error', () => finish(false));
  });
}

async function getDiscovery(url) { try { return await discoveryClient.get(url); } catch { return null; } }
async function discoverPrinterAt(ip) {
  const ports = await Promise.all([7125, 4408, 5000, 80].map(async (port) => ({ port, open: await portOpen(ip, port) })));
  const open = new Set(ports.filter((entry) => entry.open).map((entry) => entry.port));
  for (const port of [7125, 4408, 80]) if (open.has(port)) {
    const response = await getDiscovery(`http://${ip}:${port}/server/info`);
    if (response?.status === 200 && (response.data?.result || response.data?.moonraker_version || response.data?.api_version)) return { ip, port, type: 'klipper', detected_as: 'Moonraker / Klipper', url: `http://${ip}:${port}` };
  }
  for (const port of [5000, 80]) if (open.has(port)) {
    const response = await getDiscovery(`http://${ip}:${port}/api/version`);
    if (response?.status === 200 && (response.data?.api || response.data?.server || /octoprint/i.test(JSON.stringify(response.data)))) return { ip, port, type: 'octoprint', detected_as: 'OctoPrint', url: `http://${ip}:${port}` };
  }
  if (open.has(80)) {
    const response = await getDiscovery(`http://${ip}:80/api/v1/status`);
    if (response?.status === 200 && (response.data?.printer || response.data?.telemetry || response.data?.storage)) return { ip, port: 80, type: 'prusa', detected_as: 'PrusaLink', url: `http://${ip}` };
    const root = await getDiscovery(`http://${ip}:80/`); const text = typeof root?.data === 'string' ? root.data : '';
    if (/octoprint/i.test(text)) return { ip, port: 80, type: 'octoprint', detected_as: 'OctoPrint', url: `http://${ip}` };
    if (/prusalink|prusa link/i.test(text)) return { ip, port: 80, type: 'prusa', detected_as: 'PrusaLink', url: `http://${ip}` };
  }
  return null;
}

async function discoverLocalPrinters(requestedSubnet) {
  const requested = requestedPrivateNetwork(requestedSubnet); const networks = requested ? [requested] : localPrivateNetworks(); const seen = new Set(); const candidates = [];
  for (const network of networks) for (let host = 1; host <= 254; host += 1) { const ip = `${network.subnet}.${host}`; if (ip !== network.address && !seen.has(ip)) { seen.add(ip); candidates.push(ip); } }
  let cursor = 0; const found = [];
  const worker = async () => { while (cursor < candidates.length) { const ip = candidates[cursor++]; const result = await discoverPrinterAt(ip); if (result) found.push(result); } };
  await Promise.all(Array.from({ length: Math.min(28, candidates.length) }, worker));
  return { networks, printers: found.sort((left, right) => left.ip.localeCompare(right.ip)) };
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

app.get('/api/files', (_req, res) => res.json([...state().files].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))));
app.post('/api/files', upload.single('gcode'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Seleciona um ficheiro G-code.' });
  const contents = fs.readFileSync(req.file.path, 'utf8').slice(0, 4 * 1024 * 1024);
  const metadata = gcodeMetadata(contents, req.body || {});
  if (!metadata.valid) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: `Preenche os campos obrigatórios: ${metadata.missing.join(', ')}.` }); }
  const saved = state(); const id = crypto.randomUUID(); const thumbnail = gcodeThumbnail(contents, id, req.file.originalname, metadata);
  const item = { id, original_name: clean(req.file.originalname, 255), stored_name: req.file.filename, size_bytes: req.file.size, metadata, thumbnail, created_at: new Date().toISOString() };
  saved.files.unshift(item); save(saved); res.status(201).json(item);
});
app.delete('/api/files/:id', (req, res) => {
  const saved = state(); const file = getLibraryFile(saved, req.params.id); if (!file) return res.status(404).json({ error: 'Ficheiro não encontrado.' });
  for (const name of [file.stored_name, file.thumbnail?.stored_name]) if (name) fs.rmSync(path.join(uploadsDir, name), { force: true });
  saved.files = saved.files.filter((item) => item.id !== file.id); save(saved); res.status(204).end();
});
app.get('/api/orders', (_req, res) => res.json(state().orders));
app.get('/api/customers', (_req, res) => res.json(state().customers));
app.post('/api/customers/template-preview', pdfUpload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Seleciona um PDF de exemplo.' });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'c3d-template-preview-'));
  try {
    const page = await renderPdfFirstPage(req.file.buffer, temporary);
    const image = fs.readFileSync(page);
    const dimensions = pngDimensions(image);
    res.json({ file_name: clean(req.file.originalname, 255), image: `data:image/png;base64,${image.toString('base64')}`, ...dimensions });
  } catch (error) {
    res.status(422).json({ error: `Não foi possível preparar o PDF: ${error.message || 'erro desconhecido'}` });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
app.post('/api/customers', (req, res) => {
  const name = clean(req.body?.name, 120); if (!name) return res.status(400).json({ error: 'O nome do cliente é obrigatório.' });
  const saved = state();
  if (saved.customers.some((item) => item.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'Já existe um cliente com este nome.' });
  const item = { id: crypto.randomUUID(), name, email: clean(req.body?.email, 160), phone: clean(req.body?.phone, 60), notes: clean(req.body?.notes, 1000), template: { sample_name: clean(req.body?.template?.sample_name, 255), fields: templateFields(req.body?.template?.fields) }, created_at: new Date().toISOString() };
  saved.customers.push(item); save(saved); res.status(201).json(item);
});
app.delete('/api/customers/:id', (req, res) => {
  const saved = state(); const index = saved.customers.findIndex((item) => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (saved.orders.some((order) => order.customer_id === req.params.id)) return res.status(409).json({ error: 'Este cliente já tem encomendas associadas e não pode ser removido.' });
  saved.customers.splice(index, 1); save(saved); res.status(204).end();
});
app.post('/api/orders/import-pdf', pdfUpload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Seleciona um PDF de encomenda.' });
  try {
    const saved = state(); const customer = clean(req.body?.customer_id, 80) ? getCustomer(saved, req.body.customer_id) : null;
    if (req.body?.customer_id && !customer) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const generic = await extractPdfOrder(req.file.buffer);
    const templated = customer ? await extractWithCustomerTemplate(req.file.buffer, customer) : null;
    const draft = templated ? {
      ...generic,
      customer: customer.name,
      order_number: templated.order_number || generic.order_number,
      items: templated.items.length ? templated.items : generic.items,
      warnings: [...new Set([...(generic.warnings || []), ...(templated.warnings || [])])],
      ocr_used: Boolean(generic.ocr_used || templated.ocr_used),
      template_used: true,
    } : { ...generic, ...(customer ? { customer: customer.name, template_used: false } : {}) };
    res.json({ file_name: clean(req.file.originalname, 255), customer_id: customer?.id || null, ...draft });
  } catch (error) {
    res.status(422).json({ error: `NÃ£o foi possÃ­vel ler o PDF: ${error.message || 'erro desconhecido'}` });
  }
});
app.post('/api/orders', (req, res) => {
  if (!clean(req.body?.title, 120)) return res.status(400).json({ error: 'O nome da encomenda é obrigatório.' });
  const saved = state(); const customer = clean(req.body?.customer_id, 80) ? getCustomer(saved, req.body.customer_id) : null; const item = { id: orderId(), title: clean(req.body.title, 120), customer_id: customer?.id || null, customer: customer?.name || clean(req.body.customer, 120), due_date: clean(req.body.due_date, 20) || null, priority: Math.min(2, Math.max(0, Number(req.body.priority) || 0)), notes: clean(req.body.notes, 1000), status: 'received', printer_id: null, files: [], items: Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [], document: req.body.document || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
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
  if (!metadata.valid) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: `Preenche os campos obrigatórios: ${metadata.missing.join(', ')}.` }); }
  const file = { id: crypto.randomUUID(), original_name: clean(req.file.originalname, 255), stored_name: req.file.filename, size_bytes: req.file.size, uploaded_at: new Date().toISOString(), metadata };
  item.files.push(file); item.updated_at = new Date().toISOString(); save(saved); res.status(201).json(file);
});
app.post('/api/orders/:id/complete', async (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id); if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  const file = item.files.find((candidate) => candidate.id === req.body?.file_id) || item.files[0]; const spoolId = saved.assignments[String(item.printer_id)]?.spool_id; const grams = Number(file?.metadata?.filament_grams || 0);
  if (spoolId && grams > 0) { const spool = await safeGet(`${spoolmanUrl}/api/v1/spool/${spoolId}`); if (!spool.ok) return res.status(502).json({ error: 'Não foi possível obter a bobine atribuída.' }); const result = await safeRequest('patch', `${spoolmanUrl}/api/v1/spool/${spoolId}`, { used_weight: Number(spool.data.used_weight || 0) + grams }); if (!result.ok) return res.status(502).json({ error: 'Não foi possível atualizar o peso no Spoolman.' }); saved.consumption.unshift({ spool_id: spoolId, grams, printer_id: item.printer_id, order_id: item.id, automatic: true, created_at: new Date().toISOString() }); }
  item.status = 'completed'; item.updated_at = new Date().toISOString(); save(saved); res.json({ order: item, consumed_grams: grams || null });
});

app.post('/api/printers/discover', async (req, res) => {
  const requested = clean(req.body?.subnet, 32); if (requested && !requestedPrivateNetwork(requested)) return res.status(400).json({ error: 'Indica uma rede privada /24, por exemplo 192.168.1.0/24.' });
  try { res.json(await discoverLocalPrinters(requested)); } catch (error) { res.status(502).json({ error: `Não foi possível analisar a rede local: ${error.message || 'erro desconhecido'}` }); }
});
app.post('/api/printers', async (req, res) => forwarded(res, await safeRequest('post', `${farmUrl}/api/printers`, req.body)));
app.post('/api/projects', async (req, res) => forwarded(res, await safeRequest('post', `${farmUrl}/api/projects`, req.body)));
app.post('/api/spools', async (req, res) => { const { filament_id, remaining_weight } = req.body || {}; if (!filament_id) return res.status(400).json({ error: 'Seleciona um filamento antes de criar a bobine.' }); forwarded(res, await safeRequest('post', `${spoolmanUrl}/api/v1/spool`, { filament_id: Number(filament_id), used_weight: 0, ...(remaining_weight ? { initial_weight: Number(remaining_weight) } : {}) })); });
app.get('/api/filaments', async (_req, res) => { const result = await safeGet(`${spoolmanUrl}/api/v1/filament`); result.ok ? res.json(Array.isArray(result.data) ? result.data : []) : res.status(502).json({ error: 'Não foi possível obter os filamentos do Spoolman.' }); });
app.post('/api/assignments', (req, res) => { const { printer_id, spool_id } = req.body || {}; if (!printer_id || !spool_id) return res.status(400).json({ error: 'Impressora e bobine são obrigatórias.' }); const saved = state(); saved.assignments[String(printer_id)] = { spool_id: Number(spool_id), assigned_at: new Date().toISOString() }; save(saved); res.status(201).json(saved.assignments[String(printer_id)]); });
app.delete('/api/assignments/:printerId', (req, res) => { const saved = state(); delete saved.assignments[String(req.params.printerId)]; save(saved); res.status(204).end(); });
app.post('/api/consume', async (req, res) => { const spoolId = Number(req.body?.spool_id); const grams = Number(req.body?.grams); if (!spoolId || !Number.isFinite(grams) || grams <= 0) return res.status(400).json({ error: 'Indica uma bobine e uma quantidade válida em gramas.' }); const spool = await safeGet(`${spoolmanUrl}/api/v1/spool/${spoolId}`); if (!spool.ok) return res.status(404).json({ error: 'Bobine não encontrada.' }); const result = await safeRequest('patch', `${spoolmanUrl}/api/v1/spool/${spoolId}`, { used_weight: Number(spool.data.used_weight || 0) + grams }); if (!result.ok) return res.status(502).json({ error: 'Não foi possível atualizar o peso no Spoolman.' }); const saved = state(); saved.consumption.unshift({ spool_id: spoolId, grams, printer_id: req.body?.printer_id || null, order_id: req.body?.order_id || null, automatic: false, created_at: new Date().toISOString() }); save(saved); res.json({ spool: result.data }); });

app.use((error, _req, res, _next) => res.status(400).json({ error: error.message || 'Não foi possível processar o ficheiro.' }));
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.4.0' }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`Conceito 3D Production Hub listening on ${port}`));
