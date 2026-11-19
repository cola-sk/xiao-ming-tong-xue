#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <time.h>
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
    bool require_ack;
    int last_triggered_yday;
    int last_triggered_min;
} pet_schedule_t;

typedef enum {
    SCHEDULE_STATUS_PENDING = 0,
    SCHEDULE_STATUS_RINGING = 1,
    SCHEDULE_STATUS_DONE    = 2,
} pet_schedule_status_t;

typedef struct {
    char id[48];
    char title[64];
    uint8_t hour;
    uint8_t minute;
    pet_schedule_status_t status;
} pet_today_schedule_t;

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

int rtc_scheduler_get_today_schedules(pet_today_schedule_t *out, int max_items, bool *clock_valid);
uint32_t rtc_scheduler_get_version(void);

#ifdef __cplusplus
}
#endif

void rtc_scheduler_set_time(time_t epoch);
void rtc_scheduler_ack_active(void);
void rtc_scheduler_flush_acks(void);
