import type { MaterialType, Spool } from "@conceito/core";
import type { SpoolmanSettings } from "./settings-store.js";

type SpoolmanSpool = {
  id: number | string;
  remaining_weight?: number | null;
  used_weight?: number | null;
  filament?: {
    material?: string | null;
    weight?: number | null;
    color_hex?: string | null;
    name?: string | null;
    vendor?: { name?: string | null } | null;
  } | null;
};

/** Minimal, read-only Spoolman client. Usage remains authoritative in the Hub. */
export function createSpoolmanClient(settings: SpoolmanSettings) {
  const apiBaseUrl = spoolmanApiUrl(settings.url!);

  return {
    async testConnection() {
      await request<unknown>("/spool?limit=1");
    },

    async listSpools() {
      const data = await request<unknown>("/spool");
      if (!Array.isArray(data)) throw new Error("O Spoolman devolveu uma lista de bobines inesperada.");
      return data as SpoolmanSpool[];
    }
  };

  async function request<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}${path}`, {
        headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : undefined,
        signal: AbortSignal.timeout(8000)
      });
    } catch (error) {
      throw new Error(`Não foi possível contactar o Spoolman: ${error instanceof Error ? error.message : "erro de rede"}`);
    }
    if (!response.ok) throw new Error(`O Spoolman respondeu com o código HTTP ${response.status}.`);
    return response.json() as Promise<T>;
  }
}

export function spoolFromSpoolman(source: SpoolmanSpool, id: string): Spool {
  const declaredWeight = numberOrUndefined(source.filament?.weight);
  const remainingWeight = numberOrUndefined(source.remaining_weight);
  const usedWeight = numberOrUndefined(source.used_weight);
  const initialWeight = declaredWeight ?? Math.max(remainingWeight ?? 0, (remainingWeight ?? 0) + (usedWeight ?? 0), 1);
  const remaining = Math.min(initialWeight, Math.max(0, remainingWeight ?? initialWeight - (usedWeight ?? 0)));
  const colour = source.filament?.color_hex?.trim();
  return {
    id,
    externalId: String(source.id),
    brand: source.filament?.vendor?.name?.trim() || "Spoolman",
    material: materialFor(source.filament?.material),
    color: colour ? (colour.startsWith("#") ? colour : `#${colour}`) : source.filament?.name?.trim() || "Unknown",
    initialWeightGrams: initialWeight,
    remainingWeightGrams: remaining,
    reservedWeightGrams: 0
  };
}

function spoolmanApiUrl(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  url.pathname = `${path || ""}/api/v1`;
  return url.toString().replace(/\/$/, "");
}

function materialFor(value: string | null | undefined): MaterialType {
  const material = (value ?? "").trim().toUpperCase();
  if (material.startsWith("PETG") || material.startsWith("PET-G")) return "PETG";
  if (material.startsWith("PLA")) return "PLA";
  if (material.startsWith("ABS")) return "ABS";
  if (material.startsWith("ASA")) return "ASA";
  if (material.startsWith("TPU")) return "TPU";
  return "other";
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
