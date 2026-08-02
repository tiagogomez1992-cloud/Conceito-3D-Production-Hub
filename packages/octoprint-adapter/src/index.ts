import type { GcodeUpload, PrintJobRequest, PrinterAdapter, PrinterConnection, PrinterState, PrinterSummary } from "@conceito/core";

type OctoPrintJob = {
  state?: string;
  job?: { file?: { name?: string } };
  progress?: { completion?: number | null };
};

type OctoPrintPrinter = {
  temperature?: {
    tool0?: { actual?: number };
    bed?: { actual?: number };
  };
};

/** HTTP adapter for any printer operated by an OctoPrint server. */
export class OctoPrintAdapter implements PrinterAdapter {
  readonly protocol = "octoprint" as const;
  readonly capabilities = ["connection-test", "status", "upload", "start", "pause", "resume", "cancel"] as const;

  constructor(private readonly connection: PrinterConnection) {
    if (connection.protocol !== "octoprint") throw new Error("O adaptador OctoPrint requer uma ligação de impressora OctoPrint.");
  }

  async testConnection(): Promise<void> {
    await this.request<unknown>("/api/version");
  }

  async getStatus(printerId: string): Promise<PrinterSummary> {
    this.assertPrinter(printerId);
    const [job, printer] = await Promise.all([
      this.request<OctoPrintJob>("/api/job"),
      this.request<OctoPrintPrinter>("/api/printer?history=false&limit=1")
    ]);
    return {
      id: this.connection.id,
      name: this.connection.name,
      protocol: this.protocol,
      state: toPrinterState(job.state),
      nozzleTemperature: printer.temperature?.tool0?.actual,
      bedTemperature: printer.temperature?.bed?.actual,
      progress: job.progress?.completion ?? undefined,
      jobName: job.job?.file?.name
    };
  }

  async startJob(request: PrintJobRequest): Promise<void> {
    this.assertPrinter(request.printerId);
    await this.request<void>(`/api/files/local/${encodeFilePath(request.fileName)}`, {
      method: "POST",
      body: JSON.stringify({ command: "select", print: true })
    });
  }

  async uploadGcode(upload: GcodeUpload): Promise<void> {
    const body = new FormData();
    body.set("file", new Blob([upload.content], { type: "text/plain" }), upload.fileName);
    await this.request<void>("/api/files/local", { method: "POST", body });
  }

  async pauseJob(printerId: string): Promise<void> {
    this.assertPrinter(printerId);
    await this.jobCommand({ command: "pause", action: "pause" });
  }

  async resumeJob(printerId: string): Promise<void> {
    this.assertPrinter(printerId);
    await this.jobCommand({ command: "pause", action: "resume" });
  }

  async cancelJob(printerId: string): Promise<void> {
    this.assertPrinter(printerId);
    await this.jobCommand({ command: "cancel" });
  }

  private async jobCommand(command: Record<string, string>): Promise<void> {
    await this.request<void>("/api/job", { method: "POST", body: JSON.stringify(command) });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.connection.apiKey) throw new Error("O OctoPrint requer uma chave API com permissões de estado, ficheiros e impressão.");
    const headers = new Headers(init.headers);
    headers.set("X-Api-Key", this.connection.apiKey);
    headers.set("Accept", "application/json");
    if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(`${this.baseUrl()}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`O pedido ao OctoPrint falhou (código HTTP ${response.status}).`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private baseUrl(): string { return this.connection.baseUrl.replace(/\/$/, ""); }
  private assertPrinter(printerId: string): void {
    if (printerId !== this.connection.id) throw new Error("O identificador da impressora não corresponde a este adaptador.");
  }
}

function encodeFilePath(fileName: string): string {
  return fileName.split("/").map(encodeURIComponent).join("/");
}

function toPrinterState(state?: string): PrinterState {
  switch (state?.toLowerCase()) {
    case "printing": return "printing";
    case "paused": return "paused";
    case "finishing": case "starting": case "pausing": case "cancelling": return "preparing";
    case "error": case "offline after error": return "error";
    case "offline": case "closed": return "offline";
    case "operational": case "ready": return "idle";
    default: return "offline";
  }
}
