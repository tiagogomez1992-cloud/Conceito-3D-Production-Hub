# Arduino IDE

Esta pasta permite usar o mesmo firmware sem PlatformIO.

## Preparação

1. Copia `secrets.example.h` para `secrets.h` e preenche os dados de Wi-Fi,
   URL local do Production Hub e token do painel.
2. No Arduino IDE, instala o pacote **esp32 by Espressif Systems** no Gestor de
   Placas e seleciona **ESP32 Dev Module**.
3. No Gestor de Bibliotecas, instala **TFT_eSPI** e **ArduinoJson**.
4. Abre `ProductionHubStatusPanel.ino` e escolhe a porta COM da placa.
5. Usa **Sketch → Export Compiled Binary** para gerar o `.bin`, ou o botão
   **Upload** para gravar diretamente por USB.

Se o upload parar em `Connecting...`, mantém premido **BOOT**, inicia o Upload
e larga o botão quando aparecer `Writing at...`.

O `build_opt.h` já inclui os pinos do ecrã desta placa. Não é necessário editar
o `User_Setup.h` da biblioteca TFT_eSPI.
