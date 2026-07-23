-- federated-hello.lua — proof that an app can arrive from someone ELSE.
--
-- Pushed from a different person's hub, to a different person's device, with
-- the sender never learning the device ID and the recipient's hub deciding
-- everything: signature verified against the key in the sender's atproto repo,
-- then a mutual-follow check against the live social graph.
--
-- If this is on the panel, the whole trust chain in docs/social-plan.md held.

local SENDER = "@hahacomputer.bsky.social"
local ticks = 0

local function draw()
  screen.clear(255)
  screen.rect(30, 30, 900, 480, 0)
  screen.text(70, 80, "PUSHED FROM ANOTHER", 4, 0)
  screen.text(70, 130, "PERSON'S HUB", 4, 0)

  screen.line(70, 200, 890, 200, 0)

  screen.text(70, 240, "from " .. SENDER, 3, 0)
  screen.text(70, 300, "verified: signature + mutual follow", 2, 0)
  screen.text(70, 340, "the sender never saw this device id", 2, 0)

  screen.text(70, 420, "hold the button ~3s to stop me", 2, 0)
  screen.text(70, 460, "tick " .. ticks, 2, 0)
end

function init(ctx)
  draw()
  screen.flip('quality')
end

function on_tick(ctx, dt_ms)
  ticks = ticks + 1
  -- Redraw sparingly: e-ink is a calm display and the firmware rate-limits
  -- flips anyway. Once every ~5s is plenty to show it is alive.
  if ticks % 50 == 0 then
    draw()
    screen.flip()
  end
end

function on_event(ctx, event)
  if event.name == 'button' then
    draw()
    screen.flip()
  end
end
