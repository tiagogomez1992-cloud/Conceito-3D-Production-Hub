/** HTTP implementation for a Moonraker / Klipper printer. */
export class MoonrakerAdapter {
    connection;
    protocol = "moonraker";
    capabilities = ["connection-test", "status", "upload", "start", "pause", "resume", "cancel"];
    constructor(connection) {
        this.connection = connection;
        if (connection.protocol !== "moonraker") {
            throw new Error("MoonrakerAdapter requires a Moonraker printer connection.");
        }
    }
    async testConnection() {
        await this.request("/server/info");
    }
    async getStatus(printerId) {
        this.assertPrinter(printerId);
        const result = await this.request("/printer/objects/query?webhooks&print_stats&extruder&heater_bed&virtual_sdcard");
        const status = result.status;
        return {
            id: this.connection.id,
            name: this.connection.name,
            protocol: this.protocol,
            state: toPrinterState(status.webhooks?.state, status.print_stats?.state),
            nozzleTemperature: status.extruder?.temperature,
            bedTemperature: status.heater_bed?.temperature,
            progress: status.virtual_sdcard?.progress,
            jobName: status.print_stats?.filename
        };
    }
    async startJob(request) {
        this.assertPrinter(request.printerId);
        await this.request(`/printer/print/start?filename=${encodeURIComponent(request.fileName)}`, { method: "POST" });
    }
    async uploadGcode(upload) {
        const body = new FormData();
        body.set("file", new Blob([upload.content], { type: "text/plain" }), upload.fileName);
        await this.request("/server/files/upload", { method: "POST", body });
    }
    async pauseJob(printerId) {
        this.assertPrinter(printerId);
        await this.request("/printer/print/pause", { method: "POST" });
    }
    async resumeJob(printerId) {
        this.assertPrinter(printerId);
        await this.request("/printer/print/resume", { method: "POST" });
    }
    async cancelJob(printerId) {
        this.assertPrinter(printerId);
        await this.request("/printer/print/cancel", { method: "POST" });
    }
    async request(path, init = {}) {
        const headers = new Headers(init.headers);
        if (this.connection.apiKey)
            headers.set("X-Api-Key", this.connection.apiKey);
        const response = await fetch(`${this.connection.baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers });
        if (!response.ok)
            throw new Error(`Moonraker request failed (${response.status} ${response.statusText}).`);
        const body = (await response.json());
        return body.result;
    }
    assertPrinter(printerId) {
        if (printerId !== this.connection.id)
            throw new Error("Printer id does not match this adapter.");
    }
}
function toPrinterState(webhookState, printState) {
    if (webhookState !== "ready")
        return "offline";
    switch (printState) {
        case "printing": return "printing";
        case "paused": return "paused";
        case "complete": return "complete";
        case "error": return "error";
        default: return "idle";
    }
}
