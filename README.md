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

> [!NOTE]
> A one-command, guided **first-time install** (stock → Resident, with the
> safety timing handled for you) is still being finalized — we want to verify it
> end-to-end on a genuine factory-stock Poem/1 first. If you have a stock unit
> and would like to help validate it, please open an issue. For now, follow the
> two steps above and mind the hazard warning. Reflashing a device that already
> runs Resident is verified — see [Staying in sync](#staying-in-sync-with-resident).

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

### Where pushes go

A fresh clone pushes to the public relay at `resident.inanimate.tech`. That
relay has **no authentication** — anyone who knows your device ID can push code
to your Poem/1 — so this project runs its own hub instead.

[`server/`](server/) is a Cloudflare Worker (copied from Resident's
`server-template`) that speaks the same protocol. Deploy your own, then move the
device to it **over the air — no reflashing**:

```sh
cd server && npm install && npx wrangler deploy   # -> poem1-hub.<account>.workers.dev
cd ..
./set-hub.sh poem1-hub.<account>.workers.dev      # device switches live
./set-hub.sh --clear                              # back to the public relay
```

Which hub a device talks to is **runtime config**, stored in NVS — so one
firmware binary works for everybody, and moving hubs is a message rather than a
build. `set-hub.sh` also writes `.resident-hub-url` (gitignored) on success, so
`send-app.sh` follows the device to its new home; `--base-url URL` or `--dev`
still override per-push.

Once the device is on your hub it is **not** reachable on the public relay any
more. If it ever can't reach a stored hub, it falls back to the public relay for
the rest of that boot — keeping NVS intact and leaving you a way in — so a typo'd
hostname costs a reboot, never a reflash.

Why this matters, and where it's going:
[`docs/social-plan.md`](docs/social-plan.md).

## Staying in sync with Resident

Resident is a **dependency**, not a fork. `device/platformio.ini` points at
Resident's `main` branch (`git+https://github.com/inanimate-tech/resident.git#main`),
so you never clone, fork, or merge it — you just pull the latest into your build.
PlatformIO caches it after the first build, so use the helper:

```sh
./sync.sh                  # fetch latest Resident + rebuild
./sync.sh --flash          # + safely reflash over USB (quiesces the panel first)
./sync.sh --flash --force  # + skip the safety abort if the device is unreachable
```

That's the whole sync loop. Because this project never modifies Resident, there
are no merge conflicts — new Resident features just show up on the next `sync.sh`.

`--flash` protects the e-ink panel automatically: before esptool resets the
board it pushes `standby.lua` and waits for that refresh to finish, so the reset
can't land mid-refresh (which would damage the panel — see the warning above).
If it can't reach the device to quiesce it, `--flash` **aborts** rather than
flash blind; re-run with `--force` only when you can see the screen is already
idle or in its screensaver.

## Notes

- No fork, no core patches — this builds against unmodified Resident. (One
  consequence: timezone relies on Resident's network IANA lookup; if that's
  unreachable, local time falls back to UTC.)
- `device/partitions.csv` matches the stock Poem/1 layout, so a flash lands in
  an app slot and never clobbers NVS/SPIFFS.
- `sync.sh --flash` (reflashing a device already on Resident) quiesces the panel
  for you: it pushes `standby.lua`, waits for that refresh to finish, then
  flashes — so the reset can't land mid-refresh. It aborts rather than flash
  blind if it can't reach the device; `--force` overrides only when you can see
  the screen is already idle.
