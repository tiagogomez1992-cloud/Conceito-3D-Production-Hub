import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SpoolmanSettings = {
  url?: string;
  apiKey?: string;
};

export type AppearanceSettings = {
  fontScale: number;
  colorTheme: "midnight" | "graphite" | "light";
  accentColor: string;
};

const defaultAppearance: AppearanceSettings = { fontScale: 1, colorTheme: "midnight", accentColor: "#2950c8" };

type StoredSettings = { spoolman?: SpoolmanSettings; appearance?: Partial<AppearanceSettings> };

/** Keeps integration credentials outside the production export and API responses. */
export function createSettingsStore(dataDirectory: string) {
  const filePath = join(dataDirectory, "hub-settings.json");
  let settings: StoredSettings = {};

  return {
    async initialise() {
      await mkdir(dirname(filePath), { recursive: true });
      try {
        settings = JSON.parse(await readFile(filePath, "utf8")) as StoredSettings;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await persist();
      }
    },

    getSpoolman() {
      const spoolman = settings.spoolman;
      return { url: spoolman?.url, configured: Boolean(spoolman?.url) };
    },

    getSpoolmanSecret(): SpoolmanSettings | undefined {
      return settings.spoolman?.url ? { ...settings.spoolman } : undefined;
    },

    getAppearance(): AppearanceSettings {
      const appearance = settings.appearance;
      return {
        fontScale: typeof appearance?.fontScale === "number" && appearance.fontScale >= 0.85 && appearance.fontScale <= 1.3 ? appearance.fontScale : defaultAppearance.fontScale,
        colorTheme: appearance?.colorTheme === "graphite" || appearance?.colorTheme === "light" || appearance?.colorTheme === "midnight" ? appearance.colorTheme : defaultAppearance.colorTheme,
        accentColor: /^#[0-9a-f]{6}$/i.test(appearance?.accentColor ?? "") ? appearance!.accentColor! : defaultAppearance.accentColor
      };
    },

    async setAppearance(appearance: AppearanceSettings) {
      settings.appearance = { ...appearance };
      await persist();
      return this.getAppearance();
    },

    async setSpoolman(spoolman?: SpoolmanSettings) {
      settings.spoolman = spoolman?.url ? { ...spoolman } : undefined;
      await persist();
      return this.getSpoolman();
    }
  };

  async function persist() {
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(settings, null, 2), "utf8");
    await rename(temporaryPath, filePath);
  }
}
