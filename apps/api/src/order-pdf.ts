import { inflateSync } from "node:zlib";
import type { ProductionOrderItem } from "@conceito/core";

const maximumPdfBytes = 12 * 1024 * 1024;

export type PdfOrderDraft = {
  customer?: string;
  orderNumber?: string;
  items: ProductionOrderItem[];
  warnings: string[];
};

/**
 * Extracts the text layer from ordinary, non-encrypted PDFs. This deliberately
 * stays dependency-free so the portable Windows application remains self-contained.
 * It is intended for order PDFs with selectable text, not scanned documents.
 */
export function extractOrderDraftFromPdf(base64: string): PdfOrderDraft {
  const text = extractPdfTextFromPdfBase64(base64);
  if (!text.trim()) throw new Error("Não foi possível ler texto neste PDF.");
  return extractOrderDraftFromText(text);
}

export function extractPdfTextFromPdfBase64(base64: string): string {
  if (!base64 || base64.length > Math.ceil(maximumPdfBytes * 4 / 3) + 8) {
    throw new Error("O PDF excede o limite de 12 MB.");
  }
  const document = Buffer.from(base64, "base64");
  if (document.length === 0 || document.length > maximumPdfBytes) throw new Error("O PDF excede o limite de 12 MB.");
  if (!document.subarray(0, 8).toString("latin1").includes("%PDF-")) throw new Error("O ficheiro enviado não é um PDF válido.");
  return extractPdfText(document);
}

export function extractOrderDraftFromText(text: string): PdfOrderDraft {
  const customer = matchField(text, [
    /(?:cliente|customer|empresa|destinat[aá]rio)\s*(?:n[.ºo°]*)?\s*[:#-]\s*([^\n\r]{2,100})/i
  ]);
  const orderNumber = matchField(text, [
    /(?:n[.ºo°]*\s*)?(?:de\s*)?encomenda\s*[:#-]\s*([a-z0-9][a-z0-9./_-]{1,})/i,
    /(?:order\s*(?:number|no\.?))\s*[:#-]\s*([a-z0-9][a-z0-9./_-]{1,})/i
  ]);
  const items = extractItems(text);
  const warnings: string[] = [];
  if (!customer) warnings.push("Cliente não identificado automaticamente.");
  if (!orderNumber) warnings.push("Número de encomenda não identificado automaticamente.");
  if (!items.length) warnings.push("Não foram identificados códigos de peça e quantidades. Preencha-os manualmente.");
  return { customer, orderNumber, items, warnings };
}

function extractPdfText(document: Buffer): string {
  const source = document.toString("latin1");
  const streams: string[] = [];
  const streamPattern = /<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of source.matchAll(streamPattern)) {
    const dictionary = match[1];
    const raw = Buffer.from(match[2], "latin1");
    try {
      const content = /\/FlateDecode\b/.test(dictionary) ? inflateSync(raw) : raw;
      streams.push(content.toString("latin1"));
    } catch {
      // A malformed or image-only stream is ignored; other text streams can still be used.
    }
  }
  return streams.map(extractTextOperators).filter(Boolean).join("\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function extractTextOperators(content: string): string {
  const lines: string[] = [];
  let index = 0;
  while (index < content.length) {
    const character = content[index];
    if (character === "(") {
      const parsed = readLiteralString(content, index);
      const operator = content.slice(parsed.end).match(/^\s*(?:Tj|'|")/);
      if (operator) {
        lines.push(parsed.value);
        index = parsed.end + operator[0].length;
        continue;
      }
      index = parsed.end;
      continue;
    }
    if (character === "[") {
      const end = content.indexOf("]", index + 1);
      if (end !== -1 && /^\s*TJ\b/.test(content.slice(end + 1))) {
        lines.push(extractArrayStrings(content.slice(index + 1, end)));
        index = end + 3;
        continue;
      }
    }
    if (character === "<" && content[index + 1] !== "<") {
      const end = content.indexOf(">", index + 1);
      if (end !== -1 && /^\s*Tj\b/.test(content.slice(end + 1))) {
        lines.push(decodeHexString(content.slice(index + 1, end)));
        index = end + 3;
        continue;
      }
    }
    index += 1;
  }
  return lines.map(cleanText).filter(Boolean).join("\n");
}

function extractArrayStrings(content: string): string {
  const values: string[] = [];
  let index = 0;
  while (index < content.length) {
    if (content[index] === "(") {
      const parsed = readLiteralString(content, index);
      values.push(parsed.value);
      index = parsed.end;
      continue;
    }
    if (content[index] === "<" && content[index + 1] !== "<") {
      const end = content.indexOf(">", index + 1);
      if (end !== -1) {
        values.push(decodeHexString(content.slice(index + 1, end)));
        index = end + 1;
        continue;
      }
    }
    index += 1;
  }
  return values.join(" ");
}

function readLiteralString(content: string, start: number): { value: string; end: number } {
  let depth = 1;
  let index = start + 1;
  let value = "";
  while (index < content.length && depth > 0) {
    const character = content[index++];
    if (character === "\\") {
      const escaped = content[index++] ?? "";
      if (/[0-7]/.test(escaped)) {
        let octal = escaped;
        while (octal.length < 3 && /[0-7]/.test(content[index] ?? "")) octal += content[index++];
        value += String.fromCharCode(parseInt(octal, 8));
      } else {
        value += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[escaped] ?? escaped;
      }
      continue;
    }
    if (character === "(") { depth += 1; value += character; continue; }
    if (character === ")") { depth -= 1; if (depth > 0) value += character; continue; }
    value += character;
  }
  return { value, end: index };
}

function decodeHexString(value: string): string {
  const bytes = Buffer.from(value.replace(/\s/g, ""), "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let result = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) result += String.fromCharCode(bytes.readUInt16BE(index));
    return result;
  }
  return bytes.toString("latin1");
}

function matchField(text: string, expressions: RegExp[]): string | undefined {
  for (const expression of expressions) {
    const match = expression.exec(text);
    const value = cleanText(match?.[1] ?? "").replace(/\s+(?:quantidade|qtd\.?|c[oó]digo|ref(?:er[eê]ncia)?).*$/i, "").trim();
    if (value) return value.slice(0, 100);
  }
  return undefined;
}

function extractItems(text: string): ProductionOrderItem[] {
  const items = new Map<string, ProductionOrderItem>();
  const lines = text.split(/\r?\n/).map(cleanText).filter(Boolean);
  for (const line of lines) {
    const codeFirst = /(?:c[oó]d(?:igo)?|ref(?:er[eê]ncia)?|pe[cç]a|part(?:e)?)\s*[:#-]?\s*([a-z0-9][a-z0-9._/-]{1,})\D{0,36}?(?:qtd\.?|quantidade|qty|quant\.)\s*[:#-]?\s*(\d{1,6})\b/i.exec(line);
    const quantityFirst = /(?:qtd\.?|quantidade|qty|quant\.)\s*[:#-]?\s*(\d{1,6})\D{0,36}?(?:c[oó]d(?:igo)?|ref(?:er[eê]ncia)?|pe[cç]a|part(?:e)?)\s*[:#-]?\s*([a-z0-9][a-z0-9._/-]{1,})\b/i.exec(line);
    let code: string | undefined;
    let quantity: number | undefined;
    if (codeFirst) {
      code = codeFirst[1]; quantity = Number(codeFirst[2]);
    } else if (quantityFirst) {
      quantity = Number(quantityFirst[1]); code = quantityFirst[2];
    } else {
      const table = /^([a-z][a-z0-9._/-]{1,})\s*(?:[|;×x]|\s{2,})\s*(\d{1,6})\b/i.exec(line);
      if (table) { code = table[1]; quantity = Number(table[2]); }
    }
    if (!code || !quantity || quantity < 1) continue;
    const partCode = code.toUpperCase();
    const existing = items.get(partCode);
    items.set(partCode, { partCode, quantity: (existing?.quantity ?? 0) + quantity });
  }
  return [...items.values()];
}

function cleanText(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
}
