#include "audio_download.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "mbedtls/md5.h"
#include "pet_http_auth.h"

#define AUDIO_MAX_BYTES (1024 * 1024)
static const char *TAG = "audio_dl";

static void md5_hex_buf(const uint8_t *buf, size_t len, char out[33]) {
    mbedtls_md5_context ctx;
    unsigned char hash[16];
    mbedtls_md5_init(&ctx);
    mbedtls_md5_starts(&ctx);
    mbedtls_md5_update(&ctx, buf, len);
    mbedtls_md5_finish(&ctx, hash);
    mbedtls_md5_free(&ctx);
    for (int i = 0; i < 16; i++) snprintf(out + 2 * i, 3, "%02x", hash[i]);
}

bool audio_cache_valid(const char *path, const char *expected) {
    if (!path || !*path) return false;
    if (!expected || !*expected) {
        struct stat st;
        return stat(path, &st) == 0 && st.st_size > 0 && st.st_size <= AUDIO_MAX_BYTES;
    }
    FILE *f = fopen(path, "rb");
    if (!f) return false;
    mbedtls_md5_context ctx;
    mbedtls_md5_init(&ctx);
    mbedtls_md5_starts(&ctx);
    unsigned char buf[1024], hash[16];
    size_t n, total = 0;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        mbedtls_md5_update(&ctx, buf, n);
        total += n;
    }
    bool ok = !ferror(f) && total > 0 && total <= AUDIO_MAX_BYTES;
    fclose(f);
    mbedtls_md5_finish(&ctx, hash);
    mbedtls_md5_free(&ctx);
    char hex[33];
    for (int i = 0; i < 16; i++) snprintf(hex + 2 * i, 3, "%02x", hash[i]);
    return ok && strcasecmp(hex, expected) == 0;
}

esp_err_t audio_download_to_buffer(const char *url, uint8_t **out_buf, size_t *out_len,
                                   audio_download_cancel_fn cancel_fn, void *cancel_ctx) {
    if (!url || !*url || !out_buf || !out_len) return ESP_ERR_INVALID_ARG;
    *out_buf = NULL;
    *out_len = 0;

    char full[384];
    if (strncmp(url, "https://", 8) == 0) snprintf(full, sizeof(full), "%s", url);
    else if (url[0] == '/') snprintf(full, sizeof(full), "%s%s", CONFIG_PET_SERVER_URL, url);
    else return ESP_ERR_INVALID_ARG;

    if (cancel_fn && cancel_fn(cancel_ctx)) return ESP_ERR_NOT_FINISHED;

    bool locked = false;
    for (int waited = 0; waited < 10000; waited += 250) {
        if (cancel_fn && cancel_fn(cancel_ctx)) return ESP_ERR_NOT_FINISHED;
        if (pet_http_net_lock(250)) {
            locked = true;
            break;
        }
    }
    if (!locked) return ESP_ERR_TIMEOUT;

    esp_http_client_config_t cfg = {
        .url = full,
        .timeout_ms = 12000,
        .buffer_size = 8192,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_redirect = true,
        .addr_type = HTTP_ADDR_TYPE_INET,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t c = pet_http_init(&cfg);
    if (!c) {
        pet_http_net_unlock();
        return ESP_ERR_NO_MEM;
    }
    pet_http_add_auth(c, full);
    esp_http_client_set_header(c, "Connection", "close");

    int64_t started_us = esp_timer_get_time();
    esp_err_t err = esp_http_client_open(c, 0);
    if (err == ESP_OK && cancel_fn && cancel_fn(cancel_ctx)) err = ESP_ERR_NOT_FINISHED;

    uint8_t *buf = NULL;
    size_t cap = 0, total = 0;
    int64_t len = -1;

    if (err == ESP_OK) {
        len = esp_http_client_fetch_headers(c);
        int status = esp_http_client_get_status_code(c);
        device_pairing_handle_status(status);
        bool chunked = esp_http_client_is_chunked_response(c);
        if (cancel_fn && cancel_fn(cancel_ctx)) {
            err = ESP_ERR_NOT_FINISHED;
        } else if (len < 0 || len > AUDIO_MAX_BYTES || status != 200 || (len == 0 && !chunked)) {
            ESP_LOGW("audio_dl", "HTTP fail status=%d len=%lld chunked=%d url=%s", status, (long long)len, chunked, full);
            err = ESP_FAIL;
        } else {
            cap = len > 0 ? (size_t)len : 32768;
            buf = heap_caps_malloc(cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (!buf) buf = malloc(cap);
            if (!buf) err = ESP_ERR_NO_MEM;
        }
    }

    if (err == ESP_OK) {
        esp_http_client_set_timeout_ms(c, 500);
        int64_t last_progress_us = esp_timer_get_time();
        while (err == ESP_OK) {
            if (cancel_fn && cancel_fn(cancel_ctx)) {
                err = ESP_ERR_NOT_FINISHED;
                break;
            }
            if (len > 0 && total == (size_t)len) break;
            if (total == cap) {
                if (cap >= AUDIO_MAX_BYTES) {
                    char extra;
                    int r = esp_http_client_read(c, &extra, 1);
                    if (r == -ESP_ERR_HTTP_EAGAIN) {
                        if ((esp_timer_get_time() - last_progress_us) > 12000000LL) { err = ESP_ERR_TIMEOUT; break; }
                        continue;
                    }
                    if (r > 0) { err = ESP_ERR_INVALID_SIZE; break; }
                    if (r < 0 || !esp_http_client_is_complete_data_received(c)) { err = ESP_FAIL; break; }
                    break;
                }
                size_t next_cap = cap * 2;
                if (next_cap > AUDIO_MAX_BYTES) next_cap = AUDIO_MAX_BYTES;
                uint8_t *next = heap_caps_realloc(buf, next_cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
                if (!next) next = realloc(buf, next_cap);
                if (!next) { err = ESP_ERR_NO_MEM; break; }
                buf = next;
                cap = next_cap;
            }
            int want = (int)(cap - total);
            if (want > 8192) want = 8192;
            int n = esp_http_client_read(c, (char *)buf + total, want);
            if (n == -ESP_ERR_HTTP_EAGAIN) {
                if ((esp_timer_get_time() - last_progress_us) > 12000000LL) {
                    err = ESP_ERR_TIMEOUT;
                    break;
                }
                continue;
            }
            if (n < 0) {
                err = ESP_FAIL;
                break;
            }
            if (n == 0) {
                if (!esp_http_client_is_complete_data_received(c)) err = ESP_FAIL;
                break;
            }
            total += (size_t)n;
            last_progress_us = esp_timer_get_time();
        }
        if (err == ESP_OK && (!total || (len > 0 && total != (size_t)len))) {
            err = ESP_FAIL;
        }
    }

    pet_http_note_result(c, err == ESP_ERR_NOT_FINISHED ? ESP_OK : err);
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    pet_http_net_unlock();

    if (err == ESP_OK) {
        int64_t elapsed_ms = (esp_timer_get_time() - started_us) / 1000;
        ESP_LOGI(TAG, "Downloaded %u B in %lld ms (%lld KB/s)",
                 (unsigned)total, elapsed_ms, elapsed_ms > 0 ? ((int64_t)total * 1000LL / 1024LL) / elapsed_ms : 0);
        *out_buf = buf;
        *out_len = total;
        return ESP_OK;
    }

    free(buf);
    return err;
}

esp_err_t audio_download_file(const char *url, const char *path, const char *md5) {
    if (audio_cache_valid(path, md5)) return ESP_OK;

    uint8_t *buf = NULL;
    size_t len = 0;
    esp_err_t err = audio_download_to_buffer(url, &buf, &len, NULL, NULL);
    if (err != ESP_OK) return err;

    if (md5 && *md5) {
        char hex[33];
        md5_hex_buf(buf, len, hex);
        if (strcasecmp(hex, md5) != 0) {
            ESP_LOGW("audio_dl", "MD5 mismatch got=%s expected=%s len=%u", hex, md5, (unsigned)len);
            free(buf);
            return ESP_FAIL;
        }
    }

    char tmp[128];
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    FILE *f = fopen(tmp, "wb");
    bool ok = f && fwrite(buf, 1, len, f) == len;
    if (f && fclose(f) != 0) ok = false;
    free(buf);

    if (ok && rename(tmp, path) == 0) return ESP_OK;
    unlink(tmp);
    return ESP_FAIL;
}
