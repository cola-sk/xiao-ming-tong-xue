#include "device_sync.h"
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "cJSON.h"
#include "wifi_manager.h"
#include "audio_engine.h"
#include "rtc_scheduler.h"
#include "chat_client.h"

static const char *TAG = "device_sync";

#define FIRMWARE_VERSION "1.0.0"
#define HTTP_RESP_BUF_SIZE 1024

static int s_last_synced_sched_count = -1;

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

static int read_battery_percent_axp2101(void) {
    // AXP2101 I2C PMU register read hook on Waveshare board
    return 100;
}

static void apply_server_config(const char *resp_json) {
    cJSON *root = cJSON_Parse(resp_json);
    if (!root) return;

    cJSON *epoch = cJSON_GetObjectItem(root, "serverEpochSec");
    if (cJSON_IsNumber(epoch) && epoch->valuedouble > 1700000000) {
        struct timeval tv = {
            .tv_sec = (time_t)epoch->valuedouble,
            .tv_usec = 0,
        };
        settimeofday(&tv, NULL);
    }

    cJSON *cfg = cJSON_GetObjectItem(root, "config");
    if (cJSON_IsObject(cfg)) {
        cJSON *vol = cJSON_GetObjectItem(cfg, "volumeLevel");
        if (cJSON_IsNumber(vol)) {
            audio_engine_set_volume((uint8_t)vol->valuedouble);
        }

        cJSON *unread = cJSON_GetObjectItem(cfg, "unreadMessagesCount");
        if (cJSON_IsNumber(unread) && unread->valueint > 0) {
            chat_client_fetch_unread();
        }

        cJSON *sched_cnt = cJSON_GetObjectItem(cfg, "enabledSchedulesCount");
        if (cJSON_IsNumber(sched_cnt) && sched_cnt->valueint != s_last_synced_sched_count) {
            s_last_synced_sched_count = sched_cnt->valueint;
            rtc_scheduler_fetch_and_sync();
        }
    }

    cJSON_Delete(root);
}

static esp_err_t post_sync_payload(const char *event_name, const char *extra_key, const char *extra_val) {
    if (!wifi_manager_is_connected()) {
        ESP_LOGW(TAG, "Skip sync (%s): Wi-Fi not connected", event_name ? event_name : "heartbeat");
        return ESP_ERR_INVALID_STATE;
    }

    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "deviceId", wifi_manager_get_device_id());
    cJSON_AddStringToObject(body, "macAddress", wifi_manager_get_mac_str());
    cJSON_AddStringToObject(body, "firmwareVersion", FIRMWARE_VERSION);
    cJSON_AddNumberToObject(body, "batteryPercent", read_battery_percent_axp2101());
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
        .timeout_ms = 8000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = http_event_handler,
        .user_data = &resp_ctx,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, post_data, strlen(post_data));

    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
        int status = esp_http_client_get_status_code(client);
        ESP_LOGI(TAG, "Sync [%s] -> HTTP %d", event_name ? event_name : "heartbeat", status);
        if (status == 200 && resp_ctx.len > 0 && strcmp(event_name, "heartbeat") == 0) {
            apply_server_config(resp_ctx.buf);
        }
    } else {
        ESP_LOGE(TAG, "HTTPS sync failed: %s", esp_err_to_name(err));
    }

    esp_http_client_cleanup(client);
    cJSON_free(post_data);
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

    while (1) {
        device_sync_send_event("heartbeat");
        vTaskDelay(pdMS_TO_TICKS(CONFIG_PET_HEARTBEAT_INTERVAL_SEC * 1000));
    }
}

esp_err_t device_sync_start(void) {
    BaseType_t ok = xTaskCreate(
        device_sync_task,
        "device_sync_task",
        6144,
        NULL,
        5,
        NULL
    );
    return ok == pdPASS ? ESP_OK : ESP_FAIL;
}
