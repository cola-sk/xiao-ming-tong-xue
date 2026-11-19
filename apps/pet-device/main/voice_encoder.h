#pragma once
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

// 16 kHz mono PCM16 -> AAC-LC with ADTS headers; caller frees the output.
esp_err_t voice_encode_aac(const uint8_t *pcm, size_t pcm_len, uint8_t **audio, size_t *audio_len);
esp_err_t voice_encode_opus(const uint8_t *pcm, size_t pcm_len, uint8_t **audio, size_t *audio_len);
