const fs = require('fs');
const path = require('path');
const axios = require('axios');

if (!process.argv.includes('--confirm')) {
  console.error('Operação cancelada. Executa novamente com --confirm.');
  process.exit(2);
}

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'portal-state.json');
const uploadsDir = path.join(dataDir, 'uploads');
const farmUrl = (process.env.PRINT_FARM_URL || 'http://print-farm-manager:3000').replace(/\/$/, '');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(dataDir, 'reset-backups', stamp);
const client = axios.create({ baseURL: farmUrl, timeout: 15000 });

async function main() {
  fs.mkdirSync(backupDir, { recursive: true });
  const saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, path.join(backupDir, 'portal-state.json'));
  if (fs.existsSync(uploadsDir)) fs.cpSync(uploadsDir, path.join(backupDir, 'uploads'), { recursive: true });

  const projectsResponse = await client.get('/api/projects');
  const projects = Array.isArray(projectsResponse.data) ? projectsResponse.data : [];
  const exportData = [];
  for (const project of projects) {
    const partsResponse = await client.get(`/api/parts?project_id=${encodeURIComponent(project.id)}`);
    const parts = Array.isArray(partsResponse.data) ? partsResponse.data : [];
    const details = [];
    for (const part of parts) {
      const gcodesResponse = await client.get(`/api/gcodes?part_id=${encodeURIComponent(part.id)}`);
      details.push({ ...part, gcodes: Array.isArray(gcodesResponse.data) ? gcodesResponse.data : [] });
    }
    exportData.push({ ...project, parts: details });
  }
  fs.writeFileSync(path.join(backupDir, 'print-farm-projects.json'), JSON.stringify(exportData, null, 2));

  for (const project of projects) await client.delete(`/api/projects/${encodeURIComponent(project.id)}`);

  const storedNames = new Set([
    ...(Array.isArray(saved.files) ? saved.files.flatMap((file) => [file.stored_name, file.thumbnail?.stored_name]) : []),
    ...(Array.isArray(saved.orders) ? saved.orders.flatMap((order) => Array.isArray(order.files) ? order.files.map((file) => file.stored_name) : []) : []),
  ].filter(Boolean));
  for (const name of storedNames) fs.rmSync(path.join(uploadsDir, path.basename(name)), { force: true });

  saved.files = [];
  saved.library_parts = [];
  if (Array.isArray(saved.orders)) for (const order of saved.orders) {
    order.files = [];
    order.library_files = [];
    order.library_parts = [];
    delete order.library_file_id;
  }
  fs.writeFileSync(stateFile, JSON.stringify(saved, null, 2));
  console.log(`Limpeza concluída. Cópia de segurança: ${backupDir}`);
  console.log(`Projetos removidos: ${projects.length}`);
  console.log(`Ficheiros removidos: ${storedNames.size}`);
}

main().catch((error) => {
  console.error(`Falha na limpeza: ${error.response?.data?.error || error.message}`);
  console.error(`Cópia de segurança disponível em: ${backupDir}`);
  process.exit(1);
});
