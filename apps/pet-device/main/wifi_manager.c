#include "wifi_manager.h"
#include <stdio.h>
#include <string.h>
#include <stdatomic.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "lwip/netdb.h"
#include "lwip/inet.h"

static const char *TAG = "wifi_manager";

#define WIFI_CONNECTED_BIT BIT0

static EventGroupHandle_t s_wifi_event_group = NULL;
static atomic_bool s_is_connected = false;
static atomic_bool s_switching = false;
static atomic_bool s_has_config = false;
static char s_device_id[32] = {0};
static char s_mac_str[20] = {0};

typedef struct { char ssid[33]; char password[64]; } saved_network_t;
typedef struct { uint32_t version; saved_network_t entries[WIFI_SAVED_MAX]; } saved_store_t;
static saved_store_t s_saved = { .version = 1 };

static int saved_index(const char *ssid) {
    for (int i = 0; i < WIFI_SAVED_MAX; i++)
        if (s_saved.entries[i].ssid[0] && strcmp(s_saved.entries[i].ssid, ssid) == 0) return i;
    return -1;
}
static esp_err_t save_store(void) {
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("pet_wifi", NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(nvs, "networks", &s_saved, sizeof(s_saved));
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}
static esp_err_t remember(const char *ssid, const char *password) {
    int index = saved_index(ssid);
    if (index < 0) for (int i = 0; i < WIFI_SAVED_MAX; i++) if (!s_saved.entries[i].ssid[0]) { index = i; break; }
    if (index < 0) return ESP_ERR_NO_MEM;
    saved_network_t previous = s_saved.entries[index];
    snprintf(s_saved.entries[index].ssid, sizeof(s_saved.entries[index].ssid), "%s", ssid);
    snprintf(s_saved.entries[index].password, sizeof(s_saved.entries[index].password), "%s", password);
    esp_err_t err = save_store();
    if (err != ESP_OK) s_saved.entries[index] = previous;
    memset(&previous, 0, sizeof(previous));
    return err;
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base,
                               int32_t event_id, void *event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        if (s_has_config) esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        s_is_connected = false;
        xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
        wifi_event_sta_disconnected_t *event = event_data;
        ESP_LOGW(TAG, "Wi-Fi disconnected reason=%u; reconnecting", event ? event->reason : 0);
        if (!s_switching && s_has_config) esp_wifi_connect();
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&event->ip_info.ip));
        esp_wifi_set_ps(WIFI_PS_NONE);
        s_is_connected = true;
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

esp_err_t wifi_manager_init(void) {
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    uint8_t mac[6] = {0};
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    snprintf(s_mac_str, sizeof(s_mac_str), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    snprintf(s_device_id, sizeof(s_device_id), "esp32_pet_%02x%02x", mac[4], mac[5]);
    ESP_LOGI(TAG, "Device ID: %s | MAC: %s", s_device_id, s_mac_str);

    s_wifi_event_group = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));

    wifi_config_t wifi_config = {0};
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_get_config(WIFI_IF_STA, &wifi_config));
    nvs_handle_t settings;
    uint8_t forgotten = 0;
    if (nvs_open("pet_wifi", NVS_READONLY, &settings) == ESP_OK) {
        nvs_get_u8(settings, "forgotten", &forgotten);
        nvs_close(settings);
    }
    if (forgotten && wifi_config.sta.ssid[0]) {
        memset(&wifi_config, 0, sizeof(wifi_config));
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    }
    if (!wifi_config.sta.ssid[0] && !forgotten) {
    strncpy((char *)wifi_config.sta.ssid, CONFIG_PET_WIFI_SSID, sizeof(wifi_config.sta.ssid) - 1);
    strncpy((char *)wifi_config.sta.password, CONFIG_PET_WIFI_PASSWORD, sizeof(wifi_config.sta.password) - 1);
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    }
    s_has_config = wifi_config.sta.ssid[0] != 0;
    bool migrated = false;
    size_t store_size = sizeof(s_saved);
    if (nvs_open("pet_wifi", NVS_READONLY, &settings) == ESP_OK) {
        migrated = nvs_get_blob(settings, "networks", &s_saved, &store_size) == ESP_OK &&
                   store_size == sizeof(s_saved) && s_saved.version == 1;
        nvs_close(settings);
    }
    if (!migrated) {
        memset(&s_saved, 0, sizeof(s_saved)); s_saved.version = 1;
        if (s_has_config && !forgotten) {
            char ssid[33] = {0}, password[65] = {0};
            memcpy(ssid, wifi_config.sta.ssid, 32);
            memcpy(password, wifi_config.sta.password, 64);
            if (remember(ssid, password) != ESP_OK) ESP_LOGW(TAG, "Could not migrate saved Wi-Fi");
            memset(password, 0, sizeof(password));
        } else if (save_store() != ESP_OK) ESP_LOGW(TAG, "Could not initialize saved Wi-Fi list");
    }
    memset(&wifi_config, 0, sizeof(wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_set_ps(WIFI_PS_NONE);

    return ESP_OK;
}

bool wifi_manager_wait_connected(uint32_t timeout_ms) {
    if (!s_wifi_event_group) return false;
    EventBits_t bits = xEventGroupWaitBits(
        s_wifi_event_group,
        WIFI_CONNECTED_BIT,
        pdFALSE,
        pdFALSE,
        pdMS_TO_TICKS(timeout_ms)
    );
    return (bits & WIFI_CONNECTED_BIT) != 0;
}

bool wifi_manager_is_connected(void) {
    return s_is_connected;
}

bool wifi_manager_get_ssid(char *ssid, size_t size) {
    if (!ssid || !size) return false;
    ssid[0] = '\0';
    wifi_ap_record_t ap = {0};
    if (!s_is_connected || esp_wifi_sta_get_ap_info(&ap) != ESP_OK) return false;
    size_t len = strnlen((const char *)ap.ssid, sizeof(ap.ssid));
    if (len >= size) len = size - 1;
    memcpy(ssid, ap.ssid, len);
    ssid[len] = '\0';
    return true;
}

void wifi_manager_log_server_address(void) {
    const char *start = strstr(CONFIG_PET_SERVER_URL, "://");
    if (!start) return;
    start += 3;
    size_t len = strcspn(start, "/:");
    char host[128];
    if (!len || len >= sizeof(host)) return;
    memcpy(host, start, len); host[len] = 0;
    struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_STREAM };
    struct addrinfo *addresses = NULL;
    int err = getaddrinfo(host, "443", &hints, &addresses);
    if (err || !addresses) { ESP_LOGW(TAG, "Server DNS lookup failed: %d", err); return; }
    for (struct addrinfo *item = addresses; item; item = item->ai_next) {
        char address[INET_ADDRSTRLEN];
        const struct sockaddr_in *peer = (const struct sockaddr_in *)item->ai_addr;
        if (inet_ntop(AF_INET, &peer->sin_addr, address, sizeof(address)))
            ESP_LOGI(TAG, "Server IPv4: %s -> %s:443", host, address);
    }
    freeaddrinfo(addresses);
}

int wifi_manager_get_rssi(void) {
    if (!s_is_connected) return -127;
    wifi_ap_record_t ap_info;
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        return ap_info.rssi;
    }
    return -127;
}

const char *wifi_manager_get_device_id(void) {
    return s_device_id;
}

const char *wifi_manager_get_mac_str(void) {
    return s_mac_str;
}

// Run from a worker task: scanning and connection may take several seconds.
esp_err_t wifi_manager_scan(wifi_ap_record_t *records, uint16_t *count) {
    if (!records || !count || !*count) return ESP_ERR_INVALID_ARG;
    // A reconnect in progress prevents an ESP-IDF scan. Pause it only when
    // disconnected; keep an established connection intact during scanning.
    s_switching = true;
    bool was_connected = s_is_connected;
    if (!was_connected) {
        esp_wifi_disconnect();
        vTaskDelay(pdMS_TO_TICKS(200));
    }
    wifi_scan_config_t scan = { .show_hidden = false };
    esp_err_t err = esp_wifi_scan_start(&scan, true);
    if (err == ESP_OK) err = esp_wifi_scan_get_ap_records(count, records);
    else ESP_LOGW(TAG, "Wi-Fi scan failed: %s", esp_err_to_name(err));
    s_switching = false;
    if (!s_is_connected && s_has_config) esp_wifi_connect();
    return err;
}

esp_err_t wifi_manager_connect(const char *ssid, const char *password) {
    size_t slen = strlen(ssid), plen = strlen(password);
    if (!slen || slen > 32 || plen > 63 || (plen && plen < 8)) return ESP_ERR_INVALID_ARG;
    if (saved_index(ssid) < 0 && wifi_manager_saved_count() >= WIFI_SAVED_MAX) return ESP_ERR_NO_MEM;
    wifi_config_t old = {0}, next = {0};
    esp_err_t err = esp_wifi_get_config(WIFI_IF_STA, &old);
    if (err != ESP_OK) return err;
    memcpy(next.sta.ssid, ssid, slen);
    memcpy(next.sta.password, password, plen);
    next.sta.threshold.authmode = plen ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    s_switching = true;
    esp_wifi_disconnect();
    xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    s_is_connected = false;
    // Keep the previous credentials in flash until the new connection succeeds.
    err = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (err == ESP_OK) err = esp_wifi_set_config(WIFI_IF_STA, &next);
    if (err == ESP_OK) err = esp_wifi_connect();
    if (err == ESP_OK && !wifi_manager_wait_connected(15000)) err = ESP_ERR_TIMEOUT;
    if (err == ESP_OK) {
        esp_err_t save = esp_wifi_set_storage(WIFI_STORAGE_FLASH);
        if (save == ESP_OK) save = esp_wifi_set_config(WIFI_IF_STA, &next);
        if (save == ESP_OK) {
            s_has_config = true;
            nvs_handle_t settings;
            save = nvs_open("pet_wifi", NVS_READWRITE, &settings);
            if (save == ESP_OK) {
                save = nvs_set_u8(settings, "forgotten", 0);
                if (save == ESP_OK) save = nvs_commit(settings);
                nvs_close(settings);
            }
        }
        if (save == ESP_OK) save = remember(ssid, password);
        if (save != ESP_OK) err = save;
    }
    if (err != ESP_OK) {
        esp_wifi_disconnect();
        esp_wifi_set_storage(WIFI_STORAGE_RAM);
        esp_wifi_set_config(WIFI_IF_STA, &old);
        if (esp_wifi_set_storage(WIFI_STORAGE_FLASH) == ESP_OK) esp_wifi_set_config(WIFI_IF_STA, &old);
        s_has_config = old.sta.ssid[0] != 0;
        if (s_has_config) esp_wifi_connect();
    }
    s_switching = false;
    memset(&old, 0, sizeof(old));
    memset(&next, 0, sizeof(next));
    return err;
}

size_t wifi_manager_saved_count(void) {
    size_t count = 0;
    for (int i = 0; i < WIFI_SAVED_MAX; i++) if (s_saved.entries[i].ssid[0]) count++;
    return count;
}
bool wifi_manager_saved_at(size_t index, char *ssid, size_t size) {
    if (!ssid || !size) return false;
    for (int i = 0; i < WIFI_SAVED_MAX; i++) if (s_saved.entries[i].ssid[0]) {
        if (!index--) { snprintf(ssid, size, "%s", s_saved.entries[i].ssid); return true; }
    }
    return false;
}
bool wifi_manager_get_saved(const char *ssid, char *password, size_t size) {
    if (!ssid || !password || !size) return false;
    int index = saved_index(ssid);
    if (index < 0) return false;
    snprintf(password, size, "%s", s_saved.entries[index].password);
    return true;
}
esp_err_t wifi_manager_forget(const char *ssid) {
    int index = saved_index(ssid);
    if (index < 0) return ESP_ERR_NOT_FOUND;
    wifi_config_t config = {0};
    if (esp_wifi_get_config(WIFI_IF_STA, &config) != ESP_OK) return ESP_FAIL;
    bool active = s_has_config && strncmp((char *)config.sta.ssid, ssid, 32) == 0;
    memset(&config, 0, sizeof(config));
    saved_network_t old = s_saved.entries[index];
    memset(&s_saved.entries[index], 0, sizeof(s_saved.entries[index]));
    esp_err_t err = save_store();
    if (err != ESP_OK) { s_saved.entries[index] = old; memset(&old, 0, sizeof(old)); return err; }
    memset(&old, 0, sizeof(old));
    if (!active) return ESP_OK;
    nvs_handle_t settings;
    err = nvs_open("pet_wifi", NVS_READWRITE, &settings);
    if (err == ESP_OK) {
        err = nvs_set_u8(settings, "forgotten", 1);
        if (err == ESP_OK) err = nvs_commit(settings);
        nvs_close(settings);
    }
    s_switching = true; s_has_config = false;
    esp_wifi_disconnect(); s_is_connected = false;
    xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    wifi_config_t empty = {0};
    esp_err_t clear = esp_wifi_set_storage(WIFI_STORAGE_FLASH);
    if (clear == ESP_OK) clear = esp_wifi_set_config(WIFI_IF_STA, &empty);
    s_switching = false;
    return err != ESP_OK ? err : clear;
}
