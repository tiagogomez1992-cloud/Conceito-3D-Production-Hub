# Conceito 3D Production Hub

Portal autónomo para a operação da farm: impressoras, biblioteca de G-code,
projetos, fila de produção, encomendas, clientes, bobines e OCR de documentos.

## Funcionalidades

- Impressoras guardadas no próprio portal e consultadas diretamente por Moonraker,
  OctoPrint ou PrusaLink.
- Descoberta de impressoras na rede local.
- Biblioteca de G-code por peça, com variantes para modelos de impressora
  diferentes e validação de material, cor, bico e quantidade.
- Projetos, peças e fila de produção no próprio Production Hub.
- Bobines, atribuições às impressoras e registo de consumo no próprio portal.
- Leitura de PDFs por texto e OCR local em português e inglês; modelos de PDF por
  cliente para leitura por áreas.

Não requer Print Farm Manager nem Spoolman para funcionar. Os serviços antigos
podem continuar instalados durante a migração, mas não são consultados nem
alterados pelo Hub.

## Instalação

```bash
cd /srv/containers/apps/conceito3d-production-hub
docker compose up -d --build
```

Abra `http://IP-DO-SERVIDOR:8080`.

Todos os dados persistem no volume Docker `hub-data`, montado em `/app/data`
dentro do contentor. Nunca use `docker compose down -v` num servidor com dados
de produção.

## Atualização

```bash
cd /srv/containers/apps/conceito3d-production-hub
git fetch --prune origin main
git reset --hard origin/main
docker compose up -d --build
```

Na primeira atualização para a versão autónoma, o Docker poderá avisar que os
contentores antigos são órfãos. Esse aviso é esperado e não remove dados. Só os
remova depois de confirmar que tudo está a funcionar no Production Hub.
