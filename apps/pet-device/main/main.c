#include <stdio.h>
#include "esp_log.h"
#include "ui_state_machine.h"
#include "audio_engine.h"
#include "rtc_scheduler.h"
#include "wifi_manager.h"
#include "device_sync.h"
#include "device_pairing.h"
#include "device_storage.h"
#include "hardware_keys.h"

static const char *TAG = "ai_chat_pet_main";

void app_main(void) {
    ESP_LOGI(TAG, "Starting Waveshare ESP32-S3-Touch-AMOLED-2.16 (480x480) AI Chat Pet firmware...");

    ESP_ERROR_CHECK(wifi_manager_init());
    ESP_ERROR_CHECK(device_pairing_init());
    ESP_ERROR_CHECK(device_storage_init());
    audio_engine_init();
    ui_state_init();
    rtc_scheduler_init();
    hardware_keys_init();
    ESP_ERROR_CHECK(device_pairing_start());
    ESP_ERROR_CHECK(device_sync_start());
#ifdef PET_HARDWARE_SMOKE
    extern void hardware_smoke_start(void);
    hardware_smoke_start();
#endif
}
