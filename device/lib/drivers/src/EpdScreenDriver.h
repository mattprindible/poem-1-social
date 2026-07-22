#ifndef EPD_SCREEN_DRIVER_H
#define EPD_SCREEN_DRIVER_H

#include <ResidentDriver.h>
#include <ResidentLuaModule.h>
#include <ResidentStatusDisplay.h>
#include "PoemDisplay.h"

// Resident StatusDisplay (which is a Driver) wrapping the Poem/1 e-ink panel:
// Lua screen.* module + connection-state/idle-screen text during boot
// (suppressed once an app is running).
//
// E-ink specifics: draw calls render into the panel framebuffer only —
// nothing appears until screen.flip(). Flips are coalesced and rate-limited
// in update() so a Lua app ticking at 10 FPS can't thrash the panel: the
// latest framebuffer state is pushed once the minimum interval has passed.
// flip("quality") does a full clean refresh; flip() / flip("fast") does a
// quick partial update. After many consecutive fast flips the driver upgrades
// one flip to quality to clear accumulated ghosting.
//
// Colours are grayscale 0-255 (0 = black, 255 = white).
class EpdScreenDriver : public Resident::StatusDisplay {
public:
  explicit EpdScreenDriver(Poem_Display& display) : _display(display) {}

  const char* name() const override { return "screen"; }

  void registerModule(Resident::LuaModule& m) override {
    m.method<EpdScreenDriver, &EpdScreenDriver::clear>("clear")
     .method<EpdScreenDriver, &EpdScreenDriver::text>("text")
     .method<EpdScreenDriver, &EpdScreenDriver::fillRect>("fill_rect")
     .method<EpdScreenDriver, &EpdScreenDriver::rect>("rect")
     .method<EpdScreenDriver, &EpdScreenDriver::line>("line")
     .method<EpdScreenDriver, &EpdScreenDriver::pixel>("pixel")
     .method<EpdScreenDriver, &EpdScreenDriver::circle>("circle")
     .method<EpdScreenDriver, &EpdScreenDriver::fillCircle>("fill_circle")
     .method<EpdScreenDriver, &EpdScreenDriver::triangle>("triangle")
     .method<EpdScreenDriver, &EpdScreenDriver::fillTriangle>("fill_triangle")
     .method<EpdScreenDriver, &EpdScreenDriver::flip>("flip")
     .method<EpdScreenDriver, &EpdScreenDriver::width>("width")
     .method<EpdScreenDriver, &EpdScreenDriver::height>("height");
  }

  void begin() override;
  // Pushes any pending flip once the rate limit allows.
  void update() override;

  void onAppReset() override;
  void onAppRunning(bool running) override { _appRunning = running; }

  // Resident::StatusDisplay — connection-state / idle-screen text during
  // boot. Multi-line ('\n'-separated: idle screen sends title, device ID,
  // type, countdown).
  void displayText(const char* text) override;

private:
  static constexpr uint32_t FAST_MIN_MS    = 400;   // min gap between partial refreshes
  static constexpr uint32_t QUALITY_MIN_MS = 1500;  // min gap before a full refresh
  static constexpr int      FAST_FLIPS_PER_CLEAN = 60;  // ghosting control

  Poem_Display& _display;
  bool _initialized  = false;
  bool _appRunning   = false;
  bool _flipRequested = false;
  bool _pendingQuality = false;
  int  _fastFlipCount = 0;
  uint32_t _lastFlipMs = 0;

  void requestFlip(bool quality);
  void pushNow(bool quality);
  static uint32_t grayColor(int g);

  int clear(lua_State* L);
  int text(lua_State* L);
  int fillRect(lua_State* L);
  int rect(lua_State* L);
  int line(lua_State* L);
  int pixel(lua_State* L);
  int circle(lua_State* L);
  int fillCircle(lua_State* L);
  int triangle(lua_State* L);
  int fillTriangle(lua_State* L);
  int flip(lua_State* L);
  int width(lua_State* L);
  int height(lua_State* L);
};

#endif // EPD_SCREEN_DRIVER_H
