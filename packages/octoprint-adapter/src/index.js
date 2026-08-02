/** HTTP adapter for any printer operated by an OctoPrint server. */
export class OctoPrintAdapter {
    connection;
    protocol = "octoprint";
    capabilities = ["connection-test", "status", "upload", "start", "pause", "resume", "cancel"];
    constructor(connection) {
        this.connection = connection;
        if (connection.protocol !== "octoprint")
            throw new Error("OctoPrintAdapter requires an OctoPrint printer connection.");
    }
    async testConnection() {
        await this.request("/api/version");
    }
    async getStatus(printerId) {
        this.assertPrinter(printerId);
        const [job, printer] = await Promise.all([
            this.request("/api/job"),
            this.request("/api/printer?history=false&limit=1")
        ]);
        return {
            id: this.connection.id,
            name: this.connection.name,
            protocol: this.protocol,
            state: toPrinterState(job.state),
            nozzleTemperature: printer.temperature?.tool0?.actual,
            bedTemperature: printer.temperature?.bed?.actual,
            progress: job.progress?.completion ?? undefined,
            jobName: job.job?.file?.name
        };
    }
    async startJob(request) {
        this.assertPrinter(request.printerId);
        await this.request(`/api/files/local/${encodeFilePath(request.fileName)}`, {
            method: "POST",
            body: JSON.stringify({ command: "select", print: true })
        });
    }
    async uploadGcode(upload) {
        const body = new FormData();
        body.set("file", new Blob([upload.content], { type: "text/plain" }), upload.fileName);
        await this.request("/api/files/local", { method: "POST", body });
    }
    async pauseJob(printerId) {
        this.assertPrinter(printerId);
        await this.jobCommand({ command: "pause", action: "pause" });
    }
    async resumeJob(printerId) {
        this.assertPrinter(printerId);
        await this.jobCommand({ command: "pause", action: "resume" });
    }
    async cancelJob(printerId) {
        this.assertPrinter(printerId);
        await this.jobCommand({ command: "cancel" });
    }
    async jobCommand(command) {
        await this.request("/api/job", { method: "POST", body: JSON.stringify(command) });
    }
    async request(path, init = {}) {
        if (!this.connection.apiKey)
            throw new Error("OctoPrint requires an API key with status, files and print permissions.");
        const headers = new Headers(init.headers);
        headers.set("X-Api-Key", this.connection.apiKey);
        headers.set("Accept", "application/json");
        if (init.body && !(init.body instanceof FormData))
            headers.set("Content-Type", "application/json");
        const response = await fetch(`${this.baseUrl()}${path}`, { ...init, headers });
        if (!response.ok)
            throw new Error(`OctoPrint request failed (${response.status} ${response.statusText}).`);
        if (response.status === 204)
            return undefined;
        return await response.json();
    }
    baseUrl() { return this.connection.baseUrl.replace(/\/$/, ""); }
    assertPrinter(printerId) {
        if (printerId !== this.connection.id)
            throw new Error("Printer id does not match this adapter.");
    }
}
function encodeFilePath(fileName) {
    return fileName.split("/").map(encodeURIComponent).join("/");
}
function toPrinterState(state) {
    switch (state?.toLowerCase()) {
        case "printing": return "printing";
        case "paused": return "paused";
        case "finishing":
        case "starting":
        case "pausing":
        case "cancelling": return "preparing";
        case "error":
        case "offline after error": return "error";
        case "offline":
        case "closed": return "offline";
        case "operational":
        case "ready": return "idle";
        default: return "offline";
    }
}
