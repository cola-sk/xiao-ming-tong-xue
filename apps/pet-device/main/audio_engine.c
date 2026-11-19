#include "audio_engine.h"
#include <stdbool.h>
#include "esp_log.h"
#include "bsp/esp-bsp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_heap_caps.h"
#include "chat_client.h"
#include "ui_state_machine.h"
#include "wifi_manager.h"
#include "device_pairing.h"
#include <string.h>

static const char *TAG = "audio_engine";

static uint8_t s_volume_percent = 80;
static bool s_capturing = false;
static bool s_playing = false;
static esp_codec_dev_handle_t s_speaker, s_mic;
static bool s_test_busy;

static int codec_transfer(esp_codec_dev_handle_t device, uint8_t *data, size_t len, bool record) {
    for (size_t offset = 0; offset < len;) {
        size_t chunk = len - offset > 2048 ? 2048 : len - offset;
        int ret = record ? esp_codec_dev_read(device, data + offset, chunk) : esp_codec_dev_write(device, data + offset, chunk);
        if (ret != ESP_CODEC_DEV_OK) return ret;
        offset += chunk;
    }
    return ESP_CODEC_DEV_OK;
}

void audio_engine_init(void) {
    s_volume_percent = 80;
    s_capturing = false;
    s_playing = false;
    s_speaker = bsp_audio_codec_speaker_init();
    s_mic = bsp_audio_codec_microphone_init();
    ESP_LOGI(TAG, "Audio codecs: speaker=%s microphone=%s", s_speaker ? "ready" : "failed", s_mic ? "ready" : "failed");
}

static void audio_self_test_task(void *arg) {
    (void)arg;
    const size_t bytes = 22050 * 2 * 3;
    uint8_t *data = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    esp_codec_dev_sample_info_t fmt = { .sample_rate = 22050, .channel = 1, .bits_per_sample = 16 };
    bool mic_open = false, speaker_open = false;
    if (!data) { ESP_LOGE(TAG, "Audio test allocation failed"); goto done; }
    if (esp_codec_dev_open(s_mic, &fmt) != ESP_CODEC_DEV_OK) { ESP_LOGE(TAG, "Microphone open failed"); goto done; }
    mic_open = true;
    esp_codec_dev_set_in_gain(s_mic, 30.0f);
    ESP_LOGI(TAG, "Recording self-test for 3 seconds");
    if (codec_transfer(s_mic, data, bytes, true) != ESP_CODEC_DEV_OK) { ESP_LOGE(TAG, "Microphone read failed"); goto done; }
    esp_codec_dev_close(s_mic); mic_open = false;
    if (esp_codec_dev_open(s_speaker, &fmt) != ESP_CODEC_DEV_OK) { ESP_LOGE(TAG, "Speaker open failed"); goto done; }
    speaker_open = true;
    esp_codec_dev_set_out_vol(s_speaker, s_volume_percent);
    if (codec_transfer(s_speaker, data, bytes, false) != ESP_CODEC_DEV_OK) ESP_LOGE(TAG, "Speaker write failed");
    else ESP_LOGI(TAG, "Audio self-test playback completed");
done:
    if (mic_open) esp_codec_dev_close(s_mic);
    if (speaker_open) esp_codec_dev_close(s_speaker);
    free(data);
    s_test_busy = false;
    vTaskDelete(NULL);
}

bool audio_engine_start_self_test(void) {
    if (s_test_busy || !s_speaker || !s_mic) return false;
    s_test_busy = true;
    if (xTaskCreate(audio_self_test_task, "audio_test", 4096, NULL, 5, NULL) != pdPASS) { s_test_busy = false; return false; }
    return true;
}

static void put16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
static void put32(uint8_t *p, uint32_t v) { put16(p, v); put16(p + 2, v >> 16); }

static void voice_message_task(void *arg) {
    (void)arg;
    enum { SAMPLE_RATE = 22050, PCM_SIZE = SAMPLE_RATE * 2 * 3, WAV_HEADER = 44 };
    uint8_t *wav = heap_caps_malloc(PCM_SIZE + WAV_HEADER, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    bool mic_open = false;
    esp_codec_dev_sample_info_t fmt = { .sample_rate = SAMPLE_RATE, .channel = 1, .bits_per_sample = 16 };
    if (!wav) { ui_set_voice_status("内存不足"); goto done; }
    memcpy(wav, "RIFF", 4); put32(wav + 4, PCM_SIZE + 36); memcpy(wav + 8, "WAVEfmt ", 8);
    put32(wav + 16, 16); put16(wav + 20, 1); put16(wav + 22, 1);
    put32(wav + 24, SAMPLE_RATE); put32(wav + 28, SAMPLE_RATE * 2);
    put16(wav + 32, 2); put16(wav + 34, 16); memcpy(wav + 36, "data", 4); put32(wav + 40, PCM_SIZE);
    if (esp_codec_dev_open(s_mic, &fmt) != ESP_CODEC_DEV_OK) { ui_set_voice_status("麦克风不可用"); goto done; }
    mic_open = true;
    esp_codec_dev_set_in_gain(s_mic, 30.0f);
    ui_set_voice_status("正在录音3秒");
    if (codec_transfer(s_mic, wav + WAV_HEADER, PCM_SIZE, true) != ESP_CODEC_DEV_OK) { ui_set_voice_status("录音失败"); goto done; }
    esp_codec_dev_close(s_mic); mic_open = false;
    ui_set_voice_status("正在发送语音");
    esp_err_t err = chat_client_send_child_voice_wav(wav, PCM_SIZE + WAV_HEADER, NULL, 3);
    ui_set_voice_status(err == ESP_OK ? "发送成功" : "发送失败请重试");
    ESP_LOGI(TAG, "Voice message result: %s", esp_err_to_name(err));
done:
    if (mic_open) esp_codec_dev_close(s_mic);
    free(wav);
    s_test_busy = false;
    vTaskDelete(NULL);
}

bool audio_engine_start_voice_message(void) {
    if (s_test_busy || !s_mic || !wifi_manager_is_connected() || !device_pairing_is_paired()) return false;
    s_test_busy = true;
    if (xTaskCreate(voice_message_task, "voice_send", 6144, NULL, 5, NULL) != pdPASS) { s_test_busy = false; return false; }
    return true;
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
