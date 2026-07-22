#ifndef BUTTON_DRIVER_H
#define BUTTON_DRIVER_H

#include <Arduino.h>
#include <ResidentSystemButton.h>
#include <ResidentLuaModule.h>

// Poem/1's single physical button (GPIO 2, active-low), in two roles:
//  - Resident::SystemButton — the runtime polls pressed() for boot-countdown
//    gestures (tap = load saved app now, long-press = forget it).
//  - App-facing "button" Lua module: debounced releases emit a "button" event
//    with the cumulative press count.
class ButtonDriver : public Resident::SystemButton {
public:
  explicit ButtonDriver(uint8_t pin) : _pin(pin) {}

  const char* name() const override { return "button"; }

  void registerModule(Resident::LuaModule& m) override {
    m.method<ButtonDriver, &ButtonDriver::pressCount>("press_count")
     .method<ButtonDriver, &ButtonDriver::isDown>("is_down");
  }

  void begin() override;
  void update() override;
  void onAppReset() override { _pressCount = 0; }

  // Resident::SystemButton — debounced level read.
  bool pressed() override { return _down; }

private:
  static constexpr unsigned long DEBOUNCE_MS = 40;

  uint8_t _pin;
  bool _lastState = true;
  bool _down = false;
  unsigned long _lastDebounceTime = 0;
  int _pressCount = 0;

  int pressCount(lua_State* L);
  int isDown(lua_State* L);
};

#endif // BUTTON_DRIVER_H
