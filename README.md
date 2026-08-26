# Conceito 3D Production Hub

Portal único para a operação da farm: impressoras, biblioteca de G-code, fila de produção, encomendas, clientes, bobines, manutenção e relatórios.

## O que está integrado

- Importação de encomendas em PDF: lê a camada de texto e usa OCR local em português quando o PDF é digitalizado.
- Clientes e modelos de PDF por cliente.
- Projetos/encomendas, trabalhos, reserva e consumo de material.
- Biblioteca centrada em peças: nome normalizado em maiúsculas e várias variantes G-code por impressora, material, cor, bico e quantidade por impressão.
- Seleção manual ou automática do G-code de uma peça, com cálculo de impressões, produção total e excedente.
- Impressoras Moonraker, OctoPrint, PrusaLink, Anycubic e Creality através de adaptadores locais.
- Bobines e sincronização opcional com Spoolman; o portal é a interface diária.
- Plano de manutenção, alertas e métricas de produção.

## Instalação no LattePanda

1. Copie `.env.production.example` para `.env` e defina uma palavra-passe segura em `POSTGRES_PASSWORD`.
2. Execute `docker compose up -d --build`.
3. Abra `http://192.168.1.85:8080`.

Os dados persistem nos volumes Docker `conceito3d-production-hub_production-hub-postgres` e `conceito3d-production-hub_production-hub-data`.

## Atualizações e cópias de segurança

O serviço `conceito3d-hub-update.timer` atualiza a aplicação a partir de `main`. O serviço de backup guarda tanto a base de dados atual como os volumes do portal; durante a migração também mantém cópias dos volumes antigos do Print Farm Manager e do Spoolman.

Nunca execute `docker compose down -v` em produção.

## Limpeza inicial da biblioteca e dos projetos

Para começar com a nova biblioteca vazia, mantendo encomendas, clientes, impressoras, bobines e configurações:

```bash
docker compose stop hub
docker compose run --rm --no-deps hub node reset-library-projects.js --confirm
docker compose up -d hub
```

O utilitário cria primeiro uma cópia de segurança dentro do volume `hub-data`, em `reset-backups/<data-hora>`, e só depois remove os projetos do Print Farm Manager e os ficheiros da biblioteca.
