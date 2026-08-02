import { createHash, randomBytes } from "node:crypto";
import type { GcodeUpload, PrintJobRequest, PrinterAdapter, PrinterConnection, PrinterState, PrinterSummary } from "@conceito/core";

type PrusaStatus = {
  printer: {
    state: string;
    temp_nozzle?: number;
    temp_bed?: number;
  };
  job?: {
    id?: number;
    progress?: number;
  };
};

/** HTTP Digest implementation for PrusaLink's documented v1 local API. */
export class PrusaLinkAdapter implements PrinterAdapter {
  readonly protocol = "prusalink" as const;
  readonly capabilities = ["connection-test", "status", "upload", "start", "pause", "resume", "cancel"] as const;

  constructor(private readonly connection: PrinterConnection) {
    if (connection.protocol !== "prusalink") throw new Error("O adaptador PrusaLink requer uma ligação de impressora PrusaLink.");
  }

  async testConnection(): Promise<void> { await this.request<unknown>("/api/version"); }

  async getStatus(printerId: string): Promise<PrinterSummary> {
    this.assertPrinter(printerId);
    const status = await this.status();
    return {
      id: this.connection.id,
      name: this.connection.name,
      protocol: this.protocol,
      state: toPrinterState(status.printer.state),
      nozzleTemperature: status.printer.temp_nozzle,
      bedTemperature: status.printer.temp_bed,
      progress: status.job?.progress
    };
  }

  async startJob(request: PrintJobRequest): Promise<void> {
    this.assertPrinter(request.printerId);
    await this.request<void>(`/api/v1/files/local/${encodeFilePath(request.fileName)}`, { method: "POST" });
  }

  async uploadGcode(upload: GcodeUpload): Promise<void> {
    const fileName = encodeFilePath(upload.fileName);
    await this.request<void>(`/api/v1/files/local/${fileName}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Overwrite": "?1" },
      body: upload.content
    });
  }

  async pauseJob(printerId: string): Promise<void> {
    this.assertPrinter(printerId);
    await this.request<void>(`/api/v1/job/${await this.activeJobId()}/pause`, { method: "PUT" });
  }

  async resumeJob(printerId: string): Promise<void> {
    this.assertPrinter(printerId);
    await this.request<void>(`/api/v1/job/${await this.activeJobId()}/resume`, { method: "PUT" });
  }

  async cancelJob(printerId: string): Promise<void> {
    this.assertPrinter(printerId);
    await this.request<void>(`/api/v1/job/${await this.activeJobId()}`, { method: "DELETE" });
  }

  private async activeJobId(): Promise<number> {
    const id = (await this.status()).job?.id;
    if (typeof id !== "number") throw new Error("O PrusaLink não tem um trabalho ativo para controlar.");
    return id;
  }

  private async status(): Promise<PrusaStatus> { return this.request<PrusaStatus>("/api/v1/status"); }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { username, apiKey: password } = this.connection;
    if (!username || !password) throw new Error("O PrusaLink requer um utilizador e palavra-passe/chave API para autenticação HTTP Digest.");
    const url = new URL(path, `${this.connection.baseUrl.replace(/\/$/, "")}/`);
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    let response = await fetch(url, { ...init, headers });
    if (response.status === 401) {
      const challenge = response.headers.get("www-authenticate");
      if (!challenge) throw new Error("O PrusaLink pediu autenticação sem um desafio HTTP Digest.");
      headers.set("Authorization", createDigestAuthorization(challenge, username, password, init.method ?? "GET", `${url.pathname}${url.search}`));
      response = await fetch(url, { ...init, headers });
    }
    if (!response.ok) throw new Error(`O pedido ao PrusaLink falhou (código HTTP ${response.status}).`);
    const body = await response.text();
    if (!body) return undefined as T;
    try {
      return JSON.parse(body) as T;
    } catch {
      return body as T;
    }
  }

  private assertPrinter(printerId: string): void {
    if (printerId !== this.connection.id) throw new Error("O identificador da impressora não corresponde a este adaptador.");
  }
}

function createDigestAuthorization(challenge: string, username: string, password: string, method: string, uri: string): string {
  const parameters = Object.fromEntries([...challenge.matchAll(/([a-zA-Z]+)=(?:"([^"]*)"|([^,\s]+))/g)].map((match) => [match[1].toLowerCase(), match[2] ?? match[3]]));
  if (!/^Digest\s/i.test(challenge) || !parameters.realm || !parameters.nonce) throw new Error("O PrusaLink devolveu um desafio de autenticação HTTP não suportado.");
  if (parameters.algorithm && parameters.algorithm.toUpperCase() !== "MD5") throw new Error(`Algoritmo PrusaLink Digest não suportado: ${parameters.algorithm}.`);
  const qop = parameters.qop?.split(",").map((value) => value.trim()).find((value) => value === "auth");
  if (parameters.qop && !qop) throw new Error("A autenticação PrusaLink Digest não disponibiliza qop=auth.");
  const cnonce = randomBytes(12).toString("hex");
  const nc = "00000001";
  const ha1 = md5(`${username}:${parameters.realm}:${password}`);
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);
  const response = qop ? md5(`${ha1}:${parameters.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${parameters.nonce}:${ha2}`);
  const fields = [
    `username="${quote(username)}"`, `realm="${quote(parameters.realm)}"`, `nonce="${quote(parameters.nonce)}"`, `uri="${quote(uri)}"`,
    `response="${response}"`, `algorithm=MD5`
  ];
  if (parameters.opaque) fields.push(`opaque="${quote(parameters.opaque)}"`);
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${fields.join(", ")}`;
}

function md5(value: string): string { return createHash("md5").update(value).digest("hex"); }
function quote(value: string): string { return value.replace(/([\\"])/g, "\\$1"); }
function encodeFilePath(fileName: string): string { return fileName.split("/").map(encodeURIComponent).join("/"); }

function toPrinterState(state: string): PrinterState {
  switch (state) {
    case "PRINTING": return "printing";
    case "PAUSED": return "paused";
    case "FINISHED": return "complete";
    case "BUSY": case "ATTENTION": return "preparing";
    case "ERROR": case "STOPPED": return "error";
    case "IDLE": case "READY": return "idle";
    default: return "offline";
  }
}
