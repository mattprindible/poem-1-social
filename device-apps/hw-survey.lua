-- Live hardware survey of Poem/1, run inside the Resident sandbox.
-- Results go to the e-ink and to serial ([i2c]/[gpio] lines + log.info).

local function hex(n) return string.format('0x%02X', n) end

function init(ctx)
  screen.clear()
  screen.text(40, 30, 'Poem/1 hardware survey', 4)
  local y = 100

  -- I2C bus scan (SDA=41 SCL=42)
  local addrs = i2c.scan()
  local s = 'I2C devices:'
  for i, a in ipairs(addrs) do s = s .. ' ' .. hex(a) end
  if #addrs == 0 then s = s .. ' none' end
  screen.text(40, y, s, 3); y = y + 45
  log.info(s)

  -- BMI270 IMU? WHO_AM_I (reg 0x00) should be 0x24
  local who = i2c.read8(0x68, 0x00)
  s = 'IMU 0x68 WHO_AM_I: ' .. (who and hex(who) or 'no answer')
  if who == 0x24 then s = s .. '  = BMI270 CONFIRMED' end
  screen.text(40, y, s, 3); y = y + 45
  log.info(s)

  -- BM8563 RTC at 0x51?
  local rtc = i2c.read8(0x51, 0x00)
  s = 'RTC 0x51 reg0: ' .. (rtc and (hex(rtc) .. '  = BM8563 present') or 'no answer')
  screen.text(40, y, s, 3); y = y + 45
  log.info(s)

  -- Battery: GPIO3 ADC, x2 divider per M5PaperS3 map
  local mv = adc.mv(3)
  s = 'GPIO3 ADC: ' .. tostring(mv) .. ' mV -> battery ~' ..
      string.format('%.2f', (mv or 0) * 2 / 1000) .. ' V'
  screen.text(40, y, s, 3); y = y + 45
  log.info(s)

  -- Charge status line (GPIO4): sample for 500ms
  local trans, high = gpio.pulse_stats(4, 500)
  s = 'GPIO4 CHG_STAT: ' .. tostring(trans) .. ' transitions, high ' ..
      tostring(high) .. '%'
  screen.text(40, y, s, 3); y = y + 45
  log.info(s)

  -- Static reads of remaining candidates (pull-up vs floating tells us
  -- if something is driving the line)
  local pins = {0, 1, 5, 21, 38, 39, 40, 43, 47, 48}
  s = 'pin(up/none):'
  for i, p in ipairs(pins) do
    local up = gpio.read(p, 'up')
    local fl = gpio.read(p, 'none')
    s = s .. ' ' .. p .. '(' .. tostring(up) .. '/' .. tostring(fl) .. ')'
  end
  screen.text(40, y, s, 2); y = y + 40
  log.info(s)

  -- Active probes: beep the candidate buzzer, light the candidate LED
  buzzer.tone(2093, 300)
  led.set(255)
  screen.text(40, y, 'Did it BEEP? Is an LED lit? (GPIO21 / GPIO0)', 3)
  y = y + 45
  screen.text(40, y, 'Press button to replay beep + toggle LED', 2)

  screen.flip('quality')
end

local led_on = true
function on_event(ctx, event)
  if event.name == 'button' then
    buzzer.tone(1047, 200)
    led_on = not led_on
    led.set(led_on and 255 or 0)
  end
end
