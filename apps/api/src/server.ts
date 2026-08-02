import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { AnycubicAdapter } from "@conceito/anycubic-adapter";
import { CrealityAdapter } from "@conceito/creality-adapter";
import { MoonrakerAdapter } from "@conceito/moonraker-adapter";
import { OctoPrintAdapter } from "@conceito/octoprint-adapter";
import { PrusaLinkAdapter } from "@conceito/prusalink-adapter";
import type { Customer, CustomerOrderTemplate, CustomerOrderTemplateField, GcodeFile, MaintenanceRecord, MaterialType, PrinterAdapter, PrinterConnection, PrinterProfile, PrinterProtocol, ProductionJob, ProductionOrderItem, ProductionProject, Spool } from "@conceito/core";
import { createFileProductionRepository } from "./file-repository.js";
import { createGcodeLibrary } from "./gcode-library.js";
import { extractOrderDraftWithOcr, extractOrderDraftWithTemplate, renderOrderPdfPreview } from "./order-ocr.js";
import { extractOrderDraftFromText, extractPdfTextFromPdfBase64, type PdfOrderDraft } from "./order-pdf.js";
import { createProductionRepository, DomainError } from "./repository.js";
import { createSettingsStore, type AppearanceSettings } from "./settings-store.js";
import { createSpoolmanClient, spoolFromSpoolman } from "./spoolman-client.js";

export async function createServer() {

const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });
const dataDirectory = process.env.DATA_DIRECTORY ?? "./data";
const repository = process.env.STORAGE_DRIVER === "file"
  ? createFileProductionRepository(dataDirectory)
  : createProductionRepository();
const gcodeLibrary = createGcodeLibrary(dataDirectory);
const settingsStore = createSettingsStore(dataDirectory);
const protocols: PrinterProtocol[] = ["moonraker", "octoprint", "prusalink", "anycubic", "creality", "bambu", "generic"];
const materials: MaterialType[] = ["PLA", "PETG", "ABS", "ASA", "TPU", "other"];

await app.register(cors, { origin: true });
await repository.migrate();
await gcodeLibrary.initialise();
await settingsStore.initialise();

app.addHook("onClose", async () => repository.close());
app.get("/health", async () => ({ status: "ok" }));

app.get("/api/v1/printers", async () => ({ data: (await repository.listPrinters()).map(publicPrinter) }));

app.get("/api/v1/printer-protocols", async () => ({ data: protocolCatalog }));

app.post<{ Body: Partial<PrinterConnection> }>("/api/v1/printers", async (request, reply) => {
  const body = request.body;
  if (!body.name || !body.protocol || !isValidHttpUrl(body.baseUrl) || !protocols.includes(body.protocol)) {
    return reply.code(400).send({ error: "São obrigatórios um nome, um protocolo suportado e um endereço local válido." });
  }
  const candidate: PrinterConnection = {
    id: body.id || randomUUID(), name: body.name.trim(), manufacturer: optionalText(body.manufacturer), model: optionalText(body.model),
    profile: sanitizeProfile(body.profile), protocol: body.protocol, baseUrl: normalizeBaseUrl(body.baseUrl),
    apiKey: optionalText(body.apiKey), username: optionalText(body.username), deviceId: optionalText(body.deviceId)
  };
  const duplicate = await repository.findDuplicatePrinter(candidate.name, candidate.baseUrl);
  if (duplicate) return reply.code(409).send({ error: `Já existe uma impressora com o nome '${duplicate.name}' ou com este endereço.` });
  const adapter = adapterFor(candidate);
  if (adapter) {
    try {
      await adapter.testConnection();
    } catch (error) {
      const moonrakerHint = candidate.protocol === "moonraker" ? " Use o endereço do Moonraker, habitualmente http://IP-DA-IMPRESSORA:7125." : "";
      return reply.code(422).send({ error: `Falhou a validação da ligação. A impressora não foi guardada: ${errorMessage(error)}.${moonrakerHint}` });
    }
  }
  const printer = await repository.savePrinter(candidate);
  return reply.code(201).send({ data: publicPrinter(printer) });
});

/** Tests the relevant local protocols without registering or changing a printer. */
app.post<{ Body: Partial<PrinterConnection> & { protocols?: PrinterProtocol[] } }>("/api/v1/printers/discover", async (request, reply) => {
  const body = request.body;
  if (!isValidHttpUrl(body.baseUrl)) return reply.code(400).send({ error: "É necessário um endereço local válido da impressora." });
  const requested = [...new Set((body.protocols ?? [body.protocol]).filter((protocol): protocol is PrinterProtocol => Boolean(protocol) && protocols.includes(protocol as PrinterProtocol)))];
  const candidates: PrinterProtocol[] = requested.length ? requested : ["moonraker", "octoprint", "prusalink", "anycubic", "creality"];
  const results = await Promise.all(candidates.map(async (protocol) => {
    if (protocol === "generic" || protocol === "bambu") {
      return { protocol, connected: false, manual: true, message: protocol === "bambu" ? "O Bambu LAN é experimental e ainda não pode ser testado automaticamente." : "O registo manual não disponibiliza um ponto de teste." };
    }
    const printer: PrinterConnection = {
      id: "connection-probe", name: "Connection probe", protocol, baseUrl: normalizeBaseUrl(body.baseUrl!),
      apiKey: optionalText(body.apiKey), username: optionalText(body.username)
    };
    try {
      await adapterFor(printer)?.testConnection();
    return { protocol, connected: true, manual: false, message: "Ligação confirmada." };
    } catch (error) {
      return { protocol, connected: false, manual: false, message: errorMessage(error) };
    }
  }));
  return { data: results };
});

app.put<{ Params: { id: string }; Body: { profile?: unknown } }>("/api/v1/printers/:id/profile", async (request, reply) => {
  try {
    const printer = await repository.updatePrinterProfile(request.params.id, sanitizeProfile(request.body.profile));
    return { data: publicPrinter(printer) };
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.delete<{ Params: { id: string } }>("/api/v1/printers/:id", async (request, reply) => {
  try {
    await repository.deletePrinter(request.params.id);
    return reply.code(204).send();
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.get("/api/v1/projects", async () => ({ data: await repository.listProjects() }));

app.get("/api/v1/customers", async () => ({ data: await repository.listCustomers() }));

app.post<{ Body: { fileName?: string; contentBase64?: string } }>("/api/v1/customers/preview-pdf", async (request, reply) => {
  const fileName = optionalText(request.body.fileName);
  if (!fileName?.toLowerCase().endsWith(".pdf") || !optionalText(request.body.contentBase64)) {
    return reply.code(400).send({ error: "Envie um ficheiro PDF para preparar o modelo do cliente." });
  }
  try {
    return { data: { fileName, ...(await renderOrderPdfPreview(request.body.contentBase64!)) } };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: Partial<Customer> }>("/api/v1/customers", async (request, reply) => {
  const body = request.body;
  if (!optionalText(body.name)) return reply.code(400).send({ error: "É necessário indicar o nome do cliente." });
  try {
    const customer = await repository.createCustomer({
      id: body.id || randomUUID(), name: body.name!.trim(), email: optionalText(body.email), phone: optionalText(body.phone), notes: optionalText(body.notes),
      sampleDocumentName: optionalText(body.sampleDocumentName), orderTemplate: sanitizeCustomerTemplate(body.orderTemplate), createdAt: new Date().toISOString()
    });
    return reply.code(201).send({ data: customer });
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.delete<{ Params: { id: string } }>("/api/v1/customers/:id", async (request, reply) => {
  try {
    await repository.deleteCustomer(request.params.id);
    return reply.code(204).send();
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.post<{ Body: { fileName?: string; contentBase64?: string; customerId?: string } }>("/api/v1/orders/extract-pdf", async (request, reply) => {
  const fileName = optionalText(request.body.fileName);
  if (!fileName?.toLowerCase().endsWith(".pdf") || !optionalText(request.body.contentBase64)) {
    return reply.code(400).send({ error: "Envie um ficheiro PDF para extrair os dados da encomenda." });
  }
  try {
    const requestedCustomerId = optionalText(request.body.customerId);
    let customer = requestedCustomerId ? await repository.getCustomer(requestedCustomerId) : undefined;
    if (requestedCustomerId && !customer) return reply.code(404).send({ error: "Cliente não encontrado." });
    const text = extractPdfTextFromPdfBase64(request.body.contentBase64!);
    let draft = text.trim() ? extractOrderDraftFromText(text) : undefined;
    let ocrUsed = false;
    let templateUsed = false;

    if (!draft || orderDraftScore(draft) < 3) {
      const ocrDraft = await extractOrderDraftWithOcr(request.body.contentBase64!);
      if (!draft || orderDraftScore(ocrDraft) >= orderDraftScore(draft)) {
        draft = ocrDraft;
        ocrUsed = true;
      }
    }
    if (!draft) throw new Error("NÃ£o foi possÃ­vel ler dados neste PDF.");
    let finalDraft: PdfOrderDraft = draft;

    if (!customer && finalDraft.customer) {
      const detectedCustomerName = finalDraft.customer;
      customer = (await repository.listCustomers()).find((candidate) => normalizeCustomerName(candidate.name) === normalizeCustomerName(detectedCustomerName));
    }
    if (customer?.orderTemplate?.fields.length) {
      try {
        const templateDraft = await extractOrderDraftWithTemplate(request.body.contentBase64!, customer.orderTemplate);
        finalDraft = mergeCustomerTemplateDraft(finalDraft, templateDraft, customer.name);
        templateUsed = true;
      } catch (error) {
        finalDraft.warnings.push(`O modelo do cliente não pôde ser aplicado: ${errorMessage(error)}`);
      }
    } else if (customer) {
      finalDraft.customer = customer.name;
    }
    return { data: { fileName, customerId: customer?.id, ocrUsed, templateUsed, ...finalDraft } };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: Partial<ProductionProject> }>("/api/v1/projects", async (request, reply) => {
  const body = request.body;
  if (!body.name || !body.name.trim()) return reply.code(400).send({ error: "É necessário indicar o nome da encomenda." });
  try {
    const customerId = optionalText(body.customerId);
    const customer = customerId ? await repository.getCustomer(customerId) : undefined;
    if (customerId && !customer) return reply.code(404).send({ error: "Cliente não encontrado." });
    const project = await repository.createProject({
      id: body.id || randomUUID(), name: body.name.trim(), customerId: customer?.id, customer: customer?.name ?? optionalText(body.customer), orderNumber: optionalText(body.orderNumber),
      items: sanitizeOrderItems(body.items), sourceDocumentName: optionalText(body.sourceDocumentName), state: "active", createdAt: new Date().toISOString()
    });
    return reply.code(201).send({ data: project });
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.post<{ Params: { id: string } }>("/api/v1/projects/:id/archive", async (request, reply) => {
  try {
    return { data: await repository.archiveProject(request.params.id) };
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.post<{ Params: { id: string } }>("/api/v1/printers/:id/test", async (request, reply) => {
  const printer = await repository.getPrinter(request.params.id);
  if (!printer) return reply.code(404).send({ error: "Impressora não encontrada." });
  const adapter = adapterFor(printer);
  if (!adapter) return reply.code(501).send({ error: unavailableProtocolMessage(printer.protocol) });
  try {
    await adapter.testConnection();
    return { data: { connected: true } };
  } catch (error) {
    return reply.code(502).send({ error: errorMessage(error) });
  }
});

app.get<{ Params: { id: string } }>("/api/v1/printers/:id/status", async (request, reply) => {
  const printer = await repository.getPrinter(request.params.id);
  if (!printer) return reply.code(404).send({ error: "Impressora não encontrada." });
  const adapter = adapterFor(printer);
  if (!adapter) return reply.code(501).send({ error: unavailableProtocolMessage(printer.protocol) });
  try {
    return { data: await adapter.getStatus(printer.id) };
  } catch (error) {
    return reply.code(502).send({ error: errorMessage(error) });
  }
});

app.get("/api/v1/gcode-files", async () => ({ data: await gcodeLibrary.list() }));

app.get<{ Params: { fileName: string } }>("/api/v1/gcode-files/:fileName/thumbnail", async (request, reply) => {
  try {
    const thumbnail = await gcodeLibrary.readThumbnail(decodeURIComponent(request.params.fileName));
    if (!thumbnail) return reply.code(404).send({ error: "Miniatura do G-code não encontrada." });
    return reply.type(thumbnail.metadata.mimeType).send(thumbnail.data);
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.get<{ Params: { fileName: string } }>("/api/v1/gcode-files/:fileName", async (request, reply) => {
  try {
    const file = await gcodeLibrary.read(decodeURIComponent(request.params.fileName));
    if (!file) return reply.code(404).send({ error: "Ficheiro G-code não encontrado." });
    return { data: file };
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: { fileName?: string; content?: string; estimatedMaterialGrams?: number; estimatedPrintMinutes?: number } }>("/api/v1/gcode-files", async (request, reply) => {
  const { fileName, content, estimatedMaterialGrams, estimatedPrintMinutes } = request.body;
  if (!fileName || typeof content !== "string") return reply.code(400).send({ error: "São obrigatórios o nome e o conteúdo do ficheiro G-code." });
  try {
    const file = await gcodeLibrary.save({ fileName, content, estimatedMaterialGrams, estimatedPrintMinutes });
    return reply.code(201).send({ data: file });
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.delete<{ Params: { fileName: string } }>("/api/v1/gcode-files/:fileName", async (request, reply) => {
  try {
    await gcodeLibrary.remove(decodeURIComponent(request.params.fileName));
    return reply.code(204).send();
  } catch (error) {
    return reply.code(404).send({ error: errorMessage(error) });
  }
});

app.get("/api/v1/spools", async () => ({ data: await repository.listSpools() }));

app.get("/api/v1/settings/appearance", async () => ({ data: settingsStore.getAppearance() }));

app.put<{ Body: Partial<AppearanceSettings> }>("/api/v1/settings/appearance", async (request, reply) => {
  const appearance = sanitizeAppearance(request.body, settingsStore.getAppearance());
  if (!appearance) return reply.code(400).send({ error: "Indique uma escala entre 85% e 130%, um tema e uma cor hexadecimal válida." });
  return { data: await settingsStore.setAppearance(appearance) };
});

app.get("/api/v1/integrations/spoolman", async () => ({ data: settingsStore.getSpoolman() }));

app.put<{ Body: { url?: string; apiKey?: string } }>("/api/v1/integrations/spoolman", async (request, reply) => {
  const url = optionalText(request.body.url);
  if (url && !isValidHttpUrl(url)) return reply.code(400).send({ error: "O endereço do Spoolman tem de ser HTTP(S) válido." });
  const existing = settingsStore.getSpoolmanSecret();
  const apiKey = request.body.apiKey === undefined ? existing?.apiKey : optionalText(request.body.apiKey);
  return { data: await settingsStore.setSpoolman(url ? { url: normalizeBaseUrl(url), apiKey } : undefined) };
});

app.post("/api/v1/integrations/spoolman/test", async (_request, reply) => {
  const settings = settingsStore.getSpoolmanSecret();
  if (!settings) return reply.code(409).send({ error: "Configure primeiro o endereço do Spoolman." });
  try {
    await createSpoolmanClient(settings).testConnection();
    return { data: { connected: true } };
  } catch (error) {
    return reply.code(502).send({ error: errorMessage(error) });
  }
});

app.post("/api/v1/integrations/spoolman/sync", async (_request, reply) => {
  const settings = settingsStore.getSpoolmanSecret();
  if (!settings) return reply.code(409).send({ error: "Configure primeiro o endereço do Spoolman." });
  try {
    const remoteSpools = await createSpoolmanClient(settings).listSpools();
    const saved = await Promise.all(remoteSpools.map((spool) => repository.saveSpool(spoolFromSpoolman(spool, randomUUID()))));
    return { data: { imported: saved.length } };
  } catch (error) {
    return reply.code(502).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: Partial<Spool> }>("/api/v1/spools", async (request, reply) => {
  const body = request.body;
  if (!body.brand || !body.color || !body.material || !materials.includes(body.material) || !isPositiveNumber(body.initialWeightGrams)) {
    return reply.code(400).send({ error: "São obrigatórios a marca, a cor, o material e um peso inicial positivo." });
  }
  const spool = await repository.createSpool({
    id: body.id || randomUUID(), brand: body.brand, material: body.material, color: body.color,
    initialWeightGrams: body.initialWeightGrams,
    remainingWeightGrams: body.remainingWeightGrams ?? body.initialWeightGrams,
    reservedWeightGrams: 0, costPerKg: positiveNumber(body.costPerKg)
  });
  return reply.code(201).send({ data: spool });
});

app.get("/api/v1/jobs", async () => ({ data: await repository.listJobs() }));

app.post<{ Body: Partial<ProductionJob> }>("/api/v1/jobs", async (request, reply) => {
  const body = request.body;
  if (!body.printerId || !body.spoolId || !body.fileName || !isPositiveNumber(body.estimatedMaterialGrams)) {
    return reply.code(400).send({ error: "São obrigatórios a impressora, a bobine, o ficheiro e uma estimativa positiva de material." });
  }
  if (!await repository.getPrinter(body.printerId)) return reply.code(400).send({ error: "A impressora selecionada não existe." });
  if (body.projectId && !await repository.getProject(body.projectId)) return reply.code(400).send({ error: "A encomenda selecionada não existe." });
  try {
    const job = await repository.createJob({ id: body.id || randomUUID(), projectId: body.projectId, printerId: body.printerId, spoolId: body.spoolId, fileName: body.fileName, estimatedMaterialGrams: roundedEstimate(body.estimatedMaterialGrams)!, estimatedPrintMinutes: roundedEstimate(body.estimatedPrintMinutes) });
    return reply.code(201).send({ data: job });
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.post<{ Params: { id: string } }>("/api/v1/jobs/:id/start", async (request, reply) => {
  const job = await repository.getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: "Trabalho não encontrado." });
  const printer = await repository.getPrinter(job.printerId);
  if (!printer) return reply.code(409).send({ error: "A impressora associada a este trabalho já não existe." });
  const adapter = adapterFor(printer);
  if (!adapter) return reply.code(501).send({ error: unavailableProtocolMessage(printer.protocol) });
  try {
    const localFile = await gcodeLibrary.read(job.fileName);
    if (localFile) {
      if (!adapter.uploadGcode) return reply.code(501).send({ error: "Este controlador ainda não pode receber G-code da biblioteca local. Carregue primeiro o ficheiro na impressora." });
      await adapter.uploadGcode({ fileName: job.fileName, content: localFile.content });
    }
    await adapter.startJob({ printerId: printer.id, fileName: job.fileName, spoolId: job.spoolId });
    return { data: await repository.markJobPrinting(job.id) };
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.post<{ Params: { id: string } }>("/api/v1/jobs/:id/pause", async (request, reply) => {
  const job = await repository.getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: "Trabalho não encontrado." });
  if (job.state !== "printing") return reply.code(409).send({ error: "Só pode pausar um trabalho que esteja a imprimir." });
  const printer = await repository.getPrinter(job.printerId);
  if (!printer) return reply.code(409).send({ error: "A impressora associada a este trabalho já não existe." });
  const adapter = adapterFor(printer);
  if (!adapter) return reply.code(501).send({ error: unavailableProtocolMessage(printer.protocol) });
  try {
    await adapter.pauseJob(printer.id);
    return { data: await repository.markJobPaused(job.id) };
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.post<{ Params: { id: string } }>("/api/v1/jobs/:id/resume", async (request, reply) => {
  const job = await repository.getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: "Trabalho não encontrado." });
  if (job.state !== "paused") return reply.code(409).send({ error: "Só pode retomar um trabalho que esteja em pausa." });
  const printer = await repository.getPrinter(job.printerId);
  if (!printer) return reply.code(409).send({ error: "A impressora associada a este trabalho já não existe." });
  const adapter = adapterFor(printer);
  if (!adapter) return reply.code(501).send({ error: unavailableProtocolMessage(printer.protocol) });
  try {
    await adapter.resumeJob(printer.id);
    return { data: await repository.resumeJob(job.id) };
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.post<{ Params: { id: string }; Body: { actualMaterialGrams?: number; actualPrintMinutes?: number } }>("/api/v1/jobs/:id/complete", async (request, reply) => {
  try {
    const data = await repository.completeJob(request.params.id, request.body.actualMaterialGrams ?? 0, positiveNumber(request.body.actualPrintMinutes));
    return { data };
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.post<{ Params: { id: string }; Body: { actualMaterialGrams?: number; actualPrintMinutes?: number } }>("/api/v1/jobs/:id/cancel", async (request, reply) => {
  try {
    const job = await repository.getJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "Trabalho não encontrado." });
    const printer = await repository.getPrinter(job.printerId);
    const adapter = printer ? adapterFor(printer) : undefined;
    if (["printing", "paused"].includes(job.state) && adapter) {
      await adapter.cancelJob(printer!.id);
    }
    const data = await repository.cancelJob(request.params.id, request.body.actualMaterialGrams ?? 0, positiveNumber(request.body.actualPrintMinutes));
    return { data };
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.get("/api/v1/maintenance", async () => ({ data: await repository.listMaintenance() }));

app.post<{ Body: Partial<MaintenanceRecord> }>("/api/v1/maintenance", async (request, reply) => {
  const body = request.body;
  if (!body.printerId || !body.title?.trim()) return reply.code(400).send({ error: "São obrigatórios uma impressora e um título para a manutenção." });
  try {
    const record = await repository.createMaintenance({
      id: body.id || randomUUID(), printerId: body.printerId, title: body.title.trim(), notes: optionalText(body.notes), dueDate: validDate(body.dueDate),
      estimatedCost: positiveNumber(body.estimatedCost), state: "open", createdAt: new Date().toISOString()
    });
    return reply.code(201).send({ data: record });
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.post<{ Params: { id: string }; Body: { notes?: string; actualCost?: number } }>("/api/v1/maintenance/:id/complete", async (request, reply) => {
  try {
    return { data: await repository.completeMaintenance(request.params.id, optionalText(request.body.notes), positiveNumber(request.body.actualCost)) };
  } catch (error) {
    return domainReply(reply, error);
  }
});

app.get("/api/v1/reports/production", async () => {
  const [printers, spools, jobs, maintenance] = await Promise.all([repository.listPrinters(), repository.listSpools(), repository.listJobs(), repository.listMaintenance()]);
  const spoolById = new Map(spools.map((spool) => [spool.id, spool]));
  const printerById = new Map(printers.map((printer) => [printer.id, printer]));
  const completed = jobs.filter((job) => job.state === "completed");
  const metrics = completed.reduce((total, job) => {
    const spool = spoolById.get(job.spoolId);
    const printer = printerById.get(job.printerId);
    const grams = job.actualMaterialGrams ?? job.estimatedMaterialGrams;
    const minutes = job.actualPrintMinutes ?? job.estimatedPrintMinutes ?? 0;
    total.completedJobs += 1;
    total.materialGrams += grams;
    total.printMinutes += minutes;
    total.materialCost += grams / 1000 * Number(spool?.costPerKg ?? 0);
    total.machineCost += minutes / 60 * Number(printer?.profile?.costPerHour ?? 0);
    return total;
  }, { completedJobs: 0, materialGrams: 0, printMinutes: 0, materialCost: 0, machineCost: 0 });
  const lowStock = spools.filter((spool) => spool.initialWeightGrams > 0 && spool.remainingWeightGrams / spool.initialWeightGrams <= 0.15).map((spool) => ({ type: "low-stock", spoolId: spool.id, message: `${spool.brand} ${spool.material} ${spool.color} está abaixo de 15% de stock.` }));
  const overdueMaintenance = maintenance.filter((item) => item.state === "open" && item.dueDate && new Date(item.dueDate) <= new Date()).map((item) => ({ type: "maintenance", printerId: item.printerId, maintenanceId: item.id, message: `${item.title} está em atraso.` }));
  return { data: { ...metrics, totalCost: metrics.materialCost + metrics.machineCost, lowStock, overdueMaintenance } };
});

function publicPrinter(printer: PrinterConnection) {
  const { apiKey: _apiKey, username: _username, ...safePrinter } = printer;
  return safePrinter;
}

function adapterFor(printer: PrinterConnection): PrinterAdapter | undefined {
  switch (printer.protocol) {
    case "moonraker": return new MoonrakerAdapter(printer);
    case "octoprint": return new OctoPrintAdapter(printer);
    case "prusalink": return new PrusaLinkAdapter(printer);
    case "anycubic": return new AnycubicAdapter(printer);
    case "creality": return new CrealityAdapter(printer);
    default: return undefined;
  }
}

const protocolCatalog = [
  { id: "moonraker", label: "Moonraker / Klipper", support: "supported", capabilities: ["connection-test", "status", "upload", "start", "pause", "resume", "cancel"] },
  { id: "octoprint", label: "OctoPrint", support: "supported", capabilities: ["connection-test", "status", "upload", "start", "pause", "resume", "cancel"] },
  { id: "prusalink", label: "PrusaLink", support: "supported", capabilities: ["connection-test", "status", "upload", "start", "pause", "resume", "cancel"] },
  { id: "anycubic", label: "Anycubic LAN", support: "experimental", capabilities: ["connection-test", "status", "upload", "start", "cancel"] },
  { id: "creality", label: "Creality LAN", support: "experimental", capabilities: ["connection-test", "status", "upload", "start"] },
  { id: "bambu", label: "Bambu LAN", support: "experimental", capabilities: [] },
  { id: "generic", label: "Manual / genérico", support: "manual", capabilities: [] }
] as const;

function unavailableProtocolMessage(protocol: PrinterProtocol): string {
  if (protocol === "anycubic") return "O conector Anycubic LAN requer o modo LAN ativo na impressora.";
  if (protocol === "creality") return "O conector Creality LAN requer que o serviço local do Creality Print esteja ativo na impressora.";
  if (protocol === "bambu") return "O Bambu LAN é experimental: o fabricante não suporta o respetivo protocolo MQTT de terceiros. Configure-o apenas depois de validar um conector próprio com o firmware da sua impressora.";
  return "As impressoras manuais são registadas para inventário e planeamento, mas não disponibilizam controlo remoto através do Hub.";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function roundedEstimate(value: unknown): number | undefined {
  const number = positiveNumber(value);
  return number === undefined ? undefined : Math.max(1, Math.round(number));
}

function sanitizeAppearance(value: Partial<AppearanceSettings>, fallback: AppearanceSettings): AppearanceSettings | undefined {
  const fontScale = Number(value.fontScale ?? fallback.fontScale);
  const colorTheme = value.colorTheme ?? fallback.colorTheme;
  const accentColor = value.accentColor ?? fallback.accentColor;
  if (!Number.isFinite(fontScale) || fontScale < 0.85 || fontScale > 1.3) return undefined;
  if (!["midnight", "graphite", "light"].includes(colorTheme)) return undefined;
  if (!/^#[0-9a-f]{6}$/i.test(accentColor)) return undefined;
  return { fontScale, colorTheme, accentColor: accentColor.toLowerCase() };
}

function validDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function sanitizeProfile(value: unknown): PrinterProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const profile: PrinterProfile = {
    buildVolumeX: positiveNumber(input.buildVolumeX), buildVolumeY: positiveNumber(input.buildVolumeY), buildVolumeZ: positiveNumber(input.buildVolumeZ),
    nozzleDiameterMm: positiveNumber(input.nozzleDiameterMm), defaultSpeedMmPerS: positiveNumber(input.defaultSpeedMmPerS),
    costPerHour: positiveNumber(input.costPerHour), maintenanceIntervalHours: positiveNumber(input.maintenanceIntervalHours)
  };
  if (Array.isArray(input.allowedMaterials)) {
    const allowedMaterials = input.allowedMaterials.filter((material): material is MaterialType => typeof material === "string" && materials.includes(material as MaterialType));
    if (allowedMaterials.length) profile.allowedMaterials = [...new Set(allowedMaterials)];
  }
  return Object.values(profile).some((entry) => entry !== undefined) ? profile : undefined;
}

function sanitizeOrderItems(value: unknown): ProductionOrderItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((item): ProductionOrderItem[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    const partCode = optionalText(candidate.partCode);
    const quantity = Number(candidate.quantity);
    if (!partCode || !Number.isFinite(quantity) || quantity < 1) return [];
    const description = optionalText(candidate.description);
    return [{ partCode: partCode.slice(0, 100), quantity: Math.floor(quantity), description: description?.slice(0, 200) }];
  });
  return items.length ? items : undefined;
}

function sanitizeCustomerTemplate(value: unknown): CustomerOrderTemplate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = (value as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return undefined;
  const unique = new Map<CustomerOrderTemplateField["field"], CustomerOrderTemplateField>();
  for (const rawField of fields) {
    if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) continue;
    const field = rawField as Record<string, unknown>;
    const name = field.field;
    const page = Number(field.page);
    const leftPercent = Number(field.leftPercent);
    const topPercent = Number(field.topPercent);
    const widthPercent = Number(field.widthPercent);
    const heightPercent = Number(field.heightPercent);
    if (!["orderNumber", "partCode", "quantity"].includes(String(name)) || page !== 1) continue;
    if (![leftPercent, topPercent, widthPercent, heightPercent].every((number) => Number.isFinite(number) && number >= 0 && number <= 100)) continue;
    if (widthPercent < 1 || heightPercent < 1 || leftPercent + widthPercent > 100 || topPercent + heightPercent > 100) continue;
    unique.set(name as CustomerOrderTemplateField["field"], { field: name as CustomerOrderTemplateField["field"], page, leftPercent, topPercent, widthPercent, heightPercent });
  }
  return unique.size ? { fields: [...unique.values()] } : undefined;
}

function mergeCustomerTemplateDraft(base: PdfOrderDraft, template: PdfOrderDraft, customerName: string): PdfOrderDraft {
  const warnings = [...new Set([...template.warnings, ...base.warnings])];
  return {
    customer: customerName,
    orderNumber: template.orderNumber ?? base.orderNumber,
    // A template is more precise, but never replace a fuller generic extraction
    // with a partial model result.
    items: template.items.length >= base.items.length ? template.items : base.items,
    warnings
  };
}

function normalizeCustomerName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/gi, "").toLocaleLowerCase();
}

function orderDraftScore(draft: PdfOrderDraft): number {
  return Number(Boolean(draft.customer)) + Number(Boolean(draft.orderNumber)) + draft.items.length * 2;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidHttpUrl(value: unknown): value is string {
  try {
    const url = new URL(value as string);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

function domainReply(reply: { code(status: number): { send(body: unknown): unknown } }, error: unknown) {
  if (error instanceof DomainError) return reply.code(409).send({ error: error.message });
  return reply.code(502).send({ error: errorMessage(error) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Ocorreu um erro inesperado.";
}

return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createServer();
  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen({ host: "0.0.0.0", port });
}
