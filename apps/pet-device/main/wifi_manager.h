#pragma once

#include <stdbool.h>
#include "esp_err.h"
#include "esp_wifi.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialize NVS, TCP/IP stack, and Wi-Fi STA connection.
 * Also derives a deterministic device_id from the factory MAC address.
 */
esp_err_t wifi_manager_init(void);

/**
 * Block until Wi-Fi is connected and has obtained an IP address.
 */
bool wifi_manager_wait_connected(uint32_t timeout_ms);

/**
 * Return true if Wi-Fi currently has an active IP connection.
 */
bool wifi_manager_is_connected(void);
/** Copy the connected network name, or return false when disconnected. */
bool wifi_manager_get_ssid(char *ssid, size_t size);
void wifi_manager_log_server_address(void);

/**
 * Get the current Wi-Fi RSSI in dBm (returns -127 if disconnected).
 */
int wifi_manager_get_rssi(void);

/**
 * Get the unique device ID derived from MAC, e.g. "esp32_pet_a1b2".
 */
const char *wifi_manager_get_device_id(void);

/**
 * Get the formatted MAC address string, e.g. "34:85:18:A2:B9:01".
 */
const char *wifi_manager_get_mac_str(void);

#ifdef __cplusplus
}
#endif

esp_err_t wifi_manager_scan(wifi_ap_record_t *records, uint16_t *count);
esp_err_t wifi_manager_connect(const char *ssid, const char *password);
#define WIFI_SAVED_MAX 10
size_t wifi_manager_saved_count(void);
bool wifi_manager_saved_at(size_t index, char *ssid, size_t size);
bool wifi_manager_get_saved(const char *ssid, char *password, size_t size);
esp_err_t wifi_manager_forget(const char *ssid);
