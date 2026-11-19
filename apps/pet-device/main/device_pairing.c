#include "device_pairing.h"
#include "pet_http_auth.h"
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_random.h"
#include "nvs.h"
#include "cJSON.h"
#include "wifi_manager.h"
#include "ui_state_machine.h"

static const char *TAG = "device_pairing";
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static char s_token[65];
static char s_setup[65];
static bool s_paired;
static bool s_reset_pending;
static nvs_handle_t s_nvs;

typedef struct { char data[1536]; size_t used; } pairing_response_t;
static void random_secret(char *out) {
    uint8_t bytes[32]; esp_fill_random(bytes, sizeof(bytes));
    for (size_t i = 0; i < sizeof(bytes); i++) snprintf(out + i * 2, 3, "%02x", bytes[i]);
}
static bool valid_secret(const char *value) {
    if (!value || strlen(value) != 64) return false;
    for (int i = 0; i < 64; i++) if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
    return true;
}
static esp_err_t new_setup(void) {
    random_secret(s_setup);
    ESP_RETURN_ON_ERROR(nvs_set_str(s_nvs, "setup", s_setup), TAG, "Save pairing proof failed");
    return nvs_commit(s_nvs);
}
static esp_err_t response_event(esp_http_client_event_t *event) {
    pairing_response_t *response = event->user_data;
    if (event->event_id == HTTP_EVENT_ON_DATA && response && event->data_len > 0) {
        if (response->used + event->data_len >= sizeof(response->data)) return ESP_ERR_NO_MEM;
        memcpy(response->data + response->used, event->data, event->data_len);
        response->used += event->data_len; response->data[response->used] = 0;
    }
    return ESP_OK;
}
static int pairing_request(const char *action, cJSON **result) {
    *result = NULL;
    char url[256]; snprintf(url, sizeof(url), "%s/api/v1/device/pairing/%s", CONFIG_PET_SERVER_URL, action);
    cJSON *body = cJSON_CreateObject();
    if (!body) return -1;
    cJSON_AddStringToObject(body, "deviceId", wifi_manager_get_device_id());
    cJSON_AddStringToObject(body, "setupSecret", s_setup);
    char *payload = cJSON_PrintUnformatted(body); cJSON_Delete(body);
    if (!payload) return -1;
    pairing_response_t response = {0};
    esp_http_client_config_t cfg = {
        .url = url, .method = HTTP_METHOD_POST, .timeout_ms = 25000,
        .crt_bundle_attach = esp_crt_bundle_attach, .disable_auto_redirect = true,
        .addr_type = HTTP_ADDR_TYPE_INET,
        .event_handler = response_event, .user_data = &response,
    };
    esp_http_client_handle_t client = pet_http_init(&cfg);
    if (!client) { cJSON_free(payload); return -1; }
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, payload, strlen(payload));
    esp_err_t err = esp_http_client_perform(client);
    pet_http_note_result(client, err);
    int status = esp_http_client_get_status_code(client);
    // ESP-IDF returns ESP_ERR_NOT_SUPPORTED for a JSON 401 without a Basic/Digest
    // challenge. Preserve that response so an unpaired device can request a code.
    if (err != ESP_OK && status != 401) status = -1;
    if (status == 200) *result = cJSON_Parse(response.data);
    esp_http_client_cleanup(client); cJSON_free(payload);
    ESP_LOGI(TAG, "Pairing %s -> HTTP %d", action, status);
    return status;
}

esp_err_t device_pairing_init(void) {
    if (strncmp(CONFIG_PET_SERVER_URL, "https://", 8) != 0) return ESP_ERR_INVALID_ARG;
    ESP_RETURN_ON_ERROR(nvs_open("pet_pairing", NVS_READWRITE, &s_nvs), TAG, "Credential storage unavailable");
    char origin[256] = {0}; size_t len = sizeof(origin);
    nvs_get_str(s_nvs, "origin", origin, &len);
    if (strcmp(origin, CONFIG_PET_SERVER_URL) != 0) {
        ESP_RETURN_ON_ERROR(nvs_erase_all(s_nvs), TAG, "Reset credentials failed");
        ESP_RETURN_ON_ERROR(nvs_set_str(s_nvs, "origin", CONFIG_PET_SERVER_URL), TAG, "Save origin failed");
        ESP_RETURN_ON_ERROR(nvs_commit(s_nvs), TAG, "Save origin failed");
    }
    len = sizeof(s_token); nvs_get_str(s_nvs, "token", s_token, &len);
    s_paired = valid_secret(s_token);
    if (!s_paired) s_token[0] = 0;
    len = sizeof(s_setup); nvs_get_str(s_nvs, "setup", s_setup, &len);
    if (!valid_secret(s_setup)) ESP_RETURN_ON_ERROR(new_setup(), TAG, "Save pairing proof failed");
    ESP_LOGI(TAG, "Device credentials: %s", s_paired ? "loaded" : "not paired");
    return ESP_OK;
}
bool device_pairing_is_paired(void) {
    portENTER_CRITICAL(&s_lock); bool paired = s_paired; portEXIT_CRITICAL(&s_lock); return paired;
}
void device_pairing_add_auth(esp_http_client_handle_t client, const char *url) {
    size_t base_len = strlen(CONFIG_PET_SERVER_URL);
    if (!client || !url || strncmp(url, CONFIG_PET_SERVER_URL, base_len) != 0 || (url[base_len] != '/' && url[base_len] != 0)) return;
    char token[65] = {0};
    portENTER_CRITICAL(&s_lock); if (s_paired) memcpy(token, s_token, sizeof(token)); portEXIT_CRITICAL(&s_lock);
    if (token[0]) esp_http_client_set_header(client, "X-Pet-Device-Token", token);
    memset(token, 0, sizeof(token));
}
void device_pairing_handle_status(int status) {
    if (status != 401) return;
    portENTER_CRITICAL(&s_lock);
    s_paired = false; s_token[0] = 0; s_reset_pending = true;
    portEXIT_CRITICAL(&s_lock);
}
static void pairing_task(void *arg) {
    (void)arg;
    bool code_known = false;
    while (1) {
        bool reset;
        portENTER_CRITICAL(&s_lock); reset = s_reset_pending; s_reset_pending = false; portEXIT_CRITICAL(&s_lock);
        if (reset) {
            nvs_erase_key(s_nvs, "token"); nvs_commit(s_nvs);
            // Keep the setup proof so a pending delivery can be recovered after a lost response.
            code_known = false;
        }
        if (device_pairing_is_paired()) { vTaskDelay(pdMS_TO_TICKS(2000)); continue; }
        if (!wifi_manager_wait_connected(5000)) { ui_set_pairing_status(NULL, "等待网络连接"); continue; }
        cJSON *response = NULL;
        int status = pairing_request("poll", &response);
        if (status == 200 && response) {
            cJSON *token = cJSON_GetObjectItem(response, "token");
            cJSON *id = cJSON_GetObjectItem(response, "deviceId");
            if (cJSON_IsString(token) && valid_secret(token->valuestring) && cJSON_IsString(id) && strcmp(id->valuestring, wifi_manager_get_device_id()) == 0) {
                esp_err_t saved = nvs_set_str(s_nvs, "token", token->valuestring);
                if (saved == ESP_OK) saved = nvs_commit(s_nvs);
                if (saved == ESP_OK) {
                    portENTER_CRITICAL(&s_lock); memcpy(s_token, token->valuestring, sizeof(s_token)); s_paired = true; portEXIT_CRITICAL(&s_lock);
                    ui_set_pairing_status(NULL, "绑定成功");
                    ESP_LOGI(TAG, "Paired credential saved to NVS");
                } else ui_set_pairing_status(NULL, "保存失败请重试");
                cJSON_Delete(response); continue;
            }
        }
        cJSON_Delete(response); response = NULL;
        if (status == 410) { if (new_setup() != ESP_OK) { vTaskDelay(pdMS_TO_TICKS(30000)); continue; } code_known = false; }
        if (status == 401 || status == 410 || (status == 200 && !code_known)) {
            status = pairing_request("start", &response);
            cJSON *code = response ? cJSON_GetObjectItem(response, "code") : NULL;
            if (status == 200 && cJSON_IsString(code) && strlen(code->valuestring) == 8) {
                ui_set_pairing_status(code->valuestring, "家长端输入绑定码"); code_known = true;
            } else if (status == 409) ui_set_pairing_status(NULL, "请先在家长端解绑");
            cJSON_Delete(response);
        }
        if (status == 404) ui_set_pairing_status(NULL, "配对服务尚未就绪");
        else if (status != 200 && status != 409) ui_set_pairing_status(NULL, "配对连接失败稍后重试");
        vTaskDelay(pdMS_TO_TICKS(status == 200 ? 5000 : status == 429 ? 300000 : 30000));
    }
}
esp_err_t device_pairing_start(void) {
    return xTaskCreate(pairing_task, "device_pairing", 6144, NULL, 4, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
