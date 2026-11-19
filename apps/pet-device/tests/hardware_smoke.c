// Opt-in hardware check. Uses synthetic audio only; never records the microphone.
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "voice_encoder.h"
#include "audio_engine.h"
#include "chat_client.h"
#include "wifi_manager.h"
#include "rtc_scheduler.h"
#include "mbedtls/md5.h"
#include <unistd.h>
#include "esp_wifi.h"
extern const uint8_t fixture_start[] asm("_binary_smoke_voice_start");
extern const uint8_t fixture_end[] asm("_binary_smoke_voice_end");
#ifdef PET_SMOKE_SPOKEN_PCM
extern const uint8_t spoken_start[] asm("_binary_smoke_pcm_start");
extern const uint8_t spoken_end[] asm("_binary_smoke_pcm_end");
#endif
static void run(void *arg) {
    vTaskDelay(pdMS_TO_TICKS(2000));
    uint8_t *audio = NULL; size_t size = 0;
    int16_t *pcm = calloc(16000, 2);
    for (int i = 0; pcm && i < 16000; i++) pcm[i] = (int16_t)(6000 * sinf(i * 2 * 3.14159265f * 440 / 16000));
    esp_err_t err = pcm ? voice_encode_opus((uint8_t *)pcm, 32000, &audio, &size) : ESP_ERR_NO_MEM;
    ESP_LOGI("hardware_smoke", "OPUS_ENCODE=%s bytes=%u", esp_err_to_name(err), (unsigned)size);
    uint8_t *aac = NULL; size_t aac_len = 0;
    esp_err_t aac_err = pcm ? voice_encode_aac((uint8_t *)pcm, 32000, &aac, &aac_len) : ESP_ERR_NO_MEM;
    ESP_LOGI("hardware_smoke", "AAC_ENCODE=%s bytes=%u", esp_err_to_name(aac_err), (unsigned)aac_len);
    if (aac) {
        size_t cap = ((aac_len + 2) / 3) * 4 + 1, len = 0; char *b64 = malloc(cap);
        if (b64 && !mbedtls_base64_encode((unsigned char *)b64, cap, &len, aac, aac_len)) {
            for (size_t i = 0; i < len; i += 160) printf("SMOKE_AAC:%.*s\n", (int)(len - i > 160 ? 160 : len - i), b64 + i);
            printf("SMOKE_AAC_END\n");
        } free(b64); free(aac);
    }
    free(pcm);
    if (err == ESP_OK) {
        size_t cap = ((size + 2) / 3) * 4 + 1, len = 0;
        char *b64 = malloc(cap);
        if (b64 && !mbedtls_base64_encode((unsigned char *)b64, cap, &len, audio, size)) {
            for (size_t i = 0; i < len; i += 160) printf("SMOKE_OGG:%.*s\n", (int)(len - i > 160 ? 160 : len - i), b64 + i);
            printf("SMOKE_OGG_END\n");
        }
        free(b64);
    }
    free(audio);
    size_t bytes = fixture_end - fixture_start;
    err = audio_engine_play_buffer(fixture_start, bytes);
    ESP_LOGI("hardware_smoke", "MP3_PLAYBACK=%s bytes=%u", esp_err_to_name(err), (unsigned)bytes);
    extern bool audio_engine_smoke_outbox(const uint8_t *, size_t);
    ESP_LOGI("hardware_smoke", "OUTBOX_ROUNDTRIP=%s", audio_engine_smoke_outbox(fixture_start, bytes) ? "PASS" : "FAIL/SKIPPED");
    ESP_LOGI("hardware_smoke", "Temporarily stopping Wi-Fi for offline alarm check");
    esp_wifi_stop(); vTaskDelay(pdMS_TO_TICKS(300));
    if (!wifi_manager_is_connected()) {
        unsigned char digest[16]; mbedtls_md5(fixture_start, bytes, digest);
        char md5[33], path[96]; for (int i = 0; i < 16; i++) snprintf(md5 + i * 2, 3, "%02x", digest[i]);
        snprintf(path, sizeof(path), "/spiffs/alarms/%s.mp3", md5);
        FILE *f = fopen(path, "wb"); if (f) { fwrite(fixture_start, 1, bytes, f); fclose(f); }
        extern bool rtc_scheduler_smoke_alarm(const char *);
        ESP_LOGI("hardware_smoke", "OFFLINE_ALARM=%s", rtc_scheduler_smoke_alarm(md5) ? "PASS" : "FAIL/SKIPPED");
        unlink(path);
    }
    esp_wifi_start();
    if (wifi_manager_wait_connected(20000)) {
#ifdef PET_SMOKE_SPOKEN_PCM
        uint8_t *voice = NULL; size_t voice_len = 0;
        err = voice_encode_opus(spoken_start, spoken_end - spoken_start, &voice, &voice_len);
        if (err == ESP_OK) err = chat_client_ask_ai_audio(voice, voice_len, "audio/ogg");
        free(voice);
#else
        err = chat_client_ask_ai_audio(fixture_start, bytes, "audio/mpeg");
#endif
        ESP_LOGI("hardware_smoke", "AI_VOICE=%s", esp_err_to_name(err));
    }
    ESP_LOGI("hardware_smoke", "DONE internal_free=%u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    vTaskDelete(NULL);
}
void hardware_smoke_start(void) { xTaskCreate(run, "hardware_smoke", 40960, NULL, 4, NULL); }
