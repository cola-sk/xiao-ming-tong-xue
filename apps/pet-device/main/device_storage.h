#pragma once
#include "esp_err.h"
#define PET_STORAGE_BASE "/spiffs"
esp_err_t device_storage_init(void);
