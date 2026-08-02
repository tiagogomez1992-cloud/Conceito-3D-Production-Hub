import type { GcodeUpload, PrintJobRequest, PrinterAdapter, PrinterConnection, PrinterState, PrinterSummary } from "@conceito/core";

type MoonrakerResponse<T> = { result: T };

type MoonrakerStatus = {
  status: {
    webhooks?: { state?: string };
    print_stats?: { state?: string; filename?: string };
    extruder?: { temperature?: number };
    heater_bed?: { temperature?: number };
    virtual_sdcard?: { progress?: number };
  };
};

/** HTTP implementation for a Moonraker / Klipper printer. */
export class MoonrakerAdapter implements PrinterAdapter {
  readonly protocol = "moonraker" as const;
  readonly capabilities = ["connection-test", "status", "upload", "start", "pause", "resume", "cancel"] as const;

  constructor(private readonly connection: PrinterConnection) {
    if (connection.protocol !== "moonraker") {
      throw new Error("O adaptador Moonraker requer uma ligação de impressora Moonraker.");
    }
  }

  async testConnection(): Promise<void> {
    await this.request<unknown>("/server/info");
  }

  async getStatus(printerId: string): Promise<PrinterSummary> {
    this.assertPrinter(printerId);
    const result = await this.request<MoonrakerStatus>(
      "/printer/objects/query?webhooks&print_stats&extruder&heater_bed&virtual_sdcard"
    );
    const status = result.status;

    return {
      id: this.connection.id,
      name: this.connection.name,
      protocol: this.protocol,
      state: toPrinterState(status.webhooks?.state, status.print_stats?.state),
      nozzleTemperature: status.extruder?.temperature,
      bedTemperature: status.heater_bed?.temperature,
      progress: status.virtual_sdcard?.progress,
      jobName: status.print_stats?.filename
    };
  }

  async startJob(request: PrintJobRequest): Promise<void> {
    this.assertPrinter(request.printerId);
    await this.request(`/printer/print/start?filename=${encodeURIComponent(request.fileName)}`, { method: "POST" });
  }

  async uploadGcode(upload: GcodeUpload): Promise<void> {
    const body = new FormData();
    body.set("file", new Blob([upload.content], { type: "text/plain" }), upload.fileName);
    await this.request<unknown>("/server/files/upload", { method: "POST", body });
  }

  async pauseJob(printerId: string): Promise<void> {
    this.assertPrinter(printerId);
    await this.request("/printer/print/pause", { method: "POST" });
  }

  async resumeJob(printerId: string): Promise<void> {
    this.assertPrinter(printerId);
    await this.request("/printer/print/resume", { method: "POST" });
  }

  async cancelJob(printerId: string): Promise<void> {
    this.assertPrinter(printerId);
    await this.request("/printer/print/cancel", { method: "POST" });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.connection.apiKey) headers.set("X-Api-Key", this.connection.apiKey);
    const response = await fetch(`${this.connection.baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`O pedido ao Moonraker falhou (código HTTP ${response.status}).`);
    const body = (await response.json()) as MoonrakerResponse<T>;
    return body.result;
  }

  private assertPrinter(printerId: string): void {
    if (printerId !== this.connection.id) throw new Error("O identificador da impressora não corresponde a este adaptador.");
  }
}

function toPrinterState(webhookState?: string, printState?: string): PrinterState {
  if (webhookState !== "ready") return "offline";
  switch (printState) {
    case "printing": return "printing";
    case "paused": return "paused";
    case "complete": return "complete";
    case "error": return "error";
    default: return "idle";
  }
}
