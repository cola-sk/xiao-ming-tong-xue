#include "chat_client.h"
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
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
#include "ui_state_machine.h"
#include "audio_download.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "chat_client";

#define CHAT_HTTP_BUF_SIZE 4096

typedef struct {
    char id[48];
    char sender[32];
    char text[256];
    char audio_url[128];
    bool auto_play;
    bool valid;
} unread_parent_msg_t;

static unread_parent_msg_t s_pending_msg = {0};
static atomic_bool s_parent_play_busy;

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

static esp_err_t download_and_play_chat_audio(const char *msg_id, const char *audio_url) {
    char path[96];
    // Download atomically. A stable per-message cache avoids replaying stale audio.
    snprintf(path, sizeof(path), "/spiffs/wechat/%.47s.mp3", msg_id);
    esp_err_t err = audio_download_file(audio_url, path, NULL);
    return err == ESP_OK ? audio_engine_play_file(path) : err;
}

static esp_err_t post_audio_request(const char *endpoint, cJSON *body) {
    if (!wifi_manager_is_connected() || !device_pairing_is_paired()) return ESP_ERR_INVALID_STATE;
    char *post = cJSON_PrintUnformatted(body); if (!post) return ESP_ERR_NO_MEM;
    chat_resp_t ctx = { .cap = 512 * 1024 };
    ctx.buf = heap_caps_malloc(ctx.cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!ctx.buf) { cJSON_free(post); return ESP_ERR_NO_MEM; }
    char url[256]; snprintf(url, sizeof(url), "%s%s", CONFIG_PET_SERVER_URL, endpoint);
    wifi_ps_type_t ps; bool restore = esp_wifi_get_ps(&ps) == ESP_OK && esp_wifi_set_ps(WIFI_PS_NONE) == ESP_OK;
    esp_err_t err = ESP_FAIL;
    for (int attempt = 1; attempt <= 2; attempt++) {
        ctx.len = 0; ctx.overflow = false; ctx.mp3 = false;
        esp_http_client_config_t cfg = { .url = url, .method = HTTP_METHOD_POST, .timeout_ms = 12000,
            .crt_bundle_attach = esp_crt_bundle_attach, .disable_auto_redirect = true, .addr_type = HTTP_ADDR_TYPE_INET,
            .event_handler = chat_http_event_handler, .user_data = &ctx };
        esp_http_client_handle_t c = pet_http_init(&cfg);
        if (!c) { err = ESP_ERR_NO_MEM; break; }
        pet_http_add_auth(c, url); esp_http_client_set_header(c, "Content-Type", "application/json");
        size_t length = strlen(post), sent = 0;
        int64_t started = esp_timer_get_time();
        ui_set_voice_status("正在连接网络");
        err = esp_http_client_open(c, length);
        int64_t connected = esp_timer_get_time();
        // No body has been sent: it is safe to try the other DNS address.
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Audio connect failed attempt=%d elapsed=%lld ms", attempt, (connected - started) / 1000);
            pet_http_note_result(c, err); esp_http_client_close(c); esp_http_client_cleanup(c);
            if (attempt < 2 && wifi_manager_is_connected()) { ui_set_voice_status("连接失败稍后重试"); vTaskDelay(pdMS_TO_TICKS(500)); continue; }
            break;
        }
        esp_http_client_set_timeout_ms(c, 55000);
        while (err == ESP_OK && sent < length) {
            size_t chunk = length - sent; if (chunk > 2048) chunk = 2048;
            int n = esp_http_client_write(c, post + sent, chunk);
            if (n <= 0) { err = ESP_ERR_HTTP_WRITE_DATA; break; }
            sent += n; vTaskDelay(pdMS_TO_TICKS(1));
        }
        int64_t uploaded = esp_timer_get_time();
        if (err == ESP_OK) {
            ui_set_voice_status("正在思考请稍候");
            int64_t response_len = esp_http_client_fetch_headers(c);
            int status = esp_http_client_get_status_code(c); device_pairing_handle_status(status);
            if (response_len < 0 || response_len >= ctx.cap) err = ESP_FAIL;
            char scratch[2048];
            while (err == ESP_OK) {
                int n = esp_http_client_read(c, scratch, sizeof(scratch));
                if (n < 0) { err = ESP_FAIL; break; }
                if (n == 0) { if (!esp_http_client_is_complete_data_received(c)) err = ESP_FAIL; break; }
                if (ctx.overflow) { err = ESP_ERR_INVALID_SIZE; break; }
            }
            ESP_LOGI(TAG, "Audio reply HTTP=%d bytes=%d mp3=%d", status, ctx.len, ctx.mp3);
            if (status != 200 || !ctx.mp3 || ctx.overflow || !ctx.len) err = ESP_FAIL;
        }
        ESP_LOGI(TAG, "Audio timing: connect=%lld ms upload=%lld ms reply=%lld ms sent=%u/%u result=%s",
                 (connected - started) / 1000, (uploaded - connected) / 1000, (esp_timer_get_time() - uploaded) / 1000,
                 (unsigned)sent, (unsigned)length, esp_err_to_name(err));
        pet_http_note_result(c, err); esp_http_client_close(c); esp_http_client_cleanup(c);
        break; // After a possible complete upload, only an explicit user retry repeats AI work.
    }
    if (restore) esp_wifi_set_ps(ps);
    cJSON_free(post);
    if (err == ESP_OK) { ui_set_voice_status("正在播放语音"); err = audio_engine_play_buffer((uint8_t *)ctx.buf, ctx.len); }
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

esp_err_t chat_client_fetch_unread(void) {
    if (!wifi_manager_is_connected() || !device_pairing_is_paired()) return ESP_ERR_INVALID_STATE;
    if (s_pending_msg.valid) return ESP_OK;

    char url[256];
    snprintf(url, sizeof(url),
             "%s/api/v1/chat/messages?deviceId=%s&direction=parent_to_device&status=unread&limit=1",
             CONFIG_PET_SERVER_URL, wifi_manager_get_device_id());

    char *buf = calloc(1, CHAT_HTTP_BUF_SIZE);
    if (!buf) return ESP_ERR_NO_MEM;

    chat_resp_t ctx = {.buf = buf, .len = 0, .cap = CHAT_HTTP_BUF_SIZE};
    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 8000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_redirect = true,
        .addr_type = HTTP_ADDR_TYPE_INET,
        .event_handler = chat_http_event_handler,
        .user_data = &ctx,
    };

    esp_http_client_handle_t client = pet_http_init(&cfg);
    pet_http_add_auth(client, url);
    esp_err_t err = pet_http_perform(client);
    if (err == ESP_OK && esp_http_client_get_status_code(client) == 200 && ctx.len > 0) {
        cJSON *root = cJSON_Parse(ctx.buf);
        if (root) {
            cJSON *msgs = cJSON_GetObjectItem(root, "messages");
            if (cJSON_IsArray(msgs) && cJSON_GetArraySize(msgs) > 0) {
                cJSON *first = cJSON_GetArrayItem(msgs, 0);
                cJSON *id = cJSON_GetObjectItem(first, "id");
                cJSON *sender = cJSON_GetObjectItem(first, "senderName");
                cJSON *asr = cJSON_GetObjectItem(first, "asrText");
                cJSON *audio_url = cJSON_GetObjectItem(first, "audioUrl");
                cJSON *auto_play = cJSON_GetObjectItem(first, "autoPlay");

                memset(&s_pending_msg, 0, sizeof(s_pending_msg));
                if (cJSON_IsString(id)) snprintf(s_pending_msg.id, sizeof(s_pending_msg.id), "%s", id->valuestring);
                if (cJSON_IsString(sender)) snprintf(s_pending_msg.sender, sizeof(s_pending_msg.sender), "%s", sender->valuestring);
                if (cJSON_IsString(asr)) snprintf(s_pending_msg.text, sizeof(s_pending_msg.text), "%s", asr->valuestring);
                if (cJSON_IsString(audio_url)) snprintf(s_pending_msg.audio_url, sizeof(s_pending_msg.audio_url), "%s", audio_url->valuestring);
                s_pending_msg.auto_play = cJSON_IsBool(auto_play) && cJSON_IsTrue(auto_play);
                s_pending_msg.valid = true;

                ESP_LOGI(TAG, "New parent message from %s: %s (hasAudio=%d, autoPlay=%d)",
                         s_pending_msg.sender, s_pending_msg.text,
                         strlen(s_pending_msg.audio_url) > 0, s_pending_msg.auto_play);

                // Keep unread until actual decoder/speaker completion.
                ui_switch_page(PET_PAGE_WECHAT);
            }
            cJSON_Delete(root);
        }
    }

    esp_http_client_cleanup(client);
    free(buf);
    return err;
}

bool chat_client_has_unread_message(void) {
    return s_pending_msg.valid;
}

esp_err_t chat_client_play_next_unread(void) {
    if (!s_pending_msg.valid) return ESP_ERR_NOT_FOUND;
    bool expected = false;
    if (!atomic_compare_exchange_strong(&s_parent_play_busy, &expected, true)) return ESP_ERR_INVALID_STATE;

    esp_err_t err = strlen(s_pending_msg.audio_url) > 0
        ? download_and_play_chat_audio(s_pending_msg.id, s_pending_msg.audio_url)
        : synthesize_and_play_text(s_pending_msg.text);
    if (err == ESP_OK) {
        err = device_sync_send_voice_read(s_pending_msg.id);
        if (err == ESP_OK) {
            char path[96]; snprintf(path, sizeof(path), "/spiffs/wechat/%.47s.mp3", s_pending_msg.id);
            unlink(path); s_pending_msg.valid = false;
        }
    }
    atomic_store(&s_parent_play_busy, false);
    return err;
}

static esp_err_t send_child_recording(const char *message_id, const uint8_t *audio, size_t audio_len,
                                     const char *mime, const char *asr_text, int duration_sec) {
    if (!wifi_manager_is_connected() || !device_pairing_is_paired()) return ESP_ERR_INVALID_STATE;

    char local_msg_id[48];
    snprintf(local_msg_id, sizeof(local_msg_id), "msg_dev_%lld_%08lx", (long long)time(NULL), (unsigned long)esp_random());
    if (message_id) snprintf(local_msg_id, sizeof(local_msg_id), "%s", message_id);

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
        char *b64_buf = malloc(b64_max_len);
        if (!b64_buf) {
            cJSON_Delete(body);
            return ESP_ERR_NO_MEM;
        }
        size_t out_len = 0;
        if (mbedtls_base64_encode((unsigned char *)b64_buf, b64_max_len, &out_len,
                                  audio, audio_len) != 0) {
            free(b64_buf);
            cJSON_Delete(body);
            return ESP_FAIL;
        }
        b64_buf[out_len] = '\0';
        cJSON_AddStringToObject(body, "audioBase64", b64_buf);
        cJSON_AddStringToObject(body, "audioMime", mime ? mime : "audio/wav");
        free(b64_buf);
    }

    char *post_data = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (!post_data) return ESP_ERR_NO_MEM;

    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/chat/messages", CONFIG_PET_SERVER_URL);

    const size_t payload_len = strlen(post_data);
    wifi_ps_type_t previous_ps = WIFI_PS_MIN_MODEM;
    bool restore_ps = esp_wifi_get_ps(&previous_ps) == ESP_OK && esp_wifi_set_ps(WIFI_PS_NONE) == ESP_OK;
    int64_t upload_started = esp_timer_get_time();
    wifi_manager_log_server_address();
    esp_err_t err = ESP_FAIL;
    for (int attempt = 1; attempt <= 2; attempt++) {
        esp_http_client_config_t cfg = {
            .url = url,
            .method = HTTP_METHOD_POST,
            .timeout_ms = 10000,
            .crt_bundle_attach = esp_crt_bundle_attach,
            .disable_auto_redirect = true,
            .addr_type = HTTP_ADDR_TYPE_INET,
        };
        esp_http_client_handle_t client = pet_http_init(&cfg);
        if (!client) { err = ESP_ERR_NO_MEM; break; }
        pet_http_add_auth(client, url);
        esp_http_client_set_header(client, "Content-Type", "application/json");
        size_t sent = 0;
        bool retry_safe = true;
        ui_set_voice_status("正在连接网络");
        err = esp_http_client_open(client, payload_len);
        int64_t connected = esp_timer_get_time();
        if (err == ESP_OK) esp_http_client_set_timeout_ms(client, 30000);
        unsigned displayed_progress = 101;
        while (err == ESP_OK && sent < payload_len) {
            size_t chunk = payload_len - sent;
            if (chunk > 2048) chunk = 2048;
            // A failed final write might still have reached the server. Never
            // retry that ambiguous case without server-side idempotency.
            retry_safe = sent + chunk < payload_len;
            int written = esp_http_client_write(client, post_data + sent, chunk);
            if (written <= 0) { err = ESP_ERR_HTTP_WRITE_DATA; break; }
            sent += written;
            unsigned progress = (unsigned)(sent * 100 / payload_len);
            if (displayed_progress == 101 || progress >= displayed_progress + 25 || progress == 100) {
                char text[64]; snprintf(text, sizeof(text), "正在发送语音 %u%%", progress);
                ui_set_voice_status(text); displayed_progress = progress;
            }
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        int64_t body_sent = esp_timer_get_time();
        if (err == ESP_OK) {
            retry_safe = false;
            int64_t content_len = esp_http_client_fetch_headers(client);
            int status = esp_http_client_get_status_code(client);
            device_pairing_handle_status(status);
            ESP_LOGI(TAG, "Uploaded child WeChat voice -> HTTP %d, sent=%u/%u, attempt=%d",
                     status, (unsigned)sent, (unsigned)payload_len, attempt);
            ESP_LOGI(TAG, "Voice timing: connect=%lld ms, body=%lld ms, response=%lld ms, total=%lld ms",
                     (connected - upload_started) / 1000, (body_sent - connected) / 1000,
                     (esp_timer_get_time() - body_sent) / 1000, (esp_timer_get_time() - upload_started) / 1000);
            err = content_len >= 0 && status >= 200 && status < 300 ? ESP_OK : ESP_FAIL;
        }
        if (err != ESP_OK) ESP_LOGE(TAG, "Voice upload failed: %s, sent=%u/%u, attempt=%d",
                                    esp_err_to_name(err), (unsigned)sent, (unsigned)payload_len, attempt);
        pet_http_note_result(client, err);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        if (err == ESP_OK || !retry_safe || attempt == 2 || !wifi_manager_is_connected()) break;
        ui_set_voice_status("连接失败稍后重试");
        vTaskDelay(pdMS_TO_TICKS(1500));
    }
    if (restore_ps) esp_wifi_set_ps(previous_ps);
    cJSON_free(post_data);
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
