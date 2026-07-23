// Poem/1 Resident — flash once, then push Lua apps over the network forever.
//
// Replaces the stock poem.town firmware with a Resident sandbox: WiFi (creds
// reused from NVS — same esp-idf storage the stock firmware used), WebSocket
// to the Resident relay, and a Lua runtime with the e-ink + button exposed as
// modules. See DEVICE-SKILL.md for the Lua surface.

#include <Arduino.h>
#include <Resident.h>
#include "PoemDisplay.h"
#include "EpdScreenDriver.h"
#include "ButtonDriver.h"
#include "ProbeDrivers.h"

// Your own hub (server/), not the public relay at resident.inanimate.tech.
// On the public relay the device ID is effectively the credential — anyone who
// knows it can push code — so self-hosting comes before anything social. See
// docs/social-plan.md.
//
// Compile-time on purpose: one owner points at one hub for months at a time.
// Two consequences to remember. Moving hubs needs a reflash, and distributing
// this to other people means per-person builds rather than one shared binary.
//
// TODO before this repo goes public: this is a personal workers.dev subdomain.
// Parameterise it (build flag with the public relay as the default) so a fresh
// clone doesn't ship someone else's hub.
static constexpr const char* RESIDENT_HOST = "poem1-hub.service-cloudflare-442.workers.dev";
static constexpr uint16_t RESIDENT_PORT = 443;

static constexpr uint8_t BUTTON_PIN = 2;

Poem_Display poemDisplay;
EpdScreenDriver screenDriver{poemDisplay};
ButtonDriver buttonDriver{BUTTON_PIN};
I2cDriver i2cDriver;
GpioDriver gpioDriver;
AdcDriver adcDriver;
PoemLedDriver ledDriver;

Resident::SandboxConfig makeConfig() {
    Resident::SandboxConfig cfg;
    cfg.deviceType    = "poem1";
    cfg.extensions    = {&screenDriver, &buttonDriver, &i2cDriver,
                         &gpioDriver, &adcDriver, &ledDriver};
    cfg.statusDisplay = &screenDriver;
    cfg.statusLED     = &ledDriver;      // hidden green LED shows connection state
    cfg.systemButton  = &buttonDriver;   // boot countdown: tap=load now, hold=forget
    // NB: don't set cfg.timezone — configure() runs in the global ctor,
    // pre-WiFi, so ezTime's network lookup always fails into UTC. The zone
    // is set in onConnected() instead (see setup()).
    // persistApps defaults to true: last app auto-restores after the countdown.

    // Courier::Config has a constructor with default args, so designated
    // initializers don't compile under strict ESP-IDF builds.
    Courier::Config courier;
    courier.host = RESIDENT_HOST;
    courier.port = RESIDENT_PORT;
    cfg.network  = courier;

    return cfg;
}

Resident::Sandbox sandbox{makeConfig()};

// ── Runtime escape hatch ─────────────────────────────────────────────────
// Hold the button while an app is running to stop it AND forget it, so a bad
// app can't hold the device hostage. Matters once apps can arrive from other
// people rather than only from you — see docs/social-plan.md.
//
// Resident exposes sandbox.onSystemButtonHold(), but its threshold is a fixed
// 500ms, which is too short here: this same button is also the app-facing Lua
// `button` module, so any app using a half-second press would kill itself. So
// we time the hold ourselves off the same primitive the runtime uses —
// ButtonDriver::pressed(), a debounced *level* read polled from the main loop.
// That never passes through Lua's event dispatch, so an app cannot swallow the
// gesture by consuming button events. (Making the runtime's threshold
// configurable is a good upstream contribution; then this collapses to the
// stock hook.)
//
// Inert during the boot countdown, where no app is loaded yet and the runtime
// owns the button for its own tap/long-press gestures.
//
// NOT a defence against an app that wedges the Lua VM in a tight loop — the
// main loop never runs then. Power-cycling is the backstop, and the
// clearPersistedApp() below is what stops the bad app coming straight back.
static constexpr uint32_t ESCAPE_HOLD_MS = 3000;

static void updateEscapeHatch() {
    static uint32_t downSince = 0;
    static bool fired = false;

    if (!buttonDriver.pressed()) {
        downSince = 0;
        fired = false;
        return;
    }
    if (downSince == 0) {
        downSince = millis();  // press started
        return;
    }
    if (fired || millis() - downSince < ESCAPE_HOLD_MS) return;

    fired = true;  // one shot per press, whether or not there's an app to stop
    if (!sandbox.isAppRunning()) return;

    Serial.println("[escape] button held — stopping and forgetting the app");
    sandbox.suspendApp();         // halt on_tick + event dispatch
    sandbox.clearPersistedApp();  // ...and don't restore it on the next boot
    // suspendApp() frees the status display, so this now reaches the panel.
    screenDriver.displayText("App stopped\n\nHeld the button.\nPush a new app to continue.");
}

void setup() {
    Serial.begin(115200);
    delay(2000);  // wait for USB CDC
    Serial.println("\n=== Poem/1 Resident ===");
    Serial.printf("free psram=%u\n", ESP.getFreePsram());

    // Override the default /agents/<type>-agent/<deviceId> path with the
    // canonical /devices/<deviceId> path used by resident.inanimate.tech.
    sandbox.onTransportsWillConnect([]() {
        String wsPath = String("/devices/") + sandbox.getDeviceId();
        sandbox.ws().setEndpoint(RESIDENT_HOST, RESIDENT_PORT, wsPath.c_str());
    });

    sandbox.onConnected([]() {
        Serial.printf("[resident] connected, device id: %s\n", sandbox.getDeviceId().c_str());
        // Timezone lookup needs the network up, so it lives here rather than
        // in SandboxConfig (whose configure() runs pre-WiFi). Guarded so
        // reconnects don't re-query. Uses stock Resident's IANA lookup (ezTime
        // via timezoned.rop.nl); if that service is unreachable the zone stays
        // UTC — an accepted tradeoff for depending on unmodified Resident.
        if (!sandbox.hasTimezone()) {
            sandbox.setTimezone("America/New_York");
        }
    });

    // The runtime's idle screen shows device ID + type (and the restore
    // countdown when an app is persisted); no bootstrap app needed anymore.
    sandbox.setIdleScreenTitle("Poem/1 Resident");
    sandbox.setup();
}

void loop() {
    sandbox.loop();
    updateEscapeHatch();
}
