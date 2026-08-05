-- note-from-a-friend.lua — written by one person's hub, for another's screen.
--
-- Authored on idiot.town's side and published into idiot.town's repo, then
-- pushed to mfd.is. The dimensions below were not assumed: idiot.town probed
-- mfd.is first and was told poem1 / 960x540 / colors:2, by the device itself.
-- That is the whole argument for discovery in one app — the sender could not
-- have known, and did not guess.
--
-- Draw once, calmly, and stop. No 'quality' flip at load: a ~1s blocking
-- refresh is the worst thing to do at the moment the hub is waiting on
-- telemetry, and an earlier app on this device lost its connection doing
-- exactly that.

local W, H = 960, 540
local BLACK, WHITE = 0, 255

local FROM = "idiot.town"
local WRITTEN = "2026-08-05"

local function draw()
  screen.clear(WHITE)

  screen.text(60, 52, "a note from", 3, BLACK)
  screen.text(60, 92, FROM, 8, BLACK)
  screen.line(60, 186, W - 60, 186, BLACK)

  screen.text(60, 226, "I wrote this for your screen.", 3, BLACK)
  screen.text(60, 272, "960 by 540, one bit deep - I asked", 3, BLACK)
  screen.text(60, 308, "your hub before I started.", 3, BLACK)

  -- The small print is the honest part: how this got here, and what each step
  -- actually proved. Nothing in it is decoration — every line is a check that
  -- something refused to skip.
  screen.text(60, 378, "signed by my hub's key, which lives in my own repo", 2, BLACK)
  screen.text(60, 402, "accepted because we follow each other, checked by YOUR hub", 2, BLACK)
  screen.text(60, 426, "delivered to a device that proved it was itself", 2, BLACK)

  screen.line(60, H - 74, W - 60, H - 74, BLACK)
  screen.text(60, H - 58, "written " .. WRITTEN .. " - press to redraw", 2, BLACK)
end

function init(ctx)
  draw()
  screen.flip()
  events.send("note_shown", { from = FROM })
end

function on_event(ctx, event)
  if event.name == "button" then
    draw()
    -- A quality refresh is fine HERE: someone just pressed the button, so the
    -- device is not mid-handshake and nothing is waiting on it.
    screen.flip("quality")
  end
end
