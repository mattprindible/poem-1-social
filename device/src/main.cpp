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
#include "HubConfig.h"

// Which hub this device talks to is RUNTIME config (NVS), not compile-time, so
// one binary works for everyone and moving hubs is a message rather than a
// reflash. Push {"type":"set_hub","host":"..."} to change it; an empty host
// reverts to the default below. See HubConfig.h for why this matters.
//
// The default is the public relay, which is the right fallback for a fresh
// flash: it has NO authentication (anyone who knows your device ID can push
// code to it), so it is a bootstrap, not a destination. First thing to do on a
// new device is point it at a hub you own — see server/ and docs/social-plan.md.
static constexpr const char* DEFAULT_HUB_HOST = "resident.inanimate.tech";
static constexpr uint16_t RESIDENT_PORT = 443;

// The host actually used to connect. A fixed buffer, deliberately:
// Courier::Config stores `host` as a bare `const char*` and the Courier client
// is constructed during the global-ctor pass (before setup() can read NVS), so
// the pointer must be stable AND non-empty from the very start — Courier only
// auto-registers its WebSocket transport when the configured host is non-empty.
// We therefore hand it this buffer, seeded with the default, and overwrite the
// CONTENTS in setup() once NVS is readable. Courier re-reads it on every
// connect cycle, so a live hub switch is just a rewrite plus a reconnect.
static char g_activeHost[HubConfig::HOST_MAX] = "resident.inanimate.tech";

// True while g_activeHost holds a stored hub rather than the default.
static bool g_usingStoredHub = false;

static void setActiveHost(const char* host) {
    snprintf(g_activeHost, sizeof(g_activeHost), "%s", host);
}

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
    cfg.systemDisplay = &screenDriver;
    cfg.systemLED     = &ledDriver;      // hidden green LED shows connection state
    cfg.systemButton  = &buttonDriver;   // boot countdown: tap=load now, hold=forget
    // NB: don't set cfg.timezone — configure() runs in the global ctor,
    // pre-WiFi, so ezTime's network lookup always fails into UTC. The zone
    // is set in onConnected() instead (see setup()).
    // persistApps defaults to true: last app auto-restores after the countdown.

    // Courier::Config has a constructor with default args, so designated
    // initializers don't compile under strict ESP-IDF builds.
    Courier::Config courier;
    courier.host = g_activeHost;   // buffer, not a literal — see above
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

// ── Hub fallback ─────────────────────────────────────────────────────────
// A stored hub that can't be reached would otherwise be unrecoverable without
// a reflash — which is exactly the trap runtime config exists to avoid. So if
// we never connect within this window, drop back to the default relay for the
// REST OF THIS BOOT and reconnect there. NVS is left untouched, so the stored
// hub is retried on the next boot; meanwhile the device is reachable on the
// public relay, which is enough to push a corrected set_hub.
static constexpr uint32_t HUB_FALLBACK_MS = 45000;

static bool g_everConnected = false;
static bool g_fellBackToDefault = false;

// When the current hub attempt began. Measured from the attempt, NOT from boot:
// a hub set at t+2min would otherwise blow the deadline the instant it was
// applied, because millis() is already past it. (Observed exactly that.)
static uint32_t g_hubAttemptStartedMs = 0;

static void updateHubFallback() {
    if (g_everConnected || g_fellBackToDefault || !g_usingStoredHub) return;
    if (millis() - g_hubAttemptStartedMs < HUB_FALLBACK_MS) return;

    g_fellBackToDefault = true;
    Serial.printf("[hub] no connection to '%s' after %lus — falling back to %s "
                  "for this boot (stored hub kept; retried on next boot)\n",
                  g_activeHost, (unsigned long)(HUB_FALLBACK_MS / 1000),
                  DEFAULT_HUB_HOST);
    setActiveHost(DEFAULT_HUB_HOST);
    // Endpoint is re-applied by onTransportsWillConnect, which re-fires on
    // every reconnect cycle and reads g_activeHost.
    sandbox.courier().reconnect();
}

// ── Hub switching ────────────────────────────────────────────────────────
// {"type":"set_hub","host":"my-hub.example.workers.dev"}  → move to that hub
// {"type":"set_hub","host":""}                            → back to default
// Applied live: no reboot, so no risk of resetting the board mid-refresh.
static void handleSetHub(JsonDocument& doc) {
    const char* host = doc["host"] | "";

    if (host[0] == '\0') {
        HubConfig::clear();
        g_usingStoredHub = false;
        setActiveHost(DEFAULT_HUB_HOST);
        Serial.printf("[hub] cleared — reverting to %s\n", DEFAULT_HUB_HOST);
    } else if (!HubConfig::isValidHost(host)) {
        // Refuse rather than store something only a reflash could undo.
        Serial.printf("[hub] REJECTED '%s' — want a bare hostname "
                      "(no scheme, no path, no spaces)\n", host);
        return;
    } else if (!HubConfig::save(host)) {
        Serial.printf("[hub] FAILED to persist '%s'\n", host);
        return;
    } else {
        g_usingStoredHub = true;
        setActiveHost(host);
        Serial.printf("[hub] now pointing at %s\n", g_activeHost);
    }

    // A fresh hub deserves a fresh chance at the fallback timer — restart the
    // clock, don't just clear the flags, or the deadline is already blown.
    g_everConnected = false;
    g_fellBackToDefault = false;
    g_hubAttemptStartedMs = millis();
    sandbox.courier().reconnect();
}

void setup() {
    Serial.begin(115200);
    delay(2000);  // wait for USB CDC
    Serial.println("\n=== Poem/1 Resident ===");
    Serial.printf("free psram=%u\n", ESP.getFreePsram());

    // NVS is readable now (it was not during the global-ctor pass), so this is
    // the first point at which the stored hub can replace the default. Must
    // happen before sandbox.setup() kicks off the first connect.
    String storedHub = HubConfig::load();
    if (storedHub.length() > 0 && HubConfig::isValidHost(storedHub.c_str())) {
        setActiveHost(storedHub.c_str());
        g_usingStoredHub = true;
    }
    Serial.printf("[hub] %s (%s)\n", g_activeHost,
                  g_usingStoredHub ? "stored" : "default");

    // Override the default /agents/<type>-agent/<deviceId> path with the
    // canonical /devices/<deviceId> path the Resident relay protocol uses.
    // Re-fires on every reconnect, so it always reflects the current hub.
    sandbox.onTransportsWillConnect([]() {
        String wsPath = String("/devices/") + sandbox.getDeviceId();
        sandbox.ws().setEndpoint(g_activeHost, RESIDENT_PORT, wsPath.c_str());
    });

    // Control-plane messages Resident doesn't handle itself (it routes the
    // reserved app/shader/forget types internally) land here.
    //
    // Registered on BOTH paths deliberately. Since 0.7.0 a message stamped
    // channel:"system" reaches the "system" slot, while one with no channel
    // field takes the legacy onMessage path — and the two never overlap, so a
    // device registering only the new slot goes deaf to every sender that
    // hasn't been updated yet (an older hub, or a peer's hub we don't
    // control). Making the RECEIVER tolerant of both first, and stamping
    // senders afterwards, is what lets the two sides be rolled out
    // independently — which matters here because the device is reflashed over
    // USB while the hubs deploy separately. The legacy registration can be
    // dropped once every sender is known to stamp.
    auto handleControl = [](const char* /*transport*/, const char* type,
                            JsonDocument& doc) {
        if (strcmp(type, "set_hub") == 0) handleSetHub(doc);
    };
    sandbox.onMessageWithChannel("system", handleControl);  // channel:"system"
    sandbox.onMessage(handleControl);                       // legacy, un-channelled

    // ── Error reporting ──────────────────────────────────────────────────
    // Forward the sandbox's telemetry to the hub, which records it and serves
    // it at /hub/device/events. This is the half that needed a reflash: the
    // data-plane return path (events.send) has always been in stock Resident
    // and only needed the hub to listen, but telemetry is emitted by the
    // RUNTIME rather than by Lua, so nothing in an app could ever forward it.
    //
    // What it buys: a pushed app that fails to COMPILE used to fail silently.
    // The hub's push returned 200 (it delivered fine — the relay's job ended
    // there), the panel kept showing whatever was on it, and the only way to
    // learn why was a USB cable. That is a bad enough loop when the app is
    // yours; it is untenable once apps arrive from other people, because the
    // sender has no cable and the recipient has no reason to hold one.
    //
    // Verbatim rather than re-wrapped: the envelope is upstream's
    // ({type:"telemetry", generationId, name, data}), and translating it here
    // would invent a dialect this project would then have to keep in step with
    // Resident. The hub lifts `name` into its own column and keeps the raw
    // frame, so new telemetry names show up without a firmware change.
    //
    // Not routed through publishEvent deliberately: that shares a 5/s token
    // bucket with the app's own events.send, so an app erroring in a loop would
    // spend the budget it needs to report anything else. Errors must not be the
    // thing that silences the error channel. Upstream already rate-limits
    // on_tick errors at the source, which is the right place for it.
    //
    // sendText returns false when the socket is down (e.g. app_restored fires
    // during setup(), pre-WiFi). Dropping those is correct — this is a report,
    // not a queue, and a boot-time buffer would be a way to lose the panel to
    // a retry storm rather than a way to learn anything.
    sandbox.setTelemetryCallback([](const char* json) {
        sandbox.ws().sendText(json);
    });

    sandbox.onConnected([]() {
        g_everConnected = true;
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

    // Resident 0.7.0 shows an app's `description` field on systemDisplay the
    // moment a load message arrives. On a device with a separate status screen
    // that's free; here systemDisplay IS the e-ink the app draws to, so it
    // would cost an unrequested full refresh (~2-4s of waveform, plus panel
    // wear) on every push that happens to carry a description. Nothing we send
    // sets one today — but a social layer captioning its pushes is the obvious
    // next step, so decline up front rather than discover it on the panel.
    sandbox.setShowDescriptions(false);
    g_hubAttemptStartedMs = millis();  // start the fallback clock at first connect attempt
    sandbox.setup();
}

void loop() {
    sandbox.loop();
    updateEscapeHatch();
    updateHubFallback();
}
