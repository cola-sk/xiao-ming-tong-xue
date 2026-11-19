#pragma once
#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"
#include "esp_http_client.h"

esp_err_t device_pairing_init(void);
esp_err_t device_pairing_start(void);
bool device_pairing_is_paired(void);
void device_pairing_add_auth(esp_http_client_handle_t client, const char *url);
void device_pairing_handle_status(int status);
