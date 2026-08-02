const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const port = Number(process.env.PORT || 8080);
const farmUrl = (process.env.PRINT_FARM_URL || 'http://print-farm-manager:3000').replace(/\/$/, '');
const spoolmanUrl = (process.env.SPOOLMAN_URL || 'http://spoolman:8000').replace(/\/$/, '');
const client = axios.create({ timeout: 5000 });
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'portal-state.json');

fs.mkdirSync(dataDir, { recursive: true });
app.use(express.json({ limit: '128kb' }));

function loadState() {
  try {
    return { assignments: {}, consumption: [], ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
  } catch (_) {
    return { assignments: {}, consumption: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function safeGet(url) {
  try {
    const response = await client.get(url);
    return { ok: true, data: response.data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

app.get('/api/summary', async (_req, res) => {
  const [farmHealth, printers, spools, projects, jobs] = await Promise.all([
    safeGet(`${farmUrl}/api/health`),
    safeGet(`${farmUrl}/api/printers`),
    safeGet(`${spoolmanUrl}/api/v1/spool`),
    safeGet(`${farmUrl}/api/projects`),
    safeGet(`${farmUrl}/api/jobs`),
  ]);

  const printerList = Array.isArray(printers.data) ? printers.data : [];
  const spoolList = Array.isArray(spools.data) ? spools.data : [];
  const onlineStatuses = new Set(['IDLE', 'PRINTING', 'FINISHED', 'PAUSED', 'ONLINE']);

  const state = loadState();
  res.json({
    generatedAt: new Date().toISOString(),
    services: {
      printFarmManager: farmHealth.ok,
      spoolman: spools.ok,
    },
    printers: {
      total: printerList.length,
      online: printerList.filter((printer) => onlineStatuses.has(String(printer.status || '').toUpperCase())).length,
      printing: printerList.filter((printer) => String(printer.status || '').toUpperCase() === 'PRINTING').length,
      items: printerList,
    },
    spools: {
      total: spoolList.length,
      low: spoolList.filter((spool) => Number(spool.remaining_weight || 0) > 0 && Number(spool.remaining_weight || 0) < 200).length,
      items: spoolList,
    },
    production: {
      projects: Array.isArray(projects.data) ? projects.data : [],
      jobs: Array.isArray(jobs.data) ? jobs.data : [],
    },
    assignments: state.assignments,
    consumption: state.consumption.slice(0, 20),
  });
});

app.post('/api/printers', async (req, res) => {
  const result = await safeRequest('post', `${farmUrl}/api/printers`, req.body);
  returnForwarded(res, result, 201);
});

app.post('/api/projects', async (req, res) => {
  const result = await safeRequest('post', `${farmUrl}/api/projects`, req.body);
  returnForwarded(res, result, 201);
});

app.post('/api/spools', async (req, res) => {
  const { filament_id, remaining_weight } = req.body || {};
  if (!filament_id) return res.status(400).json({ error: 'Seleciona um filamento antes de criar a bobine.' });
  const result = await safeRequest('post', `${spoolmanUrl}/api/v1/spool`, {
    filament_id: Number(filament_id),
    // Spoolman calcula o peso restante a partir do peso inicial e do consumo.
    used_weight: 0,
    ...(remaining_weight ? { initial_weight: Number(remaining_weight) } : {}),
  });
  returnForwarded(res, result, 201);
});

app.get('/api/filaments', async (_req, res) => {
  const result = await safeGet(`${spoolmanUrl}/api/v1/filament`);
  if (!result.ok) return res.status(502).json({ error: 'Não foi possível obter os filamentos do Spoolman.' });
  res.json(Array.isArray(result.data) ? result.data : []);
});

app.post('/api/assignments', async (req, res) => {
  const { printer_id, spool_id } = req.body || {};
  if (!printer_id || !spool_id) return res.status(400).json({ error: 'Impressora e bobine são obrigatórias.' });
  const state = loadState();
  state.assignments[String(printer_id)] = { spool_id: Number(spool_id), assigned_at: new Date().toISOString() };
  saveState(state);
  res.status(201).json(state.assignments[String(printer_id)]);
});

app.delete('/api/assignments/:printerId', (req, res) => {
  const state = loadState();
  delete state.assignments[String(req.params.printerId)];
  saveState(state);
  res.status(204).end();
});

app.post('/api/consume', async (req, res) => {
  const spoolId = Number(req.body?.spool_id);
  const grams = Number(req.body?.grams);
  const printerId = req.body?.printer_id ? Number(req.body.printer_id) : null;
  const jobId = req.body?.job_id ? Number(req.body.job_id) : null;
  if (!spoolId || !Number.isFinite(grams) || grams <= 0) return res.status(400).json({ error: 'Indica uma bobine e uma quantidade válida em gramas.' });
  const current = await safeGet(`${spoolmanUrl}/api/v1/spool/${spoolId}`);
  if (!current.ok) return res.status(404).json({ error: 'Bobine não encontrada no Spoolman.' });
  const currentUsed = Number(current.data.used_weight || 0);
  const result = await safeRequest('patch', `${spoolmanUrl}/api/v1/spool/${spoolId}`, { used_weight: currentUsed + grams });
  if (!result.ok) return res.status(502).json({ error: 'Não foi possível atualizar o peso no Spoolman.' });
  const state = loadState();
  state.consumption.unshift({ spool_id: spoolId, grams, printer_id: printerId, job_id: jobId, created_at: new Date().toISOString() });
  state.consumption = state.consumption.slice(0, 100);
  saveState(state);
  res.json({ spool: result.data, consumption: state.consumption[0] });
});

async function safeRequest(method, url, data) {
  try {
    const response = await client.request({ method, url, data });
    return { ok: true, data: response.data };
  } catch (error) {
    return { ok: false, status: error.response?.status || 502, error: error.response?.data?.error || error.response?.data?.detail || error.message };
  }
}

function returnForwarded(res, result, successStatus) {
  if (!result.ok) return res.status(result.status || 502).json({ error: result.error || 'O serviço não aceitou o pedido.' });
  return res.status(successStatus).json(result.data);
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`Conceito 3D Production Hub listening on ${port}`));
