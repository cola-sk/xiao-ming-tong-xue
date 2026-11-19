#include "chat_storage.h"
#include "device_storage.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>
#include "esp_log.h"

static const char *TAG = "chat_storage";

#define WECHAT_DIR_BASE PET_STORAGE_BASE "/wechat"
#define MAX_INDEX_ENTRIES 256

typedef struct {
    char msg_id[48];
    char file_path[96];
    size_t size_bytes;
    time_t created_at;
    bool active;
} wechat_cache_entry_t;

static wechat_cache_entry_t s_entries[MAX_INDEX_ENTRIES];
static int s_entry_count = 0;
static size_t s_total_bytes = 0;

static size_t get_quota_max_bytes(void) {
    return (size_t)CONFIG_PET_WECHAT_MAX_BYTES_KB * 1024U;
}

static int get_quota_max_count(void) {
    int cfg_max = CONFIG_PET_WECHAT_MAX_COUNT;
    return cfg_max > MAX_INDEX_ENTRIES ? MAX_INDEX_ENTRIES : cfg_max;
}

static time_t get_quota_ttl_sec(void) {
    return (time_t)CONFIG_PET_WECHAT_MAX_AGE_DAYS * 86400L;
}

static void evict_entry_at(int idx) {
    if (idx < 0 || idx >= s_entry_count) return;
    ESP_LOGI(TAG, "Evicting local WeChat voice [%s] (%u bytes)",
             s_entries[idx].msg_id, (unsigned)s_entries[idx].size_bytes);
    unlink(s_entries[idx].file_path);

    if (s_total_bytes >= s_entries[idx].size_bytes) {
        s_total_bytes -= s_entries[idx].size_bytes;
    } else {
        s_total_bytes = 0;
    }

    for (int i = idx; i < s_entry_count - 1; i++) {
        s_entries[i] = s_entries[i + 1];
    }
    s_entry_count--;
}

static void enforce_eviction_policy(size_t incoming_bytes) {
    time_t now = time(NULL);
    time_t ttl_sec = get_quota_ttl_sec();
    size_t max_bytes = get_quota_max_bytes();
    int max_count = get_quota_max_count();

    // 1) 按时间清理：淘汰超过保留天数的语音
    if (now > 1700000000) {
        for (int i = 0; i < s_entry_count;) {
            if ((now - s_entries[i].created_at) > ttl_sec) {
                evict_entry_at(i);
            } else {
                i++;
            }
        }
    }

    // 2) 按条数与总体积双重限制，FIFO 淘汰最旧一条直到腾出足够空间
    while (s_entry_count > 0 &&
           (s_entry_count >= max_count || (s_total_bytes + incoming_bytes) > max_bytes)) {
        evict_entry_at(0);
    }
}

esp_err_t chat_storage_init(void) {
    memset(s_entries, 0, sizeof(s_entries));
    s_entry_count = 0;
    s_total_bytes = 0;
    mkdir(WECHAT_DIR_BASE, 0755);
    ESP_LOGI(TAG, "WeChat local storage ready: dir=%s | max_count=%d | max_bytes=%u KB | ttl=%d days",
             WECHAT_DIR_BASE,
             get_quota_max_count(),
             (unsigned)(get_quota_max_bytes() / 1024U),
             CONFIG_PET_WECHAT_MAX_AGE_DAYS);
    return ESP_OK;
}

esp_err_t chat_storage_save(const char *msg_id, const uint8_t *wav_data, size_t wav_len) {
    if (!msg_id || strlen(msg_id) == 0 || !wav_data || wav_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    size_t max_bytes = get_quota_max_bytes();
    if (wav_len > max_bytes) {
        ESP_LOGW(TAG, "Single voice (%u bytes) exceeds total WeChat quota (%u bytes)",
                 (unsigned)wav_len, (unsigned)max_bytes);
        return ESP_ERR_NO_MEM;
    }

    // 若已存在同 msg_id，先移除旧条目
    for (int i = 0; i < s_entry_count; i++) {
        if (strcmp(s_entries[i].msg_id, msg_id) == 0) {
            evict_entry_at(i);
            break;
        }
    }

    enforce_eviction_policy(wav_len);

    char path[96];
    snprintf(path, sizeof(path), "%s/%s.wav", WECHAT_DIR_BASE, msg_id);

    FILE *fp = fopen(path, "wb");
    if (!fp) {
        ESP_LOGE(TAG, "Cannot open audio cache file %s", path);
        return ESP_FAIL;
    }
    size_t written = fwrite(wav_data, 1, wav_len, fp);
    int close_result = fclose(fp);
    if (written != wav_len || close_result != 0) {
        unlink(path);
        return ESP_FAIL;
    }

    wechat_cache_entry_t *entry = &s_entries[s_entry_count++];
    snprintf(entry->msg_id, sizeof(entry->msg_id), "%s", msg_id);
    snprintf(entry->file_path, sizeof(entry->file_path), "%s", path);
    entry->size_bytes = wav_len;
    entry->created_at = time(NULL);
    entry->active = true;
    s_total_bytes += wav_len;

    ESP_LOGI(TAG, "Saved WeChat voice [%s] (%u bytes) | total=%d msgs (%u/%u KB)",
             msg_id, (unsigned)wav_len, s_entry_count,
             (unsigned)(s_total_bytes / 1024U), (unsigned)(max_bytes / 1024U));
    return ESP_OK;
}

bool chat_storage_get_path(const char *msg_id, char *out_path, size_t out_len) {
    if (!msg_id || !out_path || out_len == 0) return false;
    for (int i = 0; i < s_entry_count; i++) {
        if (strcmp(s_entries[i].msg_id, msg_id) == 0) {
            snprintf(out_path, out_len, "%s", s_entries[i].file_path);
            return true;
        }
    }
    return false;
}

void chat_storage_get_stats(int *out_count, size_t *out_bytes) {
    if (out_count) *out_count = s_entry_count;
    if (out_bytes) *out_bytes = s_total_bytes;
}
