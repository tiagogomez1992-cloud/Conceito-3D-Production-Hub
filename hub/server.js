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
// Internal adapters retain the portal API shape while keeping all operational data
// in the Production Hub itself.
const internalProductionUrl = 'http://production-hub.local';
const client = axios.create({ timeout: 5000 });
const discoveryClient = axios.create({ timeout: 1200, validateStatus: () => true, maxRedirects: 0 });
const printerConnectors = new Set(['prusa', 'elegoo-centauri', 'elegoo-centauri2', 'bambu', 'klipper', 'octoprint']);
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const stateFile = path.join(dataDir, 'portal-state.json');
const authUser = process.env.HUB_AUTH_USER || '';
const authPassword = process.env.HUB_AUTH_PASSWORD || '';
const execFileAsync = promisify(execFile);

fs.mkdirSync(uploadsDir, { recursive: true });
app.use(express.json({ limit: '256kb' }));

function emptyState() {
  return {
    assignments: {}, consumption: [], orders: [], customers: [], files: [], library_parts: [],
    printers: [], spools: [], projects: [], parts: [], production_gcodes: [], jobs: [],
  };
}
function libraryPartName(value) { return clean(value, 120).replace(/\s+/g, ' ').toLocaleUpperCase('pt-PT'); }
function partNameFromFile(file) {
  return libraryPartName(path.basename(file.original_name || 'PECA', path.extname(file.original_name || ''))
    .replace(/[_-]+/g, ' ')) || 'PECA';
}
function migrateState(raw) {
  const value = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) };
  value.files = Array.isArray(value.files) ? value.files : [];
  value.orders = Array.isArray(value.orders) ? value.orders : [];
  value.library_parts = Array.isArray(value.library_parts) ? value.library_parts : [];
  value.printers = Array.isArray(value.printers) ? value.printers : [];
  value.spools = Array.isArray(value.spools) ? value.spools : [];
  value.projects = Array.isArray(value.projects) ? value.projects : [];
  value.parts = Array.isArray(value.parts) ? value.parts : [];
  value.production_gcodes = Array.isArray(value.production_gcodes) ? value.production_gcodes : [];
  value.jobs = Array.isArray(value.jobs) ? value.jobs : [];
  let changed = !Array.isArray(raw?.library_parts) || !Array.isArray(raw?.printers) || !Array.isArray(raw?.spools) || !Array.isArray(raw?.projects) || !Array.isArray(raw?.parts) || !Array.isArray(raw?.production_gcodes) || !Array.isArray(raw?.jobs);
  const usedNames = new Set(value.library_parts.map((part) => libraryPartName(part.name)).filter(Boolean));

  for (const part of value.library_parts) {
    const normalized = libraryPartName(part.name);
    if (part.name !== normalized) { part.name = normalized; changed = true; }
  }
  for (const file of value.files) {
    if (!file.part_id || !value.library_parts.some((part) => part.id === file.part_id)) {
      const baseName = partNameFromFile(file);
      let name = baseName; let suffix = 2;
      while (usedNames.has(name)) name = `${baseName} ${suffix++}`;
      const part = { id: crypto.randomUUID(), name, description: '', created_at: file.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
      value.library_parts.push(part); usedNames.add(name); file.part_id = part.id; changed = true;
    }
    if (file.printer_model === undefined) { file.printer_model = clean(file.metadata?.printer_model, 100); changed = true; }
    if (file.active === undefined) { file.active = true; changed = true; }
  }
  for (const order of value.orders) {
    if (!Array.isArray(order.library_parts)) {
      const legacy = Array.isArray(order.library_files) ? order.library_files : (order.library_file_id ? [{ file_id: order.library_file_id, requested_quantity: null }] : []);
      const byPart = new Map();
      for (const entry of legacy) {
        const file = value.files.find((candidate) => candidate.id === entry?.file_id);
        if (!file?.part_id) continue;
        byPart.set(file.part_id, { part_id: file.part_id, requested_quantity: entry.requested_quantity, selected_file_id: file.id });
      }
      order.library_parts = [...byPart.values()]; changed = true;
    }
  }
  return { value, changed };
}
function state() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const migrated = migrateState(parsed);
    if (migrated.changed) save(migrated.value);
    return migrated.value;
  } catch { return emptyState(); }
}
function save(value) { fs.writeFileSync(stateFile, JSON.stringify(value, null, 2)); }
function clean(value, max = 500) { return String(value || '').trim().slice(0, max); }
function number(value) { const n = Number(String(value || '').replace(',', '.')); return Number.isFinite(n) ? n : null; }
function orderId() { return `C3D-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`; }
function getOrder(value, id) { return value.orders.find((item) => item.id === id); }
function getCustomer(value, id) { return value.customers.find((item) => item.id === id); }
function getLibraryFile(value, id) { return value.files.find((item) => item.id === id); }
function getLibraryPart(value, id) { return value.library_parts.find((item) => item.id === id); }
function libraryPartFiles(value, id, activeOnly = false) { return value.files.filter((item) => item.part_id === id && (!activeOnly || item.active !== false)); }
function orderLibraryFiles(order) {
  if (Array.isArray(order.library_files)) return order.library_files.filter((entry) => entry?.file_id);
  return order.library_file_id ? [{ file_id: order.library_file_id, requested_quantity: null }] : [];
}
function orderGcodePlan(value, order) {
  if (Array.isArray(order.library_parts) && order.library_parts.length) return order.library_parts.flatMap((entry) => {
    const part = getLibraryPart(value, entry.part_id);
    if (!part) return [];
    const allVariants = libraryPartFiles(value, part.id, true);
    const matchingPrinter = clean(order.printer_model, 100) ? allVariants.filter((file) => file.printer_model === order.printer_model) : [];
    const variants = matchingPrinter.length ? matchingPrinter : allVariants;
    const requestedQuantity = Math.max(1, Math.floor(Number(entry.requested_quantity) || 1));
    const selected = variants.find((file) => file.id === entry.selected_file_id) || [...variants].sort((left, right) => {
      const leftYield = Math.max(1, Math.floor(Number(left.metadata?.quantity) || 1));
      const rightYield = Math.max(1, Math.floor(Number(right.metadata?.quantity) || 1));
      const leftExcess = Math.ceil(requestedQuantity / leftYield) * leftYield - requestedQuantity;
      const rightExcess = Math.ceil(requestedQuantity / rightYield) * rightYield - requestedQuantity;
      return leftExcess - rightExcess || Math.ceil(requestedQuantity / leftYield) - Math.ceil(requestedQuantity / rightYield);
    })[0];
    if (!selected) return [];
    const piecesPerRun = Math.max(1, Math.floor(Number(selected.metadata?.quantity) || 1));
    const runs = Math.ceil(requestedQuantity / piecesPerRun);
    return [{ part, file: selected, requested_quantity: requestedQuantity, pieces_per_run: piecesPerRun, runs, produced_quantity: runs * piecesPerRun, excess_quantity: runs * piecesPerRun - requestedQuantity, grams: runs * (Number(selected.metadata?.filament_grams) || 0) }];
  });
  return orderLibraryFiles(order).flatMap((entry) => {
    const file = getLibraryFile(value, entry.file_id);
    if (!file) return [];
    const piecesPerRun = Math.max(1, Math.floor(Number(file.metadata?.quantity) || 1));
    const requestedQuantity = Math.max(1, Math.floor(Number(entry.requested_quantity) || piecesPerRun));
    const runs = Math.ceil(requestedQuantity / piecesPerRun);
    return [{ file, requested_quantity: requestedQuantity, pieces_per_run: piecesPerRun, runs, grams: runs * (Number(file.metadata?.filament_grams) || 0) }];
  });
}

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

function nextId(items) { return items.reduce((largest, item) => Math.max(largest, Number(item.id) || 0), 0) + 1; }
function getManagedPrinter(value, id) { return value.printers.find((item) => Number(item.id) === Number(id)); }
function getManagedProject(value, id) { return value.projects.find((item) => Number(item.id) === Number(id)); }
function getManagedPart(value, id) { return value.parts.find((item) => Number(item.id) === Number(id)); }
function getManagedGcode(value, id) { return value.production_gcodes.find((item) => Number(item.id) === Number(id)); }
function projectParts(value, projectId) { return value.parts.filter((item) => Number(item.project_id) === Number(projectId)); }
function partProductionGcodes(value, partId) { return value.production_gcodes.filter((item) => Number(item.part_id) === Number(partId)); }
function printerEndpoint(printer, pathName, defaultPort) {
  let host = clean(printer.ip, 160).replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (!host) return null;
  if (defaultPort && !/:[0-9]+$/.test(host)) host = `${host}:${defaultPort}`;
  return `http://${host}${pathName}`;
}
function canonicalState(value) {
  const stateValue = String(value || '').toLowerCase();
  if (/print|running|busy/.test(stateValue)) return 'PRINTING';
  if (/pause/.test(stateValue)) return 'PAUSED';
  if (/finish|complete|done/.test(stateValue)) return 'FINISHED';
  if (/idle|ready|operational|standby/.test(stateValue)) return 'IDLE';
  return 'UNKNOWN';
}
async function directPrinterStatus(printer) {
  const unavailable = { ...printer, status: 'OFFLINE', job_name: null, job_progress: 0, job_time_remaining: null, checked_at: new Date().toISOString() };
  try {
    if (printer.type === 'klipper') {
      const response = await client.get(printerEndpoint(printer, '/printer/objects/query?print_stats&virtual_sdcard&display_status', 7125), { timeout: 3500 });
      const status = response.data?.result?.status || {};
      const stats = status.print_stats || {}; const virtualSd = status.virtual_sdcard || {}; const display = status.display_status || {};
      return { ...printer, status: canonicalState(stats.state), job_name: stats.filename || null, job_progress: Number(virtualSd.progress ?? display.progress ?? 0), job_time_remaining: null, checked_at: new Date().toISOString() };
    }
    if (printer.type === 'octoprint') {
      const response = await client.get(printerEndpoint(printer, '/api/job'), { timeout: 3500, headers: printer.api_key ? { 'X-Api-Key': printer.api_key } : {} });
      const progress = response.data?.progress || {}; const job = response.data?.job || {};
      return { ...printer, status: canonicalState(response.data?.state), job_name: job.file?.name || null, job_progress: Number(progress.completion || 0) / 100, job_time_remaining: Number(progress.printTimeLeft) || null, checked_at: new Date().toISOString() };
    }
    if (printer.type === 'prusa') {
      const response = await client.get(printerEndpoint(printer, '/api/v1/status', 80), { timeout: 3500, headers: printer.api_key ? { 'X-Api-Key': printer.api_key } : {} });
      const printerData = response.data?.printer || response.data || {}; const job = response.data?.job || {};
      return { ...printer, status: canonicalState(printerData.state || printerData.status), job_name: job.file?.name || job.file_name || null, job_progress: Number(job.progress || printerData.progress || 0), job_time_remaining: Number(job.time_remaining || 0) || null, checked_at: new Date().toISOString() };
    }
    return { ...printer, status: 'UNKNOWN', job_name: null, job_progress: 0, job_time_remaining: null, checked_at: new Date().toISOString() };
  } catch { return unavailable; }
}
async function managedPrinterSnapshots(value) { return Promise.all(value.printers.map(directPrinterStatus)); }
function dispatchStatus(value, part, snapshots = []) {
  const variants = partProductionGcodes(value, part.id);
  if (!variants.length) return { dispatchable: false, reasons: ['A peça ainda não tem um G-code de produção.'], notes: [] };
  const compatible = snapshots.filter((printer) => variants.some((gcode) => gcode.printer_model === printer.model));
  if (!compatible.length) return { dispatchable: false, reasons: ['Não existe uma impressora registada com o modelo desta variante de G-code.'], notes: [] };
  if (!compatible.some((printer) => printer.status === 'IDLE')) return { dispatchable: false, reasons: ['As impressoras compatíveis não estão livres neste momento.'], notes: [] };
  return { dispatchable: true, reasons: [], notes: [] };
}
function localSpool(item) {
  const initial = Number(item.initial_weight || 0); const used = Number(item.used_weight || 0);
  return { ...item, remaining_weight: Math.max(0, Number(item.remaining_weight ?? initial - used)), filament: { material: item.material || 'Material não definido', color_hex: item.color_hex || '#6f747a', vendor: { name: item.brand || 'Sem fabricante' } } };
}
const localFilamentCatalog = [
  { id: 1, material: 'PLA', color_name: 'Preto', color_hex: '#1b1b1b', name: 'PLA Preto' },
  { id: 2, material: 'PETG', color_name: 'Preto', color_hex: '#1b1b1b', name: 'PETG Preto' },
  { id: 3, material: 'ASA', color_name: 'Preto', color_hex: '#1b1b1b', name: 'ASA Preto' },
  { id: 4, material: 'TPU', color_name: 'Preto', color_hex: '#1b1b1b', name: 'TPU Preto' },
];
function apiResult(data) { return { ok: true, data }; }
function apiError(status, error) { return { ok: false, status, error }; }
async function localFarmApi(method, rawUrl, body = {}) {
  const url = new URL(rawUrl); const pathname = url.pathname; const saved = state(); const now = new Date().toISOString();
  const projectMatch = pathname.match(/^\/api\/projects\/(\d+)$/); const partMatch = pathname.match(/^\/api\/parts\/(\d+)$/); const gcodeMatch = pathname.match(/^\/api\/gcodes\/(\d+)$/);
  if (method === 'get' && pathname === '/api/health') return apiResult({ ok: true, service: 'production-hub' });
  if (method === 'get' && pathname === '/api/printers') return apiResult(await managedPrinterSnapshots(saved));
  if (method === 'get' && pathname === '/api/projects') return apiResult([...saved.projects].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(b.id) - Number(a.id)));
  if (method === 'get' && projectMatch) { const project = getManagedProject(saved, projectMatch[1]); return project ? apiResult(project) : apiError(404, 'Projeto não encontrado.'); }
  if (method === 'post' && pathname === '/api/projects') {
    const name = clean(body.name, 120); if (!name) return apiError(400, 'O nome do projeto é obrigatório.');
    const item = { id: nextId(saved.projects), name, description: clean(body.description, 500), priority: Math.min(2, Math.max(0, Number(body.priority) || 0)), status: 'draft', required_material: '', required_color: '', sort_order: saved.projects.length, created_at: now, updated_at: now };
    saved.projects.push(item); save(saved); return apiResult(item);
  }
  if (method === 'put' && pathname === '/api/projects/reorder') {
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : []; if (ids.length !== saved.projects.length || ids.some((id) => !getManagedProject(saved, id))) return apiError(400, 'A nova ordem dos projetos não é válida.');
    ids.forEach((id, index) => { const project = getManagedProject(saved, id); project.sort_order = index; project.updated_at = now; }); save(saved); return apiResult(saved.projects);
  }
  if (method === 'put' && projectMatch) {
    const project = getManagedProject(saved, projectMatch[1]); if (!project) return apiError(404, 'Projeto não encontrado.');
    for (const key of ['name', 'description', 'status']) if (body[key] !== undefined) project[key] = clean(body[key], key === 'description' ? 500 : 120);
    if (body.priority !== undefined) project.priority = Math.min(2, Math.max(0, Number(body.priority) || 0)); project.updated_at = now; save(saved); return apiResult(project);
  }
  const filamentProjectMatch = pathname.match(/^\/api\/projects\/(\d+)\/filament$/);
  if (method === 'put' && filamentProjectMatch) {
    const project = getManagedProject(saved, filamentProjectMatch[1]); if (!project) return apiError(404, 'Projeto não encontrado.'); project.required_material = clean(body.required_material, 80); project.required_color = clean(body.required_color, 80); project.updated_at = now; save(saved); return apiResult(project);
  }
  const completeProjectMatch = pathname.match(/^\/api\/projects\/(\d+)\/complete$/);
  if (method === 'post' && completeProjectMatch) {
    const project = getManagedProject(saved, completeProjectMatch[1]); if (!project) return apiError(404, 'Projeto não encontrado.'); project.status = 'completed'; project.updated_at = now; projectParts(saved, project.id).forEach((part) => { part.status = 'closed'; part.updated_at = now; }); save(saved); return apiResult(project);
  }
  const reactivateProjectMatch = pathname.match(/^\/api\/projects\/(\d+)\/reactivate$/);
  if (method === 'post' && reactivateProjectMatch) {
    const project = getManagedProject(saved, reactivateProjectMatch[1]); if (!project) return apiError(404, 'Projeto não encontrado.'); project.status = 'active'; project.updated_at = now; projectParts(saved, project.id).forEach((part) => { if (Number(part.completed_qty || 0) < Number(part.target_qty || 0)) { part.status = 'open'; part.updated_at = now; } }); save(saved); return apiResult(project);
  }
  const duplicateProjectMatch = pathname.match(/^\/api\/projects\/(\d+)\/duplicate$/);
  if (method === 'post' && duplicateProjectMatch) {
    const source = getManagedProject(saved, duplicateProjectMatch[1]); if (!source) return apiError(404, 'Projeto não encontrado.');
    const copy = { ...source, id: nextId(saved.projects), name: clean(body.name, 120) || `Cópia de ${source.name}`, status: 'draft', sort_order: saved.projects.length, created_at: now, updated_at: now }; saved.projects.push(copy);
    const partMap = new Map(); for (const sourcePart of projectParts(saved, source.id)) { const copyPart = { ...sourcePart, id: nextId(saved.parts), project_id: copy.id, completed_qty: 0, active_qty: 0, status: 'open', created_at: now, updated_at: now }; saved.parts.push(copyPart); partMap.set(sourcePart.id, copyPart.id); }
    for (const sourceGcode of [...saved.production_gcodes]) if (partMap.has(sourceGcode.part_id)) saved.production_gcodes.push({ ...sourceGcode, id: nextId(saved.production_gcodes), part_id: partMap.get(sourceGcode.part_id), created_at: now });
    save(saved); return apiResult({ project: copy });
  }
  if (method === 'delete' && projectMatch) {
    const project = getManagedProject(saved, projectMatch[1]); if (!project) return apiError(404, 'Projeto não encontrado.'); const partIds = new Set(projectParts(saved, project.id).map((part) => part.id));
    saved.projects = saved.projects.filter((item) => item.id !== project.id); saved.parts = saved.parts.filter((part) => !partIds.has(part.id)); saved.production_gcodes = saved.production_gcodes.filter((gcode) => !partIds.has(gcode.part_id)); saved.jobs = saved.jobs.filter((job) => !partIds.has(job.part_id)); save(saved); return apiResult({ ok: true });
  }
  if (method === 'get' && pathname === '/api/parts') { const projectId = Number(url.searchParams.get('project_id')); return apiResult(projectParts(saved, projectId)); }
  if (method === 'get' && partMatch) { const part = getManagedPart(saved, partMatch[1]); return part ? apiResult(part) : apiError(404, 'Peça não encontrada.'); }
  if (method === 'post' && pathname === '/api/parts') {
    const project = getManagedProject(saved, body.project_id); const name = clean(body.name, 120); const targetQty = Math.floor(Number(body.target_qty)); if (!project) return apiError(404, 'Projeto não encontrado.'); if (!name || !Number.isInteger(targetQty) || targetQty < 1) return apiError(400, 'Indica o nome e a quantidade válida da peça.');
    const part = { id: nextId(saved.parts), project_id: project.id, name, target_qty: targetQty, completed_qty: 0, active_qty: 0, status: 'open', created_at: now, updated_at: now }; saved.parts.push(part); save(saved); return apiResult(part);
  }
  if (method === 'put' && partMatch) {
    const part = getManagedPart(saved, partMatch[1]); if (!part) return apiError(404, 'Peça não encontrada.'); if (body.target_qty !== undefined) { const value = Math.floor(Number(body.target_qty)); if (!Number.isInteger(value) || value < 1) return apiError(400, 'A meta deve ser uma quantidade válida.'); part.target_qty = value; }
    if (body.completed_qty !== undefined) { const value = Math.max(0, Math.floor(Number(body.completed_qty) || 0)); part.completed_qty = value; part.status = value >= Number(part.target_qty) ? 'closed' : 'open'; }
    part.updated_at = now; const project = getManagedProject(saved, part.project_id); if (project && projectParts(saved, project.id).every((candidate) => candidate.status === 'closed')) project.status = 'completed'; save(saved); return apiResult(part);
  }
  if (method === 'delete' && partMatch) { const part = getManagedPart(saved, partMatch[1]); if (!part) return apiError(404, 'Peça não encontrada.'); saved.parts = saved.parts.filter((item) => item.id !== part.id); saved.production_gcodes = saved.production_gcodes.filter((gcode) => gcode.part_id !== part.id); saved.jobs = saved.jobs.filter((job) => job.part_id !== part.id); save(saved); return apiResult({ ok: true }); }
  if (method === 'get' && pathname === '/api/gcodes') { const partId = Number(url.searchParams.get('part_id')); return apiResult(partProductionGcodes(saved, partId)); }
  if (method === 'delete' && gcodeMatch) { const gcode = getManagedGcode(saved, gcodeMatch[1]); if (!gcode) return apiError(404, 'G-code não encontrado.'); saved.production_gcodes = saved.production_gcodes.filter((item) => item.id !== gcode.id); save(saved); return apiResult({ ok: true }); }
  const dispatchMatch = pathname.match(/^\/api\/parts\/(\d+)\/dispatch-status$/);
  if (method === 'get' && dispatchMatch) { const part = getManagedPart(saved, dispatchMatch[1]); if (!part) return apiError(404, 'Peça não encontrada.'); return apiResult(dispatchStatus(saved, part, await managedPrinterSnapshots(saved))); }
  if (method === 'post' && pathname === '/api/scheduler/dispatch') return apiResult({ dispatched: 0, message: 'A fila foi analisada. O envio automático será ativado numa etapa própria.' });
  return apiError(404, 'Operação de produção não encontrada.');
}
async function safeGet(url) {
  if (url.startsWith(internalProductionUrl)) return localFarmApi('get', url);
  try { const response = await client.get(url); return apiResult(response.data); } catch (error) { return apiError(error.response?.status || 502, error.response?.data?.error || error.message); }
}
async function safeRequest(method, url, data) {
  if (url.startsWith(internalProductionUrl)) return localFarmApi(method.toLowerCase(), url, data);
  try { const response = await client.request({ method, url, data }); return apiResult(response.data); } catch (error) { return apiError(error.response?.status || 502, error.response?.data?.error || error.response?.data?.detail || error.message); }
}
function forwarded(res, result, status = 201) { return result.ok ? res.status(status).json(result.data) : res.status(result.status || 502).json({ error: result.error || 'O pedido não foi aceite.' }); }

app.get('/api/summary', async (_req, res) => {
  const saved = state(); const printerItems = await managedPrinterSnapshots(saved); const spoolItems = saved.spools.map(localSpool);
  const online = new Set(['IDLE', 'PRINTING', 'FINISHED', 'PAUSED', 'ONLINE']);
  const orders = [...saved.orders].sort((a, b) => Number(b.priority) - Number(a.priority) || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
  const projects = [...saved.projects].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(b.id) - Number(a.id));
  const jobs = [...saved.jobs].map((job) => ({ ...job, part_name: getManagedPart(saved, job.part_id)?.name || null, printer_name: getManagedPrinter(saved, job.printer_id)?.name || null }));
  res.json({ generatedAt: new Date().toISOString(), services: { productionHub: true }, system: { hostname: os.hostname(), uptime_seconds: os.uptime(), memory_total_mb: Math.round(os.totalmem() / 1048576), memory_used_mb: Math.round((os.totalmem() - os.freemem()) / 1048576), cpu_load_1m: Number(os.loadavg()[0].toFixed(2)) }, printers: { total: printerItems.length, online: printerItems.filter((item) => online.has(String(item.status || '').toUpperCase())).length, printing: printerItems.filter((item) => String(item.status || '').toUpperCase() === 'PRINTING').length, items: printerItems }, spools: { total: spoolItems.length, low: spoolItems.filter((item) => Number(item.remaining_weight || 0) > 0 && Number(item.remaining_weight || 0) < 200).length, items: spoolItems }, production: { projects, jobs, orders }, assignments: saved.assignments, consumption: saved.consumption.slice(0, 20) });
});

function libraryParts(value) {
  return [...value.library_parts]
    .sort((left, right) => left.name.localeCompare(right.name, 'pt-PT'))
    .map((part) => ({ ...part, gcodes: libraryPartFiles(value, part.id).sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))) }));
}
app.get('/api/library-parts', (_req, res) => { const saved = state(); res.json(libraryParts(saved)); });
app.post('/api/library-parts', (req, res) => {
  const name = libraryPartName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'O nome da peça é obrigatório.' });
  const saved = state();
  if (saved.library_parts.some((part) => part.name === name)) return res.status(409).json({ error: 'Já existe uma peça com este nome.' });
  const now = new Date().toISOString();
  const item = { id: crypto.randomUUID(), name, description: clean(req.body?.description, 500), created_at: now, updated_at: now };
  saved.library_parts.push(item); save(saved); res.status(201).json({ ...item, gcodes: [] });
});
app.put('/api/library-parts/:id', (req, res) => {
  const saved = state(); const item = getLibraryPart(saved, req.params.id);
  if (!item) return res.status(404).json({ error: 'Peça não encontrada.' });
  const name = libraryPartName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'O nome da peça é obrigatório.' });
  if (saved.library_parts.some((part) => part.id !== item.id && part.name === name)) return res.status(409).json({ error: 'Já existe uma peça com este nome.' });
  item.name = name; item.description = clean(req.body?.description, 500); item.updated_at = new Date().toISOString(); save(saved);
  res.json({ ...item, gcodes: libraryPartFiles(saved, item.id) });
});
app.delete('/api/library-parts/:id', (req, res) => {
  const saved = state(); const item = getLibraryPart(saved, req.params.id);
  if (!item) return res.status(404).json({ error: 'Peça não encontrada.' });
  if (libraryPartFiles(saved, item.id).length) return res.status(409).json({ error: 'Remove primeiro os G-codes desta peça.' });
  if (saved.orders.some((order) => order.library_parts?.some((entry) => entry.part_id === item.id))) return res.status(409).json({ error: 'Esta peça está associada a uma encomenda e não pode ser removida.' });
  saved.library_parts = saved.library_parts.filter((part) => part.id !== item.id); save(saved); res.status(204).end();
});

app.get('/api/files', (_req, res) => res.json([...state().files].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))));
app.post('/api/files', upload.single('gcode'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Seleciona um ficheiro G-code.' });
  const saved = state(); const part = getLibraryPart(saved, clean(req.body?.part_id, 80));
  const printerModel = clean(req.body?.printer_model, 100);
  if (!part || !printerModel) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: 'Seleciona uma peça e indica a impressora ou perfil compatível.' }); }
  const contents = fs.readFileSync(req.file.path, 'utf8').slice(0, 4 * 1024 * 1024);
  const metadata = gcodeMetadata(contents, req.body || {});
  if (!metadata.valid) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: `Preenche os campos obrigatórios: ${metadata.missing.join(', ')}.` }); }
  const id = crypto.randomUUID(); const thumbnail = gcodeThumbnail(contents, id, req.file.originalname, metadata);
  const item = { id, part_id: part.id, original_name: clean(req.file.originalname, 255), stored_name: req.file.filename, size_bytes: req.file.size, printer_model: printerModel, active: true, metadata, thumbnail, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  saved.files.unshift(item); save(saved); res.status(201).json(item);
});
app.put('/api/files/:id', (req, res) => {
  const saved = state(); const file = getLibraryFile(saved, req.params.id);
  if (!file) return res.status(404).json({ error: 'G-code não encontrado.' });
  const printerModel = clean(req.body?.printer_model, 100);
  const metadata = gcodeMetadata('', req.body || {});
  if (!printerModel || !metadata.valid) return res.status(400).json({ error: `Preenche a impressora e os campos técnicos obrigatórios${metadata.missing.length ? `: ${metadata.missing.join(', ')}` : '.'}` });
  metadata.filament_grams = number(req.body?.filament_grams) || file.metadata?.filament_grams || null;
  file.printer_model = printerModel; file.metadata = metadata; file.active = req.body?.active !== false && String(req.body?.active) !== 'false'; file.updated_at = new Date().toISOString();
  save(saved); res.json(file);
});
app.delete('/api/files/:id', (req, res) => {
  const current = state(); const target = getLibraryFile(current, req.params.id);
  const referenced = current.orders.some((order) => orderLibraryFiles(order).some((entry) => entry.file_id === req.params.id) || order.library_parts?.some((entry) => entry.selected_file_id === req.params.id || (entry.part_id === target?.part_id && !entry.selected_file_id && libraryPartFiles(current, target.part_id, true).length <= 1)));
  if (referenced) return res.status(409).json({ error: 'Este G-code está associado a uma encomenda. Remove primeiro a associação; o ficheiro permanece na biblioteca.' });
  const saved = current; const file = target; if (!file) return res.status(404).json({ error: 'Ficheiro não encontrado.' });
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
  const saved = state(); const customer = clean(req.body?.customer_id, 80) ? getCustomer(saved, req.body.customer_id) : null; const item = { id: orderId(), title: clean(req.body.title, 120), customer_id: customer?.id || null, customer: customer?.name || clean(req.body.customer, 120), due_date: clean(req.body.due_date, 20) || null, priority: Math.min(2, Math.max(0, Number(req.body.priority) || 0)), notes: clean(req.body.notes, 1000), status: 'received', printer_id: null, files: [], library_files: [], library_parts: [], items: Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [], document: req.body.document || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  saved.orders.unshift(item); save(saved); res.status(201).json(item);
});
app.patch('/api/orders/:id', (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id); if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  for (const key of ['status', 'printer_id', 'printer_model', 'due_date', 'notes']) if (req.body?.[key] !== undefined) item[key] = req.body[key];
  if (req.body?.priority !== undefined) item.priority = Math.min(2, Math.max(0, Number(req.body.priority) || 0));
  item.updated_at = new Date().toISOString(); save(saved); res.json(item);
});
app.delete('/api/orders/:id', (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id); if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  saved.orders = saved.orders.filter((order) => order.id !== item.id);
  saved.consumption = saved.consumption.filter((entry) => entry.order_id !== item.id);
  save(saved); res.status(204).end();
});
app.post('/api/orders/:id/library-file', (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id); if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  const fileId = clean(req.body?.file_id, 80); const file = fileId ? getLibraryFile(saved, fileId) : null;
  if (fileId && !file) return res.status(404).json({ error: 'G-code não encontrado na biblioteca.' });
  item.library_file_id = file?.id || null; item.updated_at = new Date().toISOString(); save(saved); res.json(item);
});
app.post('/api/orders/:id/library-files', (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id); if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  const fileId = clean(req.body?.file_id, 80); const file = getLibraryFile(saved, fileId);
  const requestedQuantity = Math.floor(Number(req.body?.requested_quantity));
  if (!file) return res.status(404).json({ error: 'G-code não encontrado na biblioteca.' });
  if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) return res.status(400).json({ error: 'Indica uma quantidade pedida válida para esta peça.' });
  const files = orderLibraryFiles(item); const existing = files.find((entry) => entry.file_id === file.id);
  if (existing) existing.requested_quantity = requestedQuantity;
  else files.push({ file_id: file.id, requested_quantity: requestedQuantity });
  item.library_files = files; delete item.library_file_id; item.updated_at = new Date().toISOString(); save(saved);
  res.status(existing ? 200 : 201).json({ order: item, plan: orderGcodePlan(saved, item) });
});
app.delete('/api/orders/:id/library-files/:fileId', (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id); if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  const before = orderLibraryFiles(item); const remaining = before.filter((entry) => entry.file_id !== req.params.fileId);
  if (before.length === remaining.length) return res.status(404).json({ error: 'Este G-code não está associado à encomenda.' });
  item.library_files = remaining; delete item.library_file_id; item.updated_at = new Date().toISOString(); save(saved); res.status(204).end();
});
app.post('/api/orders/:id/library-parts', (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id);
  if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  const part = getLibraryPart(saved, clean(req.body?.part_id, 80));
  const requestedQuantity = Math.floor(Number(req.body?.requested_quantity));
  if (!part) return res.status(404).json({ error: 'Peça não encontrada na biblioteca.' });
  if (!libraryPartFiles(saved, part.id, true).length) return res.status(409).json({ error: 'Esta peça não tem nenhum G-code ativo.' });
  if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) return res.status(400).json({ error: 'Indica uma quantidade pedida válida.' });
  item.library_parts = Array.isArray(item.library_parts) ? item.library_parts : [];
  const existing = item.library_parts.find((entry) => entry.part_id === part.id);
  if (existing) existing.requested_quantity = requestedQuantity;
  else item.library_parts.push({ part_id: part.id, requested_quantity: requestedQuantity, selected_file_id: null });
  item.updated_at = new Date().toISOString(); save(saved);
  res.status(existing ? 200 : 201).json({ order: item, plan: orderGcodePlan(saved, item) });
});
app.put('/api/orders/:id/library-parts/:partId/gcode', (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id);
  if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  const entry = item.library_parts?.find((candidate) => candidate.part_id === req.params.partId);
  if (!entry) return res.status(404).json({ error: 'A peça não está associada a esta encomenda.' });
  const fileId = clean(req.body?.file_id, 80);
  if (fileId) {
    const file = getLibraryFile(saved, fileId);
    if (!file || file.part_id !== entry.part_id || file.active === false) return res.status(400).json({ error: 'Seleciona um G-code ativo desta peça.' });
    entry.selected_file_id = file.id;
  } else entry.selected_file_id = null;
  item.updated_at = new Date().toISOString(); save(saved); res.json({ order: item, plan: orderGcodePlan(saved, item) });
});
app.delete('/api/orders/:id/library-parts/:partId', (req, res) => {
  const saved = state(); const item = getOrder(saved, req.params.id);
  if (!item) return res.status(404).json({ error: 'Encomenda não encontrada.' });
  const before = Array.isArray(item.library_parts) ? item.library_parts : [];
  const remaining = before.filter((entry) => entry.part_id !== req.params.partId);
  if (before.length === remaining.length) return res.status(404).json({ error: 'Esta peça não está associada à encomenda.' });
  item.library_parts = remaining; item.updated_at = new Date().toISOString(); save(saved); res.status(204).end();
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
  const plan = orderGcodePlan(saved, item);
  const legacyFile = getLibraryFile(saved, item.library_file_id) || item.files.find((candidate) => candidate.id === req.body?.file_id) || item.files[0];
  if (!plan.length && !legacyFile) return res.status(400).json({ error: 'Associa pelo menos um G-code da biblioteca antes de concluir a encomenda.' });
  const grams = plan.length ? plan.reduce((total, entry) => total + entry.grams, 0) : Number(legacyFile?.metadata?.filament_grams || 0);
  const spoolId = saved.assignments[String(item.printer_id)]?.spool_id;
  if (spoolId && grams > 0) {
    const spool = saved.spools.find((candidate) => Number(candidate.id) === Number(spoolId));
    if (!spool) return res.status(404).json({ error: 'A bobine atribuída já não existe no portal.' });
    spool.used_weight = Number(spool.used_weight || 0) + grams;
    spool.remaining_weight = Math.max(0, Number(spool.initial_weight || 0) - spool.used_weight);
    spool.updated_at = new Date().toISOString();
    saved.consumption.unshift({ spool_id: spoolId, grams, printer_id: item.printer_id, order_id: item.id, automatic: true, created_at: new Date().toISOString() });
  }
  item.status = 'completed'; item.updated_at = new Date().toISOString(); save(saved); res.json({ order: item, consumed_grams: grams || null, gcode_plan: plan });
});

app.post('/api/printers/discover', async (req, res) => {
  const requested = clean(req.body?.subnet, 32); if (requested && !requestedPrivateNetwork(requested)) return res.status(400).json({ error: 'Indica uma rede privada /24, por exemplo 192.168.1.0/24.' });
  try { res.json(await discoverLocalPrinters(requested)); } catch (error) { res.status(502).json({ error: `Não foi possível analisar a rede local: ${error.message || 'erro desconhecido'}` }); }
});
app.post('/api/printers', async (req, res) => {
  const saved = state(); const name = clean(req.body?.name, 100); const ip = clean(req.body?.ip, 160); const model = clean(req.body?.model, 100); const type = clean(req.body?.type, 40) || 'klipper';
  if (!name || !ip || !model) return res.status(400).json({ error: 'Nome, IP e modelo são obrigatórios.' });
  if (!printerConnectors.has(type)) return res.status(400).json({ error: 'O tipo de ligação da impressora não é suportado.' });
  if (saved.printers.some((printer) => printer.name.toLocaleLowerCase('pt-PT') === name.toLocaleLowerCase('pt-PT'))) return res.status(409).json({ error: 'Já existe uma impressora com este nome.' });
  const now = new Date().toISOString(); const printer = { id: nextId(saved.printers), name, ip, model, type, api_key: clean(req.body?.api_key, 200), group_name: clean(req.body?.group_name, 100), status: 'UNKNOWN', job_name: null, job_progress: 0, created_at: now, updated_at: now };
  saved.printers.push(printer); save(saved); res.status(201).json(printer);
});
app.delete('/api/printers/:id', (req, res) => {
  const saved = state(); const printer = getManagedPrinter(saved, req.params.id);
  if (!printer) return res.status(404).json({ error: 'Impressora não encontrada.' });
  saved.printers = saved.printers.filter((item) => Number(item.id) !== Number(printer.id));
  delete saved.assignments[String(printer.id)];
  saved.jobs = saved.jobs.filter((job) => Number(job.printer_id) !== Number(printer.id));
  save(saved); res.status(204).end();
});
app.post('/api/projects', async (req, res) => forwarded(res, await safeRequest('post', `${internalProductionUrl}/api/projects`, req.body)));
function positiveProjectId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}
function projectIdOrError(req, res) {
  const id = positiveProjectId(req.params.projectId);
  if (!id) {
    res.status(400).json({ error: 'Projeto invalido.' });
    return null;
  }
  return id;
}

// Native project workflow exposed by the portal. No secondary production service
// is required for projects, parts or the queue.
app.get('/api/projects/:projectId/details', async (req, res) => {
  const projectId = projectIdOrError(req, res); if (!projectId) return;
  const projectResult = await safeGet(`${internalProductionUrl}/api/projects/${projectId}`);
  if (!projectResult.ok) return res.status(404).json({ error: 'Projeto não encontrado no Production Hub.' });
  const partsResult = await safeGet(`${internalProductionUrl}/api/parts?project_id=${projectId}`);
  if (!partsResult.ok) return res.status(502).json({ error: 'Nao foi possivel carregar as pecas deste projeto.' });
  const parts = Array.isArray(partsResult.data) ? partsResult.data : [];
  const details = await Promise.all(parts.map(async (part) => {
    const [gcodes, dispatch] = await Promise.all([
      safeGet(`${internalProductionUrl}/api/gcodes?part_id=${part.id}`),
      safeGet(`${internalProductionUrl}/api/parts/${part.id}/dispatch-status`),
    ]);
    return {
      ...part,
      gcodes: Array.isArray(gcodes.data) ? gcodes.data : [],
      dispatch: dispatch.ok && dispatch.data ? dispatch.data : { dispatchable: false, reasons: ['Diagnostico de despacho indisponivel.'] },
    };
  }));
  res.json({ project: projectResult.data, parts: details });
});
app.put('/api/projects/reorder', async (req, res) => forwarded(res, await safeRequest('put', `${internalProductionUrl}/api/projects/reorder`, req.body), 200));
app.put('/api/projects/:projectId', async (req, res) => {
  const projectId = projectIdOrError(req, res); if (!projectId) return;
  forwarded(res, await safeRequest('put', `${internalProductionUrl}/api/projects/${projectId}`, req.body), 200);
});
app.put('/api/projects/:projectId/filament', async (req, res) => {
  const projectId = projectIdOrError(req, res); if (!projectId) return;
  forwarded(res, await safeRequest('put', `${internalProductionUrl}/api/projects/${projectId}/filament`, req.body), 200);
});
app.post('/api/projects/:projectId/complete', async (req, res) => {
  const projectId = projectIdOrError(req, res); if (!projectId) return;
  forwarded(res, await safeRequest('post', `${internalProductionUrl}/api/projects/${projectId}/complete`, {}), 200);
});
app.post('/api/projects/:projectId/reactivate', async (req, res) => {
  const projectId = projectIdOrError(req, res); if (!projectId) return;
  forwarded(res, await safeRequest('post', `${internalProductionUrl}/api/projects/${projectId}/reactivate`, {}), 200);
});
app.post('/api/projects/:projectId/duplicate', async (req, res) => {
  const projectId = projectIdOrError(req, res); if (!projectId) return;
  forwarded(res, await safeRequest('post', `${internalProductionUrl}/api/projects/${projectId}/duplicate`, req.body || {}), 201);
});
app.delete('/api/projects/:projectId', async (req, res) => {
  const projectId = projectIdOrError(req, res); if (!projectId) return;
  const result = await safeRequest('delete', `${internalProductionUrl}/api/projects/${projectId}`);
  if (!result.ok) return res.status(result.status || 502).json({ error: result.error || 'Nao foi possivel apagar o projeto.' });
  res.status(204).end();
});
app.post('/api/parts', async (req, res) => forwarded(res, await safeRequest('post', `${internalProductionUrl}/api/parts`, req.body)));
app.put('/api/parts/:partId', async (req, res) => {
  const partId = positiveProjectId(req.params.partId);
  if (!partId) return res.status(400).json({ error: 'Peca invalida.' });
  forwarded(res, await safeRequest('put', `${internalProductionUrl}/api/parts/${partId}`, req.body), 200);
});
app.delete('/api/parts/:partId', async (req, res) => {
  const partId = positiveProjectId(req.params.partId);
  if (!partId) return res.status(400).json({ error: 'Peca invalida.' });
  const result = await safeRequest('delete', `${internalProductionUrl}/api/parts/${partId}`);
  if (!result.ok) return res.status(result.status || 502).json({ error: result.error || 'Nao foi possivel apagar a peca.' });
  res.status(204).end();
});
app.delete('/api/gcodes/:gcodeId', async (req, res) => {
  const gcodeId = positiveProjectId(req.params.gcodeId);
  if (!gcodeId) return res.status(400).json({ error: 'G-code invalido.' });
  const result = await safeRequest('delete', `${internalProductionUrl}/api/gcodes/${gcodeId}`);
  if (!result.ok) return res.status(result.status || 502).json({ error: result.error || 'Nao foi possivel apagar o G-code da farm.' });
  res.status(204).end();
});

function piecesPerExecution(rawValue, libraryFile) {
  const candidate = rawValue === undefined || rawValue === '' ? libraryFile?.metadata?.quantity : rawValue;
  const amount = Math.floor(Number(candidate));
  return Number.isInteger(amount) && amount > 0 ? amount : null;
}
async function copyLibraryGcodeToFarm({ partId, libraryFile, printerModel, partsPerPlate, requiredMaterial, requiredColor }) {
  const saved = state(); const part = getManagedPart(saved, partId); const diskFile = path.join(uploadsDir, libraryFile.stored_name);
  if (!part) return { ok: false, status: 404, error: 'Peça de produção não encontrada.' };
  if (!fs.existsSync(diskFile)) return { ok: false, status: 410, error: 'O ficheiro físico já não existe na biblioteca.' };
  const model = clean(printerModel, 100); const quantity = piecesPerExecution(partsPerPlate, libraryFile);
  if (!model || !quantity) return { ok: false, status: 400, error: 'Indica o modelo e as peças por execução.' };
  if (partProductionGcodes(saved, part.id).some((gcode) => gcode.printer_model === model)) return { ok: false, status: 409, error: 'Já existe uma variante para este modelo de impressora.' };
  const item = { id: nextId(saved.production_gcodes), part_id: part.id, library_file_id: libraryFile.id, filename: libraryFile.original_name, printer_model: model, parts_per_plate: quantity, material_grams: Number(libraryFile.metadata?.filament_grams) || null, required_material: clean(requiredMaterial || libraryFile.metadata?.material, 80), required_color: clean(requiredColor || libraryFile.metadata?.color, 80), est_print_secs: null, created_at: new Date().toISOString() };
  saved.production_gcodes.push(item); save(saved); return { ok: true, data: item };
}

// Creates the production part from a G-code in the portal library. More G-code
// variants can then be added to that same part for other printer models.
app.post('/api/projects/:projectId/library-part', async (req, res) => {
  const projectId = projectIdOrError(req, res); if (!projectId) return;
  const saved = state();
  const libraryPart = getLibraryPart(saved, clean(req.body?.library_part_id, 80));
  if (libraryPart) {
    const targetQty = Math.floor(Number(req.body?.target_qty));
    const variants = libraryPartFiles(saved, libraryPart.id, true);
    if (!Number.isInteger(targetQty) || targetQty < 1) return res.status(400).json({ error: 'Indica uma quantidade válida para a peça.' });
    if (!variants.length) return res.status(409).json({ error: 'A peça não tem G-codes ativos.' });
    if (variants.some((file) => !clean(file.printer_model, 100))) return res.status(409).json({ error: 'Todos os G-codes ativos precisam de uma impressora ou perfil definido.' });
    const partResult = await safeRequest('post', `${internalProductionUrl}/api/parts`, { project_id: projectId, name: libraryPart.name, target_qty: targetQty });
    if (!partResult.ok) return res.status(partResult.status || 502).json({ error: partResult.error || 'Não foi possível criar a peça na farm.' });
    const copied = [];
    for (const file of variants) {
      const result = await copyLibraryGcodeToFarm({ partId: partResult.data.id, libraryFile: file, printerModel: file.printer_model, partsPerPlate: piecesPerExecution(undefined, file), requiredMaterial: file.metadata?.material, requiredColor: file.metadata?.color });
      if (!result.ok) {
        await safeRequest('delete', `${internalProductionUrl}/api/parts/${partResult.data.id}`);
        return res.status(result.status || 502).json({ error: `Falha ao copiar ${file.original_name}: ${result.error}` });
      }
      copied.push(result.data);
    }
    return res.status(201).json({ part: partResult.data, gcodes: copied });
  }
  const libraryFile = getLibraryFile(saved, clean(req.body?.file_id, 80));
  const printerModel = clean(req.body?.printer_model, 100);
  const targetQty = Math.floor(Number(req.body?.target_qty));
  const partsPerPlate = piecesPerExecution(req.body?.parts_per_plate, libraryFile);
  if (!libraryFile || !printerModel || !Number.isInteger(targetQty) || targetQty < 1 || !partsPerPlate) {
    return res.status(400).json({ error: 'Seleciona um G-code da biblioteca, o modelo da impressora e uma quantidade valida.' });
  }
  const fallbackName = path.basename(libraryFile.original_name, path.extname(libraryFile.original_name));
  const name = clean(req.body?.name || fallbackName, 120);
  const partResult = await safeRequest('post', `${internalProductionUrl}/api/parts`, { project_id: projectId, name, target_qty: targetQty });
  if (!partResult.ok) return res.status(partResult.status || 502).json({ error: partResult.error || 'Nao foi possivel criar a peca na farm.' });
  const gcodeResult = await copyLibraryGcodeToFarm({ partId: partResult.data.id, libraryFile, printerModel, partsPerPlate, requiredMaterial: req.body?.required_material, requiredColor: req.body?.required_color });
  if (!gcodeResult.ok) {
    await safeRequest('delete', `${internalProductionUrl}/api/parts/${partResult.data.id}`);
    return res.status(gcodeResult.status || 502).json({ error: gcodeResult.error });
  }
  res.status(201).json({ part: partResult.data, gcode: gcodeResult.data });
});
app.post('/api/projects/:projectId/parts/:partId/library-gcode', async (req, res) => {
  const projectId = projectIdOrError(req, res); if (!projectId) return;
  const partId = positiveProjectId(req.params.partId);
  if (!partId) return res.status(400).json({ error: 'Peca invalida.' });
  const saved = state();
  const libraryFile = getLibraryFile(saved, clean(req.body?.file_id, 80));
  const printerModel = clean(req.body?.printer_model, 100);
  const partsPerPlate = piecesPerExecution(req.body?.parts_per_plate, libraryFile);
  if (!libraryFile || !printerModel || !partsPerPlate) return res.status(400).json({ error: 'Seleciona um G-code, um modelo de impressora e a quantidade por execucao.' });
  const partResult = await safeGet(`${internalProductionUrl}/api/parts/${partId}`);
  if (!partResult.ok || Number(partResult.data?.project_id) !== projectId) return res.status(404).json({ error: 'A peca nao pertence a este projeto.' });
  const result = await copyLibraryGcodeToFarm({ partId, libraryFile, printerModel, partsPerPlate, requiredMaterial: req.body?.required_material, requiredColor: req.body?.required_color });
  if (!result.ok) return res.status(result.status || 502).json({ error: result.error });
  res.status(201).json(result.data);
});
app.post('/api/scheduler/dispatch', async (_req, res) => forwarded(res, await safeRequest('post', `${internalProductionUrl}/api/scheduler/dispatch`, {}), 200));
app.post('/api/spools', (req, res) => {
  const material = clean(req.body?.material, 80); const color = clean(req.body?.color, 80);
  const weight = Math.max(1, Number(req.body?.remaining_weight || req.body?.initial_weight || 1000));
  if (!material || !color) return res.status(400).json({ error: 'Indica o material e a cor da bobine.' });
  const saved = state(); const now = new Date().toISOString();
  const spool = { id: nextId(saved.spools), material, color_name: color, color_hex: clean(req.body?.color_hex, 16) || '#6f747a', brand: clean(req.body?.brand, 80), initial_weight: weight, used_weight: 0, remaining_weight: weight, created_at: now, updated_at: now };
  saved.spools.push(spool); save(saved); res.status(201).json(localSpool(spool));
});
app.get('/api/filaments', (_req, res) => res.json(localFilamentCatalog));
app.post('/api/assignments', (req, res) => { const { printer_id, spool_id } = req.body || {}; if (!printer_id || !spool_id) return res.status(400).json({ error: 'Impressora e bobine são obrigatórias.' }); const saved = state(); saved.assignments[String(printer_id)] = { spool_id: Number(spool_id), assigned_at: new Date().toISOString() }; save(saved); res.status(201).json(saved.assignments[String(printer_id)]); });
app.delete('/api/assignments/:printerId', (req, res) => { const saved = state(); delete saved.assignments[String(req.params.printerId)]; save(saved); res.status(204).end(); });
app.post('/api/consume', (req, res) => {
  const spoolId = Number(req.body?.spool_id); const grams = Number(req.body?.grams);
  if (!spoolId || !Number.isFinite(grams) || grams <= 0) return res.status(400).json({ error: 'Indica uma bobine e uma quantidade válida em gramas.' });
  const saved = state(); const spool = saved.spools.find((item) => Number(item.id) === spoolId);
  if (!spool) return res.status(404).json({ error: 'Bobine não encontrada.' });
  spool.used_weight = Number(spool.used_weight || 0) + grams;
  spool.remaining_weight = Math.max(0, Number(spool.initial_weight || 0) - spool.used_weight);
  spool.updated_at = new Date().toISOString();
  saved.consumption.unshift({ spool_id: spoolId, grams, printer_id: req.body?.printer_id || null, order_id: req.body?.order_id || null, automatic: false, created_at: new Date().toISOString() });
  save(saved); res.json({ spool: localSpool(spool) });
});

app.use((error, _req, res, _next) => res.status(400).json({ error: error.message || 'Não foi possível processar o ficheiro.' }));
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.5.0' }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`Conceito 3D Production Hub listening on ${port}`));
