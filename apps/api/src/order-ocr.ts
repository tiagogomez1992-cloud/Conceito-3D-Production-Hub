import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { CustomerOrderTemplate, CustomerOrderTemplateField, ProductionOrderItem } from "@conceito/core";
import type { PdfOrderDraft } from "./order-pdf.js";
import { extractOrderDraftFromText } from "./order-pdf.js";

const execFile = promisify(execFileCallback);
const maximumPdfBytes = 12 * 1024 * 1024;

type OcrRectangle = { top: number; left: number; width: number; height: number };
type OcrWorker = {
  recognize(image: string, options?: { rectangle?: OcrRectangle }): Promise<{ data: { text: string } }>;
  terminate(): Promise<void>;
};

type OcrResources = { pdftoppmPath: string; tessdataPath?: string; moduleDirectory?: string; tesseractPath?: string };

/** Renders the first PDF page so an operator can label fields on a customer template. */
export async function renderOrderPdfPreview(base64: string): Promise<{ page: number; mimeType: "image/png"; contentBase64: string }> {
  const pdf = decodePdf(base64);
  const resources = await resolveOcrResources();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "conceito-3d-pdf-preview-"));
  try {
    const inputPath = join(temporaryDirectory, "modelo.pdf");
    const outputPrefix = join(temporaryDirectory, "pagina");
    await writeFile(inputPath, pdf);
    await execFile(resources.pdftoppmPath, ["-f", "1", "-l", "1", "-r", "140", "-png", "-singlefile", inputPath, outputPrefix], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const image = await readFile(`${outputPrefix}.png`);
    return { page: 1, mimeType: "image/png", contentBase64: image.toString("base64") };
  } catch (error) {
    throw new Error(`Não foi possível preparar a pré-visualização do PDF: ${error instanceof Error ? error.message : "erro desconhecido"}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Reads the first two pages of a scanned order using the bundled Portuguese OCR model. */
export async function extractOrderDraftWithOcr(base64: string): Promise<PdfOrderDraft> {
  const pdf = decodePdf(base64);
  const resources = await resolveOcrResources();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "conceito-3d-ocr-"));
  let worker: OcrWorker | undefined;
  try {
    const pages = await rasterizePdf(pdf, temporaryDirectory, resources, 2);
    worker = await createOcrWorker(resources);
    const text = (await Promise.all(pages.map(async (page) => (await worker!.recognize(page)).data.text))).join("\n");
    if (!text.trim()) throw new Error("O OCR não encontrou texto legível no PDF.");
    return extractOrderDraftFromText(text);
  } catch (error) {
    throw new Error(`Não foi possível executar o OCR local: ${error instanceof Error ? error.message : "erro desconhecido"}`);
  } finally {
    await worker?.terminate().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Reads only the areas selected on a customer sample PDF. Coordinates are stored
 * as percentages so the model continues to work when another PDF has a different
 * page size.
 */
export async function extractOrderDraftWithTemplate(base64: string, template: CustomerOrderTemplate): Promise<PdfOrderDraft> {
  const fields = template.fields.filter((field) => field.page === 1 && validTemplateField(field));
  if (!fields.length) throw new Error("O modelo deste cliente não tem campos válidos na primeira página.");

  const pdf = decodePdf(base64);
  const resources = await resolveOcrResources();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "conceito-3d-template-"));
  let worker: OcrWorker | undefined;
  try {
    const [page] = await rasterizePdf(pdf, temporaryDirectory, resources, 1);
    if (!page) throw new Error("O PDF não tem uma primeira página que possa ser lida.");
    const dimensions = pngDimensions(await readFile(page));
    worker = await createOcrWorker(resources);
    const fieldTexts = await Promise.all(fields.map(async (field) => ({
      field: field.field,
      text: (await worker!.recognize(page, { rectangle: percentageRectangle(field, dimensions) })).data.text
    })));
    return templateDraft(fieldTexts);
  } catch (error) {
    throw new Error(`Não foi possível aplicar o modelo de cliente: ${error instanceof Error ? error.message : "erro desconhecido"}`);
  } finally {
    await worker?.terminate().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function decodePdf(base64: string): Buffer {
  const pdf = Buffer.from(base64, "base64");
  if (pdf.length === 0 || pdf.length > maximumPdfBytes || !pdf.subarray(0, 8).toString("latin1").includes("%PDF-")) {
    throw new Error("O ficheiro enviado não é um PDF válido para OCR.");
  }
  return pdf;
}

async function rasterizePdf(pdf: Buffer, temporaryDirectory: string, resources: OcrResources, lastPage: number): Promise<string[]> {
  const inputPath = join(temporaryDirectory, "encomenda.pdf");
  const outputPrefix = join(temporaryDirectory, "pagina");
  await writeFile(inputPath, pdf);
  await execFile(resources.pdftoppmPath, ["-f", "1", "-l", String(lastPage), "-r", "200", "-png", inputPath, outputPrefix], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const pages = (await readdir(temporaryDirectory)).filter((name) => /^pagina-\d+\.png$/i.test(name)).sort();
  if (!pages.length) throw new Error("Não foi possível converter o PDF numa imagem para OCR.");
  return pages.map((page) => join(temporaryDirectory, page));
}

async function createOcrWorker(resources: OcrResources): Promise<OcrWorker> {
  if (resources.tesseractPath) {
    return {
      async recognize(image, options) {
        let target = image;
        let cropPath: string | undefined;
        try {
          if (options?.rectangle) {
            const box = options.rectangle;
            cropPath = join(dirname(image), `recorte-${randomUUID()}.png`);
            await execFile("convert", [image, "-crop", `${box.width}x${box.height}+${box.left}+${box.top}`, "+repage", cropPath], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
            target = cropPath;
          }
          const { stdout } = await execFile(resources.tesseractPath, [target, "stdout", "-l", "por"], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
          return { data: { text: stdout } };
        } finally {
          if (cropPath) await rm(cropPath, { force: true });
        }
      },
      async terminate() {}
    };
  }
  // Tesseract starts a worker process, therefore its package deliberately stays
  // outside app.asar in the portable Electron build.
  const requireOcr = createRequire(join(resources.moduleDirectory!, "tesseract.js", "package.json"));
  const { createWorker } = requireOcr("tesseract.js") as {
    createWorker: (language: string, oem: number, options: { langPath: string; cacheMethod: "none" }) => Promise<OcrWorker>;
  };
  return createWorker("por", 1, { langPath: resources.tessdataPath!, cacheMethod: "none" });
}

function templateDraft(fieldTexts: Array<{ field: CustomerOrderTemplateField["field"]; text: string }>): PdfOrderDraft {
  const textFor = (field: CustomerOrderTemplateField["field"]) => fieldTexts.filter((entry) => entry.field === field).map((entry) => entry.text).join("\n");
  const orderNumberText = textFor("orderNumber");
  const parsedOrderNumber = extractOrderDraftFromText(orderNumberText).orderNumber;
  const orderNumber = parsedOrderNumber ?? firstIdentifier(orderNumberText);
  const items = templateItems(textFor("partCode"), textFor("quantity"));
  const warnings: string[] = [];
  if (!orderNumber) warnings.push("Número de encomenda não identificado no campo assinalado.");
  if (!items.length) warnings.push("Não foram identificados códigos e quantidades no modelo do cliente.");
  return { orderNumber, items, warnings };
}

function templateItems(codesText: string, quantitiesText: string): ProductionOrderItem[] {
  // Tesseract occasionally returns a whole table column as a single line. Read
  // every token, not only the first match of each visual line.
  const ignoredLabels = new Set(["CODIGO", "CÓDIGO", "REF", "REFERENCIA", "REFERÊNCIA", "PECA", "PEÇA", "PART", "QUANTIDADE", "QTD", "QTY"]);
  const codes = uniqueInOrder((codesText.match(/[A-Z0-9][A-Z0-9._/-]*/gi) ?? [])
    .map((token) => token.replace(/^[._/-]+|[._/-]+$/g, "").toUpperCase())
    .filter((token) => token.length >= 2 && !ignoredLabels.has(token))
    .filter((token) => /[A-Z]/.test(token) && (/[0-9]/.test(token) || /[-_/.]/.test(token) || /^[A-Z]{2,}$/.test(token))));
  const quantities = (quantitiesText.match(/\d{1,6}/g) ?? []).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return codes.slice(0, quantities.length).map((partCode, index) => ({ partCode: normalizePartCode(partCode), quantity: quantities[index] }));
}

function normalizePartCode(value: string): string {
  // In a code column, OCR commonly reads a zero immediately next to a number
  // or a separator as the letter O (for example, TAMPA-O2 instead of TAMPA-02).
  return value.toUpperCase().replace(/(?<=[-_.])O(?=\d)/g, "0").replace(/(?<=\d)O(?=\d)/g, "0");
}

function firstIdentifier(text: string): string | undefined {
  const candidates = cleanLines(text).flatMap((line) => line.match(/[A-Z0-9][A-Z0-9._/-]{1,}/gi) ?? []);
  const likelyIdentifier = candidates.filter((candidate) => /\d/.test(candidate) || /[-_/.]/.test(candidate));
  return (likelyIdentifier.length ? likelyIdentifier : candidates).sort((left, right) => right.length - left.length)[0]?.toUpperCase();
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function cleanLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function percentageRectangle(field: CustomerOrderTemplateField, image: { width: number; height: number }): OcrRectangle {
  return {
    left: Math.max(0, Math.floor(image.width * field.leftPercent / 100)),
    top: Math.max(0, Math.floor(image.height * field.topPercent / 100)),
    width: Math.max(1, Math.ceil(image.width * field.widthPercent / 100)),
    height: Math.max(1, Math.ceil(image.height * field.heightPercent / 100))
  };
}

function pngDimensions(image: Buffer): { width: number; height: number } {
  if (image.subarray(1, 4).toString("ascii") !== "PNG" || image.length < 24) throw new Error("A pré-visualização não é uma imagem PNG válida.");
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

function validTemplateField(field: CustomerOrderTemplateField): boolean {
  return ["orderNumber", "partCode", "quantity"].includes(field.field)
    && Number.isInteger(field.page) && field.page === 1
    && [field.leftPercent, field.topPercent, field.widthPercent, field.heightPercent].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    && field.widthPercent >= 1 && field.heightPercent >= 1
    && field.leftPercent + field.widthPercent <= 100 && field.topPercent + field.heightPercent <= 100;
}

async function resolveOcrResources(): Promise<OcrResources> {
  const runtime = process as NodeJS.Process & { resourcesPath?: string };
  const root = process.env.OCR_RESOURCES_DIRECTORY
    ? resolve(process.env.OCR_RESOURCES_DIRECTORY)
    : runtime.resourcesPath ? join(runtime.resourcesPath, "ocr") : undefined;
  if (!root) throw new Error("Os componentes locais de OCR não estão disponíveis neste servidor. Defina OCR_RESOURCES_DIRECTORY.");
  if (!root && process.platform !== "win32") {
    return { pdftoppmPath: process.env.PDFTOPPM_PATH ?? "pdftoppm", tesseractPath: process.env.TESSERACT_PATH ?? "tesseract" };
  }
  const pdftoppmPath = join(root!, "poppler", process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm");
  const tessdataPath = join(root, "tessdata");
  const moduleDirectory = join(root, "node_modules");
  try {
    await Promise.all([
      access(pdftoppmPath),
      access(join(tessdataPath!, "por.traineddata.gz")),
      access(join(moduleDirectory!, "tesseract.js", "package.json"))
    ]);
  } catch {
    throw new Error("Os ficheiros locais de OCR em português não estão completos.");
  }
  return { pdftoppmPath, tessdataPath, moduleDirectory };
}
