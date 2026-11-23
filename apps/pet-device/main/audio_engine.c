#include "audio_engine.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <stdatomic.h>
#include "esp_log.h"
#include "esp_random.h"
#include "bsp/esp-bsp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/idf_additions.h"
#include "esp_heap_caps.h"
#include "esp_audio_dec_default.h"
#include "esp_audio_simple_dec_default.h"
#include "esp_audio_simple_dec.h"
#include "chat_client.h"
#include "ui_state_machine.h"
#include "device_pairing.h"
#include "voice_encoder.h"
#include "device_storage.h"
#include "nvs.h"

static const char *TAG = "audio_engine";
static atomic_uchar s_volume_percent = 80;
static atomic_int s_remote_volume = -1;
static atomic_bool s_local_volume_saved;
static esp_codec_dev_handle_t s_speaker, s_mic;
static SemaphoreHandle_t s_codec_lock;
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;
static bool s_busy;
static atomic_bool s_hold;
static audio_target_t s_target;
static atomic_uint s_stop_generation;
static uint8_t *s_pending;
static size_t s_pending_len;
static char s_pending_id[48], s_pending_mime[24];
static int s_pending_duration;
static audio_target_t s_pending_target;
static atomic_bool s_pending_available;
#define PENDING_FILE PET_STORAGE_BASE "/outgoing.bin"
// A single durable outbox record. Stable message ID makes ambiguous uploads safe to retry.
typedef struct { uint32_t magic, len, target, duration; char id[48], mime[24]; } pending_header_t;

static bool reserve(void) {
    portENTER_CRITICAL(&s_state_lock);
    bool ok = !s_busy;
    if (ok) s_busy = true;
    portEXIT_CRITICAL(&s_state_lock);
    return ok;
}
static void release(void) { portENTER_CRITICAL(&s_state_lock); s_busy = false; portEXIT_CRITICAL(&s_state_lock); }
static void playback_task(void *arg);
static bool spawn(TaskFunction_t task, const char *name, void *arg) {
    return xTaskCreateWithCaps(task, name, 40960, arg, 5, NULL, (task == playback_task ? MALLOC_CAP_SPIRAM : MALLOC_CAP_INTERNAL) | MALLOC_CAP_8BIT) == pdPASS;
}
static void clear_pending(void) {
    atomic_store(&s_pending_available, false);
    free(s_pending); s_pending = NULL; s_pending_len = 0; unlink(PENDING_FILE);
}
static void save_pending(void) {
    pending_header_t h = { .magic = 0x50455432, .len = s_pending_len, .target = s_pending_target, .duration = s_pending_duration };
    snprintf(h.id, sizeof(h.id), "%s", s_pending_id); snprintf(h.mime, sizeof(h.mime), "%s", s_pending_mime);
    FILE *f = fopen(PENDING_FILE ".tmp", "wb");
    if (!f) return;
    bool ok = fwrite(&h, 1, sizeof(h), f) == sizeof(h) && fwrite(s_pending, 1, s_pending_len, f) == s_pending_len;
    if (fclose(f) != 0) ok = false;
    if (ok) rename(PENDING_FILE ".tmp", PENDING_FILE); else unlink(PENDING_FILE ".tmp");
}
static void load_pending(void) {
    FILE *f = fopen(PENDING_FILE, "rb"); if (!f) return;
    pending_header_t h;
    if (fread(&h, 1, sizeof(h), f) != sizeof(h) || h.magic != 0x50455432 || !h.len || h.len > 500000 ||
        h.target > AUDIO_TARGET_PARENT || !h.duration || h.duration > 15 || !memchr(h.id, 0, sizeof(h.id)) || !memchr(h.mime, 0, sizeof(h.mime))) { fclose(f); unlink(PENDING_FILE); return; }
    s_pending = heap_caps_malloc(h.len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_pending && fread(s_pending, 1, h.len, f) == h.len) {
        s_pending_len = h.len; s_pending_duration = h.duration; s_pending_target = h.target;
        memcpy(s_pending_id, h.id, sizeof(h.id)); memcpy(s_pending_mime, h.mime, sizeof(h.mime));
        atomic_store(&s_pending_available, true);
    } else { free(s_pending); s_pending = NULL; }
    fclose(f);
}
void audio_engine_init(void) {
    nvs_handle_t nvs;
    if (nvs_open("pet_audio", NVS_READONLY, &nvs) == ESP_OK) {
        uint8_t value;
        if (nvs_get_u8(nvs, "volume", &value) == ESP_OK && value <= 100) {
            atomic_store(&s_volume_percent, value);
            atomic_store(&s_local_volume_saved, true);
        }
        if (nvs_get_u8(nvs, "remote", &value) == ESP_OK && value <= 100) atomic_store(&s_remote_volume, value);
        nvs_close(nvs);
    }
    s_codec_lock = xSemaphoreCreateMutex();
    s_speaker = bsp_audio_codec_speaker_init(); s_mic = bsp_audio_codec_microphone_init();
    esp_audio_dec_register_default(); esp_audio_simple_dec_register_default();
    load_pending();
    if (s_pending && !strcmp(s_pending_id, "hardware_smoke_outbox")) clear_pending();
    if (s_pending && s_pending_target == AUDIO_TARGET_PARENT) {
        chat_client_add_local_outgoing(s_pending_id, s_pending, s_pending_len, s_pending_mime, s_pending_duration);
        chat_client_set_send_state(s_pending_id, CHAT_SEND_FAILED);
    }
    ESP_LOGI(TAG, "Audio speaker=%s mic=%s outbox=%d", s_speaker ? "ready" : "failed", s_mic ? "ready" : "failed", audio_engine_has_pending());
}

static void send_pending(void) {
    ui_set_voice_status(s_pending_target == AUDIO_TARGET_AI ? "正在思考请稍候" : "正在发送语音");
    esp_err_t err = s_pending_target == AUDIO_TARGET_AI
        ? chat_client_ask_ai_audio(s_pending, s_pending_len, s_pending_mime)
        : chat_client_send_child_recording(s_pending_id, s_pending, s_pending_len, s_pending_mime, s_pending_duration);
    if (err == ESP_OK) { clear_pending(); ui_set_voice_status(s_pending_target == AUDIO_TARGET_AI ? "回答结束请继续提问" : "发送成功"); }
    else ui_set_voice_status(err == ESP_ERR_HTTP_CONNECT ? "连接失败可重新发送" : "失败可重新发送或重录");
    ESP_LOGI(TAG, "Voice result: %s", esp_err_to_name(err));
}
static void retry_task(void *arg) { send_pending(); release(); vTaskDeleteWithCaps(NULL); }
bool audio_engine_retry_last(void) {
    if (!audio_engine_has_pending() || !device_pairing_is_paired() || !reserve()) return false;
    if (!spawn(retry_task, "voice_retry", NULL)) { release(); return false; } return true;
}
bool audio_engine_has_pending(void) { return atomic_load(&s_pending_available); }
bool audio_engine_can_retry(void) {
    portENTER_CRITICAL(&s_state_lock); bool ready = !s_busy && atomic_load(&s_pending_available); portEXIT_CRITICAL(&s_state_lock);
    return ready;
}
bool audio_engine_can_retry_target(audio_target_t target) {
    portENTER_CRITICAL(&s_state_lock);
    bool ready = !s_busy && atomic_load(&s_pending_available) && s_pending_target == target;
    portEXIT_CRITICAL(&s_state_lock);
    return ready;
}
bool audio_engine_is_busy(void) {
    portENTER_CRITICAL(&s_state_lock); bool busy = s_busy; portEXIT_CRITICAL(&s_state_lock);
    return busy;
}
void audio_engine_clear_pending_if_id(const char *msg_id) {
    if (!msg_id || !*msg_id) return;
    portENTER_CRITICAL(&s_state_lock);
    bool match = !s_busy && atomic_load(&s_pending_available) && strcmp(s_pending_id, msg_id) == 0;
    if (match) s_busy = true;
    portEXIT_CRITICAL(&s_state_lock);
    if (match) { clear_pending(); release(); }
}
static void put16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
static void put32(uint8_t *p, uint32_t v) { put16(p, v); put16(p + 2, v >> 16); }
static void record_task(void *arg) {
    (void)arg;
    uint8_t *pcm = heap_caps_malloc(480000 + 44, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    bool opened = false, locked = false; size_t used = 0;
    if (!pcm) { ui_set_voice_status("内存不足"); goto done; }
    if (xSemaphoreTake(s_codec_lock, pdMS_TO_TICKS(1000)) != pdTRUE) { ui_set_voice_status("音频忙请稍候"); goto done; }
    locked = true;
    esp_codec_dev_sample_info_t fmt = { .sample_rate = 16000, .channel = 1, .bits_per_sample = 16 };
    if (esp_codec_dev_open(s_mic, &fmt) != ESP_CODEC_DEV_OK) { ui_set_voice_status("麦克风不可用"); goto done; }
    opened = true; esp_codec_dev_set_in_gain(s_mic, 30.0f);
    ui_set_voice_status("正在录音松开发送");
    while (atomic_load(&s_hold) && used + 640 <= 480000) {
        if (esp_codec_dev_read(s_mic, pcm + 44 + used, 640) != ESP_CODEC_DEV_OK) { ui_set_voice_status("录音失败"); goto done; }
        used += 640;
    }
    esp_codec_dev_close(s_mic); opened = false; xSemaphoreGive(s_codec_lock); locked = false;
    if (used < 9600) { ui_set_voice_status("录音太短请按住说话"); goto done; }
    ui_set_voice_status("正在处理语音");
    uint8_t *encoded = NULL; size_t encoded_len = 0;
    esp_err_t err = s_target == AUDIO_TARGET_AI ? voice_encode_opus(pcm + 44, used, &encoded, &encoded_len)
                                               : voice_encode_aac(pcm + 44, used, &encoded, &encoded_len);
    const char *mime = s_target == AUDIO_TARGET_AI ? "audio/ogg" : "audio/aac";
    if (err != ESP_OK) {
        memcpy(pcm, "RIFF", 4); put32(pcm + 4, used + 36); memcpy(pcm + 8, "WAVEfmt ", 8);
        put32(pcm + 16, 16); put16(pcm + 20, 1); put16(pcm + 22, 1); put32(pcm + 24, 16000);
        put32(pcm + 28, 32000); put16(pcm + 32, 2); put16(pcm + 34, 16); memcpy(pcm + 36, "data", 4); put32(pcm + 40, used);
        encoded = pcm; pcm = NULL; encoded_len = used + 44; mime = "audio/wav";
    }
    clear_pending(); s_pending = encoded; s_pending_len = encoded_len; s_pending_target = s_target;
    s_pending_duration = (used + 31999) / 32000;
    snprintf(s_pending_mime, sizeof(s_pending_mime), "%s", mime);
    snprintf(s_pending_id, sizeof(s_pending_id), "msg_dev_%lld_%08lx", (long long)time(NULL), (unsigned long)esp_random());
    save_pending(); atomic_store(&s_pending_available, true); free(pcm); pcm = NULL;
    if (s_pending_target == AUDIO_TARGET_PARENT) {
        chat_client_add_local_outgoing(s_pending_id, s_pending, s_pending_len, s_pending_mime, s_pending_duration);
    }
    send_pending();
done:
    if (opened) esp_codec_dev_close(s_mic);
    if (locked) xSemaphoreGive(s_codec_lock);
    atomic_store(&s_hold, false); free(pcm); release(); vTaskDeleteWithCaps(NULL);
}
bool audio_engine_start_hold(audio_target_t target) {
    if (target > AUDIO_TARGET_PARENT || !s_mic || !device_pairing_is_paired() || !reserve()) return false;
    s_target = target; atomic_store(&s_hold, true);
    if (!spawn(record_task, "voice_record", NULL)) { atomic_store(&s_hold, false); release(); return false; } return true;
}
void audio_engine_end_hold(audio_target_t target) { if (target == s_target) atomic_store(&s_hold, false); }

// Decoder runs on an external 40 KB stack; heartbeat and RTC callers wait for completion.
typedef struct { const uint8_t *data; size_t len; unsigned generation; esp_err_t result; SemaphoreHandle_t done; } play_job_t;
static void playback_task(void *arg) {
    play_job_t *job = arg; bool opened = false, locked = false; uint8_t *pcm = NULL;
    esp_audio_simple_dec_handle_t dec = NULL; job->result = ESP_FAIL;
    if (!s_speaker || xSemaphoreTake(s_codec_lock, 0) != pdTRUE) { job->result = ESP_ERR_INVALID_STATE; goto done; }
    locked = true;
    esp_audio_simple_dec_type_t type = ESP_AUDIO_SIMPLE_DEC_TYPE_MP3;
    if (job->len >= 12 && memcmp(job->data, "RIFF", 4) == 0) type = ESP_AUDIO_SIMPLE_DEC_TYPE_WAV;
    else if (job->len >= 4 && memcmp(job->data, "OggS", 4) == 0) type = ESP_AUDIO_SIMPLE_DEC_TYPE_OGG;
    else if (job->len >= 2 && job->data[0] == 0xff && (job->data[1] & 0xf6) == 0xf0) type = ESP_AUDIO_SIMPLE_DEC_TYPE_AAC;
    esp_audio_simple_dec_cfg_t cfg = { .dec_type = type };
    if (esp_audio_simple_dec_open(&cfg, &dec) != ESP_AUDIO_ERR_OK) goto done;
    size_t cap = 8192, offset = 0, decoded = 0; pcm = malloc(cap); if (!pcm) goto done;
    while (offset < job->len && job->generation == atomic_load(&s_stop_generation)) {
        size_t n = job->len - offset; if (n > 1024) n = 1024;
        esp_audio_simple_dec_raw_t raw = { .buffer = (uint8_t *)job->data + offset, .len = n, .eos = offset + n == job->len };
        unsigned stalls = 0;
        while (raw.len) {
            if (job->generation != atomic_load(&s_stop_generation)) { job->result = ESP_ERR_NOT_FINISHED; goto done; }
            esp_audio_simple_dec_out_t out = { .buffer = pcm, .len = cap };
            int ret = esp_audio_simple_dec_process(dec, &raw, &out);
            if (ret == ESP_AUDIO_ERR_BUFF_NOT_ENOUGH && out.needed_size > cap && out.needed_size <= 65536) {
                uint8_t *next = realloc(pcm, out.needed_size); if (!next) goto done;
                pcm = next; cap = out.needed_size; continue;
            }
            if (ret != ESP_AUDIO_ERR_OK || raw.consumed > raw.len) { ESP_LOGW(TAG, "Decode error=%d", ret); goto done; }
            if (out.decoded_size) {
                if (!opened) {
                    esp_audio_simple_dec_info_t info = {0};
                    if (esp_audio_simple_dec_get_info(dec, &info) != ESP_AUDIO_ERR_OK || !info.sample_rate || !info.channel || info.bits_per_sample != 16) goto done;
                    esp_codec_dev_sample_info_t fmt = { .sample_rate = info.sample_rate, .channel = info.channel, .bits_per_sample = info.bits_per_sample };
                    if (esp_codec_dev_open(s_speaker, &fmt) != ESP_CODEC_DEV_OK) goto done;
                    opened = true; esp_codec_dev_set_out_vol(s_speaker, atomic_load(&s_volume_percent));
                }
                esp_codec_dev_set_out_vol(s_speaker, atomic_load(&s_volume_percent));
                if (esp_codec_dev_write(s_speaker, pcm, out.decoded_size) != ESP_CODEC_DEV_OK) goto done;
                decoded += out.decoded_size;
            }
            if (!raw.consumed && ++stalls > 8) goto done;
            if (raw.consumed) stalls = 0;
            raw.buffer += raw.consumed; raw.len -= raw.consumed;
        }
        offset += n;
    }
    if (job->generation != atomic_load(&s_stop_generation)) job->result = ESP_ERR_NOT_FINISHED;
    else if (decoded && offset == job->len) job->result = ESP_OK;
    ESP_LOGI(TAG, "Playback encoded=%u decoded=%u result=%s", (unsigned)job->len, (unsigned)decoded, esp_err_to_name(job->result));
done:
    if (opened) esp_codec_dev_close(s_speaker);
    if (dec) esp_audio_simple_dec_close(dec);
    free(pcm); if (locked) xSemaphoreGive(s_codec_lock);
    xSemaphoreGive(job->done); vTaskDeleteWithCaps(NULL);
}
unsigned audio_engine_get_stop_generation(void) { return atomic_load(&s_stop_generation); }
esp_err_t audio_engine_play_buffer_gen(const uint8_t *data, size_t len, unsigned expected_gen) {
    if (!data || !len || len > 1024 * 1024) return ESP_ERR_INVALID_ARG;
    if (expected_gen != atomic_load(&s_stop_generation)) return ESP_ERR_NOT_FINISHED;
    play_job_t job = { .data = data, .len = len, .generation = expected_gen, .done = xSemaphoreCreateBinary() };
    if (!job.done) return ESP_ERR_NO_MEM;
    if (!spawn(playback_task, "audio_play", &job)) { vSemaphoreDelete(job.done); return ESP_ERR_NO_MEM; }
    xSemaphoreTake(job.done, portMAX_DELAY); vSemaphoreDelete(job.done); return job.result;
}
esp_err_t audio_engine_play_buffer(const uint8_t *data, size_t len) {
    return audio_engine_play_buffer_gen(data, len, audio_engine_get_stop_generation());
}
esp_err_t audio_engine_play_file_gen(const char *path, unsigned expected_gen) {
    if (expected_gen != atomic_load(&s_stop_generation)) return ESP_ERR_NOT_FINISHED;
    FILE *f = fopen(path, "rb"); if (!f) return ESP_ERR_NOT_FOUND;
    fseek(f, 0, SEEK_END); long size = ftell(f); rewind(f);
    if (size <= 0 || size > 1024 * 1024) { fclose(f); return ESP_ERR_INVALID_SIZE; }
    uint8_t *buf = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    bool ok = buf && fread(buf, 1, size, f) == size; fclose(f);
    if (ok && expected_gen != atomic_load(&s_stop_generation)) { free(buf); return ESP_ERR_NOT_FINISHED; }
    esp_err_t err = ok ? audio_engine_play_buffer_gen(buf, size, expected_gen) : ESP_FAIL; free(buf); return err;
}
esp_err_t audio_engine_play_file(const char *path) {
    return audio_engine_play_file_gen(path, audio_engine_get_stop_generation());
}
void audio_engine_stop_playback(void) { atomic_fetch_add(&s_stop_generation, 1); }
static void save_volume(const char *key, uint8_t value) {
    nvs_handle_t nvs;
    if (nvs_open("pet_audio", NVS_READWRITE, &nvs) == ESP_OK) {
        if (nvs_set_u8(nvs, key, value) == ESP_OK) nvs_commit(nvs);
        nvs_close(nvs);
    }
}
void audio_engine_set_volume(uint8_t volume) {
    if (volume > 100) volume = 100;
    if (atomic_exchange(&s_volume_percent, volume) != volume || !atomic_load(&s_local_volume_saved)) {
        save_volume("volume", volume);
        atomic_store(&s_local_volume_saved, true);
    }
}
void audio_engine_set_remote_volume(uint8_t volume) {
    if (volume > 100) volume = 100;
    int previous = atomic_exchange(&s_remote_volume, volume);
    if (previous != volume) {
        save_volume("remote", volume);
        if (previous >= 0 || !atomic_load(&s_local_volume_saved)) audio_engine_set_volume(volume);
    }
}
uint8_t audio_engine_get_volume(void) { return atomic_load(&s_volume_percent); }

#ifdef PET_HARDWARE_SMOKE
bool audio_engine_smoke_outbox(const uint8_t *data, size_t len) {
    if (audio_engine_has_pending() || !reserve()) return false;
    s_pending = malloc(len); if (!s_pending) { release(); return false; }
    memcpy(s_pending, data, len); s_pending_len = len; s_pending_target = AUDIO_TARGET_AI; s_pending_duration = 3;
    snprintf(s_pending_id, sizeof(s_pending_id), "hardware_smoke_outbox"); snprintf(s_pending_mime, sizeof(s_pending_mime), "audio/mpeg");
    save_pending(); free(s_pending); s_pending = NULL; s_pending_len = 0;
    load_pending();
    bool ok = audio_engine_has_pending() && s_pending_len == len && !memcmp(s_pending, data, len) && !strcmp(s_pending_id, "hardware_smoke_outbox");
    clear_pending(); release(); return ok;
}
#endif
