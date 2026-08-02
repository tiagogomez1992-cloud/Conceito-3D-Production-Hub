import postgres from "postgres";
import type { Customer, CustomerOrderTemplate, MaintenanceRecord, MaintenanceState, PrinterConnection, PrinterProfile, ProductionJob, ProductionJobState, ProductionOrderItem, ProductionProject, ProductionProjectState, Spool } from "@conceito/core";

type PrinterRow = {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  profile: PrinterProfile | string | null;
  protocol: PrinterConnection["protocol"];
  base_url: string;
  api_key: string | null;
  username: string | null;
  device_id: string | null;
};

type SpoolRow = {
  id: string;
  external_id: string | null;
  brand: string;
  material: Spool["material"];
  color: string;
  initial_weight_grams: number | string;
  remaining_weight_grams: number | string;
  reserved_weight_grams: number | string;
  cost_per_kg: number | string | null;
};

type ProjectRow = {
  id: string;
  name: string;
  customer_id: string | null;
  customer: string | null;
  order_number: string | null;
  items: ProductionOrderItem[] | string | null;
  source_document_name: string | null;
  state: ProductionProjectState;
  created_at: Date | string;
};

type CustomerRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  sample_document_name: string | null;
  order_template: CustomerOrderTemplate | string | null;
  created_at: Date | string;
};

type JobRow = {
  id: string;
  project_id: string | null;
  printer_id: string;
  spool_id: string;
  file_name: string;
  estimated_material_grams: number | string;
  estimated_print_minutes: number | string | null;
  actual_material_grams: number | string | null;
  actual_print_minutes: number | string | null;
  state: ProductionJobState;
};

type MaintenanceRow = {
  id: string;
  printer_id: string;
  title: string;
  notes: string | null;
  due_date: Date | string | null;
  estimated_cost: number | string | null;
  state: MaintenanceState;
  created_at: Date | string;
  completed_at: Date | string | null;
};

const schema = `
  CREATE TABLE IF NOT EXISTS printers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    manufacturer TEXT,
    model TEXT,
    profile JSONB,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT,
    username TEXT,
    device_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS spools (
    id TEXT PRIMARY KEY,
    external_id TEXT UNIQUE,
    brand TEXT NOT NULL,
    material TEXT NOT NULL,
    color TEXT NOT NULL,
    initial_weight_grams NUMERIC(10,2) NOT NULL CHECK (initial_weight_grams >= 0),
    remaining_weight_grams NUMERIC(10,2) NOT NULL CHECK (remaining_weight_grams >= 0),
    reserved_weight_grams NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (reserved_weight_grams >= 0),
    cost_per_kg NUMERIC(10,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS production_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    customer_id TEXT,
    customer TEXT,
    order_number TEXT,
    items JSONB,
    source_document_name TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    email TEXT,
    phone TEXT,
    notes TEXT,
    sample_document_name TEXT,
    order_template JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS production_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES production_projects(id),
    printer_id TEXT NOT NULL REFERENCES printers(id),
    spool_id TEXT NOT NULL REFERENCES spools(id),
    file_name TEXT NOT NULL,
    estimated_material_grams NUMERIC(10,2) NOT NULL CHECK (estimated_material_grams > 0),
    estimated_print_minutes NUMERIC(10,2),
    actual_material_grams NUMERIC(10,2),
    actual_print_minutes NUMERIC(10,2),
    state TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS filament_reservations (
    job_id TEXT PRIMARY KEY REFERENCES production_jobs(id) ON DELETE CASCADE,
    spool_id TEXT NOT NULL REFERENCES spools(id),
    grams NUMERIC(10,2) NOT NULL CHECK (grams > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS maintenance_records (
    id TEXT PRIMARY KEY,
    printer_id TEXT NOT NULL REFERENCES printers(id),
    title TEXT NOT NULL,
    notes TEXT,
    due_date TIMESTAMPTZ,
    estimated_cost NUMERIC(10,2),
    state TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  );
`;

export class DomainError extends Error {}

export function createProductionRepository() {
  const sql = postgres(process.env.DATABASE_URL ?? "postgresql://production_hub:change-me@localhost:5432/production_hub");

  return {
    async migrate() {
      await sql.unsafe(schema);
      await sql.unsafe("ALTER TABLE printers ADD COLUMN IF NOT EXISTS username TEXT");
      await sql.unsafe("ALTER TABLE printers ADD COLUMN IF NOT EXISTS device_id TEXT");
      await sql.unsafe("ALTER TABLE printers ADD COLUMN IF NOT EXISTS manufacturer TEXT");
      await sql.unsafe("ALTER TABLE printers ADD COLUMN IF NOT EXISTS model TEXT");
      await sql.unsafe("ALTER TABLE printers ADD COLUMN IF NOT EXISTS profile JSONB");
      await sql.unsafe("ALTER TABLE spools ADD COLUMN IF NOT EXISTS cost_per_kg NUMERIC(10,2)");
      await sql.unsafe("ALTER TABLE spools ADD COLUMN IF NOT EXISTS external_id TEXT");
      await sql.unsafe("CREATE UNIQUE INDEX IF NOT EXISTS spools_external_id_unique ON spools (external_id)");
      await sql.unsafe("ALTER TABLE production_jobs ADD COLUMN IF NOT EXISTS project_id TEXT");
      await sql.unsafe("ALTER TABLE production_jobs ADD COLUMN IF NOT EXISTS estimated_print_minutes NUMERIC(10,2)");
      await sql.unsafe("ALTER TABLE production_jobs ADD COLUMN IF NOT EXISTS actual_print_minutes NUMERIC(10,2)");
      await sql.unsafe("ALTER TABLE production_projects ADD COLUMN IF NOT EXISTS order_number TEXT");
      await sql.unsafe("ALTER TABLE production_projects ADD COLUMN IF NOT EXISTS customer_id TEXT");
      await sql.unsafe("ALTER TABLE production_projects ADD COLUMN IF NOT EXISTS items JSONB");
      await sql.unsafe("ALTER TABLE production_projects ADD COLUMN IF NOT EXISTS source_document_name TEXT");
      await sql.unsafe("ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT");
      await sql.unsafe("ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone TEXT");
      await sql.unsafe("ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT");
      await sql.unsafe("ALTER TABLE customers ADD COLUMN IF NOT EXISTS sample_document_name TEXT");
      await sql.unsafe("ALTER TABLE customers ADD COLUMN IF NOT EXISTS order_template JSONB");
    },

    async close() {
      await sql.end();
    },

    async listPrinters(): Promise<PrinterConnection[]> {
      const rows = await sql<PrinterRow[]>`SELECT id, name, manufacturer, model, profile, protocol, base_url, api_key, username, device_id FROM printers ORDER BY name`;
      return rows.map(toPrinter);
    },

    async getPrinter(id: string): Promise<PrinterConnection | undefined> {
      const [row] = await sql<PrinterRow[]>`SELECT id, name, manufacturer, model, profile, protocol, base_url, api_key, username, device_id FROM printers WHERE id = ${id}`;
      return row ? toPrinter(row) : undefined;
    },

    async findDuplicatePrinter(name: string, baseUrl: string): Promise<PrinterConnection | undefined> {
      const [row] = await sql<PrinterRow[]>`
        SELECT id, name, manufacturer, model, profile, protocol, base_url, api_key, username, device_id
        FROM printers
        WHERE lower(name) = lower(${name}) OR base_url = ${baseUrl}
        LIMIT 1
      `;
      return row ? toPrinter(row) : undefined;
    },

    async savePrinter(printer: PrinterConnection): Promise<PrinterConnection> {
      const [row] = await sql<PrinterRow[]>`
        INSERT INTO printers (id, name, manufacturer, model, profile, protocol, base_url, api_key, username, device_id)
        VALUES (${printer.id}, ${printer.name}, ${printer.manufacturer ?? null}, ${printer.model ?? null}, ${JSON.stringify(printer.profile ?? null)}::jsonb, ${printer.protocol}, ${printer.baseUrl}, ${printer.apiKey ?? null}, ${printer.username ?? null}, ${printer.deviceId ?? null})
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          manufacturer = EXCLUDED.manufacturer,
          model = EXCLUDED.model,
          profile = EXCLUDED.profile,
          protocol = EXCLUDED.protocol,
          base_url = EXCLUDED.base_url,
          api_key = EXCLUDED.api_key,
          username = EXCLUDED.username,
          device_id = EXCLUDED.device_id
        RETURNING id, name, manufacturer, model, profile, protocol, base_url, api_key, username, device_id
      `;
      return toPrinter(row);
    },

    async deletePrinter(id: string): Promise<void> {
      const [job] = await sql<{ id: string }[]>`SELECT id FROM production_jobs WHERE printer_id = ${id} LIMIT 1`;
      if (job) throw new DomainError("Uma impressora com histórico de trabalhos não pode ser removida. Mova-a antes para Desativadas.");
      const [deleted] = await sql<{ id: string }[]>`DELETE FROM printers WHERE id = ${id} RETURNING id`;
      if (!deleted) throw new DomainError("Impressora não encontrada.");
    },

    async updatePrinterProfile(id: string, profile: PrinterConnection["profile"]): Promise<PrinterConnection> {
      const [row] = await sql<PrinterRow[]>`
        UPDATE printers SET profile = ${JSON.stringify(profile ?? null)}::jsonb WHERE id = ${id}
        RETURNING id, name, manufacturer, model, profile, protocol, base_url, api_key, username, device_id
      `;
      if (!row) throw new DomainError("Impressora não encontrada.");
      return toPrinter(row);
    },

    async listProjects(): Promise<ProductionProject[]> {
      const rows = await sql<ProjectRow[]>`SELECT id, name, customer_id, customer, order_number, items, source_document_name, state, created_at FROM production_projects ORDER BY created_at DESC`;
      return rows.map(toProject);
    },

    async getProject(id: string): Promise<ProductionProject | undefined> {
      const [row] = await sql<ProjectRow[]>`SELECT id, name, customer_id, customer, order_number, items, source_document_name, state, created_at FROM production_projects WHERE id = ${id}`;
      return row ? toProject(row) : undefined;
    },

    async createProject(project: ProductionProject): Promise<ProductionProject> {
      const [row] = await sql<ProjectRow[]>`
        INSERT INTO production_projects (id, name, customer_id, customer, order_number, items, source_document_name, state, created_at)
        VALUES (${project.id}, ${project.name}, ${project.customerId ?? null}, ${project.customer ?? null}, ${project.orderNumber ?? null}, ${JSON.stringify(project.items ?? [])}::jsonb, ${project.sourceDocumentName ?? null}, ${project.state}, ${project.createdAt})
        RETURNING id, name, customer_id, customer, order_number, items, source_document_name, state, created_at
      `;
      return toProject(row);
    },

    async archiveProject(id: string): Promise<ProductionProject> {
      const [row] = await sql<ProjectRow[]>`
        UPDATE production_projects SET state = 'archived' WHERE id = ${id}
        RETURNING id, name, customer_id, customer, order_number, items, source_document_name, state, created_at
      `;
      if (!row) throw new DomainError("Encomenda não encontrada.");
      return toProject(row);
    },

    async listCustomers(): Promise<Customer[]> {
      const rows = await sql<CustomerRow[]>`SELECT id, name, email, phone, notes, sample_document_name, order_template, created_at FROM customers ORDER BY name`;
      return rows.map(toCustomer);
    },

    async getCustomer(id: string): Promise<Customer | undefined> {
      const [row] = await sql<CustomerRow[]>`SELECT id, name, email, phone, notes, sample_document_name, order_template, created_at FROM customers WHERE id = ${id}`;
      return row ? toCustomer(row) : undefined;
    },

    async createCustomer(customer: Customer): Promise<Customer> {
      try {
        const [row] = await sql<CustomerRow[]>`
          INSERT INTO customers (id, name, email, phone, notes, sample_document_name, order_template, created_at)
          VALUES (${customer.id}, ${customer.name}, ${customer.email ?? null}, ${customer.phone ?? null}, ${customer.notes ?? null}, ${customer.sampleDocumentName ?? null}, ${JSON.stringify(customer.orderTemplate ?? null)}::jsonb, ${customer.createdAt})
          RETURNING id, name, email, phone, notes, sample_document_name, order_template, created_at
        `;
        return toCustomer(row);
      } catch (error) {
        if (error instanceof Error && /unique/i.test(error.message)) throw new DomainError("Já existe um cliente com este nome.");
        throw error;
      }
    },

    async deleteCustomer(id: string): Promise<void> {
      const [linked] = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM production_projects WHERE customer_id = ${id}`;
      if (Number(linked?.count ?? 0) > 0) throw new DomainError("Este cliente está associado a encomendas e não pode ser removido.");
      const result = await sql`DELETE FROM customers WHERE id = ${id}`;
      if (!result.count) throw new DomainError("Cliente não encontrado.");
    },

    async listSpools(): Promise<Spool[]> {
      const rows = await sql<SpoolRow[]>`SELECT * FROM spools ORDER BY brand, material, color`;
      return rows.map(toSpool);
    },

    async createSpool(spool: Spool): Promise<Spool> {
      const [row] = await sql<SpoolRow[]>`
        INSERT INTO spools (id, external_id, brand, material, color, initial_weight_grams, remaining_weight_grams, reserved_weight_grams, cost_per_kg)
        VALUES (${spool.id}, ${spool.externalId ?? null}, ${spool.brand}, ${spool.material}, ${spool.color}, ${spool.initialWeightGrams}, ${spool.remainingWeightGrams}, 0, ${spool.costPerKg ?? null})
        RETURNING *
      `;
      return toSpool(row);
    },

    async saveSpool(spool: Spool): Promise<Spool> {
      const [row] = await sql<SpoolRow[]>`
        INSERT INTO spools (id, external_id, brand, material, color, initial_weight_grams, remaining_weight_grams, reserved_weight_grams, cost_per_kg)
        VALUES (${spool.id}, ${spool.externalId ?? null}, ${spool.brand}, ${spool.material}, ${spool.color}, ${spool.initialWeightGrams}, ${spool.remainingWeightGrams}, ${spool.reservedWeightGrams}, ${spool.costPerKg ?? null})
        ON CONFLICT (external_id) DO UPDATE SET
          brand = EXCLUDED.brand, material = EXCLUDED.material, color = EXCLUDED.color, initial_weight_grams = EXCLUDED.initial_weight_grams,
          remaining_weight_grams = EXCLUDED.remaining_weight_grams, cost_per_kg = EXCLUDED.cost_per_kg
        RETURNING *
      `;
      return toSpool(row);
    },

    async listJobs(): Promise<ProductionJob[]> {
      const rows = await sql<JobRow[]>`SELECT * FROM production_jobs ORDER BY created_at DESC`;
      return rows.map(toJob);
    },

    async getJob(id: string): Promise<ProductionJob | undefined> {
      const [row] = await sql<JobRow[]>`SELECT * FROM production_jobs WHERE id = ${id}`;
      return row ? toJob(row) : undefined;
    },

    async createJob(job: Omit<ProductionJob, "state" | "actualMaterialGrams">): Promise<ProductionJob> {
      return sql.begin(async (tx) => {
        if (job.projectId) {
          const [project] = await tx<ProjectRow[]>`SELECT id, name, customer_id, customer, order_number, items, source_document_name, state, created_at FROM production_projects WHERE id = ${job.projectId} AND state = 'active'`;
          if (!project) throw new DomainError("A encomenda selecionada não existe ou está arquivada.");
        }
        const [spool] = await tx<SpoolRow[]>`
          SELECT * FROM spools
          WHERE id = ${job.spoolId}
            AND remaining_weight_grams - reserved_weight_grams >= ${job.estimatedMaterialGrams}
          FOR UPDATE
        `;
        if (!spool) throw new DomainError("A bobine selecionada não tem material disponível suficiente.");

        const [created] = await tx<JobRow[]>`
          INSERT INTO production_jobs (id, project_id, printer_id, spool_id, file_name, estimated_material_grams, estimated_print_minutes, state)
          VALUES (${job.id}, ${job.projectId ?? null}, ${job.printerId}, ${job.spoolId}, ${job.fileName}, ${job.estimatedMaterialGrams}, ${job.estimatedPrintMinutes ?? null}, 'reserved')
          RETURNING *
        `;
        await tx`
          INSERT INTO filament_reservations (job_id, spool_id, grams)
          VALUES (${job.id}, ${job.spoolId}, ${job.estimatedMaterialGrams})
        `;
        await tx`UPDATE spools SET reserved_weight_grams = reserved_weight_grams + ${job.estimatedMaterialGrams} WHERE id = ${spool.id}`;
        return toJob(created);
      });
    },

    async markJobPrinting(id: string): Promise<ProductionJob> {
      const [row] = await sql<JobRow[]>`
        UPDATE production_jobs SET state = 'printing', started_at = NOW()
        WHERE id = ${id} AND state = 'reserved'
        RETURNING *
      `;
      if (!row) throw new DomainError("O trabalho não está pronto para iniciar.");
      return toJob(row);
    },

    async markJobPaused(id: string): Promise<ProductionJob> {
      const [row] = await sql<JobRow[]>`
        UPDATE production_jobs SET state = 'paused'
        WHERE id = ${id} AND state = 'printing'
        RETURNING *
      `;
      if (!row) throw new DomainError("O trabalho não está a imprimir e não pode ser pausado.");
      return toJob(row);
    },

    async resumeJob(id: string): Promise<ProductionJob> {
      const [row] = await sql<JobRow[]>`
        UPDATE production_jobs SET state = 'printing'
        WHERE id = ${id} AND state = 'paused'
        RETURNING *
      `;
      if (!row) throw new DomainError("O trabalho não está em pausa e não pode ser retomado.");
      return toJob(row);
    },

    async completeJob(id: string, actualGrams: number, actualPrintMinutes?: number): Promise<ProductionJob> {
      return finishJob(id, actualGrams, "completed", actualPrintMinutes);
    },

    async cancelJob(id: string, actualGrams: number, actualPrintMinutes?: number): Promise<ProductionJob> {
      return finishJob(id, actualGrams, "cancelled", actualPrintMinutes);
    },

    async listMaintenance(): Promise<MaintenanceRecord[]> {
      const rows = await sql<MaintenanceRow[]>`SELECT * FROM maintenance_records ORDER BY state, due_date NULLS LAST, created_at DESC`;
      return rows.map(toMaintenance);
    },

    async createMaintenance(record: MaintenanceRecord): Promise<MaintenanceRecord> {
      const [row] = await sql<MaintenanceRow[]>`
        INSERT INTO maintenance_records (id, printer_id, title, notes, due_date, estimated_cost, state, created_at, completed_at)
        VALUES (${record.id}, ${record.printerId}, ${record.title}, ${record.notes ?? null}, ${record.dueDate ?? null}, ${record.estimatedCost ?? null}, ${record.state}, ${record.createdAt}, ${record.completedAt ?? null})
        RETURNING *
      `;
      return toMaintenance(row);
    },

    async completeMaintenance(id: string, notes?: string, actualCost?: number): Promise<MaintenanceRecord> {
      const [row] = await sql<MaintenanceRow[]>`
        UPDATE maintenance_records
        SET state = 'completed', completed_at = NOW(), notes = COALESCE(${notes ?? null}, notes), estimated_cost = COALESCE(${actualCost ?? null}, estimated_cost)
        WHERE id = ${id}
        RETURNING *
      `;
      if (!row) throw new DomainError("Registo de manutenção não encontrado.");
      return toMaintenance(row);
    }
  };

  async function finishJob(id: string, actualGrams: number, state: "completed" | "cancelled", actualPrintMinutes?: number): Promise<ProductionJob> {
    if (actualGrams < 0) throw new DomainError("O consumo de material não pode ser negativo.");
    return sql.begin(async (tx) => {
      const [reservation] = await tx<{ spool_id: string; grams: number | string }[]>`
        SELECT r.spool_id, r.grams
        FROM filament_reservations r
        WHERE r.job_id = ${id}
        FOR UPDATE
      `;
      if (!reservation) throw new DomainError("Não foi encontrada uma reserva ativa para este trabalho.");

      const [spool] = await tx<SpoolRow[]>`SELECT * FROM spools WHERE id = ${reservation.spool_id} FOR UPDATE`;
      if (!spool || Number(spool.remaining_weight_grams) < actualGrams) {
        throw new DomainError("A bobine não contém material suficiente para o consumo registado.");
      }
      const [job] = await tx<JobRow[]>`
        UPDATE production_jobs
        SET state = ${state}, actual_material_grams = ${actualGrams}, actual_print_minutes = ${actualPrintMinutes ?? null}, finished_at = NOW()
        WHERE id = ${id} AND state IN ('reserved', 'printing', 'paused')
        RETURNING *
      `;
      if (!job) throw new DomainError("O trabalho já foi concluído ou não pode ser atualizado.");
      await tx`
        UPDATE spools
        SET remaining_weight_grams = remaining_weight_grams - ${actualGrams},
            reserved_weight_grams = reserved_weight_grams - ${reservation.grams}
        WHERE id = ${reservation.spool_id}
      `;
      await tx`DELETE FROM filament_reservations WHERE job_id = ${id}`;
      return toJob(job);
    });
  }
}

function toPrinter(row: PrinterRow): PrinterConnection {
  return {
    id: row.id, name: row.name, manufacturer: row.manufacturer ?? undefined, model: row.model ?? undefined, profile: parseProfile(row.profile),
    protocol: row.protocol, baseUrl: row.base_url,
    apiKey: row.api_key ?? undefined, username: row.username ?? undefined, deviceId: row.device_id ?? undefined
  };
}

function toSpool(row: SpoolRow): Spool {
  return {
    id: row.id, externalId: row.external_id ?? undefined, brand: row.brand, material: row.material, color: row.color,
    initialWeightGrams: Number(row.initial_weight_grams),
    remainingWeightGrams: Number(row.remaining_weight_grams),
    reservedWeightGrams: Number(row.reserved_weight_grams),
    costPerKg: row.cost_per_kg === null ? undefined : Number(row.cost_per_kg)
  };
}

function toProject(row: ProjectRow): ProductionProject {
  return {
    id: row.id, name: row.name, customerId: row.customer_id ?? undefined, customer: row.customer ?? undefined, orderNumber: row.order_number ?? undefined,
    items: parseOrderItems(row.items), sourceDocumentName: row.source_document_name ?? undefined,
    state: row.state, createdAt: new Date(row.created_at).toISOString()
  };
}

function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id, name: row.name, email: row.email ?? undefined, phone: row.phone ?? undefined, notes: row.notes ?? undefined,
    sampleDocumentName: row.sample_document_name ?? undefined, orderTemplate: parseOrderTemplate(row.order_template),
    createdAt: new Date(row.created_at).toISOString()
  };
}

function parseOrderTemplate(value: CustomerRow["order_template"]): CustomerOrderTemplate | undefined {
  if (!value) return undefined;
  const template = typeof value === "string" ? JSON.parse(value) : value;
  return template && typeof template === "object" && Array.isArray(template.fields) ? template : undefined;
}

function parseOrderItems(value: ProjectRow["items"]): ProductionOrderItem[] | undefined {
  if (!value) return undefined;
  const items = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(items)) return undefined;
  const valid = items.flatMap((item): ProductionOrderItem[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<ProductionOrderItem>;
    if (typeof candidate.partCode !== "string" || !candidate.partCode.trim() || typeof candidate.quantity !== "number" || !Number.isFinite(candidate.quantity) || candidate.quantity < 1) return [];
    return [{ partCode: candidate.partCode.trim(), quantity: Math.floor(candidate.quantity), description: typeof candidate.description === "string" && candidate.description.trim() ? candidate.description.trim() : undefined }];
  });
  return valid.length ? valid : undefined;
}

function toJob(row: JobRow): ProductionJob {
  return {
    id: row.id, projectId: row.project_id ?? undefined, printerId: row.printer_id, spoolId: row.spool_id, fileName: row.file_name,
    estimatedMaterialGrams: Number(row.estimated_material_grams),
    estimatedPrintMinutes: row.estimated_print_minutes === null ? undefined : Number(row.estimated_print_minutes),
    actualMaterialGrams: row.actual_material_grams === null ? undefined : Number(row.actual_material_grams),
    actualPrintMinutes: row.actual_print_minutes === null ? undefined : Number(row.actual_print_minutes),
    state: row.state
  };
}

function parseProfile(value: PrinterRow["profile"]): PrinterProfile | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return JSON.parse(value) as PrinterProfile;
  return value;
}

function toMaintenance(row: MaintenanceRow): MaintenanceRecord {
  return {
    id: row.id, printerId: row.printer_id, title: row.title, notes: row.notes ?? undefined,
    dueDate: row.due_date ? new Date(row.due_date).toISOString() : undefined,
    estimatedCost: row.estimated_cost === null ? undefined : Number(row.estimated_cost), state: row.state,
    createdAt: new Date(row.created_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined
  };
}
