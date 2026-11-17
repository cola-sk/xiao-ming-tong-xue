#include <stdio.h>
#include "esp_log.h"
#include "ui_state_machine.h"
#include "audio_engine.h"
#include "rtc_scheduler.h"
#include "wifi_manager.h"
#include "device_sync.h"
#include "chat_storage.h"
#include "mqtt_client_mgr.h"

static const char *TAG = "ai_chat_pet_main";

void app_main(void) {
    ESP_LOGI(TAG, "Starting Waveshare ESP32-S3-Touch-AMOLED-2.16 (480x480) AI Chat Pet firmware...");

    ESP_ERROR_CHECK(wifi_manager_init());
    ESP_ERROR_CHECK(chat_storage_init());
    audio_engine_init();
    rtc_scheduler_init();
    ui_state_init();
    ESP_ERROR_CHECK(device_sync_start());
    ESP_ERROR_CHECK(mqtt_client_mgr_start());
}
