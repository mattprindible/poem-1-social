-- runaway.lua — a deliberately badly-behaved app, for testing the escape hatch.
--
-- Stands in for a hostile or broken app pushed by someone else: it redraws on
-- every tick (so the panel never settles) and swallows every event, including
-- button presses, so an app-level "press to quit" is impossible. The ONLY way
-- to stop it is the runtime escape hatch in device/src/main.cpp — hold the
-- physical button for ~3s, which is polled outside Lua's event dispatch and so
-- cannot be swallowed.
--
-- Expected result: screen switches to "App stopped", and the app does NOT come
-- back after a power cycle (the escape hatch clears the persisted copy too).

local ticks = 0

local function draw()
  screen.clear(255)
  screen.text(40, 40,  "RUNAWAY APP", 5, 0)
  screen.text(40, 130, "swallowing all button events", 2, 0)
  screen.text(40, 190, "tick " .. ticks, 3, 0)
  screen.text(40, 260, "HOLD THE BUTTON ~3s", 3, 0)
  screen.text(40, 310, "to escape", 3, 0)
end

function init(ctx)
  draw()
  screen.flip('quality')
end

function on_tick(ctx, dt_ms)
  ticks = ticks + 1
  draw()
  screen.flip()  -- every tick; firmware rate-limits to ~0.4s
end

function on_event(ctx, event)
  -- Deliberately swallow everything, button events included. A well-behaved
  -- app would act here; this one is the whole point of the test.
end
