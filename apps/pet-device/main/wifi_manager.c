#include "wifi_manager.h"
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "lwip/netdb.h"
#include "lwip/inet.h"

static const char *TAG = "wifi_manager";

#define WIFI_CONNECTED_BIT BIT0

static EventGroupHandle_t s_wifi_event_group = NULL;
static bool s_is_connected = false;
static bool s_switching = false;
static char s_device_id[32] = {0};
static char s_mac_str[20] = {0};

static void wifi_event_handler(void *arg, esp_event_base_t event_base,
                               int32_t event_id, void *event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        s_is_connected = false;
        xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
        wifi_event_sta_disconnected_t *event = event_data;
        ESP_LOGW(TAG, "Wi-Fi disconnected reason=%u; reconnecting", event ? event->reason : 0);
        if (!s_switching) esp_wifi_connect();
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
    if (!wifi_config.sta.ssid[0]) {
    strncpy((char *)wifi_config.sta.ssid, CONFIG_PET_WIFI_SSID, sizeof(wifi_config.sta.ssid) - 1);
    strncpy((char *)wifi_config.sta.password, CONFIG_PET_WIFI_PASSWORD, sizeof(wifi_config.sta.password) - 1);
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    }
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
    wifi_scan_config_t scan = { .show_hidden = false };
    esp_err_t err = esp_wifi_scan_start(&scan, true);
    if (err != ESP_OK) return err;
    return esp_wifi_scan_get_ap_records(count, records);
}

esp_err_t wifi_manager_connect(const char *ssid, const char *password) {
    size_t slen = strlen(ssid), plen = strlen(password);
    if (!slen || slen > 32 || plen > 63 || (plen && plen < 8)) return ESP_ERR_INVALID_ARG;
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
        if (save != ESP_OK) err = save;
    } else {
        esp_wifi_disconnect();
        esp_wifi_set_config(WIFI_IF_STA, &old);
        esp_wifi_set_storage(WIFI_STORAGE_FLASH);
        esp_wifi_connect();
    }
    s_switching = false;
    return err;
}
