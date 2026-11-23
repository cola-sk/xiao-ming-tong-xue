#include "chat_client.h"
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <dirent.h>
#include <sys/stat.h>
#include <stdatomic.h>
#include "esp_log.h"
#include "esp_random.h"
#include "esp_http_client.h"
#include "esp_wifi.h"
#include "esp_timer.h"
#include "pet_http_auth.h"
#include "esp_crt_bundle.h"
#include "mbedtls/base64.h"
#include "cJSON.h"
#include "wifi_manager.h"
#include "audio_engine.h"
#include "device_sync.h"
#include "device_storage.h"
#include "ui_state_machine.h"
#include "audio_download.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

static const char *TAG = "chat_client";

#define CHAT_HTTP_BUF_SIZE (64 * 1024)
#define CHAT_HISTORY_FILE PET_STORAGE_BASE "/chat_hist.json"
#define CHAT_CACHE_MAX_BYTES (2 * 1024 * 1024)

static chat_message_info_t *s_history = NULL;
static int s_history_count = 0;
static SemaphoreHandle_t s_chat_lock = NULL;
static atomic_uint s_chat_version = 1;
static atomic_bool s_parent_play_busy;
static atomic_int s_play_phase = CHAT_PLAY_IDLE;
static atomic_uint s_active_play_gen = 0;
static atomic_bool s_upload_busy;
static char s_playing_id[48] = {0};
static chat_message_info_t s_pending_msg = {0};
static bool s_pending_valid = false;
static int s_unread_count = 0;

static void ensure_chat_init(void) {
    if (!s_chat_lock) s_chat_lock = xSemaphoreCreateMutex();
    if (!s_history) {
        s_history = heap_caps_calloc(CHAT_HISTORY_MAX, sizeof(chat_message_info_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!s_history) s_history = calloc(CHAT_HISTORY_MAX, sizeof(chat_message_info_t));
    }
}

static void sanitize_id(const char *id, char *out, size_t out_len) {
    size_t j = 0;
    for (size_t i = 0; id && id[i] && j + 1 < out_len && j < 40; i++) {
        char c = id[i];
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '-') {
            out[j++] = c;
        }
    }
    out[j] = 0;
}

static bool wechat_cache_path(const char *msg_id, char *out, size_t out_len) {
    char safe[44];
    sanitize_id(msg_id, safe, sizeof(safe));
    if (!safe[0]) return false;
    snprintf(out, out_len, PET_STORAGE_BASE "/wechat/%s.aud", safe);
    return true;
}

static bool file_exists_nonempty(const char *path) {
    struct stat st;
    return path && path[0] && stat(path, &st) == 0 && st.st_size > 0;
}

static bool save_local_audio_file(const char *msg_id, const uint8_t *audio, size_t audio_len) {
    char path[96], tmp[104];
    if (!audio || !audio_len || !wechat_cache_path(msg_id, path, sizeof(path))) return false;
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    FILE *f = fopen(tmp, "wb");
    if (!f) return false;
    bool ok = fwrite(audio, 1, audio_len, f) == audio_len;
    if (fclose(f) != 0) ok = false;
    if (ok && rename(tmp, path) == 0) return true;
    unlink(tmp);
    return false;
}

static const char *send_state_to_str(chat_send_state_t st) {
    if (st == CHAT_SEND_SENDING) return "sending";
    if (st == CHAT_SEND_FAILED) return "failed";
    return "sent";
}

static chat_send_state_t parse_send_state(const char *s, bool on_boot) {
    if (!s) return CHAT_SEND_SENT;
    if (strcmp(s, "failed") == 0) return CHAT_SEND_FAILED;
    if (strcmp(s, "sending") == 0) return on_boot ? CHAT_SEND_FAILED : CHAT_SEND_SENDING;
    return CHAT_SEND_SENT;
}

static void format_iso_to_cst8(const char *iso, char out[8]) {
    int hh = 0, mm = 0;
    const char *t = iso ? strchr(iso, 'T') : NULL;
    if (t && sscanf(t + 1, "%d:%d", &hh, &mm) == 2 && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
        if (strchr(iso, 'Z')) hh = (hh + 8) % 24;
        snprintf(out, 8, "%02d:%02d", hh, mm);
        return;
    }
    snprintf(out, 8, "--:--");
}

static void now_time_str(char out[8]) {
    time_t now = time(NULL);
    if (now > 1700000000) {
        struct tm t;
        localtime_r(&now, &t);
        snprintf(out, 8, "%02d:%02d", t.tm_hour, t.tm_min);
    } else {
        snprintf(out, 8, "刚刚");
    }
}

static bool is_placeholder_text(const char *text) {
    if (!text || !*text) return true;
    return strncmp(text, "（", 3) == 0 || text[0] == '(';
}

static void refresh_pending_from_history_locked(void) {
    s_unread_count = 0;
    s_pending_valid = false;
    memset(&s_pending_msg, 0, sizeof(s_pending_msg));
    for (int i = 0; i < s_history_count; i++) {
        if (s_history[i].from_parent && s_history[i].unread) {
            s_unread_count++;
            s_pending_msg = s_history[i];
            s_pending_valid = true;
        }
    }
}

static int snapshot_history(chat_message_info_t *out, int max_items) {
    ensure_chat_init();
    if (!s_chat_lock || !s_history || !out || max_items <= 0) return 0;
    xSemaphoreTake(s_chat_lock, portMAX_DELAY);
    int n = s_history_count < max_items ? s_history_count : max_items;
    if (n > 0) memcpy(out, s_history, (size_t)n * sizeof(chat_message_info_t));
    xSemaphoreGive(s_chat_lock);
    return n;
}

static void save_history_file(void) {
    chat_message_info_t *items = heap_caps_calloc(CHAT_HISTORY_MAX, sizeof(chat_message_info_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!items) return;
    int count = snapshot_history(items, CHAT_HISTORY_MAX);
    cJSON *root = cJSON_CreateObject();
    cJSON *arr = cJSON_CreateArray();
    if (root && arr) {
        cJSON_AddItemToObject(root, "messages", arr);
        for (int i = 0; i < count; i++) {
            cJSON *m = cJSON_CreateObject();
            if (!m) continue;
            cJSON_AddStringToObject(m, "id", items[i].id);
            cJSON_AddStringToObject(m, "sender", items[i].sender);
            cJSON_AddStringToObject(m, "text", items[i].text);
            cJSON_AddStringToObject(m, "audioUrl", items[i].audio_url);
            cJSON_AddStringToObject(m, "timeStr", items[i].time_str);
            cJSON_AddStringToObject(m, "mime", items[i].mime);
            cJSON_AddStringToObject(m, "sendState", send_state_to_str(items[i].send_state));
            cJSON_AddNumberToObject(m, "durationSec", items[i].duration_sec);
            cJSON_AddBoolToObject(m, "fromParent", items[i].from_parent);
            cJSON_AddBoolToObject(m, "unread", items[i].unread);
            cJSON_AddItemToArray(arr, m);
        }
        char *json = cJSON_PrintUnformatted(root);
        if (json) {
            FILE *f = fopen(CHAT_HISTORY_FILE ".tmp", "wb");
            if (f) {
                size_t len = strlen(json);
                bool ok = fwrite(json, 1, len, f) == len;
                if (fclose(f) != 0) ok = false;
                if (ok) rename(CHAT_HISTORY_FILE ".tmp", CHAT_HISTORY_FILE);
                else unlink(CHAT_HISTORY_FILE ".tmp");
            }
            cJSON_free(json);
        }
    }
    if (root) cJSON_Delete(root);
    free(items);
}

static void prune_wechat_audio_cache(void) {
    chat_message_info_t *items = heap_caps_calloc(CHAT_HISTORY_MAX, sizeof(chat_message_info_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!items) return;
    int count = snapshot_history(items, CHAT_HISTORY_MAX);

    DIR *dir = opendir(PET_STORAGE_BASE);
    if (dir) {
        struct dirent *entry;
        while ((entry = readdir(dir))) {
            const char *name = entry->d_name;
            if (*name == '/') name++;
            if (strncmp(name, "wechat/", 7) != 0) continue;
            const char *fname = name + 7;
            size_t flen = strlen(fname);
            bool keep = false;
            if (flen > 4 && strcmp(fname + flen - 4, ".aud") == 0) {
                for (int i = 0; i < count; i++) {
                    char safe[44];
                    sanitize_id(items[i].id, safe, sizeof(safe));
                    if (strlen(safe) == flen - 4 && strncmp(fname, safe, flen - 4) == 0) {
                        keep = true;
                        break;
                    }
                }
            }
            if (!keep) {
                char full[128];
                snprintf(full, sizeof(full), "%s/%.100s", PET_STORAGE_BASE, name);
                unlink(full);
            }
        }
        closedir(dir);
    }

    size_t total_bytes = 0;
    size_t sizes[CHAT_HISTORY_MAX] = {0};
    for (int i = 0; i < count; i++) {
        char path[96];
        struct stat st;
        if (wechat_cache_path(items[i].id, path, sizeof(path)) && stat(path, &st) == 0 && st.st_size > 0) {
            sizes[i] = (size_t)st.st_size;
            total_bytes += sizes[i];
        }
    }
    for (int pass = 0; pass < 2 && total_bytes > CHAT_CACHE_MAX_BYTES; pass++) {
        for (int i = 0; i < count && total_bytes > CHAT_CACHE_MAX_BYTES; i++) {
            if (sizes[i] == 0) continue;
            if (pass == 0 && items[i].send_state != CHAT_SEND_SENT) continue;
            char path[96];
            if (wechat_cache_path(items[i].id, path, sizeof(path)) && unlink(path) == 0) {
                total_bytes -= sizes[i];
                sizes[i] = 0;
                if (s_chat_lock && s_history) {
                    xSemaphoreTake(s_chat_lock, portMAX_DELAY);
                    for (int j = 0; j < s_history_count; j++) {
                        if (strcmp(s_history[j].id, items[i].id) == 0) {
                            s_history[j].has_local_audio = false;
                            break;
                        }
                    }
                    xSemaphoreGive(s_chat_lock);
                }
            }
        }
    }
    free(items);
}

void chat_client_init(void) {
    ensure_chat_init();
    FILE *f = fopen(CHAT_HISTORY_FILE, "rb");
    if (!f) return;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    if (sz > 0 && sz < CHAT_HTTP_BUF_SIZE) {
        char *buf = heap_caps_calloc(1, (size_t)sz + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (buf && fread(buf, 1, (size_t)sz, f) == (size_t)sz) {
            cJSON *root = cJSON_Parse(buf);
            cJSON *arr = root ? cJSON_GetObjectItem(root, "messages") : NULL;
            if (cJSON_IsArray(arr) && s_chat_lock && s_history) {
                xSemaphoreTake(s_chat_lock, portMAX_DELAY);
                s_history_count = 0;
                cJSON *item;
                cJSON_ArrayForEach(item, arr) {
                    if (s_history_count >= CHAT_HISTORY_MAX) break;
                    chat_message_info_t *m = &s_history[s_history_count++];
                    memset(m, 0, sizeof(*m));
                    cJSON *v;
                    if (cJSON_IsString((v = cJSON_GetObjectItem(item, "id")))) snprintf(m->id, sizeof(m->id), "%s", v->valuestring);
                    if (cJSON_IsString((v = cJSON_GetObjectItem(item, "sender")))) snprintf(m->sender, sizeof(m->sender), "%s", v->valuestring);
                    if (cJSON_IsString((v = cJSON_GetObjectItem(item, "text")))) snprintf(m->text, sizeof(m->text), "%s", v->valuestring);
                    if (cJSON_IsString((v = cJSON_GetObjectItem(item, "audioUrl")))) snprintf(m->audio_url, sizeof(m->audio_url), "%s", v->valuestring);
                    if (cJSON_IsString((v = cJSON_GetObjectItem(item, "timeStr")))) snprintf(m->time_str, sizeof(m->time_str), "%s", v->valuestring);
                    if (cJSON_IsString((v = cJSON_GetObjectItem(item, "mime")))) snprintf(m->mime, sizeof(m->mime), "%s", v->valuestring);
                    v = cJSON_GetObjectItem(item, "sendState");
                    m->send_state = parse_send_state(cJSON_IsString(v) ? v->valuestring : NULL, true);
                    if (cJSON_IsNumber((v = cJSON_GetObjectItem(item, "durationSec")))) m->duration_sec = v->valueint;
                    m->from_parent = cJSON_IsTrue(cJSON_GetObjectItem(item, "fromParent"));
                    m->unread = cJSON_IsTrue(cJSON_GetObjectItem(item, "unread"));
                    char path[96];
                    m->has_local_audio = wechat_cache_path(m->id, path, sizeof(path)) && file_exists_nonempty(path);
                }
                refresh_pending_from_history_locked();
                xSemaphoreGive(s_chat_lock);
                atomic_fetch_add(&s_chat_version, 1);
            }
            if (root) cJSON_Delete(root);
        }
        free(buf);
    }
    fclose(f);
    ESP_LOGI(TAG, "Chat client ready: %d cached messages, %d unread", s_history_count, s_unread_count);
}

typedef struct {
    char *buf;
    int len;
    int cap;
    bool overflow;
    bool mp3;
} chat_resp_t;

static esp_err_t chat_http_event_handler(esp_http_client_event_t *evt) {
    chat_resp_t *ctx = (chat_resp_t *)evt->user_data;
    if (evt->event_id == HTTP_EVENT_ON_HEADER && ctx && strcasecmp(evt->header_key, "Content-Type") == 0) ctx->mp3 = strncmp(evt->header_value, "audio/mpeg", 10) == 0;
    if (evt->event_id == HTTP_EVENT_ON_DATA && ctx && evt->data_len > 0) {
        int copy_len = evt->data_len;
        if (ctx->len + copy_len >= ctx->cap) {
            ctx->overflow = true;
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

static esp_err_t post_audio_request(const char *endpoint, cJSON *body) {
    if (!wifi_manager_is_connected() || !device_pairing_is_paired()) return ESP_ERR_INVALID_STATE;
    bool from_parent_play = atomic_load(&s_parent_play_busy);
    unsigned expected_gen = from_parent_play ? atomic_load(&s_active_play_gen) : 0;
    char *post = cJSON_PrintUnformatted(body); if (!post) return ESP_ERR_NO_MEM;
    chat_resp_t ctx = { .cap = 512 * 1024 };
    ctx.buf = heap_caps_malloc(ctx.cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!ctx.buf) { cJSON_free(post); return ESP_ERR_NO_MEM; }
    if (!pet_http_net_lock(15000)) {
        cJSON_free(post); free(ctx.buf);
        return ESP_ERR_TIMEOUT;
    }
    char url[256]; snprintf(url, sizeof(url), "%s%s", CONFIG_PET_SERVER_URL, endpoint);
    wifi_ps_type_t ps; bool restore = esp_wifi_get_ps(&ps) == ESP_OK && esp_wifi_set_ps(WIFI_PS_NONE) == ESP_OK;
    esp_err_t err = ESP_FAIL;
    for (int attempt = 1; attempt <= 3; attempt++) {
        ctx.len = 0; ctx.overflow = false; ctx.mp3 = false;
        esp_http_client_config_t cfg = { .url = url, .method = HTTP_METHOD_POST, .timeout_ms = 20000,
            .buffer_size = 4096,
            .crt_bundle_attach = esp_crt_bundle_attach, .disable_auto_redirect = true,
            .addr_type = HTTP_ADDR_TYPE_INET, .keep_alive_enable = false,
            .event_handler = chat_http_event_handler, .user_data = &ctx };
        esp_http_client_handle_t c = pet_http_init(&cfg);
        if (!c) { err = ESP_ERR_NO_MEM; break; }
        pet_http_add_auth(c, url);
        esp_http_client_set_header(c, "Content-Type", "application/json");
        esp_http_client_set_header(c, "Connection", "close");
        size_t length = strlen(post), sent = 0;
        int64_t started = esp_timer_get_time();
        if (!from_parent_play) ui_set_voice_status("正在连接网络");
        err = esp_http_client_open(c, length);
        int64_t connected = esp_timer_get_time();
        // No body has been sent: it is safe to try another DNS address.
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Audio connect failed attempt=%d elapsed=%lld ms err=%s", attempt, (connected - started) / 1000, esp_err_to_name(err));
            pet_http_note_result(c, err); esp_http_client_close(c); esp_http_client_cleanup(c);
            if (attempt < 3 && wifi_manager_is_connected()) {
                if (!from_parent_play) ui_set_voice_status("连接失败稍后重试");
                vTaskDelay(pdMS_TO_TICKS(800)); continue;
            }
            break;
        }
        esp_http_client_set_timeout_ms(c, 55000);
        while (err == ESP_OK && sent < length) {
            size_t chunk = length - sent; if (chunk > 4096) chunk = 4096;
            int n = esp_http_client_write(c, post + sent, chunk);
            if (n <= 0) { err = ESP_ERR_HTTP_WRITE_DATA; break; }
            sent += n; vTaskDelay(pdMS_TO_TICKS(2));
        }
        int64_t uploaded = esp_timer_get_time();
        if (err == ESP_OK) {
            if (!from_parent_play) ui_set_voice_status("正在思考请稍候");
            int64_t response_len = esp_http_client_fetch_headers(c);
            int status = esp_http_client_get_status_code(c); device_pairing_handle_status(status);
            if (response_len < 0 || response_len >= ctx.cap) err = ESP_FAIL;
            char scratch[2048];
            while (err == ESP_OK) {
                if (from_parent_play && expected_gen != audio_engine_get_stop_generation()) {
                    err = ESP_ERR_NOT_FINISHED;
                    break;
                }
                int n = esp_http_client_read(c, scratch, sizeof(scratch));
                if (n < 0) { err = ESP_FAIL; break; }
                if (n == 0) { if (!esp_http_client_is_complete_data_received(c)) err = ESP_FAIL; break; }
                if (ctx.overflow) { err = ESP_ERR_INVALID_SIZE; break; }
            }
            ESP_LOGI(TAG, "Audio reply HTTP=%d bytes=%d mp3=%d", status, ctx.len, ctx.mp3);
            if (err == ESP_OK && (status != 200 || !ctx.mp3 || ctx.overflow || !ctx.len)) err = ESP_FAIL;
        }
        ESP_LOGI(TAG, "Audio timing: connect=%lld ms upload=%lld ms reply=%lld ms sent=%u/%u result=%s",
                 (connected - started) / 1000, (uploaded - connected) / 1000, (esp_timer_get_time() - uploaded) / 1000,
                 (unsigned)sent, (unsigned)length, esp_err_to_name(err));
        pet_http_note_result(c, err == ESP_ERR_NOT_FINISHED ? ESP_OK : err); esp_http_client_close(c); esp_http_client_cleanup(c);
        break; // After a possible complete upload, only an explicit user retry repeats AI work.
    }
    if (restore) esp_wifi_set_ps(ps);
    pet_http_net_unlock();
    cJSON_free(post);
    if (err == ESP_OK) {
        if (from_parent_play) {
            if (expected_gen != audio_engine_get_stop_generation()) {
                free(ctx.buf);
                return ESP_ERR_NOT_FINISHED;
            }
            atomic_store(&s_play_phase, CHAT_PLAY_PLAYING);
            atomic_fetch_add(&s_chat_version, 1);
            ui_wake_screen();
            ui_set_voice_status("正在播放语音");
            err = audio_engine_play_buffer_gen((uint8_t *)ctx.buf, ctx.len, expected_gen);
        } else {
            ui_wake_screen();
            ui_set_voice_status("正在播放语音");
            err = audio_engine_play_buffer((uint8_t *)ctx.buf, ctx.len);
        }
    }
    free(ctx.buf); return err;
}

static esp_err_t synthesize_and_play_text(const char *text) {
    if (!text || !*text) return ESP_ERR_INVALID_ARG;
    cJSON *body = cJSON_CreateObject(); cJSON_AddStringToObject(body, "text", text);
    cJSON_AddStringToObject(body, "responseFormat", "mp3");
    cJSON_AddBoolToObject(body, "persist", false);
    esp_err_t err = post_audio_request("/api/v1/tts", body); cJSON_Delete(body); return err;
}

esp_err_t chat_client_ask_ai(const char *question) {
    if (!question || !*question) return ESP_ERR_INVALID_ARG;
    cJSON *body = cJSON_CreateObject(); cJSON_AddStringToObject(body, "deviceId", wifi_manager_get_device_id());
    cJSON_AddStringToObject(body, "question", question); cJSON_AddStringToObject(body, "responseFormat", "mp3");
    esp_err_t err = post_audio_request("/api/v1/ai/chat", body); cJSON_Delete(body); return err;
}
esp_err_t chat_client_ask_ai_audio(const uint8_t *audio, size_t len, const char *mime) {
    if (!audio || !len || len > 500000) return ESP_ERR_INVALID_ARG;
    size_t cap = ((len + 2) / 3) * 4 + 1, used = 0;
    char *base64 = heap_caps_malloc(cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); if (!base64) return ESP_ERR_NO_MEM;
    if (mbedtls_base64_encode((unsigned char *)base64, cap, &used, audio, len) != 0) { free(base64); return ESP_FAIL; }
    base64[used] = 0;
    cJSON *body = cJSON_CreateObject(); cJSON_AddStringToObject(body, "deviceId", wifi_manager_get_device_id());
    cJSON_AddStringToObject(body, "audioBase64", base64); cJSON_AddStringToObject(body, "audioMime", mime);
    cJSON_AddStringToObject(body, "responseFormat", "mp3"); free(base64);
    esp_err_t err = post_audio_request("/api/v1/ai/chat", body); cJSON_Delete(body); return err;
}

static void make_room_in_history_locked(void) {
    if (s_history_count < CHAT_HISTORY_MAX) return;
    int victim = 0;
    for (int i = 0; i < s_history_count; i++) {
        if (s_history[i].send_state == CHAT_SEND_SENT) { victim = i; break; }
    }
    if (victim < s_history_count - 1) {
        memmove(&s_history[victim], &s_history[victim + 1],
                (size_t)(s_history_count - 1 - victim) * sizeof(chat_message_info_t));
    }
    s_history_count--;
}

void chat_client_add_local_outgoing(const char *msg_id, const uint8_t *audio, size_t audio_len,
                                    const char *mime, int duration_sec) {
    ensure_chat_init();
    if (!msg_id || !*msg_id || !s_chat_lock || !s_history) return;
    bool local_saved = save_local_audio_file(msg_id, audio, audio_len);
    xSemaphoreTake(s_chat_lock, portMAX_DELAY);
    int idx = -1;
    for (int i = 0; i < s_history_count; i++) {
        if (strcmp(s_history[i].id, msg_id) == 0) { idx = i; break; }
    }
    if (idx < 0) {
        make_room_in_history_locked();
        idx = s_history_count++;
        memset(&s_history[idx], 0, sizeof(chat_message_info_t));
        snprintf(s_history[idx].id, sizeof(s_history[idx].id), "%s", msg_id);
        snprintf(s_history[idx].sender, sizeof(s_history[idx].sender), "%s", "宝贝");
        snprintf(s_history[idx].text, sizeof(s_history[idx].text), "%s", "（宝贝发来一段语音）");
        now_time_str(s_history[idx].time_str);
    }
    chat_message_info_t *m = &s_history[idx];
    if (mime && *mime) snprintf(m->mime, sizeof(m->mime), "%s", mime);
    m->duration_sec = duration_sec > 0 ? duration_sec : 3;
    m->from_parent = false;
    m->unread = false;
    if (local_saved) m->has_local_audio = true;
    m->send_state = CHAT_SEND_SENDING;
    xSemaphoreGive(s_chat_lock);
    atomic_fetch_add(&s_chat_version, 1);
    save_history_file();
    prune_wechat_audio_cache();
}

void chat_client_set_send_state(const char *msg_id, chat_send_state_t state) {
    ensure_chat_init();
    if (!msg_id || !*msg_id || !s_chat_lock || !s_history) return;
    bool changed = false;
    xSemaphoreTake(s_chat_lock, portMAX_DELAY);
    for (int i = 0; i < s_history_count; i++) {
        if (strcmp(s_history[i].id, msg_id) == 0) {
            if (s_history[i].send_state != state) {
                s_history[i].send_state = state;
                changed = true;
            }
            break;
        }
    }
    xSemaphoreGive(s_chat_lock);
    if (changed) {
        atomic_fetch_add(&s_chat_version, 1);
        save_history_file();
    }
}

bool chat_client_is_uploading(void) {
    return atomic_load(&s_upload_busy);
}

esp_err_t chat_client_fetch_history(void) {
    ensure_chat_init();
    if (!wifi_manager_is_connected() || !device_pairing_is_paired()) return ESP_ERR_INVALID_STATE;

    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/chat/messages?deviceId=%s",
             CONFIG_PET_SERVER_URL, wifi_manager_get_device_id());

    char *buf = heap_caps_calloc(1, CHAT_HTTP_BUF_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!buf) return ESP_ERR_NO_MEM;

    if (!pet_http_net_lock(8000)) {
        free(buf);
        return ESP_ERR_TIMEOUT;
    }

    chat_resp_t ctx = {.buf = buf, .len = 0, .cap = CHAT_HTTP_BUF_SIZE};
    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 12000,
        .buffer_size = 2048,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_redirect = true,
        .addr_type = HTTP_ADDR_TYPE_INET,
        .keep_alive_enable = false,
        .event_handler = chat_http_event_handler,
        .user_data = &ctx,
    };

    esp_http_client_handle_t client = pet_http_init(&cfg);
    if (!client) { pet_http_net_unlock(); free(buf); return ESP_ERR_NO_MEM; }
    pet_http_add_auth(client, url);
    esp_http_client_set_header(client, "Connection", "close");
    esp_err_t err = pet_http_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    pet_http_net_unlock();

    if (err == ESP_OK && status == 200 && !ctx.overflow && ctx.len > 0) {
        cJSON *root = cJSON_Parse(ctx.buf);
        cJSON *msgs = root ? cJSON_GetObjectItem(root, "messages") : NULL;
        if (cJSON_IsArray(msgs) && s_chat_lock && s_history) {
            chat_message_info_t *preserved = heap_caps_calloc(CHAT_HISTORY_MAX, sizeof(chat_message_info_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            int preserved_count = 0;

            int total = cJSON_GetArraySize(msgs);
            int start = total > CHAT_HISTORY_MAX ? total - CHAT_HISTORY_MAX : 0;
            xSemaphoreTake(s_chat_lock, portMAX_DELAY);
            if (preserved) {
                for (int i = 0; i < s_history_count; i++) {
                    if (s_history[i].send_state == CHAT_SEND_SENDING || s_history[i].send_state == CHAT_SEND_FAILED) {
                        preserved[preserved_count++] = s_history[i];
                    }
                }
            }
            s_history_count = 0;
            for (int i = start; i < total && s_history_count < CHAT_HISTORY_MAX; i++) {
                cJSON *item = cJSON_GetArrayItem(msgs, i);
                if (!cJSON_IsObject(item)) continue;
                chat_message_info_t *m = &s_history[s_history_count++];
                memset(m, 0, sizeof(*m));
                cJSON *v;
                if (cJSON_IsString((v = cJSON_GetObjectItem(item, "id")))) snprintf(m->id, sizeof(m->id), "%s", v->valuestring);
                if (cJSON_IsString((v = cJSON_GetObjectItem(item, "senderName")))) snprintf(m->sender, sizeof(m->sender), "%s", v->valuestring);
                if (cJSON_IsString((v = cJSON_GetObjectItem(item, "asrText")))) snprintf(m->text, sizeof(m->text), "%s", v->valuestring);
                if (cJSON_IsString((v = cJSON_GetObjectItem(item, "audioUrl")))) snprintf(m->audio_url, sizeof(m->audio_url), "%s", v->valuestring);
                if (cJSON_IsString((v = cJSON_GetObjectItem(item, "createdAt")))) format_iso_to_cst8(v->valuestring, m->time_str);
                else snprintf(m->time_str, sizeof(m->time_str), "--:--");
                if (cJSON_IsNumber((v = cJSON_GetObjectItem(item, "durationSec")))) m->duration_sec = v->valueint;
                if (m->duration_sec <= 0) m->duration_sec = 3;
                cJSON *dir = cJSON_GetObjectItem(item, "direction");
                m->from_parent = !cJSON_IsString(dir) || strcmp(dir->valuestring, "device_to_parent") != 0;
                cJSON *st = cJSON_GetObjectItem(item, "status");
                m->unread = cJSON_IsString(st) && strcmp(st->valuestring, "unread") == 0;
                m->send_state = CHAT_SEND_SENT;
                char path[96];
                m->has_local_audio = wechat_cache_path(m->id, path, sizeof(path)) && file_exists_nonempty(path);
            }
            for (int p = 0; p < preserved_count; p++) {
                bool exists = false;
                for (int i = 0; i < s_history_count; i++) {
                    if (strcmp(s_history[i].id, preserved[p].id) == 0) { exists = true; break; }
                }
                if (!exists) {
                    make_room_in_history_locked();
                    s_history[s_history_count++] = preserved[p];
                }
            }
            refresh_pending_from_history_locked();
            xSemaphoreGive(s_chat_lock);
            free(preserved);
            atomic_fetch_add(&s_chat_version, 1);
            save_history_file();
            prune_wechat_audio_cache();
            ESP_LOGI(TAG, "Synced %d chat messages (%d unread)", s_history_count, s_unread_count);
        } else if (err == ESP_OK) {
            err = ESP_FAIL;
        }
        if (root) cJSON_Delete(root);
    } else if (err == ESP_OK) {
        err = ESP_FAIL;
    }

    free(buf);
    return err;
}

esp_err_t chat_client_fetch_unread(void) {
    return chat_client_fetch_history();
}

bool chat_client_has_unread_message(void) {
    ensure_chat_init();
    if (!s_chat_lock) return false;
    xSemaphoreTake(s_chat_lock, portMAX_DELAY);
    bool valid = s_pending_valid;
    xSemaphoreGive(s_chat_lock);
    return valid;
}

bool chat_client_get_unread_info(chat_message_info_t *out, int *out_unread_count) {
    ensure_chat_init();
    if (!s_chat_lock) return false;
    xSemaphoreTake(s_chat_lock, portMAX_DELAY);
    bool valid = s_pending_valid;
    if (valid && out) *out = s_pending_msg;
    if (out_unread_count) *out_unread_count = s_unread_count;
    xSemaphoreGive(s_chat_lock);
    return valid;
}

int chat_client_get_history(chat_message_info_t *out, int max_items) {
    return snapshot_history(out, max_items);
}

uint32_t chat_client_get_version(void) {
    return atomic_load(&s_chat_version);
}

bool chat_client_is_playing(void) {
    return atomic_load(&s_parent_play_busy);
}

chat_play_phase_t chat_client_get_play_phase(void) {
    return (chat_play_phase_t)atomic_load(&s_play_phase);
}

void chat_client_get_playing_id(char *out_id, size_t out_len) {
    if (!out_id || out_len == 0) return;
    out_id[0] = 0;
    if (!s_chat_lock) return;
    xSemaphoreTake(s_chat_lock, portMAX_DELAY);
    snprintf(out_id, out_len, "%s", s_playing_id);
    xSemaphoreGive(s_chat_lock);
}

static bool play_cancel_cb(void *ctx) {
    unsigned expected_gen = *(unsigned *)ctx;
    return expected_gen != audio_engine_get_stop_generation();
}

static bool prefetch_cancel_cb(void *ctx) {
    (void)ctx;
    return audio_engine_is_busy() || chat_client_is_playing() || chat_client_is_uploading();
}

static void voice_read_ack_task(void *arg) {
    char *id = (char *)arg;
    if (id && *id) {
        if (device_sync_send_voice_read(id) == ESP_OK && s_chat_lock && s_history) {
            bool updated = false;
            xSemaphoreTake(s_chat_lock, portMAX_DELAY);
            for (int i = 0; i < s_history_count; i++) {
                if (strcmp(s_history[i].id, id) == 0 && s_history[i].audio_url[0]) {
                    s_history[i].audio_url[0] = 0;
                    updated = true;
                    break;
                }
            }
            xSemaphoreGive(s_chat_lock);
            if (updated) save_history_file();
        }
    }
    free(id);
    vTaskDelete(NULL);
}

esp_err_t chat_client_play_message(const char *msg_id) {
    ensure_chat_init();
    if (!msg_id || !*msg_id || !s_chat_lock) return ESP_ERR_INVALID_ARG;
    bool expected = false;
    if (!atomic_compare_exchange_strong(&s_parent_play_busy, &expected, true)) return ESP_ERR_INVALID_STATE;

    unsigned start_gen = audio_engine_get_stop_generation();
    atomic_store(&s_active_play_gen, start_gen);

    chat_message_info_t target = {0};
    bool found = false;
    xSemaphoreTake(s_chat_lock, portMAX_DELAY);
    for (int i = 0; i < s_history_count; i++) {
        if (strcmp(s_history[i].id, msg_id) == 0) {
            target = s_history[i];
            found = true;
            break;
        }
    }
    if (!found && s_pending_valid && strcmp(s_pending_msg.id, msg_id) == 0) {
        target = s_pending_msg;
        found = true;
    }
    if (found) snprintf(s_playing_id, sizeof(s_playing_id), "%s", target.id);
    xSemaphoreGive(s_chat_lock);

    if (!found) {
        atomic_store(&s_play_phase, CHAT_PLAY_IDLE);
        atomic_store(&s_parent_play_busy, false);
        return ESP_ERR_NOT_FOUND;
    }

    char path[96] = {0};
    bool has_path = wechat_cache_path(target.id, path, sizeof(path));
    bool local_ok = has_path && file_exists_nonempty(path);
    bool downloaded_now = false;
    esp_err_t err = ESP_ERR_NOT_FOUND;

    if (local_ok) {
        atomic_store(&s_play_phase, CHAT_PLAY_PLAYING);
        atomic_fetch_add(&s_chat_version, 1);
        ui_wake_screen();
        ui_set_voice_status("正在播放语音");
        err = audio_engine_play_file_gen(path, start_gen);
    } else if (target.audio_url[0]) {
        atomic_store(&s_play_phase, CHAT_PLAY_DOWNLOADING);
        atomic_fetch_add(&s_chat_version, 1);
        ui_set_voice_status("正在下载语音");
        uint8_t *buf = NULL;
        size_t buf_len = 0;
        err = audio_download_to_buffer(target.audio_url, &buf, &buf_len, play_cancel_cb, &start_gen);
        if (err == ESP_OK && buf && buf_len > 0) {
            if (start_gen == audio_engine_get_stop_generation()) {
                atomic_store(&s_play_phase, CHAT_PLAY_PLAYING);
                atomic_fetch_add(&s_chat_version, 1);
                ui_wake_screen();
                ui_set_voice_status("正在播放语音");
                err = audio_engine_play_buffer_gen(buf, buf_len, start_gen);
            } else {
                err = ESP_ERR_NOT_FINISHED;
            }
            if (save_local_audio_file(target.id, buf, buf_len)) downloaded_now = true;
            free(buf);
        } else {
            free(buf);
        }
    } else if (!is_placeholder_text(target.text)) {
        atomic_store(&s_play_phase, CHAT_PLAY_DOWNLOADING);
        atomic_fetch_add(&s_chat_version, 1);
        ui_set_voice_status("正在合成语音");
        err = synthesize_and_play_text(target.text);
    }

    if (start_gen != audio_engine_get_stop_generation() && err != ESP_OK) {
        err = ESP_ERR_NOT_FINISHED;
    }

    bool mark_read = (err == ESP_OK) && target.from_parent && target.unread;
    bool need_persist = false;
    if (downloaded_now || mark_read) {
        xSemaphoreTake(s_chat_lock, portMAX_DELAY);
        for (int i = 0; i < s_history_count; i++) {
            if (strcmp(s_history[i].id, target.id) == 0) {
                if (downloaded_now) s_history[i].has_local_audio = true;
                if (mark_read) s_history[i].unread = false;
                break;
            }
        }
        if (mark_read) refresh_pending_from_history_locked();
        xSemaphoreGive(s_chat_lock);
        need_persist = true;
    }

    xSemaphoreTake(s_chat_lock, portMAX_DELAY);
    s_playing_id[0] = 0;
    xSemaphoreGive(s_chat_lock);
    atomic_store(&s_play_phase, CHAT_PLAY_IDLE);
    atomic_store(&s_parent_play_busy, false);
    atomic_fetch_add(&s_chat_version, 1);

    if (need_persist) {
        save_history_file();
        prune_wechat_audio_cache();
    }
    if (mark_read) {
        char *ack_id = strdup(target.id);
        if (!ack_id || xTaskCreate(voice_read_ack_task, "voice_ack", 8192, ack_id, 4, NULL) != pdPASS) {
            free(ack_id);
            if (device_sync_send_voice_read(target.id) == ESP_OK && s_chat_lock && s_history) {
                xSemaphoreTake(s_chat_lock, portMAX_DELAY);
                for (int i = 0; i < s_history_count; i++) {
                    if (strcmp(s_history[i].id, target.id) == 0) { s_history[i].audio_url[0] = 0; break; }
                }
                xSemaphoreGive(s_chat_lock);
                save_history_file();
            }
        }
    }
    return err;
}

void chat_client_prefetch_unread(void) {
    ensure_chat_init();
    if (!wifi_manager_is_connected() || !device_pairing_is_paired() || !s_chat_lock || !s_history) return;
    chat_message_info_t *items = heap_caps_calloc(CHAT_HISTORY_MAX, sizeof(chat_message_info_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!items) return;
    int count = snapshot_history(items, CHAT_HISTORY_MAX);
    int fetched = 0;
    for (int i = count - 1; i >= 0 && fetched < 3; i--) {
        if (prefetch_cancel_cb(NULL)) break;
        const chat_message_info_t *m = &items[i];
        if (!m->from_parent || !m->unread || !m->audio_url[0]) continue;
        char path[96];
        if (!wechat_cache_path(m->id, path, sizeof(path))) continue;
        if (file_exists_nonempty(path)) continue;
        uint8_t *buf = NULL;
        size_t len = 0;
        esp_err_t err = audio_download_to_buffer(m->audio_url, &buf, &len, prefetch_cancel_cb, NULL);
        if (err == ESP_OK && buf && len > 0) {
            bool saved = save_local_audio_file(m->id, buf, len);
            free(buf);
            if (saved) {
                xSemaphoreTake(s_chat_lock, portMAX_DELAY);
                for (int j = 0; j < s_history_count; j++) {
                    if (strcmp(s_history[j].id, m->id) == 0) {
                        s_history[j].has_local_audio = true;
                        break;
                    }
                }
                xSemaphoreGive(s_chat_lock);
                atomic_fetch_add(&s_chat_version, 1);
                save_history_file();
                prune_wechat_audio_cache();
                fetched++;
            }
        } else {
            free(buf);
            if (err == ESP_ERR_NOT_FINISHED) break;
        }
    }
    free(items);
}

esp_err_t chat_client_play_next_unread(void) {
    chat_message_info_t msg;
    if (!chat_client_get_unread_info(&msg, NULL)) return ESP_ERR_NOT_FOUND;
    return chat_client_play_message(msg.id);
}

static esp_err_t send_child_recording(const char *message_id, const uint8_t *audio, size_t audio_len,
                                     const char *mime, const char *asr_text, int duration_sec) {
    ensure_chat_init();
    char local_msg_id[48];
    snprintf(local_msg_id, sizeof(local_msg_id), "msg_dev_%lld_%08lx", (long long)time(NULL), (unsigned long)esp_random());
    if (message_id && *message_id) snprintf(local_msg_id, sizeof(local_msg_id), "%s", message_id);

    if (!wifi_manager_is_connected() || !device_pairing_is_paired()) {
        chat_client_set_send_state(local_msg_id, CHAT_SEND_FAILED);
        return ESP_ERR_INVALID_STATE;
    }

    atomic_store(&s_upload_busy, true);
    chat_client_set_send_state(local_msg_id, CHAT_SEND_SENDING);

    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "id", local_msg_id);
    cJSON_AddStringToObject(body, "deviceId", wifi_manager_get_device_id());
    cJSON_AddStringToObject(body, "direction", "device_to_parent");
    cJSON_AddStringToObject(body, "senderName", "宝贝");
    cJSON_AddNumberToObject(body, "durationSec", duration_sec > 0 ? duration_sec : 3);
    cJSON_AddStringToObject(body, "asrText",
                            asr_text && strlen(asr_text) ? asr_text : "（宝贝发来一段语音）");
    cJSON_AddBoolToObject(body, "autoPlay", false);

    if (audio && audio_len > 0) {
        size_t b64_max_len = ((audio_len + 2) / 3) * 4 + 4;
        char *b64_buf = heap_caps_malloc(b64_max_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!b64_buf) b64_buf = malloc(b64_max_len);
        if (!b64_buf) {
            cJSON_Delete(body);
            chat_client_set_send_state(local_msg_id, CHAT_SEND_FAILED);
            atomic_store(&s_upload_busy, false);
            return ESP_ERR_NO_MEM;
        }
        size_t out_len = 0;
        if (mbedtls_base64_encode((unsigned char *)b64_buf, b64_max_len, &out_len,
                                  audio, audio_len) != 0) {
            free(b64_buf);
            cJSON_Delete(body);
            chat_client_set_send_state(local_msg_id, CHAT_SEND_FAILED);
            atomic_store(&s_upload_busy, false);
            return ESP_FAIL;
        }
        b64_buf[out_len] = '\0';
        cJSON_AddStringToObject(body, "audioBase64", b64_buf);
        cJSON_AddStringToObject(body, "audioMime", mime ? mime : "audio/wav");
        free(b64_buf);
    }

    char *post_data = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (!post_data) {
        chat_client_set_send_state(local_msg_id, CHAT_SEND_FAILED);
        atomic_store(&s_upload_busy, false);
        return ESP_ERR_NO_MEM;
    }

    if (!pet_http_net_lock(15000)) {
        cJSON_free(post_data);
        chat_client_set_send_state(local_msg_id, CHAT_SEND_FAILED);
        atomic_store(&s_upload_busy, false);
        return ESP_ERR_TIMEOUT;
    }

    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/chat/messages", CONFIG_PET_SERVER_URL);

    const size_t payload_len = strlen(post_data);
    wifi_ps_type_t previous_ps = WIFI_PS_MIN_MODEM;
    bool restore_ps = esp_wifi_get_ps(&previous_ps) == ESP_OK && esp_wifi_set_ps(WIFI_PS_NONE) == ESP_OK;
    int64_t upload_started = esp_timer_get_time();
    esp_err_t err = ESP_FAIL;

    for (int attempt = 1; attempt <= 3; attempt++) {
        esp_http_client_config_t cfg = {
            .url = url,
            .method = HTTP_METHOD_POST,
            .timeout_ms = 20000,
            .buffer_size = 2048,
            .buffer_size_tx = 4096,
            .crt_bundle_attach = esp_crt_bundle_attach,
            .disable_auto_redirect = true,
            .addr_type = HTTP_ADDR_TYPE_INET,
            .keep_alive_enable = false,
        };
        esp_http_client_handle_t client = pet_http_init(&cfg);
        if (!client) { err = ESP_ERR_NO_MEM; break; }
        pet_http_add_auth(client, url);
        esp_http_client_set_header(client, "Content-Type", "application/json");
        esp_http_client_set_header(client, "Connection", "close");
        size_t sent = 0;
        int status = 0;
        ui_set_voice_status("正在连接网络");
        err = esp_http_client_open(client, payload_len);
        int64_t connected = esp_timer_get_time();
        if (err == ESP_OK) esp_http_client_set_timeout_ms(client, 35000);
        unsigned displayed_progress = 101;
        while (err == ESP_OK && sent < payload_len) {
            size_t chunk = payload_len - sent;
            if (chunk > 4096) chunk = 4096;
            int written = esp_http_client_write(client, post_data + sent, chunk);
            if (written <= 0) { err = ESP_ERR_HTTP_WRITE_DATA; break; }
            sent += written;
            unsigned progress = (unsigned)(sent * 100 / payload_len);
            if (displayed_progress == 101 || progress >= displayed_progress + 25 || progress == 100) {
                char text[64]; snprintf(text, sizeof(text), "正在发送语音 %u%%", progress);
                ui_set_voice_status(text); displayed_progress = progress;
            }
            vTaskDelay(pdMS_TO_TICKS(2));
        }
        int64_t body_sent = esp_timer_get_time();
        if (err == ESP_OK) {
            int64_t content_len = esp_http_client_fetch_headers(client);
            status = esp_http_client_get_status_code(client);
            device_pairing_handle_status(status);
            char drain[128];
            int drained = 0;
            while (drained < 512) {
                int r = esp_http_client_read(client, drain, sizeof(drain));
                if (r <= 0) break;
                drained += r;
            }
            ESP_LOGI(TAG, "Uploaded child WeChat voice -> HTTP %d, content_len=%lld, sent=%u/%u, attempt=%d, internal_free=%u",
                     status, content_len, (unsigned)sent, (unsigned)payload_len, attempt,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
            ESP_LOGI(TAG, "Voice timing: connect=%lld ms, body=%lld ms, response=%lld ms, total=%lld ms",
                     (connected - upload_started) / 1000, (body_sent - connected) / 1000,
                     (esp_timer_get_time() - body_sent) / 1000, (esp_timer_get_time() - upload_started) / 1000);
            err = content_len >= 0 && status >= 200 && status < 300 ? ESP_OK : ESP_FAIL;
        }
        if (err != ESP_OK) ESP_LOGE(TAG, "Voice upload failed: %s, http=%d, sent=%u/%u, attempt=%d, internal_free=%u",
                                    esp_err_to_name(err), status, (unsigned)sent, (unsigned)payload_len, attempt,
                                    (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        pet_http_note_result(client, err);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        if (err == ESP_OK || (status >= 400 && status < 500) || attempt == 3 || !wifi_manager_is_connected()) break;
        ui_set_voice_status("连接失败正在重试");
        vTaskDelay(pdMS_TO_TICKS(1000));
    }

    if (restore_ps) esp_wifi_set_ps(previous_ps);
    pet_http_net_unlock();
    cJSON_free(post_data);
    atomic_store(&s_upload_busy, false);

    if (err == ESP_OK) {
        bool local_saved = save_local_audio_file(local_msg_id, audio, audio_len);
        if (s_chat_lock && s_history) {
            xSemaphoreTake(s_chat_lock, portMAX_DELAY);
            int idx = -1;
            for (int i = 0; i < s_history_count; i++) {
                if (strcmp(s_history[i].id, local_msg_id) == 0) { idx = i; break; }
            }
            if (idx < 0) {
                make_room_in_history_locked();
                idx = s_history_count++;
                memset(&s_history[idx], 0, sizeof(chat_message_info_t));
                snprintf(s_history[idx].id, sizeof(s_history[idx].id), "%s", local_msg_id);
                snprintf(s_history[idx].sender, sizeof(s_history[idx].sender), "%s", "宝贝");
                snprintf(s_history[idx].text, sizeof(s_history[idx].text), "%s", asr_text && *asr_text ? asr_text : "（宝贝发来一段语音）");
                now_time_str(s_history[idx].time_str);
            }
            chat_message_info_t *m = &s_history[idx];
            if (mime && *mime) snprintf(m->mime, sizeof(m->mime), "%s", mime);
            m->duration_sec = duration_sec > 0 ? duration_sec : 3;
            m->from_parent = false;
            m->unread = false;
            if (local_saved) m->has_local_audio = true;
            m->send_state = CHAT_SEND_SENT;
            xSemaphoreGive(s_chat_lock);
            atomic_fetch_add(&s_chat_version, 1);
            save_history_file();
            prune_wechat_audio_cache();
        }
    } else {
        chat_client_set_send_state(local_msg_id, CHAT_SEND_FAILED);
    }
    return err;
}

esp_err_t chat_client_retry_outgoing(const char *msg_id) {
    ensure_chat_init();
    if (!msg_id || !*msg_id || !s_chat_lock || !s_history) return ESP_ERR_INVALID_ARG;
    if (audio_engine_is_busy() || atomic_load(&s_upload_busy)) return ESP_ERR_INVALID_STATE;

    chat_message_info_t msg = {0};
    bool found = false;
    xSemaphoreTake(s_chat_lock, portMAX_DELAY);
    for (int i = 0; i < s_history_count; i++) {
        if (strcmp(s_history[i].id, msg_id) == 0 && !s_history[i].from_parent) {
            msg = s_history[i];
            found = true;
            break;
        }
    }
    xSemaphoreGive(s_chat_lock);
    if (!found) return ESP_ERR_NOT_FOUND;

    char path[96];
    if (!wechat_cache_path(msg.id, path, sizeof(path))) return ESP_ERR_INVALID_ARG;
    FILE *f = fopen(path, "rb");
    if (!f) return ESP_ERR_NOT_FOUND;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    if (sz <= 0 || sz > 500000) { fclose(f); return ESP_ERR_INVALID_SIZE; }
    uint8_t *buf = heap_caps_malloc((size_t)sz, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    bool ok = buf && fread(buf, 1, (size_t)sz, f) == (size_t)sz;
    fclose(f);
    if (!ok) {
        free(buf);
        chat_client_set_send_state(msg.id, CHAT_SEND_FAILED);
        return ESP_FAIL;
    }

    esp_err_t err = send_child_recording(msg.id, buf, (size_t)sz,
                                         msg.mime[0] ? msg.mime : "audio/aac",
                                         NULL, msg.duration_sec);
    free(buf);
    if (err == ESP_OK) audio_engine_clear_pending_if_id(msg.id);
    return err;
}

esp_err_t chat_client_send_child_voice_wav(const uint8_t *wav_data, size_t wav_len,
                                           const char *asr_text, int duration_sec) {
    return chat_client_send_child_voice_audio(wav_data, wav_len, "audio/wav", asr_text, duration_sec);
}

esp_err_t chat_client_send_child_voice_audio(const uint8_t *audio, size_t audio_len,
                                            const char *mime, const char *asr_text, int duration_sec) {
    return send_child_recording(NULL, audio, audio_len, mime, asr_text, duration_sec);
}

esp_err_t chat_client_send_child_recording(const char *message_id, const uint8_t *audio, size_t audio_len,
                                          const char *mime, int duration_sec) {
    return send_child_recording(message_id, audio, audio_len, mime, NULL, duration_sec);
}

esp_err_t chat_client_send_child_voice(const char *asr_text, int duration_sec) {
    return chat_client_send_child_voice_wav(NULL, 0, asr_text, duration_sec);
}
