#include "pet_display.h"
#include "bsp/esp-bsp.h"
#include "bsp/display.h"
#include "bsp/touch.h"
#include "esp_lv_adapter.h"
#include "esp_lv_adapter_display.h"
#include "esp_lv_adapter_input.h"
#include "esp_log.h"

static lv_indev_t *s_input;
static void align_area(lv_event_t *event) {
    lv_area_t *area = lv_event_get_param(event);
    area->x1 &= ~1; area->y1 &= ~1;
    area->x2 |= 1; area->y2 |= 1;
}
lv_display_t *pet_display_start(void) {
    // Keep Waveshare's panel/touch configuration, but bound SPI DMA bounce
    // allocations to 15 KB so TLS and recording cannot starve redraws.
    bsp_display_cfg_t board = { .lv_adapter_cfg = ESP_LV_ADAPTER_DEFAULT_CONFIG(),
        .rotation = ESP_LV_ADAPTER_ROTATE_0, .tear_avoid_mode = ESP_LV_ADAPTER_TEAR_AVOID_MODE_NONE,
        .touch_flags = { .swap_xy = 1, .mirror_x = 0, .mirror_y = 1 } };
    board.lv_adapter_cfg.task_stack_size = 12288;
    if (esp_lv_adapter_init(&board.lv_adapter_cfg) != ESP_OK) return NULL;
    esp_lcd_panel_handle_t panel; esp_lcd_panel_io_handle_t io;
    bsp_display_config_t panel_cfg = { .max_transfer_sz = BSP_LCD_H_RES * 16 * 2 };
    if (bsp_display_new(&panel_cfg, &panel, &io) != ESP_OK) return NULL;
    esp_lv_adapter_display_config_t display_cfg = { .panel = panel, .panel_io = io,
        .profile = { .interface = ESP_LV_ADAPTER_PANEL_IF_OTHER, .rotation = board.rotation,
            .hor_res = BSP_LCD_H_RES, .ver_res = BSP_LCD_V_RES, .buffer_height = 16,
            .use_psram = true, .require_double_buffer = true, .enable_ppa_accel = false },
        .tear_avoid_mode = board.tear_avoid_mode };
    lv_display_t *display = esp_lv_adapter_register_display(&display_cfg);
    if (!display) return NULL;
    lv_display_add_event_cb(display, align_area, LV_EVENT_INVALIDATE_AREA, NULL);
    esp_lcd_touch_handle_t touch;
    if (bsp_touch_new(&board, &touch) != ESP_OK) return NULL;
    esp_lv_adapter_touch_config_t input_cfg = ESP_LV_ADAPTER_TOUCH_DEFAULT_CONFIG(display, touch);
    s_input = esp_lv_adapter_register_touch(&input_cfg);
    if (!s_input || bsp_display_brightness_init() != ESP_OK || esp_lv_adapter_start() != ESP_OK) return NULL;
    ESP_LOGI("pet_display", "Display ready: 16-line DMA transfers, original touch orientation");
    return display;
}
lv_indev_t *pet_display_input(void) { return s_input; }
