#include "device_storage.h"
#include "esp_spiffs.h"
#include "esp_log.h"
#include <sys/stat.h>

esp_err_t device_storage_init(void) {
    esp_vfs_spiffs_conf_t cfg = { .base_path = PET_STORAGE_BASE, .partition_label = "storage",
        .max_files = 12, .format_if_mount_failed = true };
    esp_err_t err = esp_vfs_spiffs_register(&cfg);
    if (err != ESP_OK) return err;
    mkdir(PET_STORAGE_BASE "/wechat", 0755);
    mkdir(PET_STORAGE_BASE "/alarms", 0755);
    ESP_LOGI("device_storage", "Persistent flash storage mounted");
    return ESP_OK;
}
