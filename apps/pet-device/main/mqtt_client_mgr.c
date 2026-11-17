#include "mqtt_client_mgr.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_crt_bundle.h"
#include "mqtt_client.h"
#include "cJSON.h"
#include "wifi_manager.h"
#include "chat_client.h"
#include "rtc_scheduler.h"
#include "audio_engine.h"

static const char *TAG = "mqtt_client_mgr";

#if CONFIG_PET_MQTT_ENABLE

static void handle_notify_payload(const char *data, int data_len) {
    if (!data || data_len <= 0) return;

    char *json_str = malloc((size_t)data_len + 1);
    if (!json_str) return;
    memcpy(json_str, data, (size_t)data_len);
    json_str[data_len] = '\0';

    ESP_LOGI(TAG, "Received MQTT wakeup payload: %s", json_str);
    cJSON *root = cJSON_Parse(json_str);
    free(json_str);
    if (!root) return;

    cJSON *evt = cJSON_GetObjectItem(root, "event");
    if (cJSON_IsString(evt)) {
        if (strcmp(evt->valuestring, "new_voice_msg") == 0) {
            ESP_LOGI(TAG, "Instant wakeup: fetching unread parent WeChat voice!");
            chat_client_fetch_unread();
        } else if (strcmp(evt->valuestring, "schedules_updated") == 0) {
            ESP_LOGI(TAG, "Instant wakeup: syncing updated voice schedules!");
            rtc_scheduler_fetch_and_sync();
        } else if (strcmp(evt->valuestring, "config_updated") == 0) {
            cJSON *vol = cJSON_GetObjectItem(root, "volumeLevel");
            if (cJSON_IsNumber(vol)) {
                audio_engine_set_volume((uint8_t)vol->valuedouble);
            }
        }
    }

    cJSON_Delete(root);
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base,
                               int32_t event_id, void *event_data) {
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;
    esp_mqtt_client_handle_t client = event->client;

    switch ((esp_mqtt_event_id_t)event_id) {
        case MQTT_EVENT_CONNECTED: {
            ESP_LOGI(TAG, "Connected to EMQX Cloud Serverless (TLS 8883)");
            char topic[96];
            snprintf(topic, sizeof(topic), "pet/%s/notify", wifi_manager_get_device_id());
            esp_mqtt_client_subscribe(client, topic, 1);
            esp_mqtt_client_subscribe(client, "pet/default/notify", 1);
            ESP_LOGI(TAG, "Subscribed to %s & pet/default/notify", topic);
            break;
        }
        case MQTT_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "EMQX MQTT disconnected, auto-reconnecting...");
            break;
        case MQTT_EVENT_DATA:
            handle_notify_payload(event->data, event->data_len);
            break;
        case MQTT_EVENT_ERROR:
            ESP_LOGE(TAG, "EMQX MQTT error occurred");
            break;
        default:
            break;
    }
}

static void mqtt_start_task(void *arg) {
    wifi_manager_wait_connected(portMAX_DELAY);

    if (strstr(CONFIG_PET_MQTT_BROKER_URI, "your-deployment") != NULL) {
        ESP_LOGW(TAG, "EMQX Broker URI not configured yet; skipping MQTT connection");
        vTaskDelete(NULL);
        return;
    }

    char client_id[64];
    snprintf(client_id, sizeof(client_id), "%s_mqtt", wifi_manager_get_device_id());

    esp_mqtt_client_config_t mqtt_cfg = {
        .broker = {
            .address = {
                .uri = CONFIG_PET_MQTT_BROKER_URI,
            },
            .verification = {
                .crt_bundle_attach = esp_crt_bundle_attach,
            },
        },
        .credentials = {
            .client_id = client_id,
            .username = CONFIG_PET_MQTT_USERNAME,
            .authentication = {
                .password = CONFIG_PET_MQTT_PASSWORD,
            },
        },
        .session = {
            .keepalive = 60,
        },
    };

    esp_mqtt_client_handle_t client = esp_mqtt_client_init(&mqtt_cfg);
    esp_mqtt_client_register_event(client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    esp_mqtt_client_start(client);
    vTaskDelete(NULL);
}

esp_err_t mqtt_client_mgr_start(void) {
    BaseType_t ok = xTaskCreate(mqtt_start_task, "mqtt_start_task", 4096, NULL, 5, NULL);
    return ok == pdPASS ? ESP_OK : ESP_FAIL;
}

#else

esp_err_t mqtt_client_mgr_start(void) {
    ESP_LOGI(TAG, "EMQX MQTT disabled in menuconfig (using HTTPS heartbeat polling)");
    return ESP_OK;
}

#endif
