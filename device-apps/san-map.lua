-- san-map.lua — the network, drawn on a device that belongs to it.
--
-- Every number and every line below came from PROBING the live network at
-- publish time, not from remembering it: the panel geometry is what this device
-- reported about itself over a proved connection, and the peer rows are what
-- each hub answered when asked. See docs/san.md.
--
-- HONEST ABOUT WHAT IT IS: a snapshot, baked when the record was published. Lua
-- has no HTTP, so the device cannot re-ask — which is exactly why the footer
-- says when it was taken. A wall display that quietly showed stale state as
-- current would be the "cached belief" failure the whole design is against,
-- just rendered at 960x540.
--
-- 1-bit panel (the device said colors:2), so black and white only. Mid grays
-- would dither into mush — the kind of thing you only know to avoid because you
-- asked the device what it was.

local W, H = 960, 540
local BLACK, WHITE = 0, 255

local SNAPSHOT = "2026-08-05"

-- Each row is what a hub actually answered, including the refusals — a network
-- that only showed the parts that said yes would be a poor map of itself.
local NODES = {
  { who = "mfd.is",                 role = "this device",
    note = "poem1 - 960x540 - key ea3116" },
  { who = "idiot.town",             role = "mutual",
    note = "hub up - no devices claimed" },
  { who = "noitsrusty.bsky.social", role = "follower",
    note = "not a mutual - probe refused" },
  { who = "san.haha.computer",      role = "authority",
    note = "defines the records - runs no hub" },
}

local last_minute = -1

local function draw()
  screen.clear(WHITE)

  screen.text(60, 44, "SAN", 9, BLACK)
  screen.text(232, 74, "social area network", 3, BLACK)
  screen.text(60, 120, "the network this device belongs to", 2, BLACK)
  screen.line(60, 158, W - 60, 158, BLACK)

  local y = 196
  for _, n in ipairs(NODES) do
    -- A filled marker for what this device is, hollow for everyone else: the
    -- map should say where you are standing on it.
    if n.role == "this device" then
      screen.fill_circle(74, y + 12, 9, BLACK)
    else
      screen.circle(74, y + 12, 9, BLACK)
    end

    screen.text(104, y, n.who, 3, BLACK)
    screen.text(104, y + 32, n.role .. " - " .. n.note, 2, BLACK)
    y = y + 78
  end

  screen.line(60, H - 74, W - 60, H - 74, BLACK)
  screen.text(60, H - 58, "probed " .. SNAPSHOT .. " - press to refresh the clock", 2, BLACK)
end

local function stamp(ctx)
  -- Clock lives in its own strip so the minute tick can be a small, cheap
  -- update rather than a full-screen redraw. On a wall its real job is to prove
  -- the panel is live and not frozen.
  --
  -- localtime_* CAN BE NIL, which cost a runtime error on this very device:
  -- the timezone is resolved over the network from onConnected, and an app that
  -- auto-restores at boot runs before that lookup finishes. Falling back to UTC
  -- keeps the clock honest about which one it is showing rather than printing a
  -- wrong local time or crashing.
  local h, m, label = ctx.localtime_h, ctx.localtime_m, "local"
  if h == nil or m == nil then h, m, label = ctx.utc_h, ctx.utc_m, "utc" end
  if h == nil or m == nil then return end

  screen.fill_rect(W - 260, H - 58, 200, 24, WHITE)
  screen.text(W - 260, H - 58, string.format("%02d:%02d %s", h, m, label), 2, BLACK)
end

function init(ctx)
  draw()
  stamp(ctx)
  -- Deliberately NOT 'quality' here. A quality refresh blocks for ~1s, and app
  -- load is the worst moment to spend that: the hub has just delivered the app
  -- and is waiting on telemetry, and the same main loop services the socket.
  -- The first version of this app opened with one, and the device lost its hub
  -- connection at exactly that point. 'fast' renders the same frame; the
  -- firmware slips a quality refresh in on its own within the first minute of
  -- ticks, so the ghosting clears without anyone blocking for it.
  screen.flip()
  last_minute = ctx.localtime_m
  events.send("san_map", { snapshot = SNAPSHOT, nodes = #NODES })
end

function on_tick(ctx, dt_ms)
  local m = ctx.localtime_m or ctx.utc_m
  if m == nil or m == last_minute then return end
  last_minute = m
  stamp(ctx)
  -- 'fast' for the minute tick. The firmware coalesces flips and slips in a
  -- quality refresh every ~60 fast ones, so ghosting cleans itself up without
  -- this app having to count.
  screen.flip()
end

function on_event(ctx, event)
  if event.name == "button" then
    draw()
    stamp(ctx)
    screen.flip("quality")
  end
end
