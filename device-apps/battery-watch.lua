-- Live battery monitor for Poem/1. Voltage from GPIO3 ADC (x2 divider),
-- percent estimated from a standard 1S LiPo resting-voltage curve (no fuel
-- gauge on this board), charger CHG_STAT line sampled on GPIO4.
-- Designed to run unplugged: updates the e-ink every 5s with fast flips.

local CURVE = {
  {3300, 0}, {3500, 10}, {3600, 20}, {3700, 40}, {3800, 60},
  {3900, 75}, {4000, 85}, {4100, 95}, {4200, 100},
}

local function pct(mv)
  if mv <= CURVE[1][1] then return 0 end
  if mv >= CURVE[#CURVE][1] then return 100 end
  for i = 2, #CURVE do
    local a, b = CURVE[i - 1], CURVE[i]
    if mv <= b[1] then
      return math.floor(a[2] + (b[2] - a[2]) * (mv - a[1]) / (b[1] - a[1]) + 0.5)
    end
  end
  return 100
end

local last_draw = -10000

function on_tick(ctx, dt_ms)
  if ctx.time_ms - last_draw < 5000 then return end
  last_draw = ctx.time_ms

  local mv = (adc.mv(3) or 0) * 2
  local p = pct(mv)
  local trans, high = gpio.pulse_stats(4, 200)
  local chg
  if trans and trans > 4 then
    chg = 'CHG_STAT: pulsing (' .. trans .. ' transitions, ' .. high .. '% high)'
  elseif high and high >= 50 then
    chg = 'CHG_STAT: steady HIGH'
  else
    chg = 'CHG_STAT: steady LOW'
  end

  screen.clear()
  screen.text(40, 40, 'Poem/1 battery', 4)
  screen.text(40, 130, string.format('%.2f V', mv / 1000), 10)
  screen.rect(40, 330, 600, 60)
  screen.fill_rect(44, 334, math.floor(592 * p / 100), 52, 80)
  screen.text(680, 340, p .. '%', 5)
  screen.text(40, 430, chg, 3)
  screen.text(40, 490, 'estimated from voltage curve - no fuel gauge on board. up '
              .. math.floor(ctx.time_ms / 1000) .. 's', 2)
  screen.flip()
  log.info(string.format('batt %.2fV ~%d%% | %s', mv / 1000, p, chg))
end
