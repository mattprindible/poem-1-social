-- Simple status screen: pushed fresh, no USB/serial attached (network-only push test).
function init(ctx)
  screen.clear()
  screen.text(40, 60, 'Hello, Poem/1', 6)
  screen.text(40, 160, 'Pushed over WiFi -- device is unplugged from laptop.', 3)
  screen.text(40, 200, 'This confirms the network relay push path works.', 3)
  screen.line(40, 250, 920, 250, 0)
  draw_status(ctx)
  screen.flip('quality')
end

function draw_status(ctx)
  screen.text(40, 290, string.format('Local time: %02d:%02d', ctx.localtime_h, ctx.localtime_m), 4)
  screen.text(40, 340, 'Timezone: ' .. (time.has_timezone() and 'ok (America/New_York)' or 'UTC (no tz yet)'), 3)
  screen.text(40, 400, 'Tap the button for a live tick.', 3)
end

function on_event(ctx, event)
  if event.name == 'button' then
    screen.fill_rect(40, 440, 880, 60, 255)
    screen.text(40, 450, 'Button presses: ' .. event.count, 4)
    screen.flip()
  end
end
