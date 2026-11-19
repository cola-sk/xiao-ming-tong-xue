#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "device_pairing.h"

esp_http_client_handle_t pet_http_init(const esp_http_client_config_t *config);
void pet_http_note_result(esp_http_client_handle_t client, esp_err_t result);
bool pet_http_net_lock(uint32_t timeout_ms);
void pet_http_net_unlock(void);

// Pairing provisions credentials at runtime. Only the configured HTTPS origin receives them.
static inline void pet_http_add_auth(esp_http_client_handle_t client, const char *url) {
    device_pairing_add_auth(client, url);
}

static inline esp_err_t pet_http_perform(esp_http_client_handle_t client) {
    esp_err_t err = esp_http_client_perform(client);
    pet_http_note_result(client, err);
    // A JSON 401 can also make perform() return an ESP-IDF authentication error.
    // Process revocation even when the transport call does not return ESP_OK.
    device_pairing_handle_status(esp_http_client_get_status_code(client));
    return err;
}
