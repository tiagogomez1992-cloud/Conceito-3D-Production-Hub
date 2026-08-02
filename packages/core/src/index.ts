/**
 * A protocol, rather than a printer brand. A Creality, Elegoo or Qidi machine
 * running Klipper is therefore configured as `moonraker`, for example.
 */
export type PrinterProtocol = "moonraker" | "octoprint" | "prusalink" | "anycubic" | "creality" | "bambu" | "generic";

export type PrinterCapability = "connection-test" | "status" | "upload" | "start" | "pause" | "resume" | "cancel";

export type PrinterState =
  | "offline"
  | "idle"
  | "preparing"
  | "printing"
  | "paused"
  | "complete"
  | "error";

export interface PrinterSummary {
  id: string;
  name: string;
  protocol: PrinterProtocol;
  state: PrinterState;
  nozzleTemperature?: number;
  bedTemperature?: number;
  /** Material reported as currently loaded by the printer, when available. */
  loadedMaterial?: string;
  progress?: number;
  jobName?: string;
}

/** Operational settings that are specific to a physical printer. */
export interface PrinterProfile {
  buildVolumeX?: number;
  buildVolumeY?: number;
  buildVolumeZ?: number;
  nozzleDiameterMm?: number;
  allowedMaterials?: MaterialType[];
  defaultSpeedMmPerS?: number;
  costPerHour?: number;
  maintenanceIntervalHours?: number;
}

export interface PrinterConnection {
  id: string;
  name: string;
  /** Commercial manufacturer selected from the printer catalogue, if known. */
  manufacturer?: string;
  /** Commercial model selected from the printer catalogue, if known. */
  model?: string;
  /** Production and maintenance settings configured by the operator. */
  profile?: PrinterProfile;
  protocol: PrinterProtocol;
  /** Local URL of the printer API, for example http://192.168.1.50:7125. */
  baseUrl: string;
  /** Kept server-side only; never returned by the API. Dedicated adapters may store an opaque connection secret here. */
  apiKey?: string;
  /**
   * Kept server-side only. Required by PrusaLink's HTTP Digest authentication.
   * Other HTTP adapters normally use only `apiKey`.
   */
  username?: string;
  /**
   * Vendor device identifier. Reserved for dedicated integrations such as
   * Bambu LAN, where a hostname alone is not enough to address MQTT topics.
   */
  deviceId?: string;
}

export interface PrintJobRequest {
  printerId: string;
  fileName: string;
  spoolId?: string;
}

export interface GcodeUpload {
  fileName: string;
  content: string;
}

export type MaterialType = "PLA" | "PETG" | "ABS" | "ASA" | "TPU" | "other";

export interface Spool {
  id: string;
  /** Identifier assigned by an external spool system such as Spoolman. */
  externalId?: string;
  brand: string;
  material: MaterialType;
  color: string;
  initialWeightGrams: number;
  remainingWeightGrams: number;
  reservedWeightGrams: number;
  /** Purchase cost per kilogram, used for production-cost estimates. */
  costPerKg?: number;
}

export type ProductionJobState =
  | "queued"
  | "reserved"
  | "printing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type ProductionProjectState = "active" | "archived";

/** A part and its requested quantity within a customer order. */
export interface ProductionOrderItem {
  partCode: string;
  quantity: number;
  description?: string;
}

/** A labelled area on the first page of a customer's sample order document. */
export interface CustomerOrderTemplateField {
  field: "orderNumber" | "partCode" | "quantity";
  page: number;
  leftPercent: number;
  topPercent: number;
  widthPercent: number;
  heightPercent: number;
}

/** The reusable layout learned from an example customer order PDF. */
export interface CustomerOrderTemplate {
  fields: CustomerOrderTemplateField[];
}

/** A customer and, optionally, a visual extraction model for their order PDFs. */
export interface Customer {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  notes?: string;
  sampleDocumentName?: string;
  orderTemplate?: CustomerOrderTemplate;
  createdAt: string;
}

/** A customer order containing one or more queued print jobs. */
export interface ProductionProject {
  id: string;
  name: string;
  customerId?: string;
  customer?: string;
  orderNumber?: string;
  items?: ProductionOrderItem[];
  /** Name of the PDF used to prefill the order, without retaining the document itself. */
  sourceDocumentName?: string;
  state: ProductionProjectState;
  createdAt: string;
}

export interface ProductionJob {
  id: string;
  /** Optional for compatibility with work created before project planning existed. */
  projectId?: string;
  printerId: string;
  spoolId: string;
  fileName: string;
  estimatedMaterialGrams: number;
  estimatedPrintMinutes?: number;
  actualMaterialGrams?: number;
  actualPrintMinutes?: number;
  state: ProductionJobState;
}

export type MaintenanceState = "open" | "completed";

/** A scheduled or completed maintenance operation for one printer. */
export interface MaintenanceRecord {
  id: string;
  printerId: string;
  title: string;
  notes?: string;
  dueDate?: string;
  estimatedCost?: number;
  state: MaintenanceState;
  createdAt: string;
  completedAt?: string;
}

export type GcodeEstimateSource = "slicer" | "calculated" | "manual";

export interface GcodeThumbnail {
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg";
}

/** Metadata for a G-code file stored locally by the Production Hub. */
export interface GcodeFile {
  fileName: string;
  sizeBytes: number;
  uploadedAt: string;
  estimatedMaterialGrams?: number;
  estimatedMaterialSource?: GcodeEstimateSource;
  estimatedPrintMinutes?: number;
  estimatedPrintTimeSource?: GcodeEstimateSource;
  thumbnail?: GcodeThumbnail;
  /** Internal migration marker for legacy files imported before thumbnail support. */
  thumbnailChecked?: boolean;
}

/** A single source of truth for inventory reservations made by production jobs. */
export interface InventoryService {
  reserve(spoolId: string, grams: number, jobId: string): Promise<void>;
  consumeReservation(jobId: string, actualGrams: number): Promise<void>;
  releaseReservation(jobId: string): Promise<void>;
}

/** Selects the protocol implementation for a configured printer. */
export interface PrinterAdapterRegistry {
  get(protocol: PrinterProtocol): PrinterAdapter;
}

/** Contract implemented once per printer protocol or vendor. */
export interface PrinterAdapter {
  readonly protocol: PrinterProtocol;
  readonly capabilities: readonly PrinterCapability[];
  testConnection(): Promise<void>;
  uploadGcode?(upload: GcodeUpload): Promise<void>;
  getStatus(printerId: string): Promise<PrinterSummary>;
  startJob(request: PrintJobRequest): Promise<void>;
  pauseJob(printerId: string): Promise<void>;
  resumeJob(printerId: string): Promise<void>;
  cancelJob(printerId: string): Promise<void>;
}
