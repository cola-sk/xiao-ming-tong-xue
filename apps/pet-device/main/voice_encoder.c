#include "voice_encoder.h"
#include <stdlib.h>
#include <string.h>
#include "esp_aac_enc.h"
#include "esp_opus_enc.h"
#include "esp_random.h"
#include "esp_log.h"

esp_err_t voice_encode_aac(const uint8_t *pcm, size_t pcm_len, uint8_t **audio, size_t *audio_len) {
    if (!audio || !audio_len || !pcm || !pcm_len || pcm_len > 480000 || pcm_len % 2) return ESP_ERR_INVALID_ARG;
    *audio = NULL; *audio_len = 0;
    esp_aac_enc_config_t cfg = {
        .sample_rate = 16000, .channel = 1, .bits_per_sample = 16,
        .bitrate = 24000, .adts_used = true,
    };
    void *encoder = NULL;
    uint8_t *input = NULL, *output = NULL, *encoded = NULL;
    esp_err_t result = ESP_FAIL;
    int in_size = 0, out_size = 0;
    if (esp_aac_enc_open(&cfg, sizeof(cfg), &encoder) != ESP_AUDIO_ERR_OK) goto done;
    if (esp_aac_enc_get_frame_size(encoder, &in_size, &out_size) != ESP_AUDIO_ERR_OK || in_size <= 0 || out_size <= 0) goto done;
    input = malloc(in_size); output = malloc(out_size); encoded = malloc(131072);
    if (!input || !output || !encoded) { result = ESP_ERR_NO_MEM; goto done; }
    size_t used = 0;
    // Pad the final partial frame and drain the AAC encoder's delay with two
    // silent frames so the last spoken syllable is retained.
    size_t frames = (pcm_len + in_size - 1) / in_size + 2;
    for (size_t frame = 0; frame < frames; frame++) {
        size_t offset = frame * in_size;
        size_t available = offset < pcm_len ? pcm_len - offset : 0;
        if (available > in_size) available = in_size;
        memset(input, 0, in_size);
        if (available) memcpy(input, pcm + offset, available);
        esp_audio_enc_in_frame_t in = { .buffer = input, .len = in_size };
        esp_audio_enc_out_frame_t out = { .buffer = output, .len = out_size };
        int err = esp_aac_enc_process(encoder, &in, &out);
        if (err != ESP_AUDIO_ERR_OK || out.encoded_bytes > out_size || out.encoded_bytes > 131072 - used) goto done;
        memcpy(encoded + used, output, out.encoded_bytes); used += out.encoded_bytes;
    }
    if (!used) goto done;
    *audio = encoded; *audio_len = used; encoded = NULL; result = ESP_OK;
    ESP_LOGI("voice_encoder", "AAC voice: PCM=%u bytes -> AAC=%u bytes", (unsigned)pcm_len, (unsigned)used);
done:
    if (encoder) esp_aac_enc_close(encoder);
    free(input); free(output); free(encoded);
    return result;
}

static void le16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
static void le32(uint8_t *p, uint32_t v) { le16(p, v); le16(p + 2, v >> 16); }
static bool ogg_page(uint8_t *dest, size_t cap, size_t *used, const uint8_t *packet, size_t len,
                     uint32_t serial, uint32_t sequence, uint64_t granule, uint8_t flags) {
    size_t segments = len / 255 + 1, size = 27 + segments + len;
    if (segments > 255 || size > cap - *used) return false;
    uint8_t *page = dest + *used;
    memset(page, 0, 27); memcpy(page, "OggS", 4); page[5] = flags;
    le32(page + 6, (uint32_t)granule); le32(page + 10, granule >> 32);
    le32(page + 14, serial); le32(page + 18, sequence); page[26] = segments;
    for (size_t i = 0; i < segments; i++) page[27 + i] = i + 1 < segments ? 255 : len % 255;
    memcpy(page + 27 + segments, packet, len);
    uint32_t crc = 0;
    for (size_t i = 0; i < size; i++) {
        crc ^= (uint32_t)page[i] << 24;
        for (int bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
    le32(page + 22, crc); *used += size;
    return true;
}

esp_err_t voice_encode_opus(const uint8_t *pcm, size_t pcm_len, uint8_t **audio, size_t *audio_len) {
    if (!audio || !audio_len || !pcm || !pcm_len || pcm_len > 480000 || pcm_len % 2) return ESP_ERR_INVALID_ARG;
    *audio = NULL; *audio_len = 0;
    esp_opus_enc_config_t cfg = { .sample_rate = 16000, .channel = 1, .bits_per_sample = 16,
        .bitrate = 16000, .frame_duration = ESP_OPUS_ENC_FRAME_DURATION_20_MS,
        .application_mode = ESP_OPUS_ENC_APPLICATION_VOIP, .complexity = 0 };
    void *encoder = NULL; uint8_t *input = NULL, *output = NULL, *ogg = NULL;
    esp_err_t result = ESP_FAIL; int in_size = 0, out_size = 0;
    if (esp_opus_enc_open(&cfg, sizeof(cfg), &encoder) != ESP_AUDIO_ERR_OK) goto done;
    if (esp_opus_enc_get_frame_size(encoder, &in_size, &out_size) != ESP_AUDIO_ERR_OK || in_size != 640 || out_size <= 0) goto done;
    input = malloc(in_size); output = malloc(out_size); ogg = malloc(131072);
    if (!input || !output || !ogg) { result = ESP_ERR_NO_MEM; goto done; }
    uint32_t serial = esp_random(); size_t used = 0;
    uint8_t head[19] = {0}; memcpy(head, "OpusHead", 8); head[8] = 1; head[9] = 1;
    le16(head + 10, 312); le32(head + 12, 16000);
    uint8_t tags[24] = {0}; memcpy(tags, "OpusTags", 8); le32(tags + 8, 8); memcpy(tags + 12, "xiaoming", 8);
    if (!ogg_page(ogg, 131072, &used, head, sizeof(head), serial, 0, 0, 2) ||
        !ogg_page(ogg, 131072, &used, tags, sizeof(tags), serial, 1, 0, 0)) goto done;
    // 312 samples at 48 kHz is the standard Opus lookahead (104 at 16 kHz).
    size_t frames = (pcm_len / 2 + 104 + 319) / 320;
    for (size_t frame = 0; frame < frames; frame++) {
        size_t offset = frame * in_size, available = offset < pcm_len ? pcm_len - offset : 0;
        if (available > in_size) available = in_size;
        memset(input, 0, in_size); if (available) memcpy(input, pcm + offset, available);
        esp_audio_enc_in_frame_t in = { .buffer = input, .len = in_size };
        esp_audio_enc_out_frame_t out = { .buffer = output, .len = out_size };
        if (esp_opus_enc_process(encoder, &in, &out) != ESP_AUDIO_ERR_OK || !out.encoded_bytes || out.encoded_bytes > out_size) goto done;
        bool last = frame + 1 == frames;
        uint64_t granule = last ? pcm_len / 2 * 3 + 312 : (frame + 1) * 960;
        if (!ogg_page(ogg, 131072, &used, output, out.encoded_bytes, serial, frame + 2, granule, last ? 4 : 0)) goto done;
    }
    *audio = ogg; *audio_len = used; ogg = NULL; result = ESP_OK;
    ESP_LOGI("voice_encoder", "Opus voice: PCM=%u bytes -> Ogg=%u bytes", (unsigned)pcm_len, (unsigned)used);
done:
    if (encoder) esp_opus_enc_close(encoder);
    free(input); free(output); free(ogg); return result;
}
