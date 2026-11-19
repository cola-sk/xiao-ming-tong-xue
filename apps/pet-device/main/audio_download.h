#pragma once
#include "esp_err.h"
#include <stdbool.h>
esp_err_t audio_download_file(const char *url, const char *path, const char *md5);
bool audio_cache_valid(const char *path, const char *md5);
