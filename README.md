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

## Timelapse por impressora (UI v0.7.1)

Na página individual da impressora, o painel **Timelapse** permite ativar ou
desativar a captura quando a integração expõe essa função. O Hub verifica o
estado da máquina e guarda `timelapse_enabled` em `portal-state.json` apenas
depois de a API confirmar a alteração. Registos antigos não têm preferência:
abrir a página não altera a configuração existente da impressora.

- **Klipper, Creality e Anycubic com Moonraker:** requer o componente
  [moonraker-timelapse](https://github.com/mainsail-crew/moonraker-timelapse/blob/main/docs/configuration.md),
  câmara, macros e renderização previamente configuradas. O Hub usa
  `/machine/timelapse/settings`, preservando as restantes definições. A Creality
  tenta as portas 7125 e 4408; um endereço com porta explícita tem prioridade.
  Definições fixadas em `moonraker.conf` ficam bloqueadas na interface.
  A alteração afeta a captura em curso; desligar também pode impedir a
  renderização automática dessa impressão. Não recupera imagens já perdidas.
- **OctoPrint:** usa a [API de timelapse](https://docs.octoprint.org/en/main/api/timelapse.html)
  com `save: true`, para as próximas impressões. Preserva o modo anterior ao
  desligar/reativar; sem modo anterior usa uma imagem a cada 10 segundos,
  25 fps e sem post-roll. Requer permissões de consulta/administração de timelapse
  e câmara/renderização configuradas no OctoPrint.
- **Bambu LAN, PrusaLink, Elegoo e firmware sem API compatível:** o controlo fica
  indisponível com uma explicação. Na Bambu, configura o timelapse no Bambu Studio
  antes de enviar a impressão. A câmara LAN continua independente deste controlo.

**Verificar estado** permite tentar novamente após uma falha. A preferência
persiste após reiniciar o Hub e é apresentada separadamente do estado da máquina;
se tiver sido alterado noutra interface, **Aplicar preferência guardada** permite
reaplicá-la explicitamente. Não há comandos automáticos ao consultar o dashboard.
Os vídeos são criados/armazenados pela integração nativa, não pelo Hub.

Validação local: `npm install --prefix hub` e `npm test --prefix hub`.
Os testes usam APIs simuladas; a gravação física e a reprodução dos streams na
farm devem ser verificadas após instalar a alteração numa máquina compatível.

## Instalação

```bash
cd /srv/containers/apps/conceito3d-production-hub
docker compose up -d --build
```

Abra `http://IP-DO-SERVIDOR:8080`.

Todos os dados persistem no volume Docker `hub-data`, montado em `/app/data`
dentro do contentor. Nunca use `docker compose down -v` num servidor com dados
de produção.

## Painel de estado ESP32

O repositório inclui firmware para o ESP32-2432S028 (CYD) em
[`esp32-status-panel/`](esp32-status-panel). O painel mostra quatro páginas:
resumo dos cinco serviços, recursos do HP, backups e alertas.

O Hub disponibiliza apenas ao painel o endpoint de leitura
`/api/display/status`. Antes de o usar, defina no `.env` do servidor um
`DISPLAY_API_TOKEN` aleatório e o IP **local** do HP:

```dotenv
DISPLAY_API_TOKEN=um-token-longo-e-aleatorio
SERVER_LOCAL_IP=192.168.x.x
SERVER_TAILSCALE_IP=100.74.119.75
```

O `compose.yml` monta dados do host em modo de leitura para obter uso real dos
discos, temperatura quando o hardware a expõe, backups e estado dos contentores.
O socket Docker também é necessário para esta última informação; mantenha o
portal protegido e não publique a porta 8080 na Internet.

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
