-- phone-home.lua — the device talking BACK.
--
-- Every other app here draws. This one reports: it uses stock Resident's
-- `events.send`, which rides the same WebSocket the relay already holds, so the
-- hub can finally hear the device instead of only shouting at it. Read what it
-- says with:
--
--     curl -H "Authorization: Bearer $HUB_ADMIN_TOKEN" \
--          https://<your-hub>/hub/device/events
--
-- Needs no reflash: the emit side has been in the firmware all along (see
-- server/src/device-agent.ts for why the missing half was the hub's).
--
-- Tap the button to make it speak on demand — which is the honest end-to-end
-- check, because you can see the press and the JSON row appear together.

local ticks = 0

function init(ctx)
  screen.clear()
  screen.text(40, 60, 'Phone home', 6)
  screen.text(40, 160, 'This app reports to the hub over events.send().', 3)
  screen.text(40, 200, 'Tap the button to send one on demand.', 3)
  screen.line(40, 250, 920, 250, 0)
  screen.text(40, 290, 'Sent: 0', 4)
  screen.flip('quality')

  -- The boot report. `set-hub.sh` currently infers a successful hub switch from
  -- a connection count that hibernating sockets make unreliable; a hello with a
  -- timestamp is the thing that count could never be.
  --
  -- No device id in here on purpose: publishEvent already stamps `from` with it,
  -- and `ctx` has no device_id field to read anyway (ctx is time_ms,
  -- trigger_count, utc_h/m, localtime_h/m — that is the whole table).
  events.send('hello', {
    app = 'phone-home',
    hour = ctx.localtime_h,
    minute = ctx.localtime_m,
  })
end

-- Slow heartbeat. Deliberately not per-tick: `events.send` is rate-limited to 5
-- events/s by a shared token bucket, and a chatty app would spend that budget
-- for every other emitter on the device.
function on_tick(ctx, dt_ms)
  ticks = ticks + 1
  if ticks % 600 == 0 then
    events.send('heartbeat', { ticks = ticks })
  end
end

function on_event(ctx, event)
  if event.name == 'button' then
    -- Show what the SEND returned, not merely that the press registered:
    -- events.send reports a failure by its return value rather than by
    -- raising, so an app that ignores it reports success it never had.
    --
    -- Read the WORD, never the truthiness. Resident 0.7.0 returned a boolean
    -- here; 0.8.0-dev returns 'sent', 'queued' or 'dropped' — and all three
    -- strings are truthy in Lua, so the `ok and ... or ...` test this line
    -- used to carry could not see a failure any more. It printed (ok) for a
    -- dropped event: the exact silence this app exists to break, reintroduced
    -- by the runtime telling us MORE than it used to. Both shapes are mapped
    -- so the app reads the same before and after the firmware catches up.
    local verdict = events.send('button', { count = event.count })
    if verdict == true then verdict = 'sent' end
    if verdict == false then verdict = 'dropped' end

    screen.fill_rect(40, 280, 880, 60, 255)
    screen.text(40, 290, 'Sent: ' .. event.count .. ' (' .. verdict .. ')', 4)
    screen.flip()
  end
end
