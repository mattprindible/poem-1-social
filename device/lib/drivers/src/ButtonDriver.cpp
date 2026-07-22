#include "ButtonDriver.h"
#include <Arduino.h>

extern "C" {
  #include "lua/lua.h"
  #include "lua/lualib.h"
  #include "lua/lauxlib.h"
}

void ButtonDriver::begin() {
  pinMode(_pin, INPUT_PULLUP);
  _lastState = digitalRead(_pin);
  Serial.printf("[button] GPIO %d ready\n", _pin);
}

void ButtonDriver::update() {
  bool current = digitalRead(_pin);
  unsigned long now = millis();

  if (current == LOW && _lastState == HIGH) {
    if (now - _lastDebounceTime > DEBOUNCE_MS) {
      _lastDebounceTime = now;
      _down = true;
    }
  }

  if (current == HIGH && _lastState == LOW) {
    if (_down) {
      _down = false;
      _pressCount++;
      Resident::EventField fields[] = {
        {"count", Resident::EventField::INT, {.i = _pressCount}}
      };
      sendEvent("button", fields, 1);
      Serial.printf("[button] pressed (count=%d)\n", _pressCount);
    }
  }

  _lastState = current;
}

int ButtonDriver::pressCount(lua_State* L) {
  lua_pushinteger(L, _pressCount);
  return 1;
}

int ButtonDriver::isDown(lua_State* L) {
  lua_pushboolean(L, _down);
  return 1;
}
