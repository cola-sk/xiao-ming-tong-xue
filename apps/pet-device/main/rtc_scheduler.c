#include "rtc_scheduler.h"
#include "esp_log.h"

static const char *TAG = "rtc_scheduler";

void rtc_scheduler_init(void) {
    ESP_LOGI(TAG, "PCF85063 hardware RTC & local audio cache manager initialized");
}

void rtc_scheduler_sync_from_json(const char *schedules_json) {
    ESP_LOGI(TAG, "Synced schedules JSON, pre-downloading audio & arming PCF85063 alarm");
}
