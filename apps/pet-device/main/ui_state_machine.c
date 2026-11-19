#include "ui_state_machine.h"
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "bsp/esp-bsp.h"
#include "esp_lv_adapter_input.h"
#include "esp_lv_adapter.h"
#include "lvgl.h"
#include "wifi_manager.h"
#include "audio_engine.h"
#include "device_sync.h"
#include "device_pairing.h"
LV_FONT_DECLARE(pet_font);

static const char *TAG = "ui_state";
static pet_page_t s_page = PET_PAGE_AI_CHAT;
static lv_obj_t *s_title, *s_subtitle, *s_ai_tab, *s_chat_tab, *s_network, *s_action_label;
static bool s_alarm_active;
static char s_alarm_id[48];
static lv_obj_t *s_pairing_panel, *s_pairing_code, *s_pairing_status;

static void render_page(void) {
    bool ai = s_page == PET_PAGE_AI_CHAT;
    lv_label_set_text(s_title, ai ? "小铭同学" : "爸妈微聊");
    lv_label_set_text(s_subtitle, ai ? "语音对话开发中" : "点一次录音并自动发送");
    lv_label_set_text(s_action_label, ai ? "录音播放测试" : "录制3秒并发送");
    lv_obj_center(s_action_label);
    lv_obj_set_style_bg_color(s_ai_tab, lv_color_hex(ai ? 0xf1a34b : 0x37445a), 0);
    lv_obj_set_style_bg_color(s_chat_tab, lv_color_hex(ai ? 0x37445a : 0xf1a34b), 0);
}

static void tab_event(lv_event_t *e) {
    s_page = (pet_page_t)(intptr_t)lv_event_get_user_data(e);
    render_page();
    ESP_LOGI(TAG, "Page: %s", s_page == PET_PAGE_AI_CHAT ? "AI" : "chat");
}
static void network_timer(lv_timer_t *timer) {
    (void)timer;
    lv_label_set_text(s_network, wifi_manager_is_connected() ? "Wi-Fi 已连接" : "Wi-Fi 未连接");
}
static void audio_test_event(lv_event_t *e) {
    (void)e;
    ESP_LOGI(TAG, "Action pressed on page %s", s_page == PET_PAGE_WECHAT ? "chat" : "AI");
    if (s_page == PET_PAGE_WECHAT) {
        if (!device_pairing_is_paired()) { lv_label_set_text(s_subtitle, "请先绑定设备"); return; }
        if (audio_engine_start_voice_message()) lv_label_set_text(s_subtitle, "准备录音");
        else lv_label_set_text(s_subtitle, wifi_manager_is_connected() ? "音频忙或不可用" : "Wi-Fi 未连接");
    } else if (audio_engine_start_self_test()) lv_label_set_text(s_subtitle, "录音3秒后播放");
    else lv_label_set_text(s_subtitle, "音频忙或不可用");
}
static void touch_poll_task(void *arg) {
    while (1) { esp_lv_adapter_touch_notify_interrupt(arg); vTaskDelay(pdMS_TO_TICKS(30)); }
}
static lv_obj_t *make_button(lv_obj_t *parent, const char *text, lv_event_cb_t cb, void *user) {
    lv_obj_t *button = lv_button_create(parent);
    lv_obj_set_size(button, 155, 48);
    lv_obj_set_style_radius(button, 24, 0);
    lv_obj_add_event_cb(button, cb, LV_EVENT_PRESSED, user);
    lv_obj_t *label = lv_label_create(button);
    lv_obj_set_style_text_font(label, &pet_font, 0);
    lv_label_set_text(label, text);
    lv_obj_center(label);
    return button;
}
void ui_state_init(void) {
    if (!bsp_display_start()) { ESP_LOGE(TAG, "Display initialization failed"); return; }
    bsp_display_lock(-1);
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x17283b), 0);
    lv_obj_set_style_text_font(screen, &pet_font, 0);
    lv_obj_set_style_text_color(screen, lv_color_hex(0xffffff), 0);
    s_network = lv_label_create(screen); lv_obj_set_style_text_font(s_network, &pet_font, 0); lv_obj_align(s_network, LV_ALIGN_TOP_MID, 0, 24);
    lv_obj_t *face = lv_obj_create(screen);
    lv_obj_set_size(face, 180, 180); lv_obj_set_style_radius(face, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(face, lv_color_hex(0xffc873), 0); lv_obj_set_style_border_width(face, 0, 0);
    lv_obj_align(face, LV_ALIGN_TOP_MID, 0, 70);
    lv_obj_t *eyes = lv_label_create(face); lv_label_set_text(eyes, "  ^     ^  \n\n     w");
    lv_obj_set_style_text_color(eyes, lv_color_hex(0x493229), 0); lv_obj_center(eyes);
    s_title = lv_label_create(screen); lv_obj_set_style_text_font(s_title, &pet_font, 0); lv_obj_align(s_title, LV_ALIGN_TOP_MID, 0, 264);
    s_subtitle = lv_label_create(screen); lv_obj_set_style_text_font(s_subtitle, &pet_font, 0); lv_obj_align(s_subtitle, LV_ALIGN_TOP_MID, 0, 294);
    lv_obj_t *test = make_button(screen, "录音播放测试", audio_test_event, NULL);
    s_action_label = lv_obj_get_child(test, 0);
    lv_obj_set_width(test, 235); lv_obj_align(test, LV_ALIGN_TOP_MID, 0, 328);
    s_ai_tab = make_button(screen, "小铭同学", tab_event, (void *)(intptr_t)PET_PAGE_AI_CHAT);
    s_chat_tab = make_button(screen, "爸妈微聊", tab_event, (void *)(intptr_t)PET_PAGE_WECHAT);
    lv_obj_align(s_ai_tab, LV_ALIGN_BOTTOM_MID, -90, -25); lv_obj_align(s_chat_tab, LV_ALIGN_BOTTOM_MID, 90, -25);
    render_page(); network_timer(NULL); lv_timer_create(network_timer, 2000, NULL);
    s_pairing_panel = lv_obj_create(screen);
    lv_obj_set_size(s_pairing_panel, 440, 300);
    lv_obj_center(s_pairing_panel);
    lv_obj_set_style_bg_color(s_pairing_panel, lv_color_hex(0x24394f), 0);
    lv_obj_set_style_text_color(s_pairing_panel, lv_color_hex(0xffffff), 0);
    lv_obj_t *pair_title = lv_label_create(s_pairing_panel);
    lv_obj_set_style_text_font(pair_title, &pet_font, 0);
    lv_label_set_text(pair_title, "绑定小铭同学"); lv_obj_align(pair_title, LV_ALIGN_TOP_MID, 0, 15);
    s_pairing_code = lv_label_create(s_pairing_panel);
    lv_obj_set_style_text_font(s_pairing_code, &lv_font_montserrat_24, 0);
    lv_label_set_text(s_pairing_code, "--------"); lv_obj_center(s_pairing_code);
    s_pairing_status = lv_label_create(s_pairing_panel);
    lv_obj_set_style_text_font(s_pairing_status, &pet_font, 0);
    lv_obj_set_width(s_pairing_status, 390);
    lv_obj_set_style_text_align(s_pairing_status, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(s_pairing_status, "联网后获取绑定码\n家长端家庭设备中输入\n绑定码10分钟内有效");
    lv_obj_align(s_pairing_status, LV_ALIGN_BOTTOM_MID, 0, -10);
    if (device_pairing_is_paired()) lv_obj_add_flag(s_pairing_panel, LV_OBJ_FLAG_HIDDEN);
    bsp_display_unlock();
    xTaskCreate(touch_poll_task, "touch_poll", 2048, bsp_display_get_input_dev(), 4, NULL);
    ESP_LOGI(TAG, "Pet interface initialized");
}
void ui_switch_page(pet_page_t page) { if (s_title && esp_lv_adapter_lock(1000) == ESP_OK) { s_page = page; render_page(); esp_lv_adapter_unlock(); } }
void ui_set_voice_status(const char *status) {
    ESP_LOGI(TAG, "Voice status: %s", status);
    if (s_subtitle && esp_lv_adapter_lock(1000) == ESP_OK) {
        if (s_page == PET_PAGE_WECHAT) {
            lv_label_set_text(s_subtitle, status);
            lv_label_set_text(s_action_label, status);
            lv_obj_center(s_action_label);
        }
        esp_lv_adapter_unlock();
    }
}
void ui_set_pairing_status(const char *code, const char *status) {
    if (!s_pairing_panel || esp_lv_adapter_lock(1000) != ESP_OK) return;
    if (device_pairing_is_paired()) lv_obj_add_flag(s_pairing_panel, LV_OBJ_FLAG_HIDDEN);
    else {
        lv_obj_remove_flag(s_pairing_panel, LV_OBJ_FLAG_HIDDEN);
        if (code) { lv_label_set_text(s_pairing_code, code); lv_obj_center(s_pairing_code); }
        lv_label_set_text(s_pairing_status, status);
    }
    esp_lv_adapter_unlock();
}
void ui_on_touch_press_start(void) { }
void ui_on_touch_press_end(void) { }
void ui_on_side_boot_key_hold_start(void) { }
void ui_on_side_boot_key_hold_end(void) { }
void ui_trigger_alarm_modal(const char *id, const char *title, const char *path) {
    (void)title; (void)path; s_alarm_active = true; snprintf(s_alarm_id, sizeof(s_alarm_id), "%s", id ? id : "");
    ESP_LOGW(TAG, "Alarm playback not implemented; no acknowledgement sent");
}
void ui_ack_alarm_modal(void) { if (s_alarm_active) ESP_LOGW(TAG, "Alarm acknowledgement unavailable"); }
