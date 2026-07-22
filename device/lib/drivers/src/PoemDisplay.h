#ifndef POEM_DISPLAY_H
#define POEM_DISPLAY_H

// Poem/1 e-ink panel — manual M5PaperS3/ED047TC1 config, verified in epd-test.
//
// M5GFX autodetect refuses this board because it also requires a GT911 touch
// chip on I2C (which Poem lacks) — but that gates TOUCH, not the display. The
// display wiring is verified identical to M5PaperS3, both from the stock
// firmware ([6,14,7,12,9,11,8,10 | 46,13,17,45,15,16,18]) and from M5GFX's own
// board definition, so the panel is driven by M5GFX's correct, DC-balanced
// ED047TC1 waveforms.

#include <M5GFX.h>
#include <lgfx/v1/platforms/esp32/Bus_EPD.h>
#include <lgfx/v1/platforms/esp32/Panel_EPD.hpp>

class Poem_Display : public lgfx::LGFX_Device {
  lgfx::Bus_EPD   _epdBus;     // NB: not _panel/_bus — those collide with the base class
  lgfx::Panel_EPD _epdPanel;
public:
  Poem_Display() {
    { auto c = _epdBus.config();
      c.bus_speed   = 16000000;
      c.pin_data[0] = GPIO_NUM_6;  c.pin_data[1] = GPIO_NUM_14;
      c.pin_data[2] = GPIO_NUM_7;  c.pin_data[3] = GPIO_NUM_12;
      c.pin_data[4] = GPIO_NUM_9;  c.pin_data[5] = GPIO_NUM_11;
      c.pin_data[6] = GPIO_NUM_8;  c.pin_data[7] = GPIO_NUM_10;
      c.pin_pwr = GPIO_NUM_46; c.pin_spv = GPIO_NUM_17; c.pin_ckv = GPIO_NUM_18;
      c.pin_sph = GPIO_NUM_13; c.pin_oe  = GPIO_NUM_45; c.pin_le  = GPIO_NUM_15;
      c.pin_cl  = GPIO_NUM_16; c.bus_width = 8;
      _epdBus.config(c);
      _epdPanel.setBus(&_epdBus);
    }
    { auto d = _epdPanel.config_detail(); d.line_padding = 8; _epdPanel.config_detail(d); }
    { auto c = _epdPanel.config();
      c.memory_width = 960; c.panel_width  = 960;
      c.memory_height = 540; c.panel_height = 540;
      c.offset_rotation = 3; c.offset_x = 0; c.offset_y = 0;
      c.bus_shared = false;
      _epdPanel.config(c);
    }
    _epdPanel.setColorDepth(lgfx::color_depth_t::grayscale_8bit);
    setPanel(&_epdPanel);
  }
};

#endif // POEM_DISPLAY_H
