# Poem/1 Resident — Device Skill

Lua app surface for **Poem/1**, an ESP32-S3 device with a 4.7" e-ink display
and one physical button, running the Resident sandbox.

## Hardware

- **Display:** 960×540 e-ink (landscape), **16-level grayscale**. No backlight,
  no color. E-ink is *bistable*: the image persists with zero power and nothing
  changes on screen until you call `screen.flip()`.
- **Button:** one physical push button (delivered as events; no polling needed).
- **LED:** a green LED on GPIO0, hidden *inside* the enclosure — dimly visible through
  a small mounting hole. Fun as a heartbeat/status light, useless as a display.
- **No touch, no speaker/buzzer, no IMU, no RTC, no battery** (hardware-surveyed
  2026-07-08: the I2C bus is empty and the unplug test failed — this is a
  cost-reduced M5PaperS3 that must stay on USB power).

## E-ink rules (important — different from an LCD!)

- Draw calls only write to an off-screen framebuffer. **Nothing appears until
  `screen.flip()`.**
- `screen.flip()` (or `screen.flip('fast')`) = quick partial update, mild
  ghosting. `screen.flip('quality')` = full clean refresh with a visible
  black/white flash (~1s). Use `'quality'` for full-screen redraws and title
  cards; `'fast'` for counters, clocks, small region updates.
- Flips are **rate-limited and coalesced by the firmware** (fast ≥ 0.4s apart,
  quality ≥ 1.5s apart). Calling `flip()` every tick is safe — the panel just
  updates at its own pace with the latest frame. Don't design apps that need
  animation faster than ~2 fps.
- After ~60 fast flips the firmware automatically does one quality refresh to
  clear ghosting.
- This is a *calm* display: prefer apps that render a state and update on
  events or every few seconds, not per-tick animation.

## Lua Modules

### `screen` — grayscale drawing (0 = black … 255 = white)

```lua
screen.width()                 -- 960
screen.height()                -- 540
screen.clear(gray)             -- fill framebuffer; default 255 (white)
screen.text(x, y, str, size, gray)   -- size default 3, gray default 0.
                               -- Char cell is 6x8 px * size (size 3 = 18x24 px).
screen.fill_rect(x, y, w, h, gray)
screen.rect(x, y, w, h, gray)
screen.line(x0, y0, x1, y1, gray)
screen.pixel(x, y, gray)
screen.circle(x, y, r, gray)
screen.fill_circle(x, y, r, gray)
screen.triangle(x0, y0, x1, y1, x2, y2, gray)
screen.fill_triangle(x0, y0, x1, y1, x2, y2, gray)
screen.flip(mode)              -- push framebuffer; mode 'fast' (default) | 'quality'
```

Trailing `gray` arguments are optional (text defaults to black, shapes to black,
clear to white).

### `button` — the physical button

```lua
button.press_count()           -- presses since app load
button.is_down()               -- true while held
```

Presses arrive as events (preferred over polling):

```lua
function on_event(ctx, event)
  if event.name == 'button' then
    -- event.data.count = cumulative press count
  end
end
```

> [!NOTE]
> **`event.data.count` is the current shape; `event.count` is a deprecated
> mirror.** Since Resident 0.8.0-dev every event — driver and wire alike —
> carries its payload in `event.data`, which is why the two used to disagree.
> The flattened top-level copy is still written for one deprecation window, so
> old apps keep working, and the apps in `device-apps/` here still read it.
> Write `event.data.count` in anything new.

> [!IMPORTANT]
> **A hold of ~3 seconds is reserved by the firmware.** Holding the button that
> long stops the running app and forgets it, so the device returns to its idle
> screen and the app does not come back after a reboot.
>
> This is the user's escape hatch, and it exists because apps can arrive from
> other people (see [`docs/social-plan.md`](docs/social-plan.md)). It is polled
> in the main loop, outside Lua's event dispatch, so **an app cannot suppress
> it** — deliberately.
>
> Practical consequence for your app: **don't build interactions around holding
> the button for 3s or more.** Taps and short holds are yours; a long hold
> belongs to the user. Nothing stops you reading `button.is_down()` during a
> hold, just don't expect your app to still be running at the end of a long one.
>
> It cannot save a user from an app that wedges the Lua VM in a tight loop —
> nothing in the main loop runs then. Power-cycling is the backstop, which is
> why the app is also *forgotten* rather than merely stopped.

### `led` — the hidden green LED (GPIO0)

```lua
led.set(v)                     -- brightness 0-255 (PWM); 0 = off
```

### Low-level probe modules (`i2c`, `gpio`, `adc`)

Present for hardware exploration; rarely useful in apps. All pin-taking calls
are allowlisted and return `nil` for refused pins. Notably: `adc.mv(3)` reads
the *charger circuit's* float voltage (~2070 mV, ×2 divider ≈ 4.1 V) — there is
**no battery**, so don't present it as battery level. `gpio.read(pin, pull)`,
`gpio.pulse_stats(pin, ms)`, `i2c.scan()` / `i2c.read8(addr, reg)` /
`i2c.readn(addr, reg, n)` (the I2C bus has no devices).

### Talking back to the hub (`events`)

```lua
events.send('hello')                          -- name only
events.send('temp', { c = 21, where = 'desk' })  -- + a FLAT table of strings/numbers
```

Publishes `{channel="app", type=<name>, data=…, from=<device id>, nonce, ts_ms}`
over the same WebSocket the relay already uses — so you do **not** set `from`,
and there is no `ctx.device_id` to read (see the `ctx` field list below).

Returns a **string** verdict rather than raising: `'sent'` (went out now),
`'queued'` (held for delivery — offline or rate-limited, drains in order), or
`'dropped'` (gone: empty name, or the queue overflowed).

> [!WARNING]
> **Compare the word, never the truthiness.** All three verdicts are non-empty
> strings, and every non-empty string is truthy in Lua, so `if events.send(…)`
> is now always true and `ok and 'ok' or 'FAILED'` can never report a failure.
> This returned a boolean before 0.8.0-dev, so that idiom used to work and now
> silently claims success. Write `if events.send(…) == 'dropped' then …`.

The limiter is a token bucket shared by every emitter on the
device: 5 events/s sustained, burst of 10. Keep heartbeats to once every few
seconds, never per-tick.

The hub records these; read them back with an owner credential:

```sh
curl -H "Authorization: Bearer $HUB_ADMIN_TOKEN" https://<your-hub>/hub/device/events
```

See `device-apps/phone-home.lua` for a working example.

**Errors report themselves** — you do not need to catch anything. The runtime
emits its own telemetry over the same WebSocket, so a compile or runtime failure
shows up at the hub with the Lua message and line number, rather than only on the
serial console:

```json
{ "channel": "system", "type": "telemetry",
  "data": { "name": "compile_error", "generationId": "caf80",
            "error": "[string \"…\"]:25: unfinished string near …" } }
```

Note `name` lives **inside `data`** as of 0.8.0-dev (it was top-level before,
when this board forwarded telemetry itself; Resident now does it, and the
firmware's forwarder was removed as a duplicate). A hub reading only the top
level records these as nameless.

Also emitted: `app_received`, `app_compiled`, `runtime_error`, `log_error`
(from `log.error(msg)`), `app_restored`. `on_tick` errors are rate-limited at
the source; `init` and `on_event` errors go out immediately.

### State that survives a reload (`store`)

```lua
store.set('streak', 4)      -- scalars only: strings, numbers, booleans
store.get('streak')         -- 4  (nil if unset)
store.keys()                -- { 'streak' }
store.remaining()           -- bytes of budget left (~2009 free on a fresh slot)
store.clear()
```

Persisted to NVS and keyed to the slot the load message named, so it survives
both `loadApp` and a reboot — this is how an app keeps a counter or a cursor
across a push. A push that names a *different* slot clears it, which is the
mechanism that stops one app inheriting another's state.

Writing past the budget does not fail silently: the runtime emits `store_full`
telemetry naming the key, once per key per load.

### Asking what you can draw on (`surfaces`)

```lua
surfaces.list()             -- {} on the Poem/1 — see below
surfaces.get('main')        -- nil
```

> [!IMPORTANT]
> **On this board `surfaces.list()` returns an empty list, and that is correct
> rather than broken** (measured: 0). The registry describes render targets used
> by Resident's own `lgfx`/`lvgl` graphics modules. The Poem/1's 960×540 e-ink
> panel is driven by this project's own `EpdScreenDriver` and exposed as
> `screen.*`, so it registers no target. Use `screen.*` and the fixed 960×540
> geometry; do not feature-detect the panel through `surfaces`.

## App lifecycle

```lua
function init(ctx) end              -- once after load; draw your first frame here
function on_tick(ctx, dt_ms) end    -- 10 FPS; keep light, flip sparingly
function on_event(ctx, event) end   -- button presses, app_event messages
```

`ctx` fields: `time_ms`, `trigger_count`, `utc_h`, `utc_m`, `localtime_h`,
`localtime_m`. The device timezone is set (America/New_York), so `localtime_*`
and `time.*` are real local time.

> [!WARNING]
> **`localtime_*` can be `nil`.** The timezone is resolved over the network
> after connect, and an app that auto-restores at boot runs *before* that
> finishes — so `string.format('%02d', ctx.localtime_h)` throws
> `number expected, got nil` on exactly the boot nobody is watching. Guard it,
> and fall back to `utc_*`:
> ```lua
> local h = ctx.localtime_h or ctx.utc_h
> if h == nil then return end
> ```

## Persistence & boot behavior

The last successfully-loaded app is saved on-device and **auto-restores after
a 20-second countdown** on the idle screen at boot. During the countdown the
physical button is the system button: **tap = load the saved app now,
long-press = forget it**. To clear the saved app remotely, send
`{"channel": "system", "type": "forget"}`. Until an app loads, the hidden green
LED shows connection status; after that `led.set()` owns it.

> [!NOTE]
> Since Resident 0.7.0 control messages carry a `channel` field. The
> un-channelled form (`{"type": "forget"}`) still works, but the device logs a
> deprecation line for every message that omits it. `send-app.sh` and
> `set-hub.sh` stamp it for you.

## Examples

Hello world:

```lua
function init(ctx)
  screen.clear()
  screen.text(40, 60, 'Hello, Poem/1', 6)
  screen.flip('quality')
end
```

Big minute clock (updates only when the minute changes):

```lua
local last = -1
function on_tick(ctx, dt_ms)
  if ctx.utc_m ~= last then
    last = ctx.utc_m
    screen.clear()
    screen.text(240, 180, string.format('%02d:%02d', ctx.utc_h, ctx.utc_m), 16)
    screen.flip()
  end
end
```

Button counter with grayscale bar:

```lua
function init(ctx)
  screen.clear()
  screen.text(40, 40, 'Press the button', 4)
  screen.flip('quality')
end

function on_event(ctx, event)
  if event.name == 'button' then
    local n = event.data.count
    screen.fill_rect(40, 200, 880, 120, 255)
    screen.text(40, 210, 'Presses: ' .. n, 5)
    screen.fill_rect(40, 300, math.min(n * 20, 880), 20, 100)
    screen.flip()
  end
end
```

## Constraints

- 960×540, landscape only. Grayscale 0–255 (quantized to 16 levels on panel).
- Text is the default 6×8 bitmap font scaled by `size`; size 16 ≈ 128 px tall.
  A size-3 char is 18 px wide → ~51 chars per line at x=40 margin.
- Effective update rate ≤ ~2 fps (fast flips). Design for calm, poster-like
  screens.
- No network access from Lua.
- **No `os`, `io`, `require`, `load`, `loadstring`, `dofile`, `package`, or
  `debug`** — the sandbox closed in 0.8.0-dev (verified on this device: `os` and
  `require` are both `nil`). There is no clock via `os.time()`; read `ctx` or the
  `time.*` module instead.
- A single dispatch is capped at ~2,000,000 VM instructions. Overrun aborts that
  call with a `runtime_error` and **leaves the app running**, so an accidental
  infinite loop in `on_tick` no longer takes the device out.
- `ctx.generation_id` is `nil` here: it carries an id only when the *pushing*
  side stamps one, and `send-app.sh` does not.

## Practical Tips

- Always end a draw sequence with `screen.flip()` — forgetting it is the #1
  "nothing happened" bug on this device.
- For partial updates, `fill_rect` the region to white first, then redraw text
  (the framebuffer keeps the previous frame's pixels).
- Use `'quality'` whenever the whole screen changes; fast flips over large
  changed areas leave visible ghosting.

## Validation stubs

```lua
screen = { width = function() return 960 end, height = function() return 540 end }
button = { press_count = function() return 0 end, is_down = function() return false end }
```

## App mode / Shader mode

App mode only — shader expressions are not supported on this device (no
`shaderTemplate` configured).
