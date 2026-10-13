// Native timelapse settings; a live camera alone is not a recording capability.
function installTimelapseRoutes(app, { client, state, save, getManagedPrinter, printerEndpoint }) {
  const pending = new Set();
  const preference = (printer) => typeof printer.timelapse_enabled === 'boolean' ? printer.timelapse_enabled : null;
  const identity = (printer) => JSON.stringify([printer.type, printer.ip, printer.api_key]);
  const unavailable = (reason) => ({ supported: false, enabled: null, reason });
  const options = (printer) => ({ timeout: 2500, maxRedirects: 0, headers: printer.api_key ? { 'X-Api-Key': printer.api_key } : {} });

  async function inspect(printer) {
    if (!['klipper', 'creality', 'anycubic', 'octoprint'].includes(printer.type)) {
      return unavailable(printer.type === 'bambu'
        ? 'O Hub ainda não dispõe de controlo de timelapse validado para Bambu LAN. Configura-o no Bambu Studio antes de enviar a impressão.'
        : 'Esta integração não expõe controlo de timelapse ao Hub.');
    }
    const octoprint = printer.type === 'octoprint';
    const endpoint = octoprint ? '/api/timelapse' : '/machine/timelapse/settings';
    const ports = octoprint ? [null] : printer.type === 'creality' ? [7125, 4408] : [7125];
    const urls = [...new Set(ports.map((port) => printerEndpoint(printer, endpoint, port)))];
    let failure;
    for (const url of urls) {
      try {
        const response = await client.get(url, options(printer));
        const config = octoprint ? response.data?.config : response.data?.result;
        if (octoprint ? !['off', 'timed', 'zchange'].includes(config?.type) : typeof config?.enabled !== 'boolean') {
          failure = 'A impressora devolveu uma resposta de timelapse inválida.';
          continue;
        }
        const enabled = octoprint ? config.type !== 'off' : config.enabled;
        const blocked = !octoprint && config.blockedsettings?.includes('enabled');
        return {
          supported: !blocked, enabled, backend: octoprint ? 'octoprint' : 'moonraker',
          reason: blocked ? 'O timelapse está fixado em moonraker.conf e não pode ser alterado pelo Hub.'
            : octoprint ? 'Aplica-se à próxima impressão. Câmara e renderização devem estar configuradas no OctoPrint.'
              : 'Aplica-se à captura durante as impressões. Requer moonraker-timelapse, câmara e macros configuradas no slicer. Ao desligar, a renderização automática da impressão atual também pode ser omitida.',
          url, config,
        };
      } catch (error) {
        const status = error.response?.status;
        if (status === 401 || status === 403) throw new Error('Sem permissão para gerir timelapse. Verifica a chave API da impressora.');
        if (status !== 404) failure = 'Não foi possível consultar o timelapse. Verifica a ligação à impressora e tenta novamente.';
      }
    }
    if (failure) throw new Error(failure);
    return unavailable(octoprint ? 'A API de timelapse não está disponível nesta instalação OctoPrint.'
      : 'Não foi encontrado moonraker-timelapse. Uma câmara em direto não confirma suporte de gravação.');
  }

  function publicStatus(printer, result) {
    const { url, config, ...status } = result;
    return { ...status, preference: preference(printer) };
  }

  app.get('/api/printers/:id/timelapse', async (req, res) => {
    const printer = getManagedPrinter(state(), req.params.id);
    if (!printer) return res.status(404).json({ error: 'Impressora não encontrada.' });
    res.set('Cache-Control', 'no-store');
    try { res.json(publicStatus(printer, await inspect(printer))); }
    catch (error) { res.status(502).json({ error: error.message, preference: preference(printer) }); }
  });

  app.put('/api/printers/:id/timelapse', async (req, res) => {
    const printer = getManagedPrinter(state(), req.params.id);
    if (!printer) return res.status(404).json({ error: 'Impressora não encontrada.' });
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled tem de ser true ou false.' });
    if (pending.has(printer.id)) return res.status(409).json({ error: 'Aguarda a alteração de timelapse em curso.' });
    pending.add(printer.id);
    try {
      const before = await inspect(printer);
      if (!before.supported) return res.status(409).json({ error: before.reason });
      const octoprint = before.backend === 'octoprint';
      const activeConfig = before.config.type !== 'off' ? before.config : printer.timelapse_octoprint_config;
      const payload = octoprint
        ? { ...(enabled ? activeConfig || { type: 'timed', interval: 10, fps: 25, postRoll: 0 } : { type: 'off' }), save: true }
        : { enabled };
      await client.post(before.url, payload, options(printer));
      const after = await inspect(printer);
      if (!after.supported || after.enabled !== enabled) throw new Error('A impressora não confirmou a alteração. A preferência anterior foi mantida; volta a verificar o estado.');
      // Re-read after I/O so unrelated edits, new jobs and other printers survive.
      const saved = state(); const current = getManagedPrinter(saved, printer.id);
      if (!current || identity(current) !== identity(printer)) return res.status(409).json({ error: 'A configuração da impressora mudou. Volta a abrir a página e verifica o timelapse.' });
      current.timelapse_enabled = enabled;
      if (octoprint && activeConfig) current.timelapse_octoprint_config = activeConfig;
      current.updated_at = new Date().toISOString();
      save(saved);
      res.json(publicStatus(current, after));
    } catch (error) {
      res.status(502).json({ error: error.response?.status === 403 || error.response?.status === 401
        ? 'Sem permissão para alterar timelapse. Verifica a chave API da impressora.'
        : error.response ? 'A impressora recusou a alteração de timelapse. A preferência anterior foi mantida.'
          : 'Não foi possível confirmar e guardar o timelapse. Verifica a ligação e consulta novamente o estado.' });
    } finally { pending.delete(printer.id); }
  });
}

module.exports = { installTimelapseRoutes };
