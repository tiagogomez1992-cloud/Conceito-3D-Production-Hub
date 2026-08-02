import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import type { GcodeUpload, PrintJobRequest, PrinterAdapter, PrinterConnection, PrinterState, PrinterSummary } from "@conceito/core";

type CrealityStatusMessage = {
  state?: number | string;
  deviceState?: number | string;
  nozzleTemp?: number | string;
  bedTemp0?: number | string;
  printProgress?: number | string;
  printFileName?: string;
};

type CrealityGcodeFile = { path: string; name: string };

/**
 * Adapter for Creality's legacy LAN controller used by the Ender-5 Max.
 * Its local Web UI uploads to HTTP and starts an already uploaded file over
 * the WebSocket service on port 9999.
 */
export class CrealityAdapter implements PrinterAdapter {
  readonly protocol = "creality" as const;
  readonly capabilities = ["connection-test", "status", "upload", "start"] as const;

  constructor(private readonly connection: PrinterConnection) {
    if (connection.protocol !== "creality") {
      throw new Error("O adaptador Creality LAN requer uma ligação configurada como Creality LAN.");
    }
  }

  async testConnection(): Promise<void> {
    await this.readStatus();
  }

  async getStatus(printerId: string): Promise<PrinterSummary> {
    this.assertPrinter(printerId);
    const message = await this.readStatus();
    const state = toPrinterState(message.state ?? message.deviceState);
    return {
      id: this.connection.id,
      name: this.connection.name,
      protocol: this.protocol,
      state,
      nozzleTemperature: numberValue(message.nozzleTemp),
      bedTemperature: numberValue(message.bedTemp0),
      // The controller exposes only a material-sensor warning, not the
      // actual material type, so no value is fabricated here.
      progress: state === "printing" || state === "paused" ? numberValue(message.printProgress) : undefined,
      jobName: state === "printing" || state === "paused" ? fileName(message.printFileName) : undefined
    };
  }

  async uploadGcode(upload: GcodeUpload): Promise<void> {
    const fileName = safeFileName(upload.fileName);
    const endpoint = new URL(`/upload/${encodeURIComponent(fileName)}`, this.connection.baseUrl);
    const body = new FormData();
    body.set("file", new Blob([upload.content], { type: "text/plain" }), fileName);

    let response: Response;
    try {
      response = await fetch(endpoint, { method: "POST", body, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new Error(`Não foi possível enviar o G-code para a Creality: ${errorMessage(error)}.`);
    }
    const text = await response.text();
    const result = jsonRecord(text);
    if (!response.ok || (result && result.code !== undefined && Number(result.code) !== 200)) {
      const reason = textFrom(result?.msg) ?? textFrom(result?.message) ?? `código HTTP ${response.status}`;
      throw new Error(`O upload Creality foi recusado (${reason}).`);
    }
  }

  async startJob(request: PrintJobRequest): Promise<void> {
    this.assertPrinter(request.printerId);
    const fileName = safeFileName(request.fileName);
    const remoteFile = await this.findRemoteFile(fileName);
    await sendCrealityWebSocket(this.host(), {
      method: "set",
      params: { opGcodeFile: `printprt:${remoteFile.path}/${remoteFile.name}` }
    });
  }

  async pauseJob(_printerId: string): Promise<void> { throw this.unsupportedControlError(); }
  async resumeJob(_printerId: string): Promise<void> { throw this.unsupportedControlError(); }
  async cancelJob(_printerId: string): Promise<void> { throw this.unsupportedControlError(); }

  private async readStatus(): Promise<CrealityStatusMessage> {
    return await requestCrealityWebSocket(this.host(), undefined, (value) => isStatusMessage(value) ? value : undefined, "estado");
  }

  private async findRemoteFile(fileName: string): Promise<CrealityGcodeFile> {
    // The HTTP response returns before the controller always refreshes its
    // local file index, therefore query it a few times before failing.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const files = await requestCrealityWebSocket(this.host(), { method: "get", params: { reqGcodeFile: 1 } }, gcodeFiles, "lista de G-code");
      const file = files.find((candidate) => candidate.name === fileName);
      if (file) return file;
      if (attempt < 4) await delay(400);
    }
    throw new Error(`A Creality ainda não encontrou o ficheiro enviado “${fileName}”. Confirme que existe espaço livre e tente novamente.`);
  }

  private host(): string {
    const host = new URL(this.connection.baseUrl).hostname;
    if (!host) throw new Error("O endereço Creality LAN não contém um anfitrião válido.");
    return host;
  }

  private assertPrinter(printerId: string): void {
    if (printerId !== this.connection.id) throw new Error("O identificador da impressora não corresponde a esta ligação Creality.");
  }

  private unsupportedControlError(): Error {
    return new Error("A Creality LAN permite envio e início de trabalhos. Pausar, retomar e cancelar exigem validação adicional para este firmware.");
  }
}

async function requestCrealityWebSocket<T>(host: string, request: object | undefined, select: (value: unknown) => T | undefined, expected: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const socket = createConnection({ host, port: 9999 });
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let upgraded = false;
    let closed = false;
    const timeout = setTimeout(() => finish(new Error(`A impressora Creality não enviou ${expected} a tempo.`)), 7_000);

    const finish = (error?: Error, result?: T) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      error ? reject(error) : resolve(result!);
    };

    socket.once("connect", () => {
      socket.write([
        "GET / HTTP/1.1",
        `Host: ${host}:9999`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n"
      ].join("\r\n"));
    });
    socket.on("error", (error) => finish(new Error(`A ligação Creality LAN falhou: ${error.message}`)));
    socket.on("close", () => { if (!closed) finish(new Error("A ligação WebSocket Creality foi terminada.")); });
    socket.on("data", (chunk: Buffer) => {
      if (closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const response = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 4);
        if (!/^HTTP\/1\.1 101\b/m.test(response)) return finish(new Error("O serviço Creality LAN não aceitou a ligação WebSocket."));
        const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(response)?.[1]?.trim();
        if (accept !== expectedAccept) return finish(new Error("A resposta do WebSocket Creality não passou na validação."));
        upgraded = true;
        if (request) socket.write(webSocketFrame(1, Buffer.from(JSON.stringify(request), "utf8")));
      }
      while (!closed) {
        const message = firstWebSocketMessage(buffer);
        if (!message) return;
        buffer = message.remaining;
        if (message.opcode === 8) return finish(new Error(`O serviço Creality fechou a ligação antes de enviar ${expected}.`));
        if (message.opcode === 9) {
          socket.write(webSocketFrame(10, message.payload));
          continue;
        }
        if (message.opcode !== 1) continue;
        try {
          const selected = select(JSON.parse(message.payload.toString("utf8")) as unknown);
          if (selected !== undefined) return finish(undefined, selected);
        } catch {
          // Initial acknowledgements and unrelated controller reports are ignored.
        }
      }
    });
  });
}

async function sendCrealityWebSocket(host: string, command: object): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const socket = createConnection({ host, port: 9999 });
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let closed = false;
    const timeout = setTimeout(() => finish(new Error("A Creality não aceitou o comando de início a tempo.")), 7_000);
    const finish = (error?: Error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      error ? reject(error) : resolve();
    };

    socket.once("connect", () => {
      socket.write([
        "GET / HTTP/1.1",
        `Host: ${host}:9999`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n"
      ].join("\r\n"));
    });
    socket.on("error", (error) => finish(new Error(`A ligação Creality LAN falhou: ${error.message}`)));
    socket.on("close", () => { if (!closed) finish(new Error("A ligação WebSocket Creality foi terminada antes de aceitar o comando.")); });
    socket.on("data", (chunk: Buffer) => {
      if (closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const response = buffer.subarray(0, end).toString("utf8");
      if (!/^HTTP\/1\.1 101\b/m.test(response)) return finish(new Error("O serviço Creality LAN não aceitou a ligação WebSocket."));
      const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(response)?.[1]?.trim();
      if (accept !== expectedAccept) return finish(new Error("A resposta do WebSocket Creality não passou na validação."));
      socket.write(webSocketFrame(1, Buffer.from(JSON.stringify(command), "utf8")), () => finish());
    });
  });
}

function gcodeFiles(value: unknown): CrealityGcodeFile[] | undefined {
  const root = jsonObject(value);
  const info = jsonObject(root?.retGcodeFileInfo);
  if (!info || typeof info.fileInfo !== "string") return undefined;
  return info.fileInfo.split(";").flatMap((entry) => {
    const [path, name] = entry.split(":");
    return path && name ? [{ path, name }] : [];
  });
}

function firstWebSocketMessage(buffer: Buffer): { opcode: number; payload: Buffer; remaining: Buffer } | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0];
  const second = buffer[1];
  let offset = 2;
  let length = second & 0x7f;
  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    const value = buffer.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Mensagem WebSocket Creality demasiado grande.");
    length = Number(value);
    offset += 8;
  }
  const masked = Boolean(second & 0x80);
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { opcode: first & 0x0f, payload, remaining: buffer.subarray(offset + length) };
}

function webSocketFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const header: number[] = [0x80 | opcode];
  if (payload.length < 126) header.push(0x80 | payload.length);
  else if (payload.length <= 0xffff) header.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
  else {
    header.push(0x80 | 127);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(payload.length));
    header.push(...length);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([Buffer.from(header), mask, masked]);
}

function safeFileName(value: string): string {
  const fileName = value.trim();
  if (!fileName || /[\\/:\0]/.test(fileName)) throw new Error("O nome do ficheiro Creality não pode incluir pastas, barras ou dois-pontos.");
  return fileName;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonRecord(value: string): Record<string, unknown> | undefined {
  try { return jsonObject(JSON.parse(value) as unknown); } catch { return undefined; }
}

function textFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "erro de rede";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isStatusMessage(value: unknown): value is CrealityStatusMessage {
  return Boolean(value && typeof value === "object" && ("state" in value || "nozzleTemp" in value || "bedTemp0" in value));
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function fileName(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parts = value.replace(/\\/g, "/").split("/");
  return parts.at(-1) || undefined;
}

function toPrinterState(value: unknown): PrinterState {
  switch (numberValue(value)) {
    case 0: return "idle";
    case 1: return "printing";
    case 2: return "complete";
    case 3: return "error";
    case 4: return "idle";
    case 5: return "paused";
    default: return "offline";
  }
}
