#include "EpdScreenDriver.h"

extern "C" {
  #include "lua/lua.h"
  #include "lua/lualib.h"
  #include "lua/lauxlib.h"
}

void EpdScreenDriver::begin() {
  if (_initialized) return;

  pinMode(44, OUTPUT);
  digitalWrite(44, LOW);      // PWROFF pulse, matches M5PaperS3 init

  bool ok = _display.begin();
  int w = _display.width(), h = _display.height();
  Serial.printf("[screen] begin()=%d panel=%dx%d\n", ok, w, h);
  if (!ok || w < 400 || h < 400) {
    Serial.println("[screen] !! init failed — panel left untouched");
    return;
  }
  _display.setRotation(1);    // 960x540 landscape

  // One clean full refresh to a known state (panel may still show the stock poem).
  _display.setEpdMode(epd_quality);
  _display.fillScreen(TFT_WHITE);
  _display.setTextColor(TFT_BLACK, TFT_WHITE);
  _display.setTextSize(4);
  _display.setCursor(40, 60);
  _display.println("Poem/1 Resident");
  _display.display();
  _lastFlipMs = millis();
  _initialized = true;
}

void EpdScreenDriver::update() {
  if (!_initialized || !_flipRequested) return;
  bool quality = _pendingQuality || _fastFlipCount >= FAST_FLIPS_PER_CLEAN;
  uint32_t minGap = quality ? QUALITY_MIN_MS : FAST_MIN_MS;
  if (millis() - _lastFlipMs < minGap) return;
  pushNow(quality);
}

void EpdScreenDriver::pushNow(bool quality) {
  _display.setEpdMode(quality ? epd_quality : epd_fast);
  _display.display();
  _lastFlipMs = millis();
  _flipRequested = false;
  _pendingQuality = false;
  _fastFlipCount = quality ? 0 : _fastFlipCount + 1;
}

void EpdScreenDriver::requestFlip(bool quality) {
  _flipRequested = true;
  if (quality) _pendingQuality = true;
}

void EpdScreenDriver::onAppReset() {
  if (!_initialized) return;
  // Fresh slate for the next app: white framebuffer + a pending clean refresh.
  // Coalesces with the app's own first flip (init usually draws immediately).
  _display.fillScreen(TFT_WHITE);
  requestFlip(true);
}

void EpdScreenDriver::displayText(const char* text) {
  if (_appRunning || !_initialized) return;
  Serial.printf("[screen] status: %s\n", text);
  _display.fillRect(0, 180, _display.width(), 280, TFT_WHITE);
  _display.setTextColor(TFT_BLACK, TFT_WHITE);
  _display.setTextSize(3);
  int y = 200;
  const char* p = text;
  while (*p) {
    const char* nl = strchr(p, '\n');
    size_t len = nl ? (size_t)(nl - p) : strlen(p);
    char line[96];
    if (len >= sizeof(line)) len = sizeof(line) - 1;
    memcpy(line, p, len);
    line[len] = '\0';
    _display.setCursor(40, y);
    _display.print(line);
    y += 40;
    p = nl ? nl + 1 : p + len;
  }
  // Push directly (pre-app there's no tick loop racing us), but respect the
  // rate limit so rapid state transitions don't stack refreshes.
  if (millis() - _lastFlipMs >= FAST_MIN_MS) {
    pushNow(false);
  } else {
    requestFlip(false);
  }
}

uint32_t EpdScreenDriver::grayColor(int g) {
  if (g < 0) g = 0;
  if (g > 255) g = 255;
  return lgfx::color888(g, g, g);
}

// screen.clear([gray]) — fill framebuffer; default white (255)
int EpdScreenDriver::clear(lua_State* L) {
  int g = (int)luaL_optinteger(L, 1, 255);
  _display.fillScreen(grayColor(g));
  return 0;
}

// screen.text(x, y, str, [size], [gray]) — defaults: size=3, black (0)
int EpdScreenDriver::text(lua_State* L) {
  int x = (int)luaL_checknumber(L, 1);
  int y = (int)luaL_checknumber(L, 2);
  const char* str = luaL_checkstring(L, 3);
  int size = (int)luaL_optinteger(L, 4, 3);
  int g = (int)luaL_optinteger(L, 5, 0);
  _display.setCursor(x, y);
  _display.setTextColor(grayColor(g));
  _display.setTextSize(size);
  _display.print(str);
  return 0;
}

// screen.fill_rect(x, y, w, h, [gray=0])
int EpdScreenDriver::fillRect(lua_State* L) {
  int x = (int)luaL_checknumber(L, 1);
  int y = (int)luaL_checknumber(L, 2);
  int w = (int)luaL_checknumber(L, 3);
  int h = (int)luaL_checknumber(L, 4);
  int g = (int)luaL_optinteger(L, 5, 0);
  _display.fillRect(x, y, w, h, grayColor(g));
  return 0;
}

// screen.rect(x, y, w, h, [gray=0])
int EpdScreenDriver::rect(lua_State* L) {
  int x = (int)luaL_checknumber(L, 1);
  int y = (int)luaL_checknumber(L, 2);
  int w = (int)luaL_checknumber(L, 3);
  int h = (int)luaL_checknumber(L, 4);
  int g = (int)luaL_optinteger(L, 5, 0);
  _display.drawRect(x, y, w, h, grayColor(g));
  return 0;
}

// screen.line(x0, y0, x1, y1, [gray=0])
int EpdScreenDriver::line(lua_State* L) {
  int x0 = (int)luaL_checknumber(L, 1);
  int y0 = (int)luaL_checknumber(L, 2);
  int x1 = (int)luaL_checknumber(L, 3);
  int y1 = (int)luaL_checknumber(L, 4);
  int g = (int)luaL_optinteger(L, 5, 0);
  _display.drawLine(x0, y0, x1, y1, grayColor(g));
  return 0;
}

// screen.pixel(x, y, [gray=0])
int EpdScreenDriver::pixel(lua_State* L) {
  int x = (int)luaL_checknumber(L, 1);
  int y = (int)luaL_checknumber(L, 2);
  int g = (int)luaL_optinteger(L, 3, 0);
  _display.drawPixel(x, y, grayColor(g));
  return 0;
}

// screen.circle(x, y, r, [gray=0])
int EpdScreenDriver::circle(lua_State* L) {
  int x = (int)luaL_checknumber(L, 1);
  int y = (int)luaL_checknumber(L, 2);
  int r = (int)luaL_checknumber(L, 3);
  int g = (int)luaL_optinteger(L, 4, 0);
  _display.drawCircle(x, y, r, grayColor(g));
  return 0;
}

// screen.fill_circle(x, y, r, [gray=0])
int EpdScreenDriver::fillCircle(lua_State* L) {
  int x = (int)luaL_checknumber(L, 1);
  int y = (int)luaL_checknumber(L, 2);
  int r = (int)luaL_checknumber(L, 3);
  int g = (int)luaL_optinteger(L, 4, 0);
  _display.fillCircle(x, y, r, grayColor(g));
  return 0;
}

// screen.triangle(x0, y0, x1, y1, x2, y2, [gray=0])
int EpdScreenDriver::triangle(lua_State* L) {
  int x0 = (int)luaL_checknumber(L, 1);
  int y0 = (int)luaL_checknumber(L, 2);
  int x1 = (int)luaL_checknumber(L, 3);
  int y1 = (int)luaL_checknumber(L, 4);
  int x2 = (int)luaL_checknumber(L, 5);
  int y2 = (int)luaL_checknumber(L, 6);
  int g = (int)luaL_optinteger(L, 7, 0);
  _display.drawTriangle(x0, y0, x1, y1, x2, y2, grayColor(g));
  return 0;
}

// screen.fill_triangle(x0, y0, x1, y1, x2, y2, [gray=0])
int EpdScreenDriver::fillTriangle(lua_State* L) {
  int x0 = (int)luaL_checknumber(L, 1);
  int y0 = (int)luaL_checknumber(L, 2);
  int x1 = (int)luaL_checknumber(L, 3);
  int y1 = (int)luaL_checknumber(L, 4);
  int x2 = (int)luaL_checknumber(L, 5);
  int y2 = (int)luaL_checknumber(L, 6);
  int g = (int)luaL_optinteger(L, 7, 0);
  _display.fillTriangle(x0, y0, x1, y1, x2, y2, grayColor(g));
  return 0;
}

// screen.flip([mode]) — request a panel refresh. mode: "fast" (default,
// partial) or "quality" (full clean refresh). Coalesced + rate-limited.
int EpdScreenDriver::flip(lua_State* L) {
  const char* mode = luaL_optstring(L, 1, "fast");
  requestFlip(strcmp(mode, "quality") == 0);
  return 0;
}

// screen.width() / screen.height()
int EpdScreenDriver::width(lua_State* L) {
  lua_pushinteger(L, _display.width());
  return 1;
}

int EpdScreenDriver::height(lua_State* L) {
  lua_pushinteger(L, _display.height());
  return 1;
}
