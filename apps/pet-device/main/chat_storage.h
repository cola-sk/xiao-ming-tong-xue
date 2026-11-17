#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialize the ESP32-S3 local WeChat voice cache index.
 * Enforces triple-constraint eviction:
 *   1) Retention TTL (CONFIG_PET_WECHAT_MAX_AGE_DAYS)
 *   2) Max Message Count (CONFIG_PET_WECHAT_MAX_COUNT)
 *   3) Max Total Size in Bytes (CONFIG_PET_WECHAT_MAX_BYTES_KB * 1024)
 */
esp_err_t chat_storage_init(void);

/**
 * Save a WeChat WAV voice message (either parent->device or child->device) locally.
 * Automatically evicts expired or oldest files to stay strictly within volume & count quotas.
 */
esp_err_t chat_storage_save(const char *msg_id, const uint8_t *wav_data, size_t wav_len);

/**
 * Resolve the local cached file path for a message ID (returns false if not cached/evicted).
 */
bool chat_storage_get_path(const char *msg_id, char *out_path, size_t out_len);

/**
 * Return current cached count and total bytes used by local WeChat audio.
 */
void chat_storage_get_stats(int *out_count, size_t *out_bytes);

#ifdef __cplusplus
}
#endif
