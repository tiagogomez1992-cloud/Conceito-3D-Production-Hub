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
- Análise local de encomendas através de Ollama e Qwen2.5 3B: utiliza o texto
  extraído pelo OCR dentro do servidor, sem enviar o PDF para a internet.
- ChatGPT/OpenAI opcional para documentos mais complexos, quando configurado.

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

## IA local para encomendas (recomendada)

O `docker compose` inclui Ollama e guarda os modelos no volume `ollama-data`.
Depois do primeiro arranque, descarrega o modelo local uma vez:

```bash
docker compose exec ollama ollama pull qwen2.5:3b
```

No `.env`, mantém:

```dotenv
AI_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:3b
```

Ao selecionar um PDF, o portal faz OCR local e passa apenas o texto extraído ao
modelo local. Sem modelo disponível, continua a usar o OCR sem bloquear a
criação da encomenda.

## IA OpenAI para encomendas (opcional)

O portal já extrai texto e faz OCR localmente. Para uma leitura mais robusta de
tabelas, referências e instruções, adicione uma chave de API OpenAI ao ficheiro
`.env` do servidor:

```dotenv
OPENAI_API_KEY=cole-a-chave-da-api-aqui
OPENAI_MODEL=gpt-5-mini
```

Mude também `AI_PROVIDER=openai` (ou `auto`, para tentar Ollama primeiro).
Ao selecionar um PDF, o portal envia-o à API OpenAI, preenche os dados que
conseguir confirmar e assinala a origem como `ChatGPT`. A chave não é exposta
ao navegador nem é guardada nos dados do portal.

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
