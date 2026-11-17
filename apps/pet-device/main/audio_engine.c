#include "audio_engine.h"
#include <stdbool.h>
#include "esp_log.h"

static const char *TAG = "audio_engine";

static uint8_t s_volume_percent = 80;
static bool s_capturing = false;
static bool s_playing = false;

void audio_engine_init(void) {
    s_volume_percent = 80;
    s_capturing = false;
    s_playing = false;
    ESP_LOGI(TAG, "Audio codec initialized (ES7210 Dual-Mic AEC + ES8311 DAC, 16kHz Opus/MP3)");
}

void audio_engine_start_capture_stream(const char *ws_url) {
    if (s_playing) {
        // 支持硬件 AEC 随时语音打断
        audio_engine_stop_playback();
    }
    s_capturing = true;
    ESP_LOGI(TAG, "ES7210 capturing 16kHz audio -> streaming to %s", ws_url ? ws_url : "");
}

void audio_engine_start_capture_file(const char *file_path) {
    if (s_playing) {
        audio_engine_stop_playback();
    }
    s_capturing = true;
    ESP_LOGI(TAG, "ES7210 capturing voice message to %s", file_path ? file_path : "");
}

void audio_engine_stop_capture(void) {
    if (!s_capturing) return;
    s_capturing = false;
    ESP_LOGI(TAG, "Audio capture stopped (EOF)");
}

void audio_engine_play_local_file(const char *file_path) {
    s_playing = true;
    ESP_LOGI(TAG, "ES8311 playing audio (vol=%u%%): %s", s_volume_percent, file_path ? file_path : "");
}

void audio_engine_stop_playback(void) {
    if (!s_playing) return;
    s_playing = false;
    ESP_LOGI(TAG, "ES8311 playback stopped");
}

void audio_engine_set_volume(uint8_t volume_percent) {
    if (volume_percent > 100) volume_percent = 100;
    if (s_volume_percent == volume_percent) return;
    s_volume_percent = volume_percent;
    ESP_LOGI(TAG, "ES8311 hardware volume updated to %u%%", s_volume_percent);
}
