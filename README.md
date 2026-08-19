# Poem/1 — Resident, and a social layer for it

Run [Resident](https://github.com/inanimate-tech/resident) on a
[Poem/1](https://poem.town). Flash this firmware once and your Poem/1 becomes a
sandboxed Lua device you push apps to over Wi-Fi — no reflashing to iterate.

Then, optionally, let **people you follow** push apps to it too. The bet: trust
implicit in a social graph affords more than an untrusted sandbox model normally
allows — enough to let mutuals deploy code to each other's devices, while you
keep a physical button that stops anything, instantly, whoever sent it. See
[`docs/social-plan.md`](docs/social-plan.md).

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
| ED047TC1 4.7" e-ink (M5GFX)| `systemDisplay` | `EpdScreenDriver`   |
| Hidden green LED (GPIO0)   | `systemLED`     | `PoemLedDriver`     |
| Button (GPIO2)             | `systemButton`  | `ButtonDriver`      |

> [!NOTE]
> This board tracks **Resident 0.8.0-dev** (see [`sync.sh`](sync.sh)).
> `systemDisplay` / `systemLED` were `statusDisplay` / `statusLED` before
> Resident 0.7.0. The old names still compile as deprecated aliases, so an older
> example you copy from will work — but they are the ones going away.

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

> [!NOTE]
> Pushing to **your own** hub needs the owner credential, which `send-app.sh`
> picks up from `$HUB_ADMIN_TOKEN` or the macOS keychain automatically. The
> public relay needs none. If you get a 401, the token for that hub isn't on
> this machine — see [`server/README.md`](server/README.md).

Apps in [`device-apps/`](device-apps/): `minute-clock`, `hw-survey` (probes the
board from Lua), `nightfall` (a still night scene, drawn once and left alone —
the calmest thing to leave on the panel), `standby`, `phone-home` (reports back
to the hub — see [Hearing the device](#hearing-the-device)), and two things
other people's hubs made — `note-from-a-friend` and `san-map` — kept because
they are what the social layer working actually looks like.

Plus three test fixtures: `runaway` (misbehaves deliberately, to exercise the
escape hatch), `wont-compile` (fails deliberately, to exercise the error
channel; safe to push — it never draws) and `federated-hello` (renders who
pushed it, used by [`test-federation.sh`](test-federation.sh)).

> [!TIP]
> **Hold the button for ~3 seconds to stop whatever is running** and forget it,
> so it does not return after a reboot. It is polled outside Lua's event
> dispatch, so an app cannot suppress it. That matters most once apps can arrive
> from other people — see below.

### Where pushes go

A fresh clone pushes to the public relay at `resident.inanimate.tech`. That
relay has **no authentication** — anyone who knows your device ID can push code
to your Poem/1 — so this project runs its own hub instead.

Your own hub **does** authenticate, as of 2026-08-05. Pushing needs the owner's
credential, and a hub only carries devices you have explicitly **claimed**:

```sh
./apps.sh devices                          # what this hub carries
./apps.sh claim fccf2990 --name "desk"     # start carrying one
./apps.sh release fccf2990                 # stop
```

An unclaimed device ID gets nothing — no socket, no traffic — so nobody can
squat an ID or use your hub as an open relay.

> [!NOTE]
> One gap remains, and it is worth knowing: a device proves who it is with
> nothing but its ID. Anyone who knows a **claimed** ID can still open that
> device's socket and receive its apps. Closing that needs a per-device secret
> in firmware, which means a reflash — see [`docs/san.md`](docs/san.md). The
> 3-second hold stops anything that lands, whoever sent it.

[`server/`](server/) is a Cloudflare Worker (copied from Resident's
`server-template`) that speaks the same protocol. Deploy your own, then move the
device to it **over the air — no reflashing**:

```sh
cd server && npm install && npx wrangler deploy   # -> <name>.<account>.workers.dev
cd ..
./set-hub.sh <name>.<account>.workers.dev         # device switches live
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

### Hearing the device

Pushes go one way; the device's own reports come back the other. A Lua app calls
stock Resident's `events.send(name, data)`, and the hub records what arrives:

```sh
curl -H "Authorization: Bearer $HUB_ADMIN_TOKEN" https://<your-hub>/hub/device/events
```

```json
{ "deviceId": "…", "deviceConnected": true, "lastEventAt": 1785895724053,
  "events": [ { "seq": 1, "at": 1785895724053, "channel": "app",
                "type": "heartbeat", "body": "{…}" } ] }
```

Owner-gated, not device-ID-gated: a device ID is the credential for *pushing* to
a device, but what a device *emits* is yours. `./send-app.sh device-apps/phone-home.lua`
is a working example — it says hello on load, heartbeats slowly, and reports
every button tap.

Prefer `lastEventAt` to `deviceConnected` as proof of life. Durable Objects keep
hibernating WebSockets from old boots, so the connection count can report a
device that left hours ago; a recorded event cannot.

On every connect the device announces itself and names the hub it thinks it
reached — `{"type":"hello","host":"…","stored":true,"fellback":false}`. That is
what `set-hub.sh` now waits for, so a hub switch is confirmed by the device
rather than inferred from a connection count. When it can't (no owner token for
the destination, or a destination not running this hub's code — the public relay,
say) it falls back to counting and says so.

Since 0.8.0-dev there are **two** frames called `hello` on the system channel:
Resident's own (`protocol`, `deviceType`, `bootId`, `limits`) and this board's
(`host`, `stored`, `fellback`). Ours arrives first — `onConnected` fires at
connect, while Resident's drains on the next `loop()`. Anything matching on
`type == "hello"` must therefore key off a field it actually needs rather than
the type alone; `set-hub.sh` selects on `.host` for exactly this reason.

The app-event side needed no reflash — `events.send` was in the firmware all
along and only the hub had to listen. See
[`server/src/device-agent.ts`](server/src/device-agent.ts).

**Errors come back on the same path.** The runtime reports its own failures, so
a pushed app that fails no longer fails silently:

```sh
./send-app.sh device-apps/wont-compile.lua   # a fixture that is meant to fail
```

```json
{ "channel": "system", "type": "telemetry",
  "data": { "name": "compile_error", "generationId": "caf80",
            "error": "[string \"…\"]:25: unfinished string near …" } }
```

Names are `app_received`, `app_compiled`, `compile_error`, `runtime_error`,
`log_error`, `app_restored`, and the hub lifts `name` into its own column so
errors are greppable.

This used to be the one half that needed a reflash: telemetry comes from the
runtime rather than from Lua, so nothing in an app could forward it, and this
board did it in `main.cpp`. **Resident 0.8.0-dev sends it upstream itself**, so
that forwarder was deleted — keeping it would have written every failure twice.
`name` moved into `data` in the same change; `device-agent.ts` reads both, top
level first, so a device on either firmware records correctly.

## The social layer

Once you own a hub, it can carry an identity — and once it has one, other
people's hubs can find it, verify it, and (if you follow each other) push apps to
your device.

```sh
cd server
# Run the script directly: `npm run gen-key |` pipes npm's own banner into
# the secret, and the hub then reports HUB_PRIVATE_JWK as invalid JSON.
node scripts/gen-key.mjs | npx wrangler secret put HUB_PRIVATE_JWK
npx wrangler deploy
```

Then open `https://<your-hub>/oauth/login` and sign in with Bluesky. The first
account to sign in **claims** the hub; afterwards only that DID may. Signing in
publishes a record into your own atproto repo:

```
at://<your-did>/computer.haha.san.hub/self
```

That single record does three jobs — **discovery** (where your hub is),
**authentication** (which key speaks for you), and **revocation** (delete it and
the old key is dead). It lives in your repo rather than in the hub, so it
outlives the Worker, the hostname, and this project. Moving hubs is a record
update.

Discovery needs no index and no account:

```sh
curl https://<your-hub>/hub/peer/someone.bsky.social
```

That resolves handle → DID → PDS → their hub record, entirely from public
infrastructure.

### Apps are records too

`send-app.sh` pushes a *file*. That is the right tool while you are iterating
with the thing in front of you, but it has no idea what it sent — no name, no
author, no version, no history. Fine for one person with a cable; useless the
moment an app arrives from someone else and the only question worth asking is
"what is this, and who wrote it".

So an app can also be published into your own atproto repo, as a record:

```sh
./apps.sh publish device-apps/minute-clock.lua
./apps.sh list                             # yours
./apps.sh list alice.bsky.social           # theirs — no account, no index
./apps.sh show alice.bsky.social/minute-clock
./apps.sh run minute-clock                 # onto your own device
./apps.sh push alice.bsky.social minute-clock
```

```
at://<your-did>/computer.haha.san.app/minute-clock
```

Authorship, versioning, history and portability all come from atproto rather
than from anything here: records are signed, the record key is derived from the
name so re-publishing is an **edit** with a new CID, and the library outlives
this hub and this project. It also collapses discovery into a read — finding
someone's apps is listing a collection in their repo. There is no app store.

Because that is pure atproto, **you can browse and publish before you own a hub
or a Poem/1** — which is the main defence against a cold start.

An app is named the same way everywhere: `minute-clock` in your library,
`alice.bsky.social/minute-clock` in hers, or the full `at://…` URI.

### Pushing to someone else's device

```sh
curl -X POST https://<your-hub>/federation/push \
  -H "Authorization: Bearer $HUB_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"to":"friend.bsky.social","app":"minute-clock"}'
```

`{"code": "<lua>"}` still works for something you have not published. Either way
the **sender** resolves the app to source before signing, so the federation wire
format is unchanged — a hub running older code cannot tell the two apart.

Their hub accepts it only if **both** hold:

1. the signature verifies against the key they can see in *your* repo, and
2. the two of you **follow each other** on Bluesky.

Social trust sets **policy** (who may push); it never changes **mechanism** (what
pushed code can do). The Lua sandbox, driver allowlists and e-ink flip limits are
untouched — and the 3-second button hold stops anything, whoever sent it.

### Testing it

This needs four atproto identities, four hubs, a real follow graph and a
physical device — the most important thing here and the most expensive to
check. [`test-federation.sh`](test-federation.sh) runs the whole trust chain and
asserts on the *device's* own answer rather than the relay's:

```sh
./test-federation.sh                 # every configured case
./test-federation.sh --list          # what each case needs
./test-federation.sh --only discovery
./test-federation.sh -v              # full JSON per case
```

Nine cases, covering each link: the device proves it is that device
(`device-identity`), the hub carries only claimed devices and refuses anonymous
pushes (`relay-closed`), a peer proves who they are and is checked against the
graph (`mutual-push`, `recipient-enforces`), and capabilities are asked for live
rather than remembered (`discovery`).

Two of them deliberately misbehave, which is what `tools/fake-device.mjs` is
for: it stands in for firmware so the impostor cases — wrong key, no key,
silence — can be exercised without asking real hardware to attack itself.

It reads the sender's owner token from `$HUB_ADMIN_TOKEN` or the macOS keychain.
Cloudflare secrets are write-only, so record the token once when you set it
rather than rotating it every time you want to run this — the script's header has
the exact commands. A token is enough for every case except `record-push`, which
publishes into the sender's repo and so needs that hub's OAuth session to still
be live; it skips rather than fails when the session has lapsed.

Routes, deployment and the trust model in detail: [`server/README.md`](server/README.md).
Why it is built this way: [`docs/social-plan.md`](docs/social-plan.md).

## Staying in sync with Resident

Resident is a **dependency**, not a fork. `device/platformio.ini` points at
Resident's `main` branch (`git+https://github.com/inanimate-tech/resident.git#main`),
so you never clone, fork, or merge it — you just pull the latest into your build.
PlatformIO caches it after the first build, so use the helper:

```sh
./sync.sh                  # fetch latest Resident + rebuild
./sync.sh --flash          # + safely reflash over USB (two safety gates, below)
./sync.sh --flash --force  # + skip the QUIESCE gate only
```

That's the whole sync loop. Because this project never modifies Resident, there
are no merge conflicts — new Resident features just show up on the next `sync.sh`.

`--flash` has **two independent safety gates**, and `--force` relaxes only the
second:

1. **Which board.** The pinned `upload_port` is confirmed by MAC before esptool
   runs. The Poem/1 and the M5StickS3 in [`voice/`](voice/) are both ESP32-S3s on
   the built-in USB JTAG peripheral, so they share a VID:PID (`303A:1001`) and
   differ only by MAC — and port numbers are assigned by the host, so a replug
   can silently swap them. Never skippable: "I can see the screen is idle" is not
   an answer to "is this the right device". Override the expected MAC with
   `$POEM1_MAC` or a `.poem1-mac` file.
2. **Which panel state.** `standby.lua` is pushed and allowed to settle, so the
   reset cannot land mid-refresh (which would damage the panel — see the warning
   above). If the device can't be reached to quiesce it, `--flash` **aborts**
   rather than flash blind; `--force` overrides this one only, for when you can
   see the screen is already idle or in its screensaver.

> [!WARNING]
> [`voice/device`](voice/device) has **neither** gate. It pins its own
> `upload_port`, so verify with `pio device list` before flashing it — a stale
> pin there is the one remaining way to reset the Poem/1 with no quiesce.

## Notes

- No fork, no core patches — this builds against unmodified Resident. (One
  consequence: timezone relies on Resident's network IANA lookup; if that's
  unreachable, local time falls back to UTC.)
- `device/partitions.csv` matches the stock Poem/1 layout, so a flash lands in
  an app slot and never clobbers NVS/SPIFFS.
- `sync.sh --flash` (reflashing a device already on Resident) is the verified
  path — see [Staying in sync](#staying-in-sync-with-resident) for its two
  safety gates.
- **Known rough edge:** `sync.sh` couples two things — it updates Resident *and*
  flashes. So reflashing a change to `device/src/main.cpp` also moves you to
  whatever upstream Resident has become, which makes one reflash carry two
  variables. When that matters, build with `pio run -e poem1 -d device` against
  the cached dependency and run the same two gates by hand before
  `pio run -e poem1 -t upload -d device`: confirm the pinned `upload_port`'s MAC
  from `pio device list --json-output`, then push `standby.lua` and let the panel
  settle. A `--no-update` flag would fold this back into the script.
- Hub admin tokens are **write-only** in Cloudflare: `wrangler secret list` shows
  that `HUB_ADMIN_TOKEN` exists, never its value. Record it when you set it (the
  macOS keychain works well) rather than rotating it every time you need it.
