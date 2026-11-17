#include "chat_client.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "mbedtls/base64.h"
#include "cJSON.h"
#include "wifi_manager.h"
#include "audio_engine.h"
#include "device_sync.h"
#include "ui_state_machine.h"
#include "chat_storage.h"

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

typedef struct {
    char *buf;
    int len;
    int cap;
} chat_resp_t;

static esp_err_t chat_http_event_handler(esp_http_client_event_t *evt) {
    chat_resp_t *ctx = (chat_resp_t *)evt->user_data;
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

static esp_err_t download_and_play_chat_audio(const char *msg_id, const char *audio_url) {
    char local_path[96];
    if (chat_storage_get_path(msg_id, local_path, sizeof(local_path))) {
        ESP_LOGI(TAG, "Playing cached local parent WAV: %s", local_path);
        audio_engine_play_local_file(local_path);
        return ESP_OK;
    }

    char full_url[256];
    if (strncmp(audio_url, "http", 4) == 0) {
        snprintf(full_url, sizeof(full_url), "%s", audio_url);
    } else {
        snprintf(full_url, sizeof(full_url), "%s%s", CONFIG_PET_SERVER_URL, audio_url);
    }

    ESP_LOGI(TAG, "Downloading parent recorded WAV voice: %s", full_url);
    esp_http_client_config_t cfg = {
        .url = full_url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 12000,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_err_t err = esp_http_client_open(client, 0);
    if (err == ESP_OK) {
        int content_len = esp_http_client_fetch_headers(client);
        int status = esp_http_client_get_status_code(client);
        ESP_LOGI(TAG, "Downloaded parent WAV stream -> HTTP %d, bytes=%d", status, content_len);
        if (status == 200 && content_len > 0 && content_len <= 512 * 1024) {
            uint8_t *wav_buf = malloc((size_t)content_len);
            if (wav_buf) {
                int total_read = 0;
                while (total_read < content_len) {
                    int r = esp_http_client_read(client, (char *)wav_buf + total_read,
                                                 content_len - total_read);
                    if (r <= 0) break;
                    total_read += r;
                }
                if (total_read > 0) {
                    chat_storage_save(msg_id, wav_buf, (size_t)total_read);
                    if (chat_storage_get_path(msg_id, local_path, sizeof(local_path))) {
                        audio_engine_play_local_file(local_path);
                    }
                }
                free(wav_buf);
            }
        }
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return err;
}

static esp_err_t synthesize_and_play_text(const char *text) {
    if (!text || strlen(text) == 0) return ESP_ERR_INVALID_ARG;
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "text", text);
    cJSON_AddBoolToObject(body, "persist", false); // 微聊与伴聊不持久化音频到数据库
    char *post_data = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (!post_data) return ESP_ERR_NO_MEM;

    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/tts", CONFIG_PET_SERVER_URL);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 12000,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, post_data, strlen(post_data));

    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
        int status = esp_http_client_get_status_code(client);
        ESP_LOGI(TAG, "TTS stream request for '%s' -> HTTP %d", text, status);
        audio_engine_play_local_file("/ram/tts_stream.mp3");
    }
    esp_http_client_cleanup(client);
    cJSON_free(post_data);
    return err;
}

esp_err_t chat_client_ask_ai(const char *question_text) {
    if (!wifi_manager_is_connected()) return ESP_ERR_INVALID_STATE;

    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "deviceId", wifi_manager_get_device_id());
    cJSON_AddStringToObject(body, "question", question_text ? question_text : "你好呀");
    cJSON_AddStringToObject(body, "responseFormat", "mp3");
    char *post_data = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (!post_data) return ESP_ERR_NO_MEM;

    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/ai/chat", CONFIG_PET_SERVER_URL);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 15000,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, post_data, strlen(post_data));

    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
        int status = esp_http_client_get_status_code(client);
        int content_len = esp_http_client_get_content_length(client);
        ESP_LOGI(TAG, "AI Chat reply MP3 -> HTTP %d, bytes=%d", status, content_len);
        if (status == 200) {
            audio_engine_play_local_file("/ram/ai_reply.mp3");
        }
    } else {
        ESP_LOGE(TAG, "AI Chat request failed: %s", esp_err_to_name(err));
    }

    esp_http_client_cleanup(client);
    cJSON_free(post_data);
    return err;
}

esp_err_t chat_client_fetch_unread(void) {
    if (!wifi_manager_is_connected()) return ESP_ERR_INVALID_STATE;

    char url[256];
    snprintf(url, sizeof(url),
             "%s/api/v1/chat/messages?deviceId=%s&direction=parent_to_device&status=unread",
             CONFIG_PET_SERVER_URL, wifi_manager_get_device_id());

    char *buf = calloc(1, CHAT_HTTP_BUF_SIZE);
    if (!buf) return ESP_ERR_NO_MEM;

    chat_resp_t ctx = {.buf = buf, .len = 0, .cap = CHAT_HTTP_BUF_SIZE};
    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 8000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = chat_http_event_handler,
        .user_data = &ctx,
    };

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_err_t err = esp_http_client_perform(client);
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

                if (s_pending_msg.auto_play) {
                    chat_client_play_next_unread();
                } else {
                    // 切换至微聊页并点亮未读红点提示
                    ui_switch_page(PET_PAGE_WECHAT);
                }
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

    ESP_LOGI(TAG, "Playing parent message [%s]: %s", s_pending_msg.id, s_pending_msg.text);
    if (strlen(s_pending_msg.audio_url) > 0) {
        download_and_play_chat_audio(s_pending_msg.id, s_pending_msg.audio_url);
    } else {
        synthesize_and_play_text(s_pending_msg.text);
    }
    // 通知云端已读（同时销毁服务端暂存的聊天音频，不长期保存）
    device_sync_send_voice_read(s_pending_msg.id);
    s_pending_msg.valid = false;
    return ESP_OK;
}

esp_err_t chat_client_send_child_voice_wav(const uint8_t *wav_data, size_t wav_len,
                                           const char *asr_text, int duration_sec) {
    if (!wifi_manager_is_connected()) return ESP_ERR_INVALID_STATE;

    char local_msg_id[48];
    snprintf(local_msg_id, sizeof(local_msg_id), "msg_dev_%lld", (long long)time(NULL));

    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "id", local_msg_id);
    cJSON_AddStringToObject(body, "deviceId", wifi_manager_get_device_id());
    cJSON_AddStringToObject(body, "direction", "device_to_parent");
    cJSON_AddStringToObject(body, "senderName", "宝贝");
    cJSON_AddNumberToObject(body, "durationSec", duration_sec > 0 ? duration_sec : 3);
    cJSON_AddStringToObject(body, "asrText",
                            asr_text && strlen(asr_text) ? asr_text : "（宝贝发来一段语音）");
    cJSON_AddBoolToObject(body, "autoPlay", false);

    if (wav_data && wav_len > 0) {
        chat_storage_save(local_msg_id, wav_data, wav_len);
        size_t b64_max_len = ((wav_len + 2) / 3) * 4 + 4;
        char *b64_buf = malloc(b64_max_len);
        if (b64_buf) {
            size_t out_len = 0;
            if (mbedtls_base64_encode((unsigned char *)b64_buf, b64_max_len, &out_len,
                                      wav_data, wav_len) == 0) {
                b64_buf[out_len] = '\0';
                cJSON_AddStringToObject(body, "audioBase64", b64_buf);
                cJSON_AddStringToObject(body, "audioMime", "audio/wav");
            }
            free(b64_buf);
        }
    }

    char *post_data = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (!post_data) return ESP_ERR_NO_MEM;

    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/chat/messages", CONFIG_PET_SERVER_URL);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 12000,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, post_data, strlen(post_data));

    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Uploaded child WeChat voice -> HTTP %d", esp_http_client_get_status_code(client));
    } else {
        ESP_LOGE(TAG, "Failed to upload child WeChat voice: %s", esp_err_to_name(err));
    }

    esp_http_client_cleanup(client);
    cJSON_free(post_data);
    return err;
}

esp_err_t chat_client_send_child_voice(const char *asr_text, int duration_sec) {
    return chat_client_send_child_voice_wav(NULL, 0, asr_text, duration_sec);
}
