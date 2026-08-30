# Painel físico do Production Hub

Firmware PlatformIO para o ESP32-2432S028, também conhecido como **Cheap Yellow
Display**. Atualiza os dados de 15 em 15 segundos e muda automaticamente entre
quatro páginas; um toque no ecrã avança imediatamente para a página seguinte.

1. **Resumo:** Production Hub, Print Farm Manager, Spoolman, Portainer e
   Tracefinity.
2. **Recursos:** CPU, temperatura, memória, disco, hostname e tempo ativo.
3. **Backups:** data, idade e tamanho do último backup.
4. **Alertas:** serviços parados, espaço reduzido e backups desatualizados.

## Preparação do servidor

No `.env` do Production Hub, define um token só para o painel e o IP local do
HP. Nunca uses a password de administrador no ESP32:

```dotenv
DISPLAY_API_TOKEN=gera-um-token-aleatorio-longo
SERVER_LOCAL_IP=192.168.1.10
SERVER_TAILSCALE_IP=100.74.119.75
```

Depois aplica a atualização do Hub:

```bash
cd /srv/containers/apps/conceito3d-production-hub
sudo docker compose up -d --build
```

## Compilar e gravar

1. Instala o [PlatformIO](https://platformio.org/install/ide?install=vscode).
2. Abre a pasta `esp32-status-panel` no VS Code.
3. Copia `include/secrets.example.h` para `include/secrets.h`.
4. Preenche Wi-Fi, URL e token. A URL deve usar o IP **local** do HP:

   ```cpp
   #define DISPLAY_API_URL "http://192.168.1.10:8080/api/display/status"
   ```

5. Liga a placa ao computador através da porta micro-USB e usa **Upload**.

O perfil incluído é para o ESP32-2432S028 com ecrã ILI9341. Se a placa mostrar
o ecrã branco depois de gravar, é provavelmente uma variante com controlador
ST7789; nesse caso alteramos apenas a configuração do ecrã, sem mudar o resto
do firmware.
