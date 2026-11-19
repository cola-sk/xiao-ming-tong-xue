#include "rtc_scheduler.h"
#include "schedule_rules.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include <sys/stat.h>
#include <unistd.h>
#include <dirent.h>
#include <stdatomic.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "pet_http_auth.h"
#include "esp_crt_bundle.h"
#include "cJSON.h"
#include "wifi_manager.h"
#include "ui_state_machine.h"
#include "audio_engine.h"
#include "audio_download.h"
#include "device_storage.h"
#include "device_sync.h"
#include "bsp/esp-bsp.h"
#include "driver/i2c_master.h"
#include "nvs.h"
#include "mbedtls/md5.h"

static const char *TAG = "rtc_scheduler";
static pet_schedule_t s_schedules[MAX_SCHEDULES];
static int s_count;
static SemaphoreHandle_t s_lock;
static i2c_master_dev_handle_t s_rtc;
static atomic_bool s_alarm_active, s_alarm_ack;
static pet_schedule_t s_active;
static atomic_uint s_version = 1;
#ifdef PET_HARDWARE_SMOKE
static atomic_int s_smoke_offset;
#endif
#define SCHEDULE_FILE PET_STORAGE_BASE "/schedules.json"
#define SCHED_HTTP_BUF_SIZE 24576

static int bcd(uint8_t v) { return (v >> 4) * 10 + (v & 15); }
static uint8_t to_bcd(int v) { return (v / 10) * 16 + v % 10; }
static void rtc_hardware_init(void) {
    i2c_device_config_t cfg = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x51, .scl_speed_hz = 100000 };
    if (i2c_master_bus_add_device(bsp_i2c_get_handle(), &cfg, &s_rtc) != ESP_OK) return;
    uint8_t reg = 4, bytes[7];
    if (i2c_master_transmit_receive(s_rtc, &reg, 1, bytes, 7, 100) != ESP_OK || (bytes[0] & 0x80)) { ESP_LOGW(TAG, "RTC time invalid; waiting for server clock"); return; }
    struct tm t = { .tm_sec = bcd(bytes[0] & 0x7f), .tm_min = bcd(bytes[1] & 0x7f), .tm_hour = bcd(bytes[2] & 0x3f),
        .tm_mday = bcd(bytes[3] & 0x3f), .tm_mon = bcd(bytes[5] & 0x1f) - 1, .tm_year = 100 + bcd(bytes[6]), .tm_isdst = -1 };
    if (t.tm_sec > 59 || t.tm_min > 59 || t.tm_hour > 23 || t.tm_mday < 1 || t.tm_mday > 31 || t.tm_mon < 0 || t.tm_mon > 11 || t.tm_year < 124 || t.tm_year > 199) {
        ESP_LOGW(TAG, "RTC registers out of range; waiting for server clock"); return;
    }
    time_t epoch = mktime(&t);
    if (epoch > 1700000000) { struct timeval tv = { .tv_sec = epoch }; settimeofday(&tv, NULL); ESP_LOGI(TAG, "Clock restored from PCF85063"); }
}
void rtc_scheduler_set_time(time_t epoch) {
    if (epoch < 1700000000) return;
    struct timeval tv = { .tv_sec = epoch }; settimeofday(&tv, NULL);
    atomic_fetch_add(&s_version, 1);
    if (!s_rtc) return;
    struct tm t; localtime_r(&epoch, &t);
    uint8_t bytes[] = { 4, to_bcd(t.tm_sec), to_bcd(t.tm_min), to_bcd(t.tm_hour), to_bcd(t.tm_mday), to_bcd(t.tm_wday), to_bcd(t.tm_mon + 1), to_bcd(t.tm_year - 100) };
    if (i2c_master_transmit(s_rtc, bytes, sizeof(bytes), 100) != ESP_OK) return;
    uint8_t reg = 0, control;
    if (i2c_master_transmit_receive(s_rtc, &reg, 1, &control, 1, 100) == ESP_OK) {
        uint8_t run[] = { 0, control & ~0x22 }; i2c_master_transmit(s_rtc, run, sizeof(run), 100);
    }
}
static void schedule_key(const pet_schedule_t *s, char key[16], char prefix) {
    char content[160]; snprintf(content, sizeof(content), "%s/%u:%u/%s", s->id, s->hour, s->minute, s->audio_md5);
    unsigned char md5[16]; mbedtls_md5((unsigned char *)content, strlen(content), md5);
    key[0] = prefix; for (int i = 0; i < 6; i++) snprintf(key + 1 + 2 * i, 3, "%02x", md5[i]);
}
static int32_t last_fired(const pet_schedule_t *s) {
    nvs_handle_t h; int32_t value = 0; char key[16]; schedule_key(s, key, 'f');
    if (nvs_open("pet_alarms", NVS_READONLY, &h) == ESP_OK) { nvs_get_i32(h, key, &value); nvs_close(h); } return value;
}
static void mark_fired(const pet_schedule_t *s, int32_t stamp) {
    nvs_handle_t h; char key[16]; schedule_key(s, key, 'f');
    if (nvs_open("pet_alarms", NVS_READWRITE, &h) == ESP_OK) { nvs_set_i32(h, key, stamp); nvs_commit(h); nvs_close(h); }
}
static void clear_fired(const pet_schedule_t *s) {
    nvs_handle_t h; char key[16]; schedule_key(s, key, 'f');
    if (nvs_open("pet_alarms", NVS_READWRITE, &h) == ESP_OK) { nvs_erase_key(h, key); nvs_commit(h); nvs_close(h); }
}
static bool md5_valid(const char *md5) {
    if (strlen(md5) != 32) return false;
    for (int i = 0; i < 32; i++) if (!((md5[i] >= '0' && md5[i] <= '9') || (md5[i] >= 'a' && md5[i] <= 'f') || (md5[i] >= 'A' && md5[i] <= 'F'))) return false;
    return true;
}
static bool cache_path(const pet_schedule_t *s, char path[96]) {
    if (!md5_valid(s->audio_md5)) return false;
    snprintf(path, 96, PET_STORAGE_BASE "/alarms/%s.mp3", s->audio_md5); return true;
}
static const char *str(cJSON *obj, const char *name) { cJSON *v = cJSON_GetObjectItem(obj, name); return cJSON_IsString(v) ? v->valuestring : ""; }
static bool schedule_needs_audio(const pet_schedule_t *s) {
    return s->enabled && !(s->repeat_mask == 0 && last_fired(s) != 0);
}
static bool audio_md5_in_use(const pet_schedule_t *items, int count, const char *md5, const char *exclude_id) {
    for (int i = 0; i < count; i++) {
        if (exclude_id && !strcmp(items[i].id, exclude_id)) continue;
        if (schedule_needs_audio(&items[i]) && !strncasecmp(md5, items[i].audio_md5, 32)) return true;
    }
    return false;
}
static void prune_audio_cache(const pet_schedule_t *items, int count) {
    DIR *dir = opendir(PET_STORAGE_BASE); if (!dir) return;
    struct dirent *entry;
    while ((entry = readdir(dir))) {
        const char *name = entry->d_name;
        if (*name == '/') name++;
        if (strncmp(name, "alarms/", 7) || strlen(name) != 43 || strcmp(name + 39, ".mp3")) continue;
        if (!audio_md5_in_use(items, count, name + 7, NULL)) {
            char path[128]; snprintf(path, sizeof(path), "%s/%.100s", PET_STORAGE_BASE, name); unlink(path);
        }
    }
    closedir(dir);
}
static bool apply_json(const char *json, bool download) {
    cJSON *root = cJSON_Parse(json); if (!root) return false;
    cJSON *arr = cJSON_GetObjectItem(root, "schedules");
    if (!cJSON_IsArray(arr) || cJSON_GetArraySize(arr) > MAX_SCHEDULES) { cJSON_Delete(root); return false; }
    pet_schedule_t *next = calloc(MAX_SCHEDULES, sizeof(*next)); if (!next) { cJSON_Delete(root); return false; }
    int count = 0; bool complete = true;
    cJSON *item;
    cJSON_ArrayForEach(item, arr) {
        int h, m;
        if (!*str(item, "id") || strlen(str(item, "id")) >= sizeof(next[0].id) || sscanf(str(item, "timeStr"), "%d:%d", &h, &m) != 2 || h < 0 || h > 23 || m < 0 || m > 59) { complete = false; continue; }
        pet_schedule_t *s = &next[count++];
        snprintf(s->id, sizeof(s->id), "%s", str(item, "id")); snprintf(s->title, sizeof(s->title), "%s", str(item, "title"));
        snprintf(s->audio_url, sizeof(s->audio_url), "%s", str(item, "audioUrl")); snprintf(s->audio_md5, sizeof(s->audio_md5), "%s", str(item, "audioMd5"));
        s->hour = h; s->minute = m; s->enabled = cJSON_IsTrue(cJSON_GetObjectItem(item, "enabled"));
        cJSON *repeat = cJSON_GetObjectItem(item, "repeatPlayCount"); int repeats = cJSON_IsNumber(repeat) ? repeat->valueint : 2;
        s->repeat_play_count = repeats < 1 ? 1 : repeats > 20 ? 20 : repeats;
        s->require_ack = cJSON_IsTrue(cJSON_GetObjectItem(item, "requireAck"));
        cJSON *days = cJSON_GetObjectItem(item, "repeatDays"), *d;
        cJSON_ArrayForEach(d, days) if (cJSON_IsNumber(d) && d->valueint >= 1 && d->valueint <= 7) s->repeat_mask |= 1 << d->valueint;
        // Empty repeatDays means one shot, matching the parent UI.
        if (download && s->repeat_mask == 0 && s->enabled &&
            strcmp(str(item, "lastAckStatus"), "idle") == 0 && last_fired(s) != 0) {
            clear_fired(s);
        }
        ESP_LOGI(TAG, "Sched item id=%s %02u:%02u enabled=%d mask=0x%02x repeats=%u req_ack=%d md5=%s fired=%ld",
                 s->id, s->hour, s->minute, s->enabled, s->repeat_mask, s->repeat_play_count, s->require_ack, s->audio_md5, (long)last_fired(s));
        if (schedule_needs_audio(s)) {
            char path[96];
            if (!cache_path(s, path)) {
                ESP_LOGW(TAG, "Sched %s invalid md5='%s'", s->id, s->audio_md5);
                complete = false;
            } else if (download && audio_download_file(s->audio_url, path, s->audio_md5) != ESP_OK) {
                ESP_LOGW(TAG, "Sched %s audio download failed url=%s", s->id, s->audio_url);
                complete = false;
            } else if (!download && !audio_cache_valid(path, s->audio_md5)) {
                ESP_LOGW(TAG, "Sched %s local cache invalid", s->id);
                s->enabled = false;
            }
        }
    }
    xSemaphoreTake(s_lock, portMAX_DELAY); memcpy(s_schedules, next, MAX_SCHEDULES * sizeof(*next)); s_count = count; xSemaphoreGive(s_lock);
    atomic_fetch_add(&s_version, 1);
    if (download && complete) prune_audio_cache(next, count);
    free(next); cJSON_Delete(root); return complete;
}
void rtc_scheduler_sync_from_json(const char *json) { if (json) apply_json(json, true); }
typedef struct { char *buf; int used; bool overflow; } response_t;
static esp_err_t http_event(esp_http_client_event_t *evt) {
    response_t *r = evt->user_data;
    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->data_len > 0) {
        if (r->used + evt->data_len >= SCHED_HTTP_BUF_SIZE) r->overflow = true;
        else { memcpy(r->buf + r->used, evt->data, evt->data_len); r->used += evt->data_len; r->buf[r->used] = 0; }
    } return ESP_OK;
}
esp_err_t rtc_scheduler_fetch_and_sync(void) {
    if (!wifi_manager_is_connected() || !device_pairing_is_paired()) return ESP_ERR_INVALID_STATE;
    response_t r = { .buf = calloc(1, SCHED_HTTP_BUF_SIZE) }; if (!r.buf) return ESP_ERR_NO_MEM;
    char url[256]; snprintf(url, sizeof(url), "%s/api/v1/schedules?deviceId=%s", CONFIG_PET_SERVER_URL, wifi_manager_get_device_id());
    esp_http_client_config_t cfg = { .url = url, .timeout_ms = 10000, .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_redirect = true, .addr_type = HTTP_ADDR_TYPE_INET, .event_handler = http_event, .user_data = &r };
    esp_http_client_handle_t c = pet_http_init(&cfg); if (!c) { free(r.buf); return ESP_ERR_NO_MEM; }
    pet_http_add_auth(c, url); esp_err_t err = pet_http_perform(c);
    int status = esp_http_client_get_status_code(c); esp_http_client_cleanup(c);
    if (err == ESP_OK && status == 200 && !r.overflow && r.used) {
        // Persist the complete task list, even if an audio download must retry.
        cJSON *j = cJSON_Parse(r.buf); bool valid = j && cJSON_IsArray(cJSON_GetObjectItem(j, "schedules")); cJSON_Delete(j);
        if (valid) {
            FILE *f = fopen(SCHEDULE_FILE ".tmp", "wb");
            if (f) { bool ok = fwrite(r.buf, 1, r.used, f) == r.used; if (fclose(f)) ok = false; if (ok) rename(SCHEDULE_FILE ".tmp", SCHEDULE_FILE); }
            err = apply_json(r.buf, true) ? ESP_OK : ESP_FAIL;
            ESP_LOGI(TAG, "Synced schedules: count=%d ok=%d", s_count, err == ESP_OK);
        } else {
            ESP_LOGW(TAG, "Schedule sync parse failed (status=%d overflow=%d used=%d)", status, r.overflow, r.used);
            err = ESP_FAIL;
        }
    } else {
        ESP_LOGW(TAG, "Schedule fetch failed (err=%s status=%d overflow=%d used=%d)", esp_err_to_name(err), status, r.overflow, r.used);
        err = ESP_FAIL;
    }
    free(r.buf); return err;
}
void rtc_scheduler_ack_active(void) {
    if (atomic_load(&s_alarm_active)) { atomic_store(&s_alarm_ack, true); audio_engine_stop_playback(); }
}
static void save_ack(const char *id) {
    nvs_handle_t h; if (nvs_open("pet_alarms", NVS_READWRITE, &h) != ESP_OK) return;
    // One displayed reminder at a time. Queue multiple offline confirmations in NVS.
    for (int i = 0; i < 16; i++) { char key[12], prior[48]; size_t len = sizeof(prior); snprintf(key, sizeof(key), "ack%d", i);
        if (nvs_get_str(h, key, prior, &len) != ESP_OK) { nvs_set_str(h, key, id); break; }
        if (!strcmp(prior, id)) break;
    } nvs_commit(h); nvs_close(h);
}
void rtc_scheduler_flush_acks(void) {
    for (int i = 0; i < 16 && wifi_manager_is_connected(); i++) {
        nvs_handle_t h; char key[12], id[48]; size_t len = sizeof(id); snprintf(key, sizeof(key), "ack%d", i);
        if (nvs_open("pet_alarms", NVS_READWRITE, &h) != ESP_OK) return;
        esp_err_t err = nvs_get_str(h, key, id, &len); nvs_close(h);
        if (err == ESP_OK && device_sync_send_alarm_ack(id) == ESP_OK && nvs_open("pet_alarms", NVS_READWRITE, &h) == ESP_OK) {
            nvs_erase_key(h, key); nvs_commit(h); nvs_close(h);
        }
    }
}
static void rtc_monitor_task(void *arg) {
    while (1) {
        time_t now = time(NULL);
#ifdef PET_HARDWARE_SMOKE
        now += atomic_load(&s_smoke_offset);
#endif
        struct tm t; localtime_r(&now, &t);
        if (now > 1700000000) {
            int32_t stamp = schedule_date_stamp(&t);
            pet_schedule_t candidates[MAX_SCHEDULES]; int count;
            xSemaphoreTake(s_lock, portMAX_DELAY); count = s_count; memcpy(candidates, s_schedules, sizeof(candidates)); xSemaphoreGive(s_lock);
            for (int i = 0; i < count; i++) {
                pet_schedule_t *s = &candidates[i];
                if (!schedule_is_due(s->enabled, s->hour, s->minute, s->repeat_mask, &t, last_fired(s))) continue;
                char path[96]; struct stat cached;
                // MD5 is checked on download/load; avoid re-reading the entire file at its due time.
                if (!cache_path(s, path) || stat(path, &cached) || cached.st_size <= 0 || cached.st_size > 1024 * 1024) continue;
                s_active = *s; atomic_store(&s_alarm_ack, false); atomic_store(&s_alarm_active, true);
                atomic_fetch_add(&s_version, 1);
                ESP_LOGI(TAG, "Alarm due id=%s repeats=%u req_ack=%d", s->id, s->repeat_play_count, s->require_ack);
                ui_trigger_alarm_modal(s->id, s->title, path);
                bool played = false;
                for (int n = 0; n < s->repeat_play_count && !atomic_load(&s_alarm_ack); n++) {
                    esp_err_t err = audio_engine_play_file(path);
                    if (err != ESP_OK) break;
                    played = true;
                    for (int w = 0; w < 10 && !atomic_load(&s_alarm_ack) && n + 1 < s->repeat_play_count; w++) {
                        vTaskDelay(pdMS_TO_TICKS(100));
                    }
                }
                if (played || atomic_load(&s_alarm_ack)) {
                    mark_fired(s, stamp);
                }
                if (s->require_ack && played && !atomic_load(&s_alarm_ack)) {
                    ui_set_alarm_modal_subtitle("请点击下方按钮确认结束");
                    while (!atomic_load(&s_alarm_ack)) {
                        vTaskDelay(pdMS_TO_TICKS(200));
                        bool still_enabled = false;
                        xSemaphoreTake(s_lock, portMAX_DELAY);
                        for (int k = 0; k < s_count; k++) {
                            if (strcmp(s_schedules[k].id, s->id) == 0 && s_schedules[k].enabled) {
                                still_enabled = true;
                                break;
                            }
                        }
                        xSemaphoreGive(s_lock);
                        if (!still_enabled) break;
                    }
                }
                bool acked = atomic_exchange(&s_alarm_ack, false);
                if (acked || (played && s->repeat_mask == 0)) {
                    if (!wifi_manager_is_connected() || device_sync_send_alarm_ack(s_active.id) != ESP_OK) {
                        save_ack(s_active.id);
                    }
                }
                if (played || acked) {
                    if (s->repeat_mask == 0) {
                        xSemaphoreTake(s_lock, portMAX_DELAY);
                        bool in_use = audio_md5_in_use(s_schedules, s_count, s->audio_md5, s->id);
                        xSemaphoreGive(s_lock);
                        if (!in_use && unlink(path) == 0) {
                            ESP_LOGI(TAG, "Cleaned up one-shot alarm audio %s", path);
                        }
                    }
                    ESP_LOGI(TAG, "Alarm finished id=%s acked=%d", s->id, acked);
                }
                atomic_store(&s_alarm_active, false);
                ui_hide_alarm_modal();
                atomic_fetch_add(&s_version, 1);
                break;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
uint32_t rtc_scheduler_get_version(void) {
    return atomic_load(&s_version);
}
int rtc_scheduler_get_today_schedules(pet_today_schedule_t *out, int max_items, bool *clock_valid) {
    time_t now = time(NULL);
    bool valid = now > 1700000000;
    if (clock_valid) *clock_valid = valid;
    if (!valid || !out || max_items <= 0 || !s_lock) return 0;

    pet_schedule_t *candidates = calloc(MAX_SCHEDULES, sizeof(*candidates));
    pet_today_schedule_t *sorted = calloc(MAX_SCHEDULES, sizeof(*sorted));
    if (!candidates || !sorted) {
        free(candidates);
        free(sorted);
        return 0;
    }

    struct tm t; localtime_r(&now, &t);
    int32_t stamp = schedule_date_stamp(&t);
    int count = 0;
    bool ringing = atomic_load(&s_alarm_active);
    char active_id[48] = {0};

    xSemaphoreTake(s_lock, portMAX_DELAY);
    count = s_count;
    memcpy(candidates, s_schedules, MAX_SCHEDULES * sizeof(*candidates));
    if (ringing) snprintf(active_id, sizeof(active_id), "%s", s_active.id);
    xSemaphoreGive(s_lock);

    int found = 0;
    for (int i = 0; i < count && found < MAX_SCHEDULES; i++) {
        const pet_schedule_t *s = &candidates[i];
        int32_t fired = last_fired(s);
        if (!schedule_is_for_today(s->enabled, s->repeat_mask, &t, fired)) continue;

        pet_today_schedule_t item = {0};
        snprintf(item.id, sizeof(item.id), "%s", s->id);
        snprintf(item.title, sizeof(item.title), "%s", s->title);
        item.hour = s->hour;
        item.minute = s->minute;
        if (ringing && strcmp(s->id, active_id) == 0) item.status = SCHEDULE_STATUS_RINGING;
        else if (fired == stamp) item.status = SCHEDULE_STATUS_DONE;
        else item.status = SCHEDULE_STATUS_PENDING;

        int pos = found;
        int item_min = (int)item.hour * 60 + item.minute;
        while (pos > 0 && ((int)sorted[pos - 1].hour * 60 + sorted[pos - 1].minute) > item_min) {
            sorted[pos] = sorted[pos - 1];
            pos--;
        }
        sorted[pos] = item;
        found++;
    }
    int copy_count = found < max_items ? found : max_items;
    memcpy(out, sorted, (size_t)copy_count * sizeof(*out));
    free(candidates);
    free(sorted);
    return copy_count;
}
void rtc_scheduler_init(void) {
    s_lock = xSemaphoreCreateMutex(); setenv("TZ", "CST-8", 1); tzset(); rtc_hardware_init();
    FILE *f = fopen(SCHEDULE_FILE, "rb");
    if (f) { char *buf = calloc(1, SCHED_HTTP_BUF_SIZE); if (buf) { size_t n = fread(buf, 1, SCHED_HTTP_BUF_SIZE - 1, f); if (n && !ferror(f) && feof(f)) apply_json(buf, false); free(buf); } fclose(f); }
    xTaskCreate(rtc_monitor_task, "rtc_monitor", 12288, NULL, 4, NULL);
    ESP_LOGI(TAG, "RTC scheduler ready: %d cached tasks", s_count);
}

#ifdef PET_HARDWARE_SMOKE
bool rtc_scheduler_smoke_alarm(const char *md5) {
    if (wifi_manager_is_connected()) return false;
    pet_schedule_t *backup = malloc(sizeof(s_schedules)); if (!backup) return false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    int backup_count = s_count; memcpy(backup, s_schedules, sizeof(s_schedules));
    time_t now = time(NULL), target = now + 60 - now % 60;
    struct tm t; localtime_r(&target, &t);
    pet_schedule_t test = { .enabled = true, .hour = t.tm_hour, .minute = t.tm_min, .repeat_play_count = 1 };
    snprintf(test.id, sizeof(test.id), "hardware_smoke_alarm"); snprintf(test.audio_md5, sizeof(test.audio_md5), "%s", md5);
    nvs_handle_t initial; char fired_key[16]; schedule_key(&test, fired_key, 'f');
    if (nvs_open("pet_alarms", NVS_READWRITE, &initial) == ESP_OK) { nvs_erase_key(initial, fired_key); nvs_commit(initial); nvs_close(initial); }
    s_schedules[0] = test; s_count = 1; atomic_store(&s_smoke_offset, target - now - 2);
    xSemaphoreGive(s_lock);
    bool ok = false;
    TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(35000);
    while ((int32_t)(deadline - xTaskGetTickCount()) > 0) {
        if (last_fired(&test) == schedule_date_stamp(&t)) { ok = true; break; }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    rtc_scheduler_ack_active(); vTaskDelay(pdMS_TO_TICKS(1000));
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_count == 1 && !strcmp(s_schedules[0].id, test.id)) { memcpy(s_schedules, backup, sizeof(s_schedules)); s_count = backup_count; }
    atomic_store(&s_smoke_offset, 0); xSemaphoreGive(s_lock); free(backup);
    nvs_handle_t h; if (nvs_open("pet_alarms", NVS_READWRITE, &h) == ESP_OK) {
        char key[16]; schedule_key(&test, key, 'f'); nvs_erase_key(h, key);
        for (int i = 0; i < 16; i++) { char id[48]; size_t len = sizeof(id); snprintf(key, sizeof(key), "ack%d", i);
            if (nvs_get_str(h, key, id, &len) == ESP_OK && !strcmp(id, test.id)) nvs_erase_key(h, key);
        } nvs_commit(h); nvs_close(h);
    }
    return ok;
}
#endif
