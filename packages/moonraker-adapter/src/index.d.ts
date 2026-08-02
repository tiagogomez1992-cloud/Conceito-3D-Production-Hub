import type { GcodeUpload, PrintJobRequest, PrinterAdapter, PrinterConnection, PrinterSummary } from "@conceito/core";
/** HTTP implementation for a Moonraker / Klipper printer. */
export declare class MoonrakerAdapter implements PrinterAdapter {
    private readonly connection;
    readonly protocol: "moonraker";
    readonly capabilities: readonly ["connection-test", "status", "upload", "start", "pause", "resume", "cancel"];
    constructor(connection: PrinterConnection);
    testConnection(): Promise<void>;
    getStatus(printerId: string): Promise<PrinterSummary>;
    startJob(request: PrintJobRequest): Promise<void>;
    uploadGcode(upload: GcodeUpload): Promise<void>;
    pauseJob(printerId: string): Promise<void>;
    resumeJob(printerId: string): Promise<void>;
    cancelJob(printerId: string): Promise<void>;
    private request;
    private assertPrinter;
}
