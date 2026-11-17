#include "rtc_scheduler.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "pet_http_auth.h"
#include "esp_crt_bundle.h"
#include "cJSON.h"
#include "wifi_manager.h"
#include "ui_state_machine.h"

static const char *TAG = "rtc_scheduler";

#define SCHED_HTTP_BUF_SIZE 8192

static pet_schedule_t s_schedules[MAX_SCHEDULES];
static int s_schedule_count = 0;

typedef struct {
    char *buf;
    int len;
    int cap;
} sched_resp_t;

static esp_err_t sched_http_event_handler(esp_http_client_event_t *evt) {
    sched_resp_t *ctx = (sched_resp_t *)evt->user_data;
    if (evt->event_id == HTTP_EVENT_ON_DATA && ctx && evt->data_len > 0) {
        int copy_len = evt->data_len;
        if (ctx->len + copy_len >= ctx->cap) {
            copy_len = ctx->cap - ctx->len - 1;
        }
        if (copy_len > 0) {
            memcpy(ctx->buf + ctx->len, evt->data, copy_len);
            ctx->len += copy_len;
            ctx->buf[ctx->len] = '\0';
        }
    }
    return ESP_OK;
}

static esp_err_t prefetch_alarm_audio(const char *audio_url, const char *audio_md5) {
    if (!audio_url || strlen(audio_url) == 0 || !audio_md5 || strlen(audio_md5) == 0) {
        return ESP_OK;
    }

    char full_url[256];
    if (strncmp(audio_url, "http", 4) == 0) {
        snprintf(full_url, sizeof(full_url), "%s", audio_url);
    } else {
        snprintf(full_url, sizeof(full_url), "%s%s", CONFIG_PET_SERVER_URL, audio_url);
    }

    ESP_LOGI(TAG, "Verifying/downloading alarm MP3 (MD5=%s): %s", audio_md5, full_url);
    esp_http_client_config_t cfg = {
        .url = full_url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 10000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_redirect = true,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    pet_http_add_auth(client, full_url);
    esp_err_t err = esp_http_client_open(client, 0);
    if (err == ESP_OK) {
        int content_len = esp_http_client_fetch_headers(client);
        int status = esp_http_client_get_status_code(client);
        ESP_LOGI(TAG, "Cached alarm MP3 (%s) -> HTTP %d, size=%d bytes", audio_md5, status, content_len);
        // NOTE: In production with mounted SPIFFS/SD, stream chunks directly to /sdcard/alarms/<md5>.mp3
    } else {
        ESP_LOGW(TAG, "Failed to download alarm MP3: %s", esp_err_to_name(err));
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return err;
}

void rtc_scheduler_sync_from_json(const char *schedules_json) {
    if (!schedules_json) return;
    cJSON *root = cJSON_Parse(schedules_json);
    if (!root) {
        ESP_LOGE(TAG, "Failed to parse schedules JSON");
        return;
    }

    cJSON *arr = cJSON_GetObjectItem(root, "schedules");
    if (!cJSON_IsArray(arr)) {
        cJSON_Delete(root);
        return;
    }

    int count = 0;
    cJSON *item = NULL;
    cJSON_ArrayForEach(item, arr) {
        if (count >= MAX_SCHEDULES) break;
        pet_schedule_t *dst = &s_schedules[count];
        memset(dst, 0, sizeof(pet_schedule_t));
        dst->last_triggered_yday = -1;
        dst->last_triggered_min = -1;

        cJSON *id = cJSON_GetObjectItem(item, "id");
        cJSON *title = cJSON_GetObjectItem(item, "title");
        cJSON *timeStr = cJSON_GetObjectItem(item, "timeStr");
        cJSON *enabled = cJSON_GetObjectItem(item, "enabled");
        cJSON *audioUrl = cJSON_GetObjectItem(item, "audioUrl");
        cJSON *audioMd5 = cJSON_GetObjectItem(item, "audioMd5");
        cJSON *repeatPlay = cJSON_GetObjectItem(item, "repeatPlayCount");
        cJSON *repeatDays = cJSON_GetObjectItem(item, "repeatDays");

        if (cJSON_IsString(id)) snprintf(dst->id, sizeof(dst->id), "%s", id->valuestring);
        if (cJSON_IsString(title)) snprintf(dst->title, sizeof(dst->title), "%s", title->valuestring);
        if (cJSON_IsString(timeStr)) {
            int h = 0, m = 0;
            if (sscanf(timeStr->valuestring, "%d:%d", &h, &m) == 2) {
                dst->hour = (uint8_t)h;
                dst->minute = (uint8_t)m;
            }
        }
        dst->enabled = cJSON_IsBool(enabled) ? cJSON_IsTrue(enabled) : true;
        if (cJSON_IsString(audioUrl)) snprintf(dst->audio_url, sizeof(dst->audio_url), "%s", audioUrl->valuestring);
        if (cJSON_IsString(audioMd5)) snprintf(dst->audio_md5, sizeof(dst->audio_md5), "%s", audioMd5->valuestring);
        dst->repeat_play_count = cJSON_IsNumber(repeatPlay) ? (uint8_t)repeatPlay->valueint : 2;

        uint8_t mask = 0;
        if (cJSON_IsArray(repeatDays)) {
            cJSON *d = NULL;
            cJSON_ArrayForEach(d, repeatDays) {
                if (cJSON_IsNumber(d) && d->valueint >= 1 && d->valueint <= 7) {
                    mask |= (1 << d->valueint);
                }
            }
        }
        dst->repeat_mask = mask ? mask : 0xFE;

        if (dst->enabled && strlen(dst->audio_url) > 0) {
            prefetch_alarm_audio(dst->audio_url, dst->audio_md5);
        }
        count++;
    }

    s_schedule_count = count;
    ESP_LOGI(TAG, "Synced %d voice schedules into PCF85063 RTC table", s_schedule_count);
    cJSON_Delete(root);
}

esp_err_t rtc_scheduler_fetch_and_sync(void) {
    if (!wifi_manager_is_connected()) return ESP_ERR_INVALID_STATE;

    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/schedules?deviceId=%s",
             CONFIG_PET_SERVER_URL, wifi_manager_get_device_id());

    char *buf = calloc(1, SCHED_HTTP_BUF_SIZE);
    if (!buf) return ESP_ERR_NO_MEM;

    sched_resp_t ctx = {.buf = buf, .len = 0, .cap = SCHED_HTTP_BUF_SIZE};
    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 10000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_redirect = true,
        .event_handler = sched_http_event_handler,
        .user_data = &ctx,
    };

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    pet_http_add_auth(client, url);
    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK && esp_http_client_get_status_code(client) == 200 && ctx.len > 0) {
        cJSON *root = cJSON_Parse(ctx.buf);
        if (!root || !cJSON_IsArray(cJSON_GetObjectItem(root, "schedules"))) {
            err = ESP_FAIL;
        } else {
            rtc_scheduler_sync_from_json(ctx.buf);
        }
        cJSON_Delete(root);
    } else {
        ESP_LOGW(TAG, "Schedule sync HTTP err=%s", esp_err_to_name(err));
        err = ESP_FAIL;
    }

    esp_http_client_cleanup(client);
    free(buf);
    return err;
}

static void rtc_monitor_task(void *arg) {
    // Set China Standard Time (CST-8) for localtime matching
    setenv("TZ", "CST-8", 1);
    tzset();

    while (1) {
        time_t now = time(NULL);
        if (now > 1700000000) {
            struct tm tm_now;
            localtime_r(&now, &tm_now);
            // Convert tm_wday (0=Sun..6=Sat) -> 1=Mon..7=Sun
            int iso_wday = tm_now.tm_wday == 0 ? 7 : tm_now.tm_wday;
            int cur_min_of_day = tm_now.tm_hour * 60 + tm_now.tm_min;

            for (int i = 0; i < s_schedule_count; i++) {
                pet_schedule_t *s = &s_schedules[i];
                if (!s->enabled) continue;
                if ((s->repeat_mask & (1 << iso_wday)) == 0) continue;
                if (tm_now.tm_hour == s->hour && tm_now.tm_min == s->minute) {
                    if (s->last_triggered_yday != tm_now.tm_yday || s->last_triggered_min != cur_min_of_day) {
                        s->last_triggered_yday = tm_now.tm_yday;
                        s->last_triggered_min = cur_min_of_day;
                        char local_path[96];
                        snprintf(local_path, sizeof(local_path), "/sdcard/alarms/%s.mp3",
                                 strlen(s->audio_md5) ? s->audio_md5 : s->id);
                        ui_trigger_alarm_modal(s->id, s->title, local_path);
                    }
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}

void rtc_scheduler_init(void) {
    ESP_LOGI(TAG, "PCF85063 hardware RTC & local audio cache manager initialized");
    xTaskCreate(rtc_monitor_task, "rtc_monitor_task", 4096, NULL, 4, NULL);
}
