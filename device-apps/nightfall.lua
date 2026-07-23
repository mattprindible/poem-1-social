-- nightfall.lua — a still night scene for the Poem/1, drawn once and left alone.
--
-- Draws a single quality refresh at init and then never touches the panel
-- again: no on_tick, no on_event. E-ink is bistable, so the image holds with
-- zero power for as long as you like — pull the plug and it stays. (Just don't
-- cut power *during* a refresh; this app finishes in a couple of seconds and is
-- then permanently quiet, which makes it a safe thing to leave overnight.)
--
-- DITHERING, and why it is per-row.
-- The panel is 16-level greyscale, so a smooth 340px sky gradient would band
-- badly across so few levels. The fix is ordered dithering — mixing two
-- adjacent levels in a fixed pattern so the eye blends them. Doing that per
-- PIXEL would need ~500k screen.pixel() calls from Lua, which is far too slow.
-- But the gradient is purely vertical, so the dither only has to vary along y:
-- each row is one solid fill_rect, and alternating rows between two levels
-- reads as a smooth ramp. 540 calls instead of 518,400.
--
-- Everything else is a handful of shapes. Total draw calls: a few thousand.

local W, H = 960, 540
local HORIZON = 330   -- sky meets water
local SHORE   = 434   -- water meets near bank

-- 4-entry ordered dither. Spreading the thresholds (0,2,1,3 rather than
-- 0,1,2,3) keeps the interleaved rows from clumping into visible pairs.
local BAYER = { 0, 2, 1, 3 }

-- Level is 0..15 (the panel's real resolution); gray is the 0..255 the driver
-- wants. Fractional levels get dithered against the row's threshold.
local function shade(level, y)
  local base = math.floor(level)
  local frac = level - base
  if frac > (BAYER[(y % 4) + 1] + 0.5) / 4 then base = base + 1 end
  if base < 0 then base = 0 elseif base > 15 then base = 15 end
  return base * 17
end

-- Small deterministic PRNG so the stars are identical on every boot — a night
-- sky that reshuffles itself each time would feel wrong.
local seed = 20260723
local function rnd()
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
end

-- Smooth ridge line through evenly spaced control points.
local function ridge_at(x, pts)
  local n = #pts - 1
  local fx = x / W * n
  local i = math.floor(fx)
  if i >= n then i = n - 1 end
  local t = fx - i
  t = t * t * (3 - 2 * t)          -- smoothstep: no math.sin needed
  local a, b = pts[i + 1], pts[i + 2]
  return a + (b - a) * t
end

local MOON_X, MOON_Y, MOON_R = 742, 104, 46

local function draw_sky()
  -- Near-black overhead, lifting toward the horizon like residual dusk.
  for y = 0, HORIZON - 1 do
    local t = y / (HORIZON - 1)
    screen.fill_rect(0, y, W, 1, shade(0.7 + t * t * 4.1, y))
  end
end

local function draw_stars()
  for _ = 1, 110 do
    local x = math.floor(rnd() * W)
    local y = math.floor(rnd() * (HORIZON - 40))
    -- Skip the moon's glare, where a star would not be visible anyway.
    local dx, dy = x - MOON_X, y - MOON_Y
    if dx * dx + dy * dy > (MOON_R + 46) * (MOON_R + 46) then
      local b = rnd()
      if b > 0.94 then
        -- A few bright ones get a tiny cross so they read as stars, not dust.
        screen.pixel(x, y, 255)
        screen.pixel(x - 1, y, 170); screen.pixel(x + 1, y, 170)
        screen.pixel(x, y - 1, 170); screen.pixel(x, y + 1, 170)
      elseif b > 0.72 then
        screen.pixel(x, y, 238)
      else
        screen.pixel(x, y, 187)
      end
    end
  end
end

local function draw_moon()
  -- Halo first, as widening rings that fade into the sky.
  for i = 7, 1, -1 do
    screen.circle(MOON_X, MOON_Y, MOON_R + i * 3, (6 - i) * 12)
  end
  screen.fill_circle(MOON_X, MOON_Y, MOON_R, 255)
  -- A couple of maria, just enough to stop it reading as a hole in the sky.
  screen.fill_circle(MOON_X - 15, MOON_Y - 12, 11, 221)
  screen.fill_circle(MOON_X + 13, MOON_Y + 9, 8, 221)
  screen.fill_circle(MOON_X - 4, MOON_Y + 18, 6, 238)
end

local function draw_hills()
  -- Far ridge: lighter, so it sits back in the haze.
  local far  = { 250, 214, 236, 190, 226, 198, 244, 220 }
  -- Near ridge: pure black silhouette against it.
  local near = { 296, 268, 310, 258, 286, 250, 300, 276 }
  for x = 0, W - 1 do
    local fy = math.floor(ridge_at(x, far))
    screen.fill_rect(x, fy, 1, HORIZON - fy, 51)
    local ny = math.floor(ridge_at(x, near))
    screen.fill_rect(x, ny, 1, HORIZON - ny, 0)
  end
end

local function draw_water()
  -- Water is darker than the sky it reflects, and settles as it recedes.
  for y = HORIZON, SHORE - 1 do
    local t = (y - HORIZON) / (SHORE - HORIZON)
    screen.fill_rect(0, y, W, 1, shade(3.4 - t * 2.6, y))
  end

  -- Moonlight on the water: broken horizontal dashes under the moon, widening
  -- and dimming with distance from the shore.
  local row = 0
  for y = HORIZON + 3, SHORE - 4, 4 do
    row = row + 1
    local spread = 12 + row * 7
    local level  = 13 - row * 0.55
    if level < 4 then level = 4 end
    local dashes = 2 + math.floor(rnd() * 3)
    for _ = 1, dashes do
      local w = 10 + math.floor(rnd() * 42)
      local x = MOON_X - spread + math.floor(rnd() * (spread * 2)) - w / 2
      screen.fill_rect(math.floor(x), y, w, 2, shade(level, y))
    end
  end
end

local function draw_shore()
  screen.fill_rect(0, SHORE, W, H - SHORE, 0)
  -- Reeds along the bank, so the black band has an edge rather than a border.
  for _ = 1, 26 do
    local x = math.floor(rnd() * W)
    local h = 10 + math.floor(rnd() * 26)
    screen.fill_rect(x, SHORE - h, 2, h, 0)
  end
end

function init(ctx)
  screen.clear(0)
  draw_sky()
  draw_stars()
  draw_moon()
  draw_hills()
  draw_water()
  draw_shore()
  -- 'quality' = full clean refresh. Slower and it flashes, but it clears any
  -- ghosting from whatever was on the panel before, which matters for an image
  -- that is going to sit there all night.
  screen.flip('quality')
end

-- Deliberately no on_tick and no on_event. The panel is never touched again, so
-- the scene survives a power cut exactly as drawn. The firmware's hold-the-
-- button escape hatch still works — it is polled outside Lua entirely.
