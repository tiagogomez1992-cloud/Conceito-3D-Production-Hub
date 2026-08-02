import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GcodeEstimateSource, GcodeFile, GcodeThumbnail } from "@conceito/core";

type StoredGcode = Record<string, GcodeFile>;

/** Small local G-code library shared by the desktop and server deployments. */
export function createGcodeLibrary(dataDirectory: string) {
  const directory = join(dataDirectory, "gcode");
  const manifestPath = join(directory, "library.json");
  let manifest: StoredGcode = {};

  return {
    async initialise() {
      await mkdir(directory, { recursive: true });
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8")) as StoredGcode;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await persist();
      }
    },

    async list(): Promise<GcodeFile[]> {
      const files = new Set(await readdir(directory));
      let manifestChanged = false;
      const available = await Promise.all(Object.values(manifest).map(async (entry) => {
        if (!files.has(entry.fileName)) return undefined;
        if (roundStoredEstimates(entry)) manifestChanged = true;
        const details = await stat(pathFor(entry.fileName));
        if (!entry.thumbnailChecked) {
          const thumbnail = extractThumbnail(await readFile(pathFor(entry.fileName), "utf8"));
          if (thumbnail) {
            await writeFile(thumbnailPathFor(entry.fileName), thumbnail.data);
            entry.thumbnail = thumbnail.metadata;
          }
          entry.thumbnailChecked = true;
          manifestChanged = true;
        }
        return { ...entry, sizeBytes: details.size };
      }));
      if (manifestChanged) await persist();
      return available.filter((entry): entry is GcodeFile => Boolean(entry)).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    },

    async save(input: { fileName: string; content: string; estimatedMaterialGrams?: number; estimatedPrintMinutes?: number }): Promise<GcodeFile> {
      const fileName = safeFileName(input.fileName);
      const content = input.content.replace(/\r\n/g, "\n");
      const sizeBytes = Buffer.byteLength(content, "utf8");
      if (sizeBytes === 0) throw new Error("O ficheiro G-code está vazio.");
      if (sizeBytes > 30 * 1024 * 1024) throw new Error("O ficheiro G-code excede o limite de 30 MB da biblioteca local.");
      await writeFile(pathFor(fileName), content, "utf8");
      const thumbnail = extractThumbnail(content);
      if (thumbnail) await writeFile(thumbnailPathFor(fileName), thumbnail.data);
      else await removeThumbnail(fileName);
      const extracted = extractGcodeEstimates(content);
      const manualMaterial = positive(input.estimatedMaterialGrams);
      const manualTime = positive(input.estimatedPrintMinutes);
      const material = roundEstimate(extracted.material ?? estimateFromManual(manualMaterial));
      const time = roundEstimate(extracted.time ?? estimateFromManual(manualTime));
      const entry: GcodeFile = {
        fileName, sizeBytes, uploadedAt: new Date().toISOString(),
        estimatedMaterialGrams: material?.value, estimatedMaterialSource: material?.source,
        estimatedPrintMinutes: time?.value, estimatedPrintTimeSource: time?.source, thumbnail: thumbnail?.metadata, thumbnailChecked: true
      };
      manifest[fileName] = entry;
      await persist();
      return entry;
    },

    async read(fileName: string): Promise<{ metadata: GcodeFile; content: string } | undefined> {
      const safeName = safeFileName(fileName);
      const metadata = manifest[safeName];
      if (!metadata) return undefined;
      try {
        const content = await readFile(pathFor(safeName), "utf8");
        return { metadata: { ...metadata, sizeBytes: Buffer.byteLength(content, "utf8") }, content };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },

    async readThumbnail(fileName: string): Promise<{ metadata: GcodeThumbnail; data: Buffer } | undefined> {
      const safeName = safeFileName(fileName);
      const metadata = manifest[safeName]?.thumbnail;
      if (!metadata) return undefined;
      try {
        return { metadata, data: await readFile(thumbnailPathFor(safeName)) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },

    async remove(fileName: string): Promise<void> {
      const safeName = safeFileName(fileName);
      if (!manifest[safeName]) throw new Error("Ficheiro G-code não encontrado.");
      await unlink(pathFor(safeName));
      await removeThumbnail(safeName);
      delete manifest[safeName];
      await persist();
    }
  };

  function pathFor(fileName: string) { return join(directory, fileName); }
  function thumbnailPathFor(fileName: string) { return join(directory, `${fileName}.thumbnail`); }
  async function removeThumbnail(fileName: string) {
    try { await unlink(thumbnailPathFor(fileName)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async function persist() {
    const temporaryPath = `${manifestPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(manifest, null, 2), "utf8");
    await rename(temporaryPath, manifestPath);
  }
}

function safeFileName(value: string): string {
  const fileName = value.trim().replace(/\\/g, "/").split("/").pop() ?? "";
  if (!/\.(gcode|gco|gc|g)$/i.test(fileName)) throw new Error("Use um ficheiro G-code de texto terminado em .gcode, .gco, .gc ou .g. Os ficheiros .3mf e .bgcode têm de ser exportados primeiro como .gcode simples.");
  if (fileName.length > 180 || /[<>:"/\\|?*\u0000-\u001F]/.test(fileName) || /[. ]$/.test(fileName)) {
    throw new Error("O nome do ficheiro G-code contém caracteres que o Windows não pode guardar.");
  }
  const baseName = fileName.replace(/\.[^.]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(baseName)) throw new Error("Escolha outro nome para o ficheiro G-code; este nome é reservado pelo Windows.");
  return fileName;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

type ExtractedThumbnail = { metadata: GcodeThumbnail; data: Buffer };

/** Reads the standard thumbnail blocks written by PrusaSlicer, OrcaSlicer and Bambu Studio. */
function extractThumbnail(content: string): ExtractedThumbnail | undefined {
  let preferred: ExtractedThumbnail | undefined;
  const blocks = content.matchAll(/^\s*;\s*thumbnail begin\s+(\d+)x(\d+)(?:\s+\d+)?\s*$([\s\S]*?)^\s*;\s*thumbnail end\s*$/gim);
  for (const block of blocks) {
    const width = Number(block[1]); const height = Number(block[2]);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) continue;
    const base64 = block[3].split(/\r?\n/).map((line) => line.replace(/^\s*;\s?/, "").trim()).join("");
    if (!base64 || base64.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) continue;
    const data = Buffer.from(base64, "base64");
    const mimeType = imageMimeType(data);
    if (!mimeType || data.length > 2 * 1024 * 1024) continue;
    const candidate: ExtractedThumbnail = { metadata: { width, height, mimeType }, data };
    if (!preferred || width * height > preferred.metadata.width * preferred.metadata.height) preferred = candidate;
  }
  return preferred;
}

function imageMimeType(data: Buffer): GcodeThumbnail["mimeType"] | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  return undefined;
}

type Estimate = { value: number; source: GcodeEstimateSource };

function roundEstimate(estimate: Estimate | undefined): Estimate | undefined {
  if (!estimate) return undefined;
  return { ...estimate, value: Math.max(1, Math.round(estimate.value)) };
}

function roundStoredEstimates(entry: GcodeFile): boolean {
  let changed = false;
  if (entry.estimatedMaterialGrams) {
    const rounded = Math.max(1, Math.round(entry.estimatedMaterialGrams));
    if (rounded !== entry.estimatedMaterialGrams) { entry.estimatedMaterialGrams = rounded; changed = true; }
  }
  if (entry.estimatedPrintMinutes) {
    const rounded = Math.max(1, Math.round(entry.estimatedPrintMinutes));
    if (rounded !== entry.estimatedPrintMinutes) { entry.estimatedPrintMinutes = rounded; changed = true; }
  }
  return changed;
}

/**
 * Reads common slicer metadata first. If it is absent, estimates material from
 * extrusion distance (1.75 mm PLA defaults) and time from linear G0/G1 moves.
 */
export function extractGcodeEstimates(content: string): { material?: Estimate; time?: Estimate } {
  const slicerMaterial = slicerMaterialGrams(content);
  const slicerTime = slicerPrintMinutes(content);
  const calculated = (!slicerMaterial || !slicerTime) ? calculateFromMoves(content) : undefined;
  return {
    material: slicerMaterial ? { value: slicerMaterial, source: "slicer" } : calculated?.materialGrams ? { value: calculated.materialGrams, source: "calculated" } : undefined,
    time: slicerTime ? { value: slicerTime, source: "slicer" } : calculated?.printMinutes ? { value: calculated.printMinutes, source: "calculated" } : undefined
  };
}

function estimateFromManual(value: number | undefined): Estimate | undefined {
  return value ? { value, source: "manual" } : undefined;
}

function slicerMaterialGrams(content: string): number | undefined {
  const matches = [...content.matchAll(/(?:total\s+)?filament\s+used\s*\[\s*g\s*\]\s*[:=]\s*([0-9]+(?:[.,][0-9]+)?)/gi)];
  if (!matches.length) return undefined;
  const value = Number(matches[matches.length - 1][1].replace(",", "."));
  return positive(value);
}

function slicerPrintMinutes(content: string): number | undefined {
  const curaSeconds = /^\s*;\s*TIME\s*:\s*([0-9]+(?:\.\d+)?)\s*$/im.exec(content);
  if (curaSeconds) return positive(Number(curaSeconds[1]) / 60);
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!/estimated\s+(?:printing\s+)?time|estimated\s+printing\s+time|print\s+time/i.test(line)) continue;
    const value = line.split(/[:=]/).slice(1).join("=").trim();
    const minutes = durationInMinutes(value);
    if (minutes) return minutes;
  }
  return undefined;
}

function durationInMinutes(value: string): number | undefined {
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(value.trim());
  if (clock) return positive(((Number(clock[1] ?? 0) * 60 + Number(clock[2])) * 60 + Number(clock[3])) / 60);
  let seconds = 0;
  for (const match of value.matchAll(/([0-9]+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
    const quantity = Number(match[1]); const unit = match[2].toLowerCase();
    seconds += quantity * (unit.startsWith("d") ? 86400 : unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1);
  }
  return positive(seconds / 60);
}

function calculateFromMoves(content: string): { materialGrams?: number; printMinutes?: number } {
  let x = 0; let y = 0; let z = 0; let e = 0; let feedrate = 0; let filamentDiameter = 1.75;
  let absoluteXYZ = true; let absoluteE = true; let extrusionMillimetres = 0; let printSeconds = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split(";")[0].trim().toUpperCase();
    if (!line) continue;
    if (/^(?:N\d+\s*)?G90\b/.test(line)) { absoluteXYZ = true; continue; }
    if (/^(?:N\d+\s*)?G91\b/.test(line)) { absoluteXYZ = false; continue; }
    if (/^(?:N\d+\s*)?M82\b/.test(line)) { absoluteE = true; continue; }
    if (/^(?:N\d+\s*)?M83\b/.test(line)) { absoluteE = false; continue; }
    const m200 = /^(?:N\d+\s*)?M200\b.*\bD([0-9]+(?:\.\d+)?)/.exec(line);
    if (m200) { filamentDiameter = Number(m200[1]); continue; }
    const values = coordinates(line);
    if (/^(?:N\d+\s*)?G92\b/.test(line)) {
      if (values.X !== undefined) x = values.X; if (values.Y !== undefined) y = values.Y; if (values.Z !== undefined) z = values.Z; if (values.E !== undefined) e = values.E;
      continue;
    }
    if (/^(?:N\d+\s*)?G4\b/.test(line)) {
      printSeconds += (values.S ?? 0) + (values.P ?? 0) / 1000;
      continue;
    }
    if (!/(?:^|\s)G0?[01]\b/.test(line)) continue;
    const nextX = values.X === undefined ? x : (absoluteXYZ ? values.X : x + values.X);
    const nextY = values.Y === undefined ? y : (absoluteXYZ ? values.Y : y + values.Y);
    const nextZ = values.Z === undefined ? z : (absoluteXYZ ? values.Z : z + values.Z);
    const nextE = values.E === undefined ? e : (absoluteE ? values.E : e + values.E);
    feedrate = values.F ?? feedrate;
    const distance = Math.hypot(nextX - x, nextY - y, nextZ - z);
    if (distance > 0 && feedrate > 0) printSeconds += distance / (feedrate / 60);
    extrusionMillimetres += Math.max(0, nextE - e);
    x = nextX; y = nextY; z = nextZ; e = nextE;
  }
  const area = Math.PI * (filamentDiameter / 2) ** 2;
  const materialGrams = positive(extrusionMillimetres * area / 1000 * 1.24);
  return { materialGrams, printMinutes: positive(printSeconds / 60) };
}

function coordinates(line: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const match of line.matchAll(/([XYZEFSP])([-+]?(?:\d+(?:\.\d*)?|\.\d+))/g)) values[match[1]] = Number(match[2]);
  return values;
}
