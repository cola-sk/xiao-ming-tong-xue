#include "device_sync.h"
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "pet_http_auth.h"
#include "esp_crt_bundle.h"
#include "cJSON.h"
#include "wifi_manager.h"
#include "audio_engine.h"
#include "rtc_scheduler.h"
#include "chat_client.h"
#include "ui_state_machine.h"
#include "esp_heap_caps.h"

static const char *TAG = "device_sync";

#define FIRMWARE_VERSION "1.0.0"
#define HTTP_RESP_BUF_SIZE 1024

static char s_last_schedule_version[65] = {0};

typedef struct {
    char buf[HTTP_RESP_BUF_SIZE];
    int len;
} http_resp_ctx_t;

static esp_err_t http_event_handler(esp_http_client_event_t *evt) {
    http_resp_ctx_t *ctx = (http_resp_ctx_t *)evt->user_data;
    if (evt->event_id == HTTP_EVENT_ON_DATA && ctx != NULL && evt->data_len > 0) {
        int copy_len = evt->data_len;
        if (ctx->len + copy_len >= HTTP_RESP_BUF_SIZE) {
            copy_len = HTTP_RESP_BUF_SIZE - ctx->len - 1;
        }
        if (copy_len > 0) {
            memcpy(ctx->buf + ctx->len, evt->data, copy_len);
            ctx->len += copy_len;
            ctx->buf[ctx->len] = '\0';
        }
    }
    return ESP_OK;
}

static void apply_server_config(const char *resp_json) {
    cJSON *root = cJSON_Parse(resp_json);
    if (!root) return;

    cJSON *epoch = cJSON_GetObjectItem(root, "serverEpochSec");
    if (cJSON_IsNumber(epoch) && epoch->valuedouble > 1700000000) {
        rtc_scheduler_set_time((time_t)epoch->valuedouble);
    }

    cJSON *cfg = cJSON_GetObjectItem(root, "config");
    if (cJSON_IsObject(cfg)) {
        cJSON *vol = cJSON_GetObjectItem(cfg, "volumeLevel");
        if (cJSON_IsNumber(vol)) {
            audio_engine_set_remote_volume((uint8_t)(vol->valuedouble < 0 ? 0 : vol->valuedouble > 100 ? 100 : vol->valuedouble));
        }

        static bool s_chat_boot_synced = false;
        static int s_last_unread = -1;
        cJSON *unread = cJSON_GetObjectItem(cfg, "unreadMessagesCount");
        int unread_val = cJSON_IsNumber(unread) ? unread->valueint : 0;
        if (!s_chat_boot_synced ||
            (unread_val > 0 && unread_val != s_last_unread) ||
            (unread_val > 0 && !chat_client_has_unread_message())) {
            if (chat_client_fetch_history() == ESP_OK) {
                s_chat_boot_synced = true;
                s_last_unread = unread_val;
                chat_client_prefetch_unread();
            }
        } else {
            s_last_unread = unread_val;
        }

        cJSON *version = cJSON_GetObjectItem(cfg, "scheduleVersion");
        if (cJSON_IsString(version) && strlen(version->valuestring) == 64 &&
            strcmp(version->valuestring, s_last_schedule_version) != 0 &&
            rtc_scheduler_fetch_and_sync() == ESP_OK) {
            snprintf(s_last_schedule_version, sizeof(s_last_schedule_version), "%s", version->valuestring);
        }
    }

    cJSON_Delete(root);
}

static esp_err_t post_sync_payload(const char *event_name, const char *extra_key, const char *extra_val) {
    if (!device_pairing_is_paired()) return ESP_ERR_INVALID_STATE;
    if (!wifi_manager_is_connected()) {
        ESP_LOGW(TAG, "Skip sync (%s): Wi-Fi not connected", event_name ? event_name : "heartbeat");
        return ESP_ERR_INVALID_STATE;
    }

    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "deviceId", wifi_manager_get_device_id());
    cJSON_AddStringToObject(body, "macAddress", wifi_manager_get_mac_str());
    cJSON_AddStringToObject(body, "firmwareVersion", FIRMWARE_VERSION);
    int battery = ui_get_battery_percent();
    if (battery >= 0) cJSON_AddNumberToObject(body, "batteryPercent", battery);
    cJSON_AddNumberToObject(body, "wifiRssi", wifi_manager_get_rssi());
    cJSON_AddStringToObject(body, "event", event_name ? event_name : "heartbeat");
    if (extra_key && extra_val) {
        cJSON_AddStringToObject(body, extra_key, extra_val);
    }

    char *post_data = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (!post_data) return ESP_ERR_NO_MEM;

    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/device/sync", CONFIG_PET_SERVER_URL);

    http_resp_ctx_t resp_ctx = {0};
    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 25000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_redirect = true,
        .addr_type = HTTP_ADDR_TYPE_INET,
        .event_handler = http_event_handler,
        .user_data = &resp_ctx,
    };

    if (!pet_http_net_lock(8000)) {
        ESP_LOGW(TAG, "Skip sync (%s): network busy", event_name ? event_name : "heartbeat");
        cJSON_free(post_data);
        return ESP_ERR_TIMEOUT;
    }

    esp_http_client_handle_t client = pet_http_init(&config);
    if (!client) {
        pet_http_net_unlock();
        cJSON_free(post_data);
        return ESP_ERR_NO_MEM;
    }
    pet_http_add_auth(client, url);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, post_data, strlen(post_data));

    esp_err_t err = pet_http_perform(client);
    if (err == ESP_OK) {
        int status = esp_http_client_get_status_code(client);
        device_pairing_handle_status(status);
        ESP_LOGI(TAG, "Sync [%s] -> HTTP %d", event_name ? event_name : "heartbeat", status);
        if (status < 200 || status >= 300) err = ESP_FAIL;

    } else {
        ESP_LOGE(TAG, "HTTPS sync failed: %s", esp_err_to_name(err));
    }

    // Release TLS buffers and transport lock before fetching config-dependent audio or schedules.
    esp_http_client_cleanup(client);
    pet_http_net_unlock();
    cJSON_free(post_data);
    if (err == ESP_OK && resp_ctx.len > 0 && strcmp(event_name, "heartbeat") == 0) apply_server_config(resp_ctx.buf);
    return err;
}

esp_err_t device_sync_send_event(const char *event_name) {
    return post_sync_payload(event_name, NULL, NULL);
}

esp_err_t device_sync_send_alarm_ack(const char *task_id) {
    return post_sync_payload("alarm_ack", "taskId", task_id);
}

esp_err_t device_sync_send_voice_read(const char *msg_id) {
    return post_sync_payload("voice_read", "msgId", msg_id);
}

static void device_sync_task(void *arg) {
    ESP_LOGI(TAG, "Waiting for Wi-Fi connection before starting heartbeat...");
    wifi_manager_wait_connected(portMAX_DELAY);
    wifi_manager_log_server_address();

    while (1) {
        if (audio_engine_is_busy() || chat_client_is_playing() || chat_client_is_uploading()) {
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }
        device_sync_send_event("heartbeat");
        rtc_scheduler_flush_acks();
        ESP_LOGI(TAG, "Sync resources: stack_free=%u internal_heap=%u", (unsigned)uxTaskGetStackHighWaterMark(NULL), (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        vTaskDelay(pdMS_TO_TICKS(CONFIG_PET_HEARTBEAT_INTERVAL_SEC * 1000));
    }
}

esp_err_t device_sync_start(void) {
    BaseType_t ok = xTaskCreate(
        device_sync_task,
        "device_sync_task",
        16384,
        NULL,
        5,
        NULL
    );
    return ok == pdPASS ? ESP_OK : ESP_FAIL;
}
