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

static constexpr const char* RESIDENT_HOST = "resident.inanimate.tech";
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
}
