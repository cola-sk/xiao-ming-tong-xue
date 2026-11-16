#include <stdio.h>
#include "esp_log.h"
#include "ui_state_machine.h"
#include "audio_engine.h"
#include "rtc_scheduler.h"

static const char *TAG = "ai_chat_pet_main";

void app_main(void) {
    ESP_LOGI(TAG, "Starting Waveshare ESP32-S3-Touch-AMOLED-2.16 (480x480) AI Chat Pet firmware...");
    audio_engine_init();
    rtc_scheduler_init();
    ui_state_init();
}
