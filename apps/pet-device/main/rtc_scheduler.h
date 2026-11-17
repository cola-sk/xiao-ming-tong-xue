#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MAX_SCHEDULES 16

typedef struct {
    char id[48];
    char title[64];
    uint8_t hour;
    uint8_t minute;
    uint8_t repeat_mask; // bit 1..7 for Mon..Sun (bit0 unused), 0xFE = daily
    bool enabled;
    char audio_url[128];
    char audio_md5[40];
    uint8_t repeat_play_count;
    int last_triggered_yday;
    int last_triggered_min;
} pet_schedule_t;

void rtc_scheduler_init(void);

/**
 * Fetch schedules from GET /api/v1/schedules?deviceId=... over HTTPS,
 * parse JSON, pre-download missing MP3 audio files, and arm the RTC monitor.
 */
esp_err_t rtc_scheduler_fetch_and_sync(void);

/**
 * Legacy helper to sync from raw JSON payload.
 */
void rtc_scheduler_sync_from_json(const char *schedules_json);

#ifdef __cplusplus
}
#endif
