#pragma once

#include <stdbool.h>
#include "esp_err.h"

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
