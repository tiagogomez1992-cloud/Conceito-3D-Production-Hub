#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <TFT_eSPI.h>
#include <WiFi.h>

#include "secrets.h"

namespace {
constexpr uint16_t COLOR_BACKGROUND = 0x0841;
constexpr uint16_t COLOR_PANEL = 0x10A2;
constexpr uint16_t COLOR_BORDER = 0x31A6;
constexpr uint16_t COLOR_TEXT = TFT_WHITE;
constexpr uint16_t COLOR_MUTED = 0xBDF7;
constexpr uint16_t COLOR_BLUE = 0x049F;
constexpr uint16_t COLOR_ORANGE = 0xFD20;
constexpr uint16_t COLOR_GREEN = 0x05E0;
constexpr uint16_t COLOR_RED = 0xF800;
constexpr uint16_t COLOR_YELLOW = 0xFFE0;
constexpr uint8_t PAGE_COUNT = 4;
constexpr unsigned long POLL_INTERVAL_MS = 15000;
constexpr unsigned long PAGE_INTERVAL_MS = 9000;
constexpr int TFT_BACKLIGHT_PIN = 21;

TFT_eSPI tft;
JsonDocument statusDocument;
uint8_t currentPage = 0;
unsigned long lastPoll = 0;
unsigned long lastPageChange = 0;
unsigned long lastTouch = 0;
bool dataReady = false;
String connectionError;

String stringValue(JsonVariantConst object, const char *key, const char *fallback = "—") {
  const char *value = object[key] | fallback;
  return String(value);
}

String shortDetail(const String &value, size_t maxLength = 31) {
  return value.length() > maxLength ? value.substring(0, maxLength - 3) + "..." : value;
}

String formatUptime(unsigned long seconds) {
  const unsigned long days = seconds / 86400UL;
  const unsigned long hours = (seconds % 86400UL) / 3600UL;
  const unsigned long minutes = (seconds % 3600UL) / 60UL;
  if (days) return String(days) + "d " + String(hours) + "h";
  return String(hours) + "h " + String(minutes) + "m";
}

String formatBytes(double bytes) {
  if (bytes >= 1073741824.0) return String(bytes / 1073741824.0, 1) + " GB";
  if (bytes >= 1048576.0) return String(bytes / 1048576.0, 1) + " MB";
  return String(bytes / 1024.0, 0) + " KB";
}

uint16_t statusColor(const String &status) {
  if (status == "running" || status == "ok") return COLOR_GREEN;
  if (status == "warning") return COLOR_YELLOW;
  return COLOR_RED;
}

void drawBrand() {
  tft.setTextColor(COLOR_TEXT, COLOR_BACKGROUND);
  tft.setTextFont(4);
  tft.setCursor(10, 10);
  tft.print("PRO");
  tft.setCursor(10, 33);
  tft.print("3D");
  tft.setTextFont(2);
  tft.setCursor(10, 60);
  tft.print("WORLD");
  tft.fillRect(74, 11, 8, 58, COLOR_ORANGE);
  tft.drawFastHLine(92, 14, 218, COLOR_BORDER);
}

void drawHeader(const String &title) {
  tft.fillScreen(COLOR_BACKGROUND);
  drawBrand();
  tft.setTextColor(COLOR_ORANGE, COLOR_BACKGROUND);
  tft.setTextFont(2);
  tft.setCursor(94, 25);
  tft.print(title);
  tft.setTextColor(COLOR_MUTED, COLOR_BACKGROUND);
  tft.setCursor(94, 48);
  tft.printf("PAGINA %u/%u", currentPage + 1, PAGE_COUNT);
  tft.drawFastHLine(10, 78, 300, COLOR_BORDER);
}

void drawValue(const String &label, const String &value, int x, int y, uint16_t valueColor = COLOR_TEXT) {
  tft.setTextFont(2);
  tft.setTextColor(COLOR_MUTED, COLOR_BACKGROUND);
  tft.setCursor(x, y);
  tft.print(label);
  tft.setTextFont(4);
  tft.setTextColor(valueColor, COLOR_BACKGROUND);
  tft.setCursor(x, y + 16);
  tft.print(value);
}

void drawPanel(int x, int y, int width, int height) {
  tft.fillRoundRect(x, y, width, height, 6, COLOR_PANEL);
  tft.drawRoundRect(x, y, width, height, 6, COLOR_BORDER);
}

void drawFooter() {
  tft.drawFastHLine(10, 222, 300, COLOR_BORDER);
  tft.setTextFont(2);
  tft.setTextColor(COLOR_MUTED, COLOR_BACKGROUND);
  tft.setCursor(10, 228);
  if (WiFi.status() == WL_CONNECTED) tft.printf("Wi-Fi %s  |  toque para mudar", WiFi.localIP().toString().c_str());
  else tft.print("Wi-Fi desligado");
}

void drawUnavailable() {
  drawHeader("PAINEL DE ESTADO");
  tft.setTextColor(COLOR_RED, COLOR_BACKGROUND);
  tft.setTextFont(4);
  tft.setCursor(18, 108);
  tft.print("SEM LIGACAO");
  tft.setTextColor(COLOR_MUTED, COLOR_BACKGROUND);
  tft.setTextFont(2);
  tft.setCursor(18, 145);
  tft.print(shortDetail(connectionError.length() ? connectionError : "A aguardar dados do Hub", 43));
  drawFooter();
}

void renderSummary() {
  drawHeader("RESUMO");
  JsonArrayConst services = statusDocument["services"].as<JsonArrayConst>();
  int y = 88;
  for (JsonObjectConst service : services) {
    if (y > 196) break;
    const String status = stringValue(service, "status", "missing");
    drawPanel(10, y, 300, 22);
    tft.fillCircle(23, y + 11, 5, statusColor(status));
    tft.setTextFont(2);
    tft.setTextColor(COLOR_TEXT, COLOR_PANEL);
    tft.setCursor(35, y + 5);
    tft.print(shortDetail(stringValue(service, "label"), 20));
    tft.setTextColor(COLOR_MUTED, COLOR_PANEL);
    tft.setCursor(169, y + 5);
    tft.print(shortDetail(stringValue(service, "detail"), 22));
    y += 27;
  }
  drawFooter();
}

void renderResources() {
  drawHeader("RECURSOS DO HP");
  JsonObjectConst resources = statusDocument["resources"].as<JsonObjectConst>();
  JsonObjectConst cpu = resources["cpu"].as<JsonObjectConst>();
  JsonObjectConst memory = resources["memory"].as<JsonObjectConst>();
  const double cpuUsage = cpu["usage_percent"] | -1.0;
  const double temperature = resources["cpu_temperature_c"] | -1.0;
  drawValue("CPU", cpuUsage >= 0 ? String(cpuUsage, 0) + "%" : "a medir", 16, 88, COLOR_BLUE);
  drawValue("TEMP.", temperature >= 0 ? String(temperature, 0) + " C" : "n/d", 164, 88, temperature >= 80 ? COLOR_ORANGE : COLOR_TEXT);
  const int total = memory["total_mb"] | 0; const int used = memory["used_mb"] | 0;
  drawValue("RAM", String(used) + "/" + String(total) + " MB", 16, 139, COLOR_BLUE);
  JsonArrayConst disks = resources["disks"].as<JsonArrayConst>();
  if (!disks.isNull() && disks.size()) {
    JsonObjectConst disk = disks[0].as<JsonObjectConst>();
    drawValue(shortDetail(stringValue(disk, "label"), 16), disk["unavailable"] | false ? "n/d" : String(disk["used_percent"] | 0) + "%", 164, 139, (disk["used_percent"] | 0) >= 85 ? COLOR_ORANGE : COLOR_GREEN);
  }
  tft.setTextFont(2); tft.setTextColor(COLOR_MUTED, COLOR_BACKGROUND);
  int diskY = 187;
  for (size_t index = 0; index < disks.size() && index < 2; ++index) {
    JsonObjectConst disk = disks[index].as<JsonObjectConst>();
    if (disk["unavailable"] | false) continue;
    tft.setCursor(16, diskY); tft.printf("%s: %.1f/%.1f GB", shortDetail(stringValue(disk, "label"), 14).c_str(), double(disk["used_gb"] | 0.0), double(disk["total_gb"] | 0.0));
    diskY += 14;
  }
  JsonArrayConst addresses = statusDocument["network"]["addresses"].as<JsonArrayConst>();
  const String serverIp = !addresses.isNull() && addresses.size() ? String(addresses[0].as<const char *>()) : "IP nao definido";
  const unsigned long up = resources["uptime_seconds"] | 0UL;
  tft.setCursor(16, 208); tft.printf("HP %s | %s", shortDetail(serverIp, 17).c_str(), formatUptime(up).c_str());
  drawFooter();
}

void renderBackup() {
  drawHeader("BACKUPS");
  JsonObjectConst backup = statusDocument["backup"].as<JsonObjectConst>();
  const String status = stringValue(backup, "status", "unavailable");
  const bool present = status == "ok" || status == "warning" || status == "critical";
  drawPanel(10, 92, 300, 95);
  tft.fillCircle(30, 116, 8, statusColor(status));
  tft.setTextFont(4); tft.setTextColor(COLOR_TEXT, COLOR_PANEL); tft.setCursor(48, 104);
  tft.print(present ? "ULTIMO BACKUP" : "SEM BACKUP");
  tft.setTextFont(2); tft.setTextColor(COLOR_MUTED, COLOR_PANEL); tft.setCursor(22, 139);
  if (present) {
    tft.print(shortDetail(stringValue(backup, "name"), 36));
    tft.setCursor(22, 162);
    const double age = backup["age_hours"] | 0.0; const double size = backup["size_bytes"] | 0.0;
    tft.printf("ha %.1f h  |  %s", age, formatBytes(size).c_str());
  } else tft.print(shortDetail(stringValue(backup, "message"), 40));
  drawFooter();
}

void renderAlerts() {
  drawHeader("ALERTAS");
  JsonArrayConst alerts = statusDocument["alerts"].as<JsonArrayConst>();
  if (alerts.isNull() || !alerts.size()) {
    tft.setTextFont(4); tft.setTextColor(COLOR_GREEN, COLOR_BACKGROUND); tft.setCursor(28, 126); tft.print("TUDO OPERACIONAL");
    tft.setTextFont(2); tft.setTextColor(COLOR_MUTED, COLOR_BACKGROUND); tft.setCursor(28, 158); tft.print("Sem alertas neste momento.");
  } else {
    int y = 92;
    for (JsonObjectConst alert : alerts) {
      if (y > 194) break;
      const String severity = stringValue(alert, "severity", "warning");
      drawPanel(10, y, 300, 31); tft.fillCircle(25, y + 15, 6, statusColor(severity));
      tft.setTextFont(2); tft.setTextColor(COLOR_TEXT, COLOR_PANEL); tft.setCursor(38, y + 9); tft.print(shortDetail(stringValue(alert, "message"), 39));
      y += 37;
    }
  }
  drawFooter();
}

void renderPage() {
  if (!dataReady) return drawUnavailable();
  switch (currentPage) {
    case 0: renderSummary(); break;
    case 1: renderResources(); break;
    case 2: renderBackup(); break;
    default: renderAlerts(); break;
  }
}

void connectWifi() {
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int attempt = 0; attempt < 20 && WiFi.status() != WL_CONNECTED; ++attempt) delay(500);
}

void fetchStatus() {
  if (WiFi.status() != WL_CONNECTED) { connectWifi(); if (WiFi.status() != WL_CONNECTED) { connectionError = "Wi-Fi indisponivel"; return; } }
  HTTPClient http; http.setTimeout(5000); http.begin(DISPLAY_API_URL); http.addHeader("X-Display-Token", DISPLAY_API_TOKEN);
  const int result = http.GET();
  if (result != HTTP_CODE_OK) { connectionError = "Hub respondeu HTTP " + String(result); http.end(); return; }
  const String body = http.getString(); http.end();
  statusDocument.clear();
  const DeserializationError error = deserializeJson(statusDocument, body);
  if (error) { connectionError = "Resposta invalida do Hub"; return; }
  dataReady = true; connectionError = "";
}

void handleTouchAndPaging() {
  uint16_t x, y;
  if (tft.getTouch(&x, &y) && millis() - lastTouch > 500) { currentPage = (currentPage + 1) % PAGE_COUNT; lastTouch = millis(); lastPageChange = millis(); renderPage(); }
  if (millis() - lastPageChange > PAGE_INTERVAL_MS) { currentPage = (currentPage + 1) % PAGE_COUNT; lastPageChange = millis(); renderPage(); }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  pinMode(TFT_BACKLIGHT_PIN, OUTPUT); digitalWrite(TFT_BACKLIGHT_PIN, HIGH);
  tft.init(); tft.setRotation(1); tft.fillScreen(COLOR_BACKGROUND); tft.setTextDatum(TL_DATUM);
  tft.setTextColor(COLOR_TEXT, COLOR_BACKGROUND); tft.setTextFont(4); tft.setCursor(40, 100); tft.print("PRODUCTION HUB");
  tft.setTextFont(2); tft.setTextColor(COLOR_ORANGE, COLOR_BACKGROUND); tft.setCursor(74, 135); tft.print("A ligar ao servidor...");
  connectWifi(); fetchStatus(); lastPoll = millis(); lastPageChange = millis(); renderPage();
}

void loop() {
  if (millis() - lastPoll > POLL_INTERVAL_MS) { fetchStatus(); lastPoll = millis(); renderPage(); }
  handleTouchAndPaging();
  delay(20);
}
