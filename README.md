# Poem/1 — Resident

Run [Resident](https://github.com/inanimate-tech/resident) on a
[Poem/1](https://poem.town). Flash this firmware once and your Poem/1 becomes a
sandboxed Lua device you push apps to over Wi-Fi — no reflashing to iterate.

Poem/1 and Resident are both by Matt Webb, and this project treats the Poem/1 as
**just another ESP32 board**: it depends on **stock, unmodified Resident** and
expresses the Poem/1's hardware as Resident `Driver` subclasses. When Resident
grows, you sync by pulling the latest and rebuilding — nothing here is forked.

This directory is shaped like a Resident `examples/<board>/` project so it can
live standalone or drop straight into a Resident checkout.

## What maps to what

The Poem/1's three quirks are expressed in Resident's own terms
(`device/lib/drivers/`), and wired up in `device/src/main.cpp`:

| Poem/1 hardware            | Resident role   | Driver              |
|----------------------------|-----------------|---------------------|
| ED047TC1 4.7" e-ink (M5GFX)| `statusDisplay` | `EpdScreenDriver`   |
| Hidden green LED (GPIO0)   | `statusLED`     | `PoemLedDriver`     |
| Button (GPIO2)             | `systemButton`  | `ButtonDriver`      |

Plus `i2c` / `gpio` / `adc` probe modules for exploring the board from Lua.
The Lua surface (screen/button/led/lifecycle) is documented in
[`DEVICE-SKILL.md`](DEVICE-SKILL.md).

## Prerequisites

- A Poem/1 (ESP32-S3, 16MB flash, 8MB OPI PSRAM).
- [PlatformIO Core](https://platformio.org/install) (`pio`).
- `curl` + `jq` for pushing apps.
- A USB-C cable for the one-time flash.

## Flash it (one time)

```sh
cd device
pio run -e poem1            # build against the latest Resident (main)
pio run -e poem1 -t upload  # flash over USB
```

> [!WARNING]
> **E-ink flash hazard.** The Poem/1's e-ink panel can be physically damaged if
> power is cut or the board is reset *during a screen refresh*. The stock
> poem.town firmware refreshes on a network poll, so before flashing over it,
> flash while the screen is idle (in its screensaver, or right after a refresh
> completes). Once this Resident firmware is running it only refreshes when a
> Lua app draws, so subsequent reflashes are safe when no app is active.

On first boot it reuses the Wi-Fi credentials already in NVS (same storage the
stock firmware used), connects to the Resident relay, and shows an idle screen
with the **device ID** — you'll need that to push apps.

## Push apps (forever after)

```sh
# device ID is read from ./.resident-device-id, or pass --device-id <id>
./send-app.sh device-apps/minute-clock.lua
cat my-app.lua | ./send-app.sh --device-id <id>
```

Apps in [`device-apps/`](device-apps/): `minute-clock`, `battery-watch`,
`hello-status`, `first-light`, `hw-survey`, `standby`.

Pushes go to the public relay at `resident.inanimate.tech` by default; use
`--base-url` to target a self-hosted worker.

## Staying in sync with Resident

Resident is a **dependency**, not a fork. `device/platformio.ini` points at
Resident's `main` branch (`git+https://github.com/inanimate-tech/resident.git#main`),
so you never clone, fork, or merge it — you just pull the latest into your build.
PlatformIO caches it after the first build, so use the helper:

```sh
./sync.sh           # fetch latest Resident + rebuild
./sync.sh --flash   # fetch latest Resident + rebuild + reflash over USB
```

That's the whole sync loop. Because this project never modifies Resident, there
are no merge conflicts — new Resident features just show up on the next `sync.sh`.

## Notes

- No fork, no core patches — this builds against unmodified Resident. (One
  consequence: timezone relies on Resident's network IANA lookup; if that's
  unreachable, local time falls back to UTC.)
- `device/partitions.csv` matches the stock Poem/1 layout, so a flash lands in
  an app slot and never clobbers NVS/SPIFFS.
