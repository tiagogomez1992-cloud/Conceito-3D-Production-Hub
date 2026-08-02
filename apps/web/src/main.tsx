import { FormEvent, StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const apiUrl = import.meta.env.VITE_API_URL ?? "/api";

type Protocol = "moonraker" | "octoprint" | "prusalink" | "bambu" | "generic";
type Printer = { id: string; name: string; protocol: Protocol; baseUrl: string };
type Spool = { id: string; brand: string; material: string; color: string; remainingWeightGrams: number; reservedWeightGrams: number };
type Job = { id: string; printerId: string; spoolId: string; fileName: string; estimatedMaterialGrams: number; actualMaterialGrams?: number; state: string };
type Page = "dashboard" | "fleet" | "printers" | "projects" | "jobs" | "decommissioned" | "settings";

const navigation: Array<{ id: Page; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "fleet", label: "Fleet" },
  { id: "printers", label: "Printers" },
  { id: "projects", label: "Projects" },
  { id: "jobs", label: "Jobs" },
  { id: "decommissioned", label: "Decommissioned" },
  { id: "settings", label: "Settings" }
];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  const payload = await response.json() as { data?: T; error?: string };
  if (!response.ok) throw new Error(payload.error ?? "O pedido falhou.");
  return payload.data as T;
}

function App() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [spools, setSpools] = useState<Spool[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [message, setMessage] = useState("A ligar ao Production Hub…");
  const [error, setError] = useState("");
  const [page, setPage] = useState<Page>("dashboard");

  const refresh = useCallback(async () => {
    try {
      const [nextPrinters, nextSpools, nextJobs] = await Promise.all([
        request<Printer[]>("/api/v1/printers"), request<Spool[]>("/api/v1/spools"), request<Job[]>("/api/v1/jobs")
      ]);
      setPrinters(nextPrinters); setSpools(nextSpools); setJobs(nextJobs);
      setMessage("Dados atualizados."); setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível contactar a API.");
      setMessage("");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const activeJobs = useMemo(() => jobs.filter((job) => ["reserved", "printing", "paused"].includes(job.state)), [jobs]);
  const pageTitle = navigation.find((item) => item.id === page)?.label ?? "Dashboard";

  async function submitPrinter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      await request<Printer>("/api/v1/printers", { method: "POST", body: JSON.stringify({
        name: values.get("name"), protocol: values.get("protocol"), baseUrl: values.get("baseUrl"),
        apiKey: values.get("apiKey") || undefined, username: values.get("username") || undefined
      }) });
      form.reset(); setMessage("Impressora registada."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível registar a impressora."); }
  }

  async function submitSpool(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      await request<Spool>("/api/v1/spools", { method: "POST", body: JSON.stringify({
        brand: values.get("brand"), material: values.get("material"), color: values.get("color"), initialWeightGrams: Number(values.get("weight"))
      }) });
      form.reset(); setMessage("Bobine registada."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível registar a bobine."); }
  }

  async function submitJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      await request<Job>("/api/v1/jobs", { method: "POST", body: JSON.stringify({
        printerId: values.get("printerId"), spoolId: values.get("spoolId"), fileName: values.get("fileName"), estimatedMaterialGrams: Number(values.get("weight"))
      }) });
      form.reset(); setMessage("Trabalho criado e filamento reservado."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível criar o trabalho."); }
  }

  async function startJob(job: Job) {
    try { await request<Job>(`/api/v1/jobs/${job.id}/start`, { method: "POST" }); setMessage("Trabalho enviado para a impressora."); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível iniciar o trabalho."); }
  }

  async function finishJob(job: Job, action: "complete" | "cancel") {
    const entered = window.prompt("Consumo real de filamento em gramas:", job.estimatedMaterialGrams.toString());
    if (entered === null) return;
    try {
      await request<Job>(`/api/v1/jobs/${job.id}/${action}`, { method: "POST", body: JSON.stringify({ actualMaterialGrams: Number(entered) }) });
      setMessage(action === "complete" ? "Trabalho concluído e stock atualizado." : "Trabalho cancelado e reserva libertada."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível atualizar o trabalho."); }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">C3</span><span>Conceito 3D</span></div>
      <nav aria-label="Navegação principal">
        {navigation.map((item) => <button key={item.id} className={page === item.id ? "nav-item active" : "nav-item"} onClick={() => setPage(item.id)}>{item.label}</button>)}
      </nav>
      <p className="sidebar-footer">Production Hub<br />Preview 0.1.2</p>
    </aside>

    <main className="content">
      <header className="topbar">
        <div><p className="eyebrow">CONCEITO 3D / {pageTitle.toUpperCase()}</p><h1>{pageTitle}</h1></div>
        <button className="secondary" onClick={() => void refresh()}>Atualizar</button>
      </header>
      <p className={error ? "notice error" : "notice"}>{error || message}</p>

      {page === "dashboard" && <>
        <section className="cards" aria-label="Resumo operacional">
          <Metric label="Impressoras" value={printers.length} hint="Registadas no Hub" />
          <Metric label="Produção" value={activeJobs.length} hint="Reservados ou em impressão" />
          <Metric label="Bobines" value={spools.length} hint="Com stock controlado" />
          <Metric label="Alertas" value={error ? 1 : 0} hint={error ? "Requer atenção" : "Tudo pronto"} />
        </section>
        <section className="workspace">
          <div className="panel"><h2>Estado da Fleet</h2><List empty="Ainda não existem impressoras." items={printers.slice(0, 4)} render={(printer) => <div><strong>{printer.name}</strong><span>{printer.protocol} · pronto para configurar</span></div>} /></div>
          <div className="panel"><h2>Trabalhos recentes</h2><List empty="A fila está vazia." items={jobs.slice(0, 4)} render={(job) => <div><strong>{job.fileName}</strong><span>{formatGrams(job.estimatedMaterialGrams)} · {translateState(job.state)}</span></div>} /></div>
        </section>
      </>}

      {page === "fleet" && <section className="workspace">
        <div className="panel"><h2>Impressoras ativas</h2><List empty="Ainda não existem impressoras." items={printers} render={(printer) => <div><strong>{printer.name}</strong><span>{printer.protocol} · {printer.baseUrl}</span></div>} /></div>
        <div className="panel"><h2>Filamentos</h2><SpoolForm onSubmit={submitSpool} /><List empty="Ainda não existem bobines." items={spools} render={spoolSummary} /></div>
      </section>}

      {page === "printers" && <section className="panel"><h2>Adicionar impressora</h2><PrinterForm onSubmit={submitPrinter} /><h2 className="section-title">Impressoras registadas</h2><List empty="Ainda não existem impressoras." items={printers} render={(printer) => <div><strong>{printer.name}</strong><span>{printer.protocol} · {printer.baseUrl}</span></div>} /></section>}

      {page === "jobs" && <section className="panel production"><h2>Fila de produção</h2><JobForm printers={printers} spools={spools} onSubmit={submitJob} /><List empty="A fila está vazia." items={jobs} render={(job) => <JobRow job={job} onStart={startJob} onFinish={finishJob} />} /></section>}

      {["projects", "decommissioned", "settings"].includes(page) && <section className="panel placeholder"><h2>{pageTitle}</h2><p>Este módulo está preparado no menu e será desenvolvido nas próximas fases.</p></section>}
    </main>
  </div>;
}

function Metric({ label, value, hint }: { label: string; value: number; hint: string }) { return <article><p>{label}</p><strong>{value}</strong><span>{hint}</span></article>; }
function spoolSummary(spool: Spool) { return <div><strong>{spool.brand} · {spool.material} {spool.color}</strong><span>{formatGrams(spool.remainingWeightGrams)} disponíveis · {formatGrams(spool.reservedWeightGrams)} reservados</span></div>; }

function LegacyPrinterForm({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form onSubmit={onSubmit} className="compact-form"><input required name="name" placeholder="Nome (ex.: Voron 2.4)" /><select name="protocol"><option value="moonraker">Moonraker / Klipper</option><option value="octoprint">OctoPrint</option><option value="bambu">Bambu</option><option value="generic">Manual / genérico</option></select><input required name="baseUrl" type="url" placeholder="http://192.168.1.50:7125" /><input name="apiKey" type="password" placeholder="Chave API (opcional)" /><button>Adicionar impressora</button></form>;
}

function PrinterForm({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form onSubmit={onSubmit} className="compact-form">
    <input required name="name" placeholder="Nome (ex.: Voron 2.4)" />
    <select name="protocol">
      <option value="moonraker">Moonraker / Klipper</option>
      <option value="octoprint">OctoPrint</option>
      <option value="prusalink">PrusaLink</option>
      <option value="bambu">Bambu LAN (experimental)</option>
      <option value="generic">Manual / generic</option>
    </select>
    <input required name="baseUrl" type="url" placeholder="http://192.168.1.50:7125" />
    <input name="username" placeholder="User (PrusaLink only)" />
    <input name="apiKey" type="password" placeholder="API key / password" />
    <button>Adicionar impressora</button>
  </form>;
}

function SpoolForm({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form onSubmit={onSubmit} className="compact-form"><input required name="brand" placeholder="Marca" /><select name="material"><option>PLA</option><option>PETG</option><option>ABS</option><option>ASA</option><option>TPU</option><option value="other">Outro</option></select><input required name="color" placeholder="Cor" /><input required name="weight" type="number" min="1" step="1" placeholder="Peso (g)" /><button>Adicionar bobine</button></form>;
}

function JobForm({ printers, spools, onSubmit }: { printers: Printer[]; spools: Spool[]; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const canCreate = printers.length > 0 && spools.length > 0;
  return <form onSubmit={onSubmit} className="job-form"><select required name="printerId" disabled={!printers.length}><option value="">Escolher impressora</option>{printers.map((printer) => <option value={printer.id} key={printer.id}>{printer.name}</option>)}</select><select required name="spoolId" disabled={!spools.length}><option value="">Escolher bobine</option>{spools.map((spool) => <option value={spool.id} key={spool.id}>{spool.brand} · {spool.material} {spool.color}</option>)}</select><input required name="fileName" placeholder="ficheiro.gcode" /><input required name="weight" type="number" min="1" step="0.1" placeholder="Estimativa (g)" /><button disabled={!canCreate}>Criar trabalho</button></form>;
}

function JobRow({ job, onStart, onFinish }: { job: Job; onStart: (job: Job) => void; onFinish: (job: Job, action: "complete" | "cancel") => void }) {
  return <div className="job-row"><div><strong>{job.fileName}</strong><span>{formatGrams(job.estimatedMaterialGrams)} estimados · <em className={`status ${job.state}`}>{translateState(job.state)}</em></span></div><div className="actions">{job.state === "reserved" && <button onClick={() => void onStart(job)}>Iniciar</button>}{["reserved", "printing"].includes(job.state) && <><button className="secondary" onClick={() => void onFinish(job, "complete")}>Concluir</button><button className="danger" onClick={() => void onFinish(job, "cancel")}>Cancelar</button></>}</div></div>;
}

function List<T>({ items, empty, render }: { items: T[]; empty: string; render: (item: T) => React.ReactNode }) { return <div className="list">{items.length ? items.map((item, index) => <div className="list-row" key={index}>{render(item)}</div>) : <p className="empty">{empty}</p>}</div>; }
function formatGrams(value: number) { return `${Math.round(value)} g`; }
function translateState(state: string) { return ({ reserved: "reservado", printing: "a imprimir", completed: "concluído", cancelled: "cancelado" } as Record<string, string>)[state] ?? state; }

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
