#include "hardware_keys.h"
#include "audio_engine.h"
#include "ui_state_machine.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
// Waveshare official schematic: Key2=BOOT/GPIO0, Key3=IO18. PWR stays a power key.
static void keys_task(void *arg) {
    const gpio_num_t pins[] = { GPIO_NUM_0, GPIO_NUM_18 };
    const audio_target_t targets[] = { AUDIO_TARGET_AI, AUDIO_TARGET_PARENT };
    bool stable[2] = { false }, started[2] = { false }, armed[2] = { false };
    unsigned debounce[2] = {0};
    while (1) {
        for (int i = 0; i < 2; i++) {
            bool down = gpio_get_level(pins[i]) == 0;
            if (!armed[i]) { if (!down) armed[i] = true; continue; }
            if (down == stable[i]) debounce[i] = 0;
            else if (++debounce[i] >= 3) {
                stable[i] = down; debounce[i] = 0;
                ESP_LOGI("hardware_keys", "GPIO%d %s", pins[i], down ? "pressed" : "released");
                if (down) {
                    ui_switch_page(i == 0 ? PET_PAGE_AI_CHAT : PET_PAGE_WECHAT);
                    started[i] = audio_engine_start_hold(targets[i]);
                    if (started[i]) ui_set_key_hold_state(targets[i], true);
                    else ui_set_voice_status("音频忙或请先绑定");
                } else if (started[i]) {
                    ui_set_key_hold_state(targets[i], false);
                    audio_engine_end_hold(targets[i]);
                    started[i] = false;
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
void hardware_keys_init(void) {
    gpio_config_t cfg = { .pin_bit_mask = (1ULL << 0) | (1ULL << 18), .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE, .intr_type = GPIO_INTR_DISABLE };
    ESP_ERROR_CHECK(gpio_config(&cfg));
    xTaskCreate(keys_task, "ptt_keys", 3072, NULL, 4, NULL);
}
