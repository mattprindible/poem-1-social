#include "ProbeDrivers.h"
#include <Wire.h>

extern "C" {
  #include "lua/lua.h"
  #include "lua/lualib.h"
  #include "lua/lauxlib.h"
}

// ---------------------------------------------------------------- i2c

static constexpr int I2C_SDA = 41;
static constexpr int I2C_SCL = 42;

void I2cDriver::begin() {
  Wire.begin(I2C_SDA, I2C_SCL, 100000);
  Wire.setTimeOut(50);
  Serial.printf("[i2c] bus up SDA=%d SCL=%d @100kHz\n", I2C_SDA, I2C_SCL);
}

int I2cDriver::scan(lua_State* L) {
  lua_newtable(L);
  int n = 0;
  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    uint8_t err = Wire.endTransmission();
    if (err == 0) {
      n++;
      lua_pushinteger(L, addr);
      lua_rawseti(L, -2, n);
      Serial.printf("[i2c] found device at 0x%02X\n", addr);
    }
  }
  Serial.printf("[i2c] scan complete: %d device(s)\n", n);
  return 1;
}

int I2cDriver::read8(lua_State* L) {
  int addr = (int)luaL_checkinteger(L, 1);
  int reg  = (int)luaL_checkinteger(L, 2);
  Wire.beginTransmission((uint8_t)addr);
  Wire.write((uint8_t)reg);
  if (Wire.endTransmission(false) != 0) { lua_pushnil(L); return 1; }
  if (Wire.requestFrom((uint8_t)addr, (uint8_t)1) != 1) { lua_pushnil(L); return 1; }
  lua_pushinteger(L, Wire.read());
  return 1;
}

int I2cDriver::readn(lua_State* L) {
  int addr = (int)luaL_checkinteger(L, 1);
  int reg  = (int)luaL_checkinteger(L, 2);
  int n    = (int)luaL_checkinteger(L, 3);
  if (n < 1) n = 1;
  if (n > 32) n = 32;
  Wire.beginTransmission((uint8_t)addr);
  Wire.write((uint8_t)reg);
  if (Wire.endTransmission(false) != 0) { lua_pushnil(L); return 1; }
  int got = Wire.requestFrom((uint8_t)addr, (uint8_t)n);
  if (got == 0) { lua_pushnil(L); return 1; }
  lua_newtable(L);
  for (int i = 0; i < got; i++) {
    lua_pushinteger(L, Wire.read());
    lua_rawseti(L, -2, i + 1);
  }
  return 1;
}

// ---------------------------------------------------------------- gpio

static bool applyPull(int pin, const char* pull) {
  if (strcmp(pull, "up") == 0)        pinMode(pin, INPUT_PULLUP);
  else if (strcmp(pull, "down") == 0) pinMode(pin, INPUT_PULLDOWN);
  else if (strcmp(pull, "none") == 0) pinMode(pin, INPUT);
  else return false;
  return true;
}

int GpioDriver::read(lua_State* L) {
  int pin = (int)luaL_checkinteger(L, 1);
  const char* pull = luaL_optstring(L, 2, "none");
  if (!PoemPins::gpioAllowed(pin) || !applyPull(pin, pull)) {
    lua_pushnil(L);
    return 1;
  }
  delayMicroseconds(50);  // let the pull settle
  lua_pushinteger(L, digitalRead(pin));
  return 1;
}

int GpioDriver::pulseStats(lua_State* L) {
  int pin = (int)luaL_checkinteger(L, 1);
  int ms  = (int)luaL_optinteger(L, 2, 200);
  const char* pull = luaL_optstring(L, 3, "none");
  if (ms < 1) ms = 1;
  if (ms > 1000) ms = 1000;
  if (!PoemPins::gpioAllowed(pin) || !applyPull(pin, pull)) {
    lua_pushnil(L);
    return 1;
  }
  delayMicroseconds(50);
  uint32_t start = millis();
  int last = digitalRead(pin);
  uint32_t transitions = 0, highSamples = 0, samples = 0;
  while (millis() - start < (uint32_t)ms) {
    int v = digitalRead(pin);
    if (v != last) { transitions++; last = v; }
    if (v) highSamples++;
    samples++;
  }
  int highPct = samples ? (int)((highSamples * 100) / samples) : 0;
  Serial.printf("[gpio] pin %d over %dms (pull=%s): %u transitions, high %d%%\n",
                pin, ms, pull, transitions, highPct);
  lua_pushinteger(L, transitions);
  lua_pushinteger(L, highPct);
  return 2;
}

// ---------------------------------------------------------------- adc

int AdcDriver::mv(lua_State* L) {
  int pin = (int)luaL_checkinteger(L, 1);
  if (!PoemPins::adcAllowed(pin)) {
    lua_pushnil(L);
    return 1;
  }
  uint32_t mv = analogReadMilliVolts(pin);
  lua_pushinteger(L, (lua_Integer)mv);
  return 1;
}

// ---------------------------------------------------------------- led

void PoemLedDriver::write(uint8_t v) {
  if (!_attached) {
    ledcSetup(CHANNEL, 5000, 8);
    ledcAttachPin(PIN, CHANNEL);
    _attached = true;
  }
  ledcWrite(CHANNEL, v);
}

void PoemLedDriver::onAppReset() {
  write(0);
}

void PoemLedDriver::solidColor(uint32_t color) {
  if (_appRunning) return;  // Lua owns the LED once an app loads
  uint8_t r = (color >> 16) & 0xFF, g = (color >> 8) & 0xFF, b = color & 0xFF;
  write((uint8_t)((r + g + b) / 3));
}

int PoemLedDriver::set(lua_State* L) {
  int v = (int)luaL_checkinteger(L, 1);
  if (v < 0) v = 0;
  if (v > 255) v = 255;
  write((uint8_t)v);
  return 0;
}
