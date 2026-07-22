-- First app pushed live to Poem/1 Resident: grayscale ramp + button counter.
function init(ctx)
  screen.clear()
  screen.text(40, 50, 'First light', 6)
  screen.text(40, 170, 'This Lua app was pushed over WiFi.', 3)
  screen.text(40, 220, 'No reflash. No reboot. Live code.', 3)
  for i = 0, 15 do
    screen.fill_rect(40 + i * 55, 300, 55, 80, i * 17)
  end
  screen.text(40, 420, 'Press the button...', 3)
  screen.flip('quality')
end

function on_event(ctx, event)
  if event.name == 'button' then
    screen.fill_rect(40, 460, 880, 60, 255)
    screen.text(40, 470, 'Button presses: ' .. event.count, 4)
    screen.flip()
  end
end
