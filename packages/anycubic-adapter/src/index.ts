import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { connect as connectTls, type ConnectionOptions, type TLSSocket } from "node:tls";
import type { GcodeUpload, PrintJobRequest, PrinterAdapter, PrinterConnection, PrinterState, PrinterSummary } from "@conceito/core";

type AnycubicInfo = {
  token?: string;
  ctrlInfoUrl?: string;
  modelId?: string | number;
};

type AnycubicControlResponse = {
  code?: number;
  data?: { info?: string; token?: string };
};

type AnycubicMqttDetails = {
  broker?: string;
  deviceId?: string;
  modelId?: string | number;
  modeId?: string | number;
  username?: string;
  password?: string;
  devicecrt?: string;
  devicepk?: string;
};

type AnycubicSecret = {
  type: "anycubic-lan";
  version: 1;
  clientId: string;
  broker: string;
  deviceId: string;
  modelId: string;
  username: string;
  password: string;
  certificate: string;
  privateKey: string;
};

type AnycubicInfoReport = {
  type?: string;
  code?: number;
  data?: {
    state?: string;
    project?: { filename?: string; progress?: number };
    temp?: { curr_nozzle_temp?: number; curr_hotbed_temp?: number };
    urls?: { fileUploadurl?: string };
  };
};

type AnycubicReport = {
  type?: string;
  code?: number;
  data?: unknown;
};

/**
 * Local adapter for recent Anycubic printers, starting with Kobra X. It uses
 * the printer-issued upload URL and local MQTT command topic. Credentials are
 * retained only in the server-side printer secret.
 */
export class AnycubicAdapter implements PrinterAdapter {
  readonly protocol = "anycubic" as const;
  readonly capabilities = ["connection-test", "status", "upload", "start", "cancel"] as const;
  private readonly uploadedFiles = new Map<string, { md5: string; size: number }>();

  constructor(private readonly connection: PrinterConnection) {
    if (connection.protocol !== "anycubic") {
      throw new Error("O adaptador Anycubic LAN requer uma ligação configurada como Anycubic LAN.");
    }
  }

  async testConnection(): Promise<void> {
    await this.withClient(async () => undefined);
  }

  async getStatus(printerId: string): Promise<PrinterSummary> {
    this.assertPrinter(printerId);
    return this.withClient(async (client, secret) => {
      await client.subscribe(`anycubic/anycubicCloud/v1/printer/+/${secret.modelId}/${secret.deviceId}/#`);
      const [infoResult, materialResult] = await Promise.allSettled([
        this.requestReport<AnycubicInfoReport>(client, secret, "info", "query", 8_000),
        // The multi-colour box report is optional. A printer without an ACE or
        // with an older firmware can omit it without losing normal monitoring.
        this.requestReport<AnycubicReport>(client, secret, "multiColorBox", "getInfo", 3_000)
      ]);
      if (infoResult.status === "rejected") throw infoResult.reason;
      const report = infoResult.value;
      const data = report.data ?? {};
      return {
        id: this.connection.id,
        name: this.connection.name,
        protocol: this.protocol,
        state: toPrinterState(data.state),
        nozzleTemperature: finiteNumber(data.temp?.curr_nozzle_temp),
        bedTemperature: finiteNumber(data.temp?.curr_hotbed_temp),
        loadedMaterial: materialResult.status === "fulfilled" ? materialDescription(materialResult.value.data) : undefined,
        progress: finiteNumber(data.project?.progress),
        jobName: text(data.project?.filename)
      };
    });
  }

  async uploadGcode(upload: GcodeUpload): Promise<void> {
    const fileName = safeFileName(upload.fileName);
    await this.withClient(async (client, secret) => {
      await client.subscribe(`anycubic/anycubicCloud/v1/printer/+/${secret.modelId}/${secret.deviceId}/#`);
      const report = await this.requestReport<AnycubicInfoReport>(client, secret, "info", "query", 8_000);
      const endpoint = this.uploadEndpoint(report.data?.urls?.fileUploadurl);
      const body = new FormData();
      body.set("file", new Blob([upload.content], { type: "text/plain" }), fileName);
      let response: Response;
      try {
        response = await fetch(endpoint, { method: "POST", body, signal: AbortSignal.timeout(60_000) });
      } catch (error) {
        throw new Error(`Não foi possível enviar o G-code para a Anycubic: ${errorMessage(error)}.`);
      }
      const responseText = await response.text();
      const responseBody = jsonRecord(responseText);
      if (!response.ok || (responseBody && responseBody.code !== undefined && ![0, 200].includes(Number(responseBody.code)))) {
        const reason = text(responseBody?.message) ?? text(responseBody?.msg) ?? `código HTTP ${response.status}`;
        throw new Error(`O upload Anycubic foi recusado (${reason}).`);
      }
      this.uploadedFiles.set(fileName, { md5: md5(upload.content), size: Buffer.byteLength(upload.content, "utf8") });
    });
  }

  async startJob(request: PrintJobRequest): Promise<void> {
    this.assertPrinter(request.printerId);
    const fileName = safeFileName(request.fileName);
    await this.withClient(async (client, secret) => {
      const uploaded = this.uploadedFiles.get(fileName);
      await this.publishCommand(client, secret, "slicer", "print", {
        type: "print",
        action: "start",
        timestamp: Date.now(),
        msgid: randomBytes(16).toString("hex"),
        data: {
          taskid: "-1",
          filename: fileName,
          filetype: 1,
          ...(uploaded ? { md5: uploaded.md5, filesize: uploaded.size } : {})
        }
      });
    });
  }
  async pauseJob(_printerId: string): Promise<void> { throw this.readOnlyError(); }
  async resumeJob(_printerId: string): Promise<void> { throw this.readOnlyError(); }
  async cancelJob(printerId: string): Promise<void> {
    this.assertPrinter(printerId);
    await this.withClient(async (client, secret) => {
      await this.publishCommand(client, secret, "web", "print", {
        type: "print",
        action: "stop",
        timestamp: Date.now(),
        msgid: randomBytes(16).toString("hex"),
        data: { taskid: "-1" }
      });
    });
  }

  private async withClient<T>(work: (client: AnycubicMqttClient, secret: AnycubicSecret) => Promise<T>): Promise<T> {
    let secret = await this.credentials();
    try {
      return await this.withConnectedClient(secret, work);
    } catch (error) {
      // A firmware restart can rotate the device-issued TLS details. Retry once
      // with a fresh local discovery, while keeping the same client identity.
      if (!this.hasStoredSecret()) throw error;
      secret = await this.discoverCredentials();
      return await this.withConnectedClient(secret, work);
    }
  }

  private async withConnectedClient<T>(secret: AnycubicSecret, work: (client: AnycubicMqttClient, secret: AnycubicSecret) => Promise<T>): Promise<T> {
    const client = await this.connect(secret);
    try {
      return await work(client, secret);
    } finally {
      client.end();
    }
  }

  private async credentials(): Promise<AnycubicSecret> {
    const stored = this.readStoredSecret();
    return stored ?? this.discoverCredentials();
  }

  private hasStoredSecret(): boolean { return Boolean(this.readStoredSecret()); }

  private readStoredSecret(): AnycubicSecret | undefined {
    if (!this.connection.apiKey) return undefined;
    try {
      const value = JSON.parse(this.connection.apiKey) as Partial<AnycubicSecret>;
      if (value.type !== "anycubic-lan" || value.version !== 1) return undefined;
      if (![value.clientId, value.broker, value.deviceId, value.modelId, value.username, value.password, value.certificate, value.privateKey].every((item) => typeof item === "string" && item.length > 0)) return undefined;
      return value as AnycubicSecret;
    } catch {
      return undefined;
    }
  }

  private async discoverCredentials(): Promise<AnycubicSecret> {
    const discoveryBase = this.discoveryBaseUrl();
    const info = await this.json<AnycubicInfo>(new URL("/info", discoveryBase));
    if (!info.token || info.token.length < 32 || !info.ctrlInfoUrl) {
      throw new Error("A impressora Anycubic não devolveu os dados locais necessários. Confirme que o modo LAN está ativo.");
    }

    const controllerUrl = new URL(info.ctrlInfoUrl, discoveryBase);
    if (controllerUrl.hostname !== discoveryBase.hostname) {
      throw new Error("A descoberta Anycubic devolveu um controlador fora da rede local e foi bloqueada.");
    }
    const clientId = createHash("sha256").update(`conceito:${this.connection.id}:${this.connection.baseUrl}`).digest("hex").slice(0, 32).toUpperCase();
    const timestamp = String(Date.now());
    const nonce = randomBytes(6).toString("base64url").slice(0, 6);
    const sign = md5(md5(info.token.slice(0, 16)) + timestamp + nonce);
    controllerUrl.searchParams.set("ts", timestamp);
    controllerUrl.searchParams.set("nonce", nonce);
    controllerUrl.searchParams.set("sign", sign);
    controllerUrl.searchParams.set("did", clientId);

    const control = await this.json<AnycubicControlResponse>(controllerUrl, { method: "POST" });
    if (control.code !== 200 || !control.data?.info || !control.data.token) {
      throw new Error("A impressora Anycubic recusou a descoberta de credenciais LAN.");
    }
    const cipher = Buffer.from(control.data.info, "base64");
    const decipher = createDecipheriv("aes-128-cbc", Buffer.from(info.token.slice(16, 32), "utf8"), Buffer.from(control.data.token, "utf8"));
    const details = JSON.parse(Buffer.concat([decipher.update(cipher), decipher.final()]).toString("utf8")) as AnycubicMqttDetails;
    const broker = requiredText(details.broker, "servidor MQTT");
    const brokerUrl = new URL(broker);
    if (brokerUrl.protocol !== "mqtts:" || brokerUrl.hostname !== discoveryBase.hostname) {
      throw new Error("A descoberta Anycubic não devolveu um servidor MQTT TLS local válido.");
    }

    const secret: AnycubicSecret = {
      type: "anycubic-lan",
      version: 1,
      clientId,
      broker,
      deviceId: requiredText(details.deviceId, "identificador da impressora"),
      modelId: String(details.modelId ?? details.modeId ?? info.modelId ?? ""),
      username: requiredText(details.username, "utilizador MQTT"),
      password: requiredText(details.password, "palavra-passe MQTT"),
      certificate: requiredText(details.devicecrt, "certificado MQTT"),
      privateKey: requiredText(details.devicepk, "chave privada MQTT")
    };
    if (!secret.modelId) throw new Error("A descoberta Anycubic não devolveu o identificador do modelo.");

    // apiKey is the existing server-side-only secret column. It is never sent
    // to the UI, logs or exports and avoids persisting sensitive details client-side.
    this.connection.apiKey = JSON.stringify(secret);
    this.connection.username = secret.username;
    this.connection.deviceId = secret.deviceId;
    return secret;
  }

  private async connect(secret: AnycubicSecret): Promise<AnycubicMqttClient> {
    return AnycubicMqttClient.connect({
      broker: secret.broker, clientId: secret.clientId, username: secret.username, password: secret.password,
      certificate: secret.certificate, privateKey: secret.privateKey
    });
  }

  private async requestReport<T extends AnycubicReport>(client: AnycubicMqttClient, secret: AnycubicSecret, type: string, action: "query" | "getInfo", timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`A impressora Anycubic não respondeu ao pedido ${type}.`)), timeoutMs);
      const message = (topic: string, payload: Buffer) => {
        if (!topic.endsWith(`/${type}/report`)) return;
        try {
          const report = JSON.parse(payload.toString("utf8")) as T;
          if (report.type && report.type !== type) return;
          finish(undefined, report);
        } catch {
          // Ignore unrelated or malformed reports and wait for the matching one.
        }
      };
      const finish = (error?: Error, report?: T) => {
        clearTimeout(timeout);
        client.removeMessageListener(message);
        error ? reject(error) : resolve(report!);
      };
      client.onMessage(message);
      const commandTopic = `anycubic/anycubicCloud/v1/web/printer/${secret.modelId}/${secret.deviceId}/${type}`;
      const payload = JSON.stringify({ type, action, timestamp: Date.now(), msgid: randomBytes(16).toString("hex"), data: null });
      try {
        client.publish(commandTopic, payload);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Não foi possível enviar a consulta Anycubic."));
      }
    });
  }

  private async publishCommand(client: AnycubicMqttClient, secret: AnycubicSecret, channel: "slicer" | "web", command: string, payload: object): Promise<void> {
    const topic = `anycubic/anycubicCloud/v1/${channel}/printer/${secret.modelId}/${secret.deviceId}/${command}`;
    await client.publishConfirmed(topic, JSON.stringify(payload));
  }

  private uploadEndpoint(value: unknown): URL {
    if (typeof value !== "string" || !value.trim()) throw new Error("A impressora Anycubic não disponibilizou o URL temporário para envio de G-code.");
    const endpoint = new URL(value);
    const base = new URL(this.connection.baseUrl);
    if (endpoint.protocol !== "http:" || endpoint.hostname !== base.hostname || endpoint.port !== "18910" || endpoint.pathname !== "/gcode_upload") {
      throw new Error("A impressora Anycubic devolveu um URL de upload local inválido.");
    }
    return endpoint;
  }

  private discoveryBaseUrl(): URL {
    const url = new URL(this.connection.baseUrl);
    url.protocol = "http:";
    url.port = "18910";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url;
  }

  private async json<T>(url: URL, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`O pedido LAN à Anycubic falhou (código HTTP ${response.status}).`);
    return await response.json() as T;
  }

  private assertPrinter(printerId: string): void {
    if (printerId !== this.connection.id) throw new Error("O identificador da impressora não corresponde a esta ligação Anycubic.");
  }

  private readOnlyError(): Error {
    return new Error("A Anycubic LAN permite enviar, iniciar e cancelar trabalhos. Pausar e retomar exigem validação adicional para este firmware.");
  }
}

function md5(value: string): string { return createHash("md5").update(value).digest("hex"); }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function safeFileName(value: string): string {
  const fileName = value.trim();
  if (!fileName || /[\\/:\0]/.test(fileName)) throw new Error("O nome do ficheiro Anycubic não pode incluir pastas, barras ou dois-pontos.");
  return fileName;
}
function jsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "erro de rede"; }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

/**
 * Anycubic's ACE / colour-box payload differs between firmware families. This
 * accepts the known field aliases and only returns a material from a selected
 * slot; it deliberately never guesses from the first available spool.
 */
function materialDescription(value: unknown): string | undefined {
  const root = record(value);
  if (!root) return undefined;
  const direct = textFrom(root, ["loadedMaterial", "currentMaterial", "activeMaterial", "currentFilament", "loadedFilament"]);
  if (direct) return direct;

  // Kobra X reports ACE data as multi_color_box[].loaded_slot with the
  // physical spool data in that box's slots[]. Indexes are zero based.
  const aceBoxes = Array.isArray(root.multi_color_box) ? root.multi_color_box.map(record) : [];
  for (const box of aceBoxes) {
    if (!box) continue;
    const loadedSlot = finiteNumber(box.loaded_slot);
    if (loadedSlot === undefined || loadedSlot < 0 || !Array.isArray(box.slots)) continue;
    const slot = box.slots.map(record).find((item) => item && finiteNumber(item.index) === loadedSlot);
    const description = slot ? materialFromSlot(slot) : undefined;
    if (description) return description;
  }

  const slots = ["slots", "boxs", "boxes", "colorBoxList", "materialBoxes", "materialBoxs", "filaments"]
    .flatMap((key) => Array.isArray(root[key]) ? root[key] : [])
    .map(record)
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const selected = slots.find(isSelectedMaterialSlot);
  return selected ? materialFromSlot(selected) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textFrom(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const result = text(value[key]);
    if (result) return result;
  }
  return undefined;
}

function isSelectedMaterialSlot(slot: Record<string, unknown>): boolean {
  if (["loaded", "current", "active", "selected", "using", "inuse", "printing"].includes(String(slot.status ?? "").toLowerCase())) return true;
  return ["loaded", "isLoaded", "current", "isCurrent", "active", "isActive", "selected", "isSelected", "using", "inUse"]
    .some((key) => slot[key] === true || slot[key] === 1 || slot[key] === "1");
}

function materialFromSlot(slot: Record<string, unknown>): string | undefined {
  const explicit = textFrom(slot, ["material", "materialName", "materialType", "filament", "filamentType", "type", "name"]);
  const material = record(slot.material);
  const nested = material ? textFrom(material, ["name", "type", "materialType", "filamentType"]) : undefined;
  const label = explicit ?? nested;
  if (!label || label.toLowerCase() === "unknown") return undefined;
  const colour = colourFrom(slot.color) ?? textFrom(slot, ["color", "colour", "hexColor"]);
  return colour ? `${label} · ${colour}` : label;
}

function colourFrom(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const channels = value.slice(0, 3).map(finiteNumber);
  if (channels.some((channel) => channel === undefined)) return undefined;
  return `#${channels.map((channel) => channel!.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function requiredText(value: unknown, label: string): string {
  const result = text(value);
  if (!result) throw new Error(`A descoberta Anycubic não devolveu ${label}.`);
  return result;
}

function toPrinterState(value?: string): PrinterState {
  switch (value?.toLowerCase()) {
    case "printing": case "busy": case "running": return "printing";
    case "paused": case "pause": return "paused";
    case "preparing": case "starting": return "preparing";
    case "complete": case "completed": case "finished": return "complete";
    case "error": case "failed": return "error";
    case "idle": case "ready": case "standby": case "free": return "idle";
    default: return "offline";
  }
}

type LocalMqttConnection = {
  broker: string;
  clientId: string;
  username: string;
  password: string;
  certificate: string;
  privateKey: string;
};

type MessageListener = (topic: string, payload: Buffer) => void;

/** A deliberately small MQTT 3.1.1 client for read-only Anycubic LAN queries. */
class AnycubicMqttClient {
  private readonly messages = new Set<MessageListener>();
  private buffer = Buffer.alloc(0);
  private packetId = 1;
  private closed = false;
  private resolveConnack?: () => void;
  private rejectConnack?: (error: Error) => void;
  private readonly connack = new Promise<void>((resolve, reject) => { this.resolveConnack = resolve; this.rejectConnack = reject; });
  private readonly pending = new Map<number, { kind: "suback" | "puback"; resolve: () => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: TLSSocket) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", () => { if (!this.closed) this.fail(new Error("A ligação MQTT Anycubic foi terminada.")); });
  }

  static async connect(options: LocalMqttConnection): Promise<AnycubicMqttClient> {
    const broker = new URL(options.broker);
    const connection: ConnectionOptions = {
      host: broker.hostname,
      port: Number(broker.port || 9883),
      cert: options.certificate,
      key: options.privateKey,
      rejectUnauthorized: false
    };
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(broker.hostname)) connection.servername = broker.hostname;
    const socket = connectTls(connection);
    const client = new AnycubicMqttClient(socket);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("A ligação MQTT Anycubic excedeu o tempo limite.")), 9_000);
      socket.once("error", fail);
      socket.once("secureConnect", () => {
        socket.removeListener("error", fail);
        client.sendConnect(options);
        client.connack.then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        }, fail);
      });
    });
    return client;
  }

  async subscribe(topic: string): Promise<void> {
    const packetId = this.nextPacketId();
    const body = Buffer.concat([packetIdBuffer(packetId), mqttString(topic), Buffer.from([0])]);
    await this.sendAwaitAcknowledgement(0x82, body, packetId, "suback");
  }

  publish(topic: string, payload: string): void {
    const body = Buffer.concat([mqttString(topic), Buffer.from(payload, "utf8")]);
    this.sendPacket(0x30, body);
  }

  async publishConfirmed(topic: string, payload: string): Promise<void> {
    const packetId = this.nextPacketId();
    const body = Buffer.concat([mqttString(topic), packetIdBuffer(packetId), Buffer.from(payload, "utf8")]);
    await this.sendAwaitAcknowledgement(0x32, body, packetId, "puback");
  }

  onMessage(listener: MessageListener): void { this.messages.add(listener); }
  removeMessageListener(listener: MessageListener): void { this.messages.delete(listener); }

  end(): void {
    if (this.closed) {
      this.socket.destroy();
      return;
    }
    this.closed = true;
    if (!this.socket.destroyed && this.socket.writable) {
      this.socket.write(Buffer.from([0xe0, 0x00]));
      this.socket.end();
    }
    this.socket.destroy();
  }

  private sendConnect(options: LocalMqttConnection): void {
    const variableHeader = Buffer.concat([mqttString("MQTT"), Buffer.from([4, 0xc2, 0, 45])]);
    const payload = Buffer.concat([mqttString(options.clientId), mqttString(options.username), mqttString(options.password)]);
    this.sendPacket(0x10, Buffer.concat([variableHeader, payload]));
  }

  private sendAwaitAcknowledgement(header: number, body: Buffer, packetId: number, kind: "suback" | "puback"): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.set(packetId, { kind, resolve, reject });
      this.sendPacket(header, body);
    });
  }

  private sendPacket(header: number, body: Buffer): void {
    if (this.closed) throw new Error("A ligação MQTT Anycubic já foi terminada.");
    this.socket.write(Buffer.concat([Buffer.from([header]), mqttRemainingLength(body.length), body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const remaining = decodeRemainingLength(this.buffer, 1);
      if (!remaining) return;
      const end = 1 + remaining.bytes + remaining.value;
      if (this.buffer.length < end) return;
      const header = this.buffer[0];
      const body = this.buffer.subarray(1 + remaining.bytes, end);
      this.buffer = this.buffer.subarray(end);
      this.handlePacket(header, body);
    }
  }

  private handlePacket(header: number, body: Buffer): void {
    const kind = header >> 4;
    if (kind === 2) {
      if (body.length < 2 || body[1] !== 0) this.rejectConnack?.(new Error(`A autenticação MQTT Anycubic foi recusada (código ${body[1] ?? "desconhecido"}).`));
      else this.resolveConnack?.();
      return;
    }
    if (kind === 9 || kind === 4) {
      if (body.length < 2) return;
      const id = body.readUInt16BE(0);
      const pending = this.pending.get(id);
      if (pending && ((kind === 9 && pending.kind === "suback") || (kind === 4 && pending.kind === "puback"))) {
        this.pending.delete(id);
        pending.resolve();
      }
      return;
    }
    if (kind !== 3) return;
    const topic = readMqttString(body, 0);
    if (!topic) return;
    let offset = topic.offset;
    const qos = (header >> 1) & 3;
    if (qos > 0) {
      if (body.length < offset + 2) return;
      const id = body.readUInt16BE(offset);
      offset += 2;
      if (qos === 1) this.sendPacket(0x40, packetIdBuffer(id));
    }
    const payload = body.subarray(offset);
    for (const listener of this.messages) listener(topic.value, payload);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectConnack?.(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.socket.destroy();
  }

  private nextPacketId(): number {
    this.packetId = this.packetId >= 65_535 ? 1 : this.packetId + 1;
    return this.packetId;
  }
}

function mqttString(value: string): Buffer {
  const buffer = Buffer.from(value, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(buffer.length);
  return Buffer.concat([length, buffer]);
}

function packetIdBuffer(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function mqttRemainingLength(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let digit = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) digit |= 0x80;
    bytes.push(digit);
  } while (value > 0);
  return Buffer.from(bytes);
}

function decodeRemainingLength(buffer: Buffer, offset: number): { value: number; bytes: number } | undefined {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 4; index += 1) {
    const current = buffer[offset + index];
    if (current === undefined) return undefined;
    value += (current & 127) * multiplier;
    if ((current & 128) === 0) return { value, bytes: index + 1 };
    multiplier *= 128;
  }
  throw new Error("Pacote MQTT Anycubic inválido.");
}

function readMqttString(buffer: Buffer, offset: number): { value: string; offset: number } | undefined {
  if (buffer.length < offset + 2) return undefined;
  const length = buffer.readUInt16BE(offset);
  const start = offset + 2;
  const end = start + length;
  if (buffer.length < end) return undefined;
  return { value: buffer.subarray(start, end).toString("utf8"), offset: end };
}
