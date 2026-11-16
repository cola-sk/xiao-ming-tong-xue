#include "ui_state_machine.h"
#include "audio_engine.h"
#include "esp_log.h"

static const char *TAG = "ui_state";
static pet_page_t s_current_page = PET_PAGE_AI_CHAT;
static ai_pet_state_t s_ai_state = AI_STATE_IDLE;
static bool s_alarm_modal_active = false;

void ui_state_init(void) {
    s_current_page = PET_PAGE_AI_CHAT;
    s_ai_state = AI_STATE_IDLE;
    s_alarm_modal_active = false;
    ESP_LOGI(TAG, "LVGL UI State Machine initialized (480x480 CO5300 QSPI AMOLED + CST9220)");
}

void ui_switch_page(pet_page_t target_page) {
    s_current_page = target_page;
    ESP_LOGI(TAG, "Switched page to: %s", target_page == PET_PAGE_AI_CHAT ? "AI_PET" : "WECHAT_VOICE");
}

void ui_on_touch_press_start(void) {
    if (s_alarm_modal_active) {
        ui_ack_alarm_modal();
        return;
    }
    if (s_current_page == PET_PAGE_AI_CHAT) {
        s_ai_state = AI_STATE_LISTENING;
        audio_engine_start_capture_stream("ws://cloud/ai-stream");
    } else {
        audio_engine_start_capture_file("/sdcard/wechat_out.opus");
    }
}

void ui_on_touch_press_end(void) {
    if (s_current_page == PET_PAGE_AI_CHAT && s_ai_state == AI_STATE_LISTENING) {
        s_ai_state = AI_STATE_THINKING;
        audio_engine_stop_capture();
    } else if (s_current_page == PET_PAGE_WECHAT) {
        audio_engine_stop_capture();
        ESP_LOGI(TAG, "Uploading child WeChat voice message to parent App...");
    }
}

void ui_on_side_boot_key_hold_start(void) {
    ESP_LOGI(TAG, "Side BOOT key held: shortcut recording for Parent WeChat voice");
    audio_engine_start_capture_file("/sdcard/wechat_shortcut.opus");
}

void ui_on_side_boot_key_hold_end(void) {
    audio_engine_stop_capture();
    ESP_LOGI(TAG, "Side BOOT key released: sending voice message to Mom/Dad");
}

void ui_trigger_alarm_modal(const char *task_id, const char *title, const char *audio_path) {
    s_alarm_modal_active = true;
    ESP_LOGI(TAG, "Alarm Modal Ringing: [%s] %s -> %s", task_id, title, audio_path);
    audio_engine_play_local_file(audio_path);
}

void ui_ack_alarm_modal(void) {
    if (!s_alarm_modal_active) return;
    s_alarm_modal_active = false;
    audio_engine_stop_playback();
    ESP_LOGI(TAG, "Child tapped screen to ACK alarm -> publishing MQTT event alarm_ack");
}
