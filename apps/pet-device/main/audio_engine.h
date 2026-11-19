#pragma once
#include <stdint.h>
#include <stdbool.h>

/**
 * 音频录放引擎接口 (ES7210 双麦阵列录音 + ES8311 音频解码播报 + Opus 编解码)
 */
void audio_engine_init(void);
void audio_engine_start_capture_stream(const char *ws_url);
void audio_engine_start_capture_file(const char *file_path);
void audio_engine_stop_capture(void);
void audio_engine_play_local_file(const char *file_path);
void audio_engine_stop_playback(void);
void audio_engine_set_volume(uint8_t volume_percent);
bool audio_engine_start_self_test(void);
bool audio_engine_start_voice_message(void);
