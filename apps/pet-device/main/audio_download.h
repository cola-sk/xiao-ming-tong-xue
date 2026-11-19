#pragma once
#include "esp_err.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef bool (*audio_download_cancel_fn)(void *ctx);

esp_err_t audio_download_to_buffer(const char *url, uint8_t **out_buf, size_t *out_len,
                                   audio_download_cancel_fn cancel_fn, void *cancel_ctx);
esp_err_t audio_download_file(const char *url, const char *path, const char *md5);
bool audio_cache_valid(const char *path, const char *expected);
