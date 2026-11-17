#pragma once
#include <string.h>
#include "esp_http_client.h"

// Do not forward device credentials to third-party audio hosts or plaintext URLs.
static inline void pet_http_add_auth(esp_http_client_handle_t client, const char *url) {
    const char *base = CONFIG_PET_SERVER_URL;
    size_t len = strlen(base);
    if (client && url && strncmp(base, "https://", 8) == 0 &&
        strlen(CONFIG_PET_DEVICE_TOKEN) >= 32 && strncmp(url, base, len) == 0 &&
        (url[len] == '/' || url[len] == '\0')) {
        esp_http_client_set_header(client, "X-Pet-Device-Token", CONFIG_PET_DEVICE_TOKEN);
    }
}
