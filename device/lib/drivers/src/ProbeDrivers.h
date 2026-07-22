#ifndef PROBE_DRIVERS_H
#define PROBE_DRIVERS_H

#include <Arduino.h>
#include <ResidentDriver.h>
#include <ResidentLuaModule.h>
#include <ResidentStatusLED.h>

// Hardware-exploration modules for Poem/1 (M5PaperS3-class). These expose
// read-mostly primitives to Lua so novel hardware can be probed live over
// the network instead of reflashing probe firmwares.
//
// SAFETY: Lua must never be able to reconfigure pins that would corrupt the
// EPD bus (6-18, 44-46), the octal PSRAM (26-37), SPI flash, or USB (19/20).
// Every pin-taking method checks pinAllowed() first and returns nil on refusal.

namespace PoemPins {
  // Pins Lua may read / pulse-sample: candidates from the M5PaperS3 map that
  // are not display, PSRAM, flash, USB, power-hold, or already-owned pins.
  // 0=LED?, 1=Grove, 3=battery ADC, 4=CHG_STAT, 5=?, 21=buzzer?,
  // 38/39/40/47=SD, 43/48=spare.
  inline bool gpioAllowed(int pin) {
    switch (pin) {
      case 0: case 1: case 3: case 4: case 5: case 21:
      case 38: case 39: case 40: case 43: case 47: case 48:
        return true;
      default:
        return false;
    }
  }
  // ADC1 = GPIO 1-10 on ESP32-S3, but 2 is the button and 6-10 are EPD data.
  inline bool adcAllowed(int pin) {
    return pin == 1 || pin == 3 || pin == 4 || pin == 5;
  }
}

// i2c.* — internal bus SDA=41 SCL=42 (timeout-hardened; the naive scanner
// from the hw-probe days hung on endTransmission).
class I2cDriver : public Resident::Driver {
public:
  const char* name() const override { return "i2c"; }
  void registerModule(Resident::LuaModule& m) override {
    m.method<I2cDriver, &I2cDriver::scan>("scan")
     .method<I2cDriver, &I2cDriver::read8>("read8")
     .method<I2cDriver, &I2cDriver::readn>("readn");
  }
  void begin() override;

private:
  int scan(lua_State* L);   // i2c.scan() -> array of responding addresses
  int read8(lua_State* L);  // i2c.read8(addr, reg) -> byte | nil
  int readn(lua_State* L);  // i2c.readn(addr, reg, n<=32) -> array of bytes | nil
};

// gpio.* — input-only pin inspection on allowlisted pins.
class GpioDriver : public Resident::Driver {
public:
  const char* name() const override { return "gpio"; }
  void registerModule(Resident::LuaModule& m) override {
    m.method<GpioDriver, &GpioDriver::read>("read")
     .method<GpioDriver, &GpioDriver::pulseStats>("pulse_stats");
  }

private:
  int read(lua_State* L);       // gpio.read(pin, [pull "none"|"up"|"down"]) -> 0|1|nil
  int pulseStats(lua_State* L); // gpio.pulse_stats(pin, ms<=1000, [pull])
                                //   -> transitions, high_pct | nil
};

// adc.* — millivolt reads on safe ADC1 pins.
class AdcDriver : public Resident::Driver {
public:
  const char* name() const override { return "adc"; }
  void registerModule(Resident::LuaModule& m) override {
    m.method<AdcDriver, &AdcDriver::mv>("mv");
  }

private:
  int mv(lua_State* L);  // adc.mv(pin) -> millivolts | nil
};

// led.* — the green LED on GPIO0 (confirmed: inside the enclosure, visible
// through a mounting hole). Doubles as the Resident StatusLED: connection
// states glow the LED (color mapped to brightness — it's monochrome) until a
// Lua app loads and takes ownership via led.set().
class PoemLedDriver : public Resident::StatusLED {
public:
  const char* name() const override { return "led"; }
  void registerModule(Resident::LuaModule& m) override {
    m.method<PoemLedDriver, &PoemLedDriver::set>("set");
  }
  void onAppReset() override;
  void onAppRunning(bool running) override { _appRunning = running; }

  // Resident::StatusLED — 0xRRGGBB; we only have brightness to work with.
  void solidColor(uint32_t color) override;

private:
  static constexpr int PIN = 0;
  static constexpr int CHANNEL = 6;
  bool _attached = false;
  bool _appRunning = false;

  void write(uint8_t v);
  int set(lua_State* L);  // led.set(0-255)
};

#endif // PROBE_DRIVERS_H
