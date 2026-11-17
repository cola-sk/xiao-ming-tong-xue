#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Start the background FreeRTOS task that periodically sends HTTPS heartbeats
 * to /api/v1/device/sync and syncs device volume, RTC time, schedules & unread messages.
 */
esp_err_t device_sync_start(void);

/**
 * Send a generic event to /api/v1/device/sync.
 */
esp_err_t device_sync_send_event(const char *event_name);

/**
 * Report alarm confirmation ("alarm_ack") with taskId after child taps screen.
 */
esp_err_t device_sync_send_alarm_ack(const char *task_id);

/**
 * Report parent voice message played ("voice_read") with msgId.
 */
esp_err_t device_sync_send_voice_read(const char *msg_id);

#ifdef __cplusplus
}
#endif
