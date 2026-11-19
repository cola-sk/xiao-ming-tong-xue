#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

typedef enum { AUDIO_TARGET_AI, AUDIO_TARGET_PARENT } audio_target_t;
void audio_engine_init(void);
void audio_engine_set_volume(uint8_t volume_percent);
uint8_t audio_engine_get_volume(void);
void audio_engine_stop_playback(void);
unsigned audio_engine_get_stop_generation(void);
// Press starts up to 15 seconds of mono 16 kHz capture; release encodes and sends.
bool audio_engine_start_hold(audio_target_t target);
void audio_engine_end_hold(audio_target_t target);
// Retry uses the retained audio and stable message ID; no microphone capture.
bool audio_engine_retry_last(void);
bool audio_engine_has_pending(void);
bool audio_engine_can_retry(void);
bool audio_engine_can_retry_target(audio_target_t target);
bool audio_engine_is_busy(void);
void audio_engine_clear_pending_if_id(const char *msg_id);
// Synchronous completion: ESP_OK only after decoded PCM reaches the speaker.
esp_err_t audio_engine_play_buffer(const uint8_t *data, size_t len);
esp_err_t audio_engine_play_buffer_gen(const uint8_t *data, size_t len, unsigned expected_gen);
esp_err_t audio_engine_play_file(const char *path);
esp_err_t audio_engine_play_file_gen(const char *path, unsigned expected_gen);
