import type { PrintJobRequest, PrinterAdapter, PrinterConnection, PrinterSummary } from "@conceito/core";
/** HTTP Digest implementation for PrusaLink's documented v1 local API. */
export declare class PrusaLinkAdapter implements PrinterAdapter {
    private readonly connection;
    readonly protocol: "prusalink";
    readonly capabilities: readonly ["connection-test", "status", "start", "pause", "resume", "cancel"];
    constructor(connection: PrinterConnection);
    testConnection(): Promise<void>;
    getStatus(printerId: string): Promise<PrinterSummary>;
    startJob(request: PrintJobRequest): Promise<void>;
    pauseJob(printerId: string): Promise<void>;
    resumeJob(printerId: string): Promise<void>;
    cancelJob(printerId: string): Promise<void>;
    private activeJobId;
    private status;
    private request;
    private assertPrinter;
}
