const TimelapsePanel = (() => {
  const contexts = new WeakMap();
  function mount(panel) {
    if (!panel) return;
    if (contexts.has(panel)) { contexts.get(panel).refresh(); return; }
    panel.innerHTML = '<div class="panel-heading"><div><p class="eyebrow">GRAVAÇÃO</p><h2>Timelapse</h2></div><button type="button" role="switch" aria-checked="false" aria-label="Criar timelapse durante as impressões" aria-describedby="timelapse-description" data-timelapse-toggle disabled>A verificar…</button></div><p id="timelapse-description" data-timelapse-description role="status" aria-live="polite">A verificar o suporte da impressora…</p><small data-timelapse-preference></small><div class="timelapse-actions"><button type="button" class="compact secondary" data-timelapse-retry>Verificar estado</button><button type="button" class="compact secondary" data-timelapse-restore hidden>Aplicar preferência guardada</button></div>';
    const toggle = panel.querySelector('[data-timelapse-toggle]');
    const description = panel.querySelector('[data-timelapse-description]');
    const preference = panel.querySelector('[data-timelapse-preference]');
    const retry = panel.querySelector('[data-timelapse-retry]');
    const restore = panel.querySelector('[data-timelapse-restore]');
    const url = `/api/printers/${encodeURIComponent(panel.dataset.printerTimelapse)}/timelapse`;
    let status = null; let busy = false;
    function paint() {
      toggle.disabled = busy || status?.supported !== true;
      toggle.setAttribute('aria-checked', String(status?.enabled === true));
      toggle.textContent = busy ? 'A aguardar…' : status?.enabled === true ? 'Ativado' : status?.enabled === false ? 'Desativado' : 'Indisponível';
      retry.disabled = busy; restore.disabled = busy;
      restore.hidden = status?.supported !== true || typeof status.preference !== 'boolean' || status.preference === status.enabled;
      preference.textContent = typeof status?.preference === 'boolean'
        ? `Preferência guardada: ${status.preference ? 'ativado' : 'desativado'}.${status.supported && status.preference !== status.enabled ? ' O estado da máquina é diferente.' : ''}`
        : 'Ainda não foi guardada uma preferência no Hub.';
    }
    async function request(options) {
      const response = await fetch(url, options);
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error || 'Não foi possível consultar o timelapse.'), { preference: data.preference });
      return data;
    }
    async function refresh() {
      if (busy) return;
      busy = true; paint();
      try { status = await request(); description.textContent = status.reason; }
      catch (error) {
        status = { supported: false, enabled: null, preference: error.preference ?? status?.preference ?? null };
        description.textContent = error.message;
      } finally { busy = false; paint(); }
    }
    async function change(enabled) {
      if (busy || status?.supported !== true) return;
      busy = true; paint();
      try {
        status = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
        description.textContent = `Preferência guardada. ${status.reason}`;
      } catch (error) {
        // A timed-out write may still have reached the printer. Do not show a
        // stale on/off state as confirmed; require a fresh read before retrying.
        status = { supported: false, enabled: null, preference: status?.preference ?? null };
        description.textContent = error.message;
      } finally { busy = false; paint(); }
    }
    toggle.addEventListener('click', () => change(!status.enabled));
    restore.addEventListener('click', () => change(status.preference));
    retry.addEventListener('click', refresh);
    contexts.set(panel, { refresh });
    refresh();
  }
  return { mount };
})();
