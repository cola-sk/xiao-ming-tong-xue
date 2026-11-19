#pragma once
#include "device_pairing.h"

// Pairing provisions credentials at runtime. Only the configured HTTPS origin receives them.
static inline void pet_http_add_auth(esp_http_client_handle_t client, const char *url) {
    device_pairing_add_auth(client, url);
}
