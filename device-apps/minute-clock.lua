-- Minimal e-ink clock: big local time, redrawn only when the minute changes.
-- Also the persistence test app: it should survive reboots on its own.
local last = -1

function draw(h, m)
  screen.clear()
  screen.text(230, 160, string.format('%02d:%02d', h, m), 16)
  screen.text(40, 480, 'poem/1 resident - local time (' ..
              (time.has_timezone() and 'tz ok' or 'UTC!') .. ')', 2)
  screen.flip()
end

function on_tick(ctx, dt_ms)
  if ctx.localtime_m ~= last then
    last = ctx.localtime_m
    draw(ctx.localtime_h, ctx.localtime_m)
  end
end
