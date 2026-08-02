import { createHash, randomBytes } from "node:crypto";
/** HTTP Digest implementation for PrusaLink's documented v1 local API. */
export class PrusaLinkAdapter {
    connection;
    protocol = "prusalink";
    capabilities = ["connection-test", "status", "start", "pause", "resume", "cancel"];
    constructor(connection) {
        this.connection = connection;
        if (connection.protocol !== "prusalink")
            throw new Error("PrusaLinkAdapter requires a PrusaLink printer connection.");
    }
    async testConnection() { await this.request("/api/version"); }
    async getStatus(printerId) {
        this.assertPrinter(printerId);
        const status = await this.status();
        return {
            id: this.connection.id,
            name: this.connection.name,
            protocol: this.protocol,
            state: toPrinterState(status.printer.state),
            nozzleTemperature: status.printer.temp_nozzle,
            bedTemperature: status.printer.temp_bed,
            progress: status.job?.progress
        };
    }
    async startJob(request) {
        this.assertPrinter(request.printerId);
        await this.request(`/api/v1/files/local/${encodeFilePath(request.fileName)}`, { method: "POST" });
    }
    async pauseJob(printerId) {
        this.assertPrinter(printerId);
        await this.request(`/api/v1/job/${await this.activeJobId()}/pause`, { method: "PUT" });
    }
    async resumeJob(printerId) {
        this.assertPrinter(printerId);
        await this.request(`/api/v1/job/${await this.activeJobId()}/resume`, { method: "PUT" });
    }
    async cancelJob(printerId) {
        this.assertPrinter(printerId);
        await this.request(`/api/v1/job/${await this.activeJobId()}`, { method: "DELETE" });
    }
    async activeJobId() {
        const id = (await this.status()).job?.id;
        if (typeof id !== "number")
            throw new Error("PrusaLink has no active job to control.");
        return id;
    }
    async status() { return this.request("/api/v1/status"); }
    async request(path, init = {}) {
        const { username, apiKey: password } = this.connection;
        if (!username || !password)
            throw new Error("PrusaLink requires a username and password/API key for HTTP Digest authentication.");
        const url = new URL(path, `${this.connection.baseUrl.replace(/\/$/, "")}/`);
        const headers = new Headers(init.headers);
        headers.set("Accept", "application/json");
        let response = await fetch(url, { ...init, headers });
        if (response.status === 401) {
            const challenge = response.headers.get("www-authenticate");
            if (!challenge)
                throw new Error("PrusaLink requested authentication without an HTTP Digest challenge.");
            headers.set("Authorization", createDigestAuthorization(challenge, username, password, init.method ?? "GET", `${url.pathname}${url.search}`));
            response = await fetch(url, { ...init, headers });
        }
        if (!response.ok)
            throw new Error(`PrusaLink request failed (${response.status} ${response.statusText}).`);
        if (response.status === 204)
            return undefined;
        return await response.json();
    }
    assertPrinter(printerId) {
        if (printerId !== this.connection.id)
            throw new Error("Printer id does not match this adapter.");
    }
}
function createDigestAuthorization(challenge, username, password, method, uri) {
    const parameters = Object.fromEntries([...challenge.matchAll(/([a-zA-Z]+)=(?:"([^"]*)"|([^,\s]+))/g)].map((match) => [match[1].toLowerCase(), match[2] ?? match[3]]));
    if (!/^Digest\s/i.test(challenge) || !parameters.realm || !parameters.nonce)
        throw new Error("PrusaLink returned an unsupported HTTP authentication challenge.");
    if (parameters.algorithm && parameters.algorithm.toUpperCase() !== "MD5")
        throw new Error(`Unsupported PrusaLink Digest algorithm: ${parameters.algorithm}.`);
    const qop = parameters.qop?.split(",").map((value) => value.trim()).find((value) => value === "auth");
    if (parameters.qop && !qop)
        throw new Error("PrusaLink Digest authentication does not offer qop=auth.");
    const cnonce = randomBytes(12).toString("hex");
    const nc = "00000001";
    const ha1 = md5(`${username}:${parameters.realm}:${password}`);
    const ha2 = md5(`${method.toUpperCase()}:${uri}`);
    const response = qop ? md5(`${ha1}:${parameters.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${parameters.nonce}:${ha2}`);
    const fields = [
        `username="${quote(username)}"`, `realm="${quote(parameters.realm)}"`, `nonce="${quote(parameters.nonce)}"`, `uri="${quote(uri)}"`,
        `response="${response}"`, `algorithm=MD5`
    ];
    if (parameters.opaque)
        fields.push(`opaque="${quote(parameters.opaque)}"`);
    if (qop)
        fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    return `Digest ${fields.join(", ")}`;
}
function md5(value) { return createHash("md5").update(value).digest("hex"); }
function quote(value) { return value.replace(/([\\"])/g, "\\$1"); }
function encodeFilePath(fileName) { return fileName.split("/").map(encodeURIComponent).join("/"); }
function toPrinterState(state) {
    switch (state) {
        case "PRINTING": return "printing";
        case "PAUSED": return "paused";
        case "FINISHED": return "complete";
        case "BUSY":
        case "ATTENTION": return "preparing";
        case "ERROR":
        case "STOPPED": return "error";
        case "IDLE":
        case "READY": return "idle";
        default: return "offline";
    }
}
