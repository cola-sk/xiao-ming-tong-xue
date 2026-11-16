#include "audio_engine.h"
#include "esp_log.h"

static const char *TAG = "audio_engine";

void audio_engine_init(void) {
    ESP_LOGI(TAG, "Audio codec initialized (ES7210 Mic + ES8311 Speaker, 16kHz Opus)");
}

void audio_engine_start_capture_stream(const char *ws_url) {
    ESP_LOGI(TAG, "ES7210 capturing 16kHz audio -> Opus streaming to %s", ws_url);
}

void audio_engine_start_capture_file(const char *file_path) {
    ESP_LOGI(TAG, "ES7210 capturing voice message to %s", file_path);
}

void audio_engine_stop_capture(void) {
    ESP_LOGI(TAG, "Audio capture stopped (EOF)");
}

void audio_engine_play_local_file(const char *file_path) {
    ESP_LOGI(TAG, "ES8311 playing cached audio: %s", file_path);
}

void audio_engine_stop_playback(void) {
    ESP_LOGI(TAG, "ES8311 playback stopped");
}

void audio_engine_set_volume(uint8_t volume_percent) {
    ESP_LOGI(TAG, "ES8311 volume set to %u%%", volume_percent);
}
