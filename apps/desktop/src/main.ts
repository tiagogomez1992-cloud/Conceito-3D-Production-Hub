import { app, BrowserWindow, dialog } from "electron";
import { createServer } from "@conceito/api";
import { join } from "node:path";

let api: Awaited<ReturnType<typeof createServer>> | undefined;

async function start() {
  await app.whenReady();

  process.env.STORAGE_DRIVER = "file";
  process.env.DATA_DIRECTORY = app.getPath("userData");
  api = await createServer();
  await api.listen({ host: "127.0.0.1", port: 3001 });

  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: "#0b1120",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  const webDirectory = app.isPackaged ? join(process.resourcesPath, "web") : join(app.getAppPath(), "..", "web", "dist");
  await window.loadFile(join(webDirectory, "index.html"));
}

app.on("before-quit", () => { void api?.close(); });
start().catch(async (error) => {
  await dialog.showMessageBox({ type: "error", title: "Centro de Produção", message: "Não foi possível iniciar a aplicação.", detail: error instanceof Error ? error.message : String(error) });
  app.quit();
});
