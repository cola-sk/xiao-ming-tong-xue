#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Start the background FreeRTOS task that periodically sends HTTPS heartbeats
 * to /api/v1/device/sync and syncs device volume & RTC time.
 */
esp_err_t device_sync_start(void);

/**
 * Immediately send an event (e.g. "alarm_ack", "voice_read") to /api/v1/device/sync.
 */
esp_err_t device_sync_send_event(const char *event_name);

#ifdef __cplusplus
}
#endif
