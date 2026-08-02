import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Customer, MaintenanceRecord, PrinterConnection, ProductionJob, ProductionProject, Spool } from "@conceito/core";
import { DomainError } from "./repository.js";

type FileData = {
  printers: PrinterConnection[];
  spools: Spool[];
  jobs: ProductionJob[];
  projects: ProductionProject[];
  customers: Customer[];
  maintenance: MaintenanceRecord[];
};

/** Portable store used by the Windows preview app. It deliberately has the same business rules as PostgreSQL. */
export function createFileProductionRepository(dataDirectory: string) {
  const filePath = join(dataDirectory, "production-hub.json");
  let data: FileData = { printers: [], spools: [], jobs: [], projects: [], customers: [], maintenance: [] };

  return {
    async migrate() {
      await mkdir(dirname(filePath), { recursive: true });
      try {
        data = JSON.parse(await readFile(filePath, "utf8")) as FileData;
        data.projects ??= [];
        data.customers ??= [];
        data.maintenance ??= [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await persist();
      }
    },

    async close() {},

    async listPrinters() { return [...data.printers].sort((a, b) => a.name.localeCompare(b.name)); },
    async getPrinter(id: string) { return data.printers.find((printer) => printer.id === id); },
    async findDuplicatePrinter(name: string, baseUrl: string) {
      const normalizedName = name.trim().toLocaleLowerCase();
      return data.printers.find((printer) => printer.name.trim().toLocaleLowerCase() === normalizedName || printer.baseUrl === baseUrl);
    },
    async savePrinter(printer: PrinterConnection) {
      const existing = data.printers.findIndex((item) => item.id === printer.id);
      if (existing === -1) data.printers.push(printer); else data.printers[existing] = printer;
      await persist(); return printer;
    },
    async deletePrinter(id: string) {
      if (data.jobs.some((job) => job.printerId === id)) throw new DomainError("Uma impressora com histórico de trabalhos não pode ser removida. Mova-a antes para Desativadas.");
      const index = data.printers.findIndex((printer) => printer.id === id);
      if (index === -1) throw new DomainError("Impressora não encontrada.");
      data.printers.splice(index, 1); await persist();
    },

    async updatePrinterProfile(id: string, profile: PrinterConnection["profile"]) {
      const printer = data.printers.find((item) => item.id === id);
      if (!printer) throw new DomainError("Impressora não encontrada.");
      printer.profile = profile;
      await persist(); return printer;
    },

    async listProjects() { return [...data.projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    async getProject(id: string) { return data.projects.find((project) => project.id === id); },
    async createProject(project: ProductionProject) {
      if (data.projects.some((item) => item.name.trim().toLocaleLowerCase() === project.name.trim().toLocaleLowerCase())) {
        throw new DomainError("Já existe uma encomenda com este nome.");
      }
      data.projects.push(project); await persist(); return project;
    },
    async archiveProject(id: string) {
      const project = data.projects.find((item) => item.id === id);
      if (!project) throw new DomainError("Encomenda não encontrada.");
      project.state = "archived"; await persist(); return project;
    },

    async listCustomers() { return [...data.customers].sort((a, b) => a.name.localeCompare(b.name)); },
    async getCustomer(id: string) { return data.customers.find((customer) => customer.id === id); },
    async createCustomer(customer: Customer) {
      if (data.customers.some((item) => item.name.trim().toLocaleLowerCase() === customer.name.trim().toLocaleLowerCase())) {
        throw new DomainError("Já existe um cliente com este nome.");
      }
      data.customers.push(customer); await persist(); return customer;
    },
    async deleteCustomer(id: string) {
      if (data.projects.some((project) => project.customerId === id)) throw new DomainError("Este cliente está associado a encomendas e não pode ser removido.");
      const index = data.customers.findIndex((customer) => customer.id === id);
      if (index === -1) throw new DomainError("Cliente não encontrado.");
      data.customers.splice(index, 1); await persist();
    },

    async listSpools() { return [...data.spools].sort((a, b) => `${a.brand}${a.material}${a.color}`.localeCompare(`${b.brand}${b.material}${b.color}`)); },
    async createSpool(spool: Spool) {
      if (data.spools.some((item) => item.id === spool.id)) throw new DomainError("Já existe uma bobine com este identificador.");
      data.spools.push(spool); await persist(); return spool;
    },
    async saveSpool(spool: Spool) {
      const index = data.spools.findIndex((item) => item.id === spool.id || (spool.externalId && item.externalId === spool.externalId));
      if (index === -1) data.spools.push(spool); else data.spools[index] = { ...spool, id: data.spools[index].id, reservedWeightGrams: data.spools[index].reservedWeightGrams };
      await persist(); return index === -1 ? spool : data.spools[index];
    },

    async listJobs() { return [...data.jobs].reverse(); },
    async getJob(id: string) { return data.jobs.find((job) => job.id === id); },
    async createJob(job: Omit<ProductionJob, "state" | "actualMaterialGrams">) {
      if (job.projectId && !data.projects.some((project) => project.id === job.projectId && project.state === "active")) {
        throw new DomainError("A encomenda selecionada não existe ou está arquivada.");
      }
      const spool = data.spools.find((item) => item.id === job.spoolId);
      if (!spool || spool.remainingWeightGrams - spool.reservedWeightGrams < job.estimatedMaterialGrams) {
        throw new DomainError("A bobine selecionada não tem material disponível suficiente.");
      }
      const created: ProductionJob = { ...job, state: "reserved" };
      spool.reservedWeightGrams += job.estimatedMaterialGrams;
      data.jobs.push(created); await persist(); return created;
    },

    async markJobPrinting(id: string) {
      const job = activeJob(id);
      if (job.state !== "reserved") throw new DomainError("O trabalho não está pronto para iniciar.");
      job.state = "printing"; await persist(); return job;
    },

    async markJobPaused(id: string) {
      const job = activeJob(id);
      if (job.state !== "printing") throw new DomainError("O trabalho não está a imprimir e não pode ser pausado.");
      job.state = "paused"; await persist(); return job;
    },

    async resumeJob(id: string) {
      const job = activeJob(id);
      if (job.state !== "paused") throw new DomainError("O trabalho não está em pausa e não pode ser retomado.");
      job.state = "printing"; await persist(); return job;
    },

    async completeJob(id: string, actualGrams: number, actualPrintMinutes?: number) { return finishJob(id, actualGrams, "completed", actualPrintMinutes); },
    async cancelJob(id: string, actualGrams: number, actualPrintMinutes?: number) { return finishJob(id, actualGrams, "cancelled", actualPrintMinutes); },

    async listMaintenance() { return [...data.maintenance].sort((a, b) => `${a.state}${a.dueDate ?? ""}${a.createdAt}`.localeCompare(`${b.state}${b.dueDate ?? ""}${b.createdAt}`)); },
    async createMaintenance(record: MaintenanceRecord) {
      if (!data.printers.some((printer) => printer.id === record.printerId)) throw new DomainError("A impressora selecionada não existe.");
      data.maintenance.push(record); await persist(); return record;
    },
    async completeMaintenance(id: string, notes?: string, actualCost?: number) {
      const record = data.maintenance.find((item) => item.id === id);
      if (!record) throw new DomainError("Registo de manutenção não encontrado.");
      record.state = "completed";
      record.completedAt = new Date().toISOString();
      if (notes !== undefined) record.notes = notes;
      if (actualCost !== undefined) record.estimatedCost = actualCost;
      await persist(); return record;
    }
  };

  async function finishJob(id: string, actualGrams: number, state: "completed" | "cancelled", actualPrintMinutes?: number) {
    if (!Number.isFinite(actualGrams) || actualGrams < 0) throw new DomainError("O consumo de material não pode ser negativo.");
    const job = activeJob(id);
    const spool = data.spools.find((item) => item.id === job.spoolId);
    if (!spool || spool.remainingWeightGrams < actualGrams) {
      throw new DomainError("A bobine não contém material suficiente para o consumo registado.");
    }
    spool.remainingWeightGrams -= actualGrams;
    spool.reservedWeightGrams -= job.estimatedMaterialGrams;
    job.actualMaterialGrams = actualGrams;
    if (actualPrintMinutes !== undefined) job.actualPrintMinutes = actualPrintMinutes;
    job.state = state;
    await persist(); return job;
  }

  function activeJob(id: string) {
    const job = data.jobs.find((item) => item.id === id);
    if (!job || !["reserved", "printing", "paused"].includes(job.state)) {
      throw new DomainError("O trabalho já foi concluído ou não pode ser atualizado.");
    }
    return job;
  }

  async function persist() {
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), "utf8");
    await rename(temporaryPath, filePath);
  }
}
