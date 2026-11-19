#include "audio_download.h"
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "esp_http_client.h"
#include "pet_http_auth.h"
#include "esp_crt_bundle.h"
#include "mbedtls/md5.h"

bool audio_cache_valid(const char *path, const char *expected) {
    FILE *f = fopen(path, "rb"); if (!f) return false;
    mbedtls_md5_context ctx; mbedtls_md5_init(&ctx); mbedtls_md5_starts(&ctx);
    unsigned char buf[1024], hash[16]; size_t n, total = 0;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) { mbedtls_md5_update(&ctx, buf, n); total += n; }
    bool ok = !ferror(f) && total > 0 && total <= 1024 * 1024;
    fclose(f); mbedtls_md5_finish(&ctx, hash); mbedtls_md5_free(&ctx);
    char hex[33]; for (int i = 0; i < 16; i++) snprintf(hex + 2 * i, 3, "%02x", hash[i]);
    return ok && (!expected || !*expected || strcasecmp(hex, expected) == 0);
}
esp_err_t audio_download_file(const char *url, const char *path, const char *md5) {
    if (audio_cache_valid(path, md5)) return ESP_OK;
    char full[384], tmp[128];
    if (strncmp(url, "https://", 8) == 0) snprintf(full, sizeof(full), "%s", url);
    else if (url[0] == '/') snprintf(full, sizeof(full), "%s%s", CONFIG_PET_SERVER_URL, url);
    else return ESP_ERR_INVALID_ARG;
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    esp_http_client_config_t cfg = { .url = full, .timeout_ms = 12000, .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_redirect = true, .addr_type = HTTP_ADDR_TYPE_INET };
    esp_http_client_handle_t c = pet_http_init(&cfg); if (!c) return ESP_ERR_NO_MEM;
    pet_http_add_auth(c, full); esp_err_t err = esp_http_client_open(c, 0);
    FILE *f = NULL; size_t total = 0;
    if (err == ESP_OK) {
        int64_t len = esp_http_client_fetch_headers(c); int status = esp_http_client_get_status_code(c);
        device_pairing_handle_status(status);
        if (len < 0 || len > 1024 * 1024 || status != 200) err = ESP_FAIL;
        else {
            f = fopen(tmp, "wb"); if (!f) err = ESP_FAIL;
            char buf[2048];
            while (f && err == ESP_OK) {
                int n = esp_http_client_read(c, buf, sizeof(buf));
                if (n < 0) { err = ESP_FAIL; break; }
                if (!n) { if (!esp_http_client_is_complete_data_received(c)) err = ESP_FAIL; break; }
                total += n;
                if (total > 1024 * 1024 || fwrite(buf, 1, n, f) != n) err = ESP_FAIL;
            }
            if (!total || (len > 0 && total != len)) err = ESP_FAIL;
        }
    }
    if (f && fclose(f) != 0) err = ESP_FAIL;
    pet_http_note_result(c, err); esp_http_client_close(c); esp_http_client_cleanup(c);
    if (err == ESP_OK && audio_cache_valid(tmp, md5) && rename(tmp, path) == 0) return ESP_OK;
    unlink(tmp); return err == ESP_OK ? ESP_FAIL : err;
}
