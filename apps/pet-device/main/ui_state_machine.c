#include "ui_state_machine.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "bsp/esp-bsp.h"
#include "esp_lv_adapter_input.h"
#include "esp_lv_adapter.h"
#include "lvgl.h"
#include "driver/i2c_master.h"
#include "wifi_manager.h"
#include "audio_engine.h"
#include "pet_display.h"
#include "device_sync.h"
#include "device_pairing.h"
#include "rtc_scheduler.h"
#include "chat_client.h"
LV_FONT_DECLARE(pet_font);

static const char *TAG = "ui_state";
static pet_page_t s_page = PET_PAGE_AI_CHAT;
static lv_obj_t *s_title, *s_subtitle, *s_ai_tab, *s_chat_tab, *s_network, *s_action_label;
static bool s_alarm_active;
static lv_obj_t *s_retry, *s_listen, *s_alarm_panel;
static portMUX_TYPE s_status_lock = portMUX_INITIALIZER_UNLOCKED;
static char s_status[128];
static bool s_status_dirty;
static bool s_touch_started;
static audio_target_t s_touch_target;
static char s_alarm_id[48];
static lv_obj_t *s_pairing_panel, *s_pairing_code, *s_pairing_status;

static lv_obj_t *s_settings, *s_wifi_list, *s_wifi_status, *s_password, *s_keyboard, *s_volume;
static wifi_ap_record_t s_aps[12];
static uint16_t s_ap_count;
static bool s_wifi_working;
static i2c_master_dev_handle_t s_pmu;
static atomic_int s_battery = -1;
static unsigned s_battery_ticks;
static void battery_init(void) {
    i2c_device_config_t cfg = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x34, .scl_speed_hz = 100000 };
    if (i2c_master_bus_add_device(bsp_i2c_get_handle(), &cfg, &s_pmu) != ESP_OK) s_pmu = NULL;
}
static void battery_update(void) {
    uint8_t reg = 0xa4, value;
    if (s_pmu && i2c_master_transmit_receive(s_pmu, &reg, 1, &value, 1, 20) == ESP_OK && value <= 100) atomic_store(&s_battery, value);
    else atomic_store(&s_battery, -1);
}

static void render_page(void) {
    bool ai = s_page == PET_PAGE_AI_CHAT;
    lv_label_set_text(s_title, ai ? "小铭同学" : "爸妈微聊");
    lv_label_set_text(s_subtitle, ai ? "BOOT 按住提问松开发送" : "IO18 按住说话松开发送");
    lv_label_set_text(s_action_label, ai ? "按住问 AI" : "按住发给家长");
    lv_obj_center(s_action_label);
    lv_obj_set_style_bg_color(s_ai_tab, lv_color_hex(ai ? 0xf1a34b : 0x37445a), 0);
    lv_obj_set_style_bg_color(s_chat_tab, lv_color_hex(ai ? 0x37445a : 0xf1a34b), 0);
}

static void tab_event(lv_event_t *e) {
    if (s_touch_started) { audio_engine_end_hold(s_touch_target); s_touch_started = false; }
    s_page = (pet_page_t)(intptr_t)lv_event_get_user_data(e);
    render_page();
    ESP_LOGI(TAG, "Page: %s", s_page == PET_PAGE_AI_CHAT ? "AI" : "chat");
}
static void network_timer(lv_timer_t *timer) {
    (void)timer;
    if (++s_battery_ticks >= 50) { battery_update(); s_battery_ticks = 0; }
    char bar[96], battery[12];
    int battery_percent = atomic_load(&s_battery);
    if (battery_percent >= 0) snprintf(battery, sizeof(battery), "%d%%", battery_percent);
    else snprintf(battery, sizeof(battery), "--");
    snprintf(bar, sizeof(bar), "Wi-Fi %s   %s   BAT %s", wifi_manager_is_connected() ? "OK" : "--", chat_client_has_unread_message() ? "MSG" : "--", battery);
    lv_label_set_text(s_network, bar);
    if (s_volume) lv_label_set_text_fmt(s_volume, "Volume %d%%", audio_engine_get_volume());
    lv_obj_set_hidden(s_retry, !audio_engine_can_retry());
    lv_obj_set_hidden(s_listen, !chat_client_has_unread_message());
    char status[128]; bool dirty;
    portENTER_CRITICAL(&s_status_lock); dirty = s_status_dirty; s_status_dirty = false; memcpy(status, s_status, sizeof(status)); portEXIT_CRITICAL(&s_status_lock);
    if (dirty) lv_label_set_text(s_subtitle, status);
}
static void hold_event(lv_event_t *e) {
    lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_PRESSED) {
        if (s_alarm_active) return;
        s_touch_target = s_page == PET_PAGE_AI_CHAT ? AUDIO_TARGET_AI : AUDIO_TARGET_PARENT;
        s_touch_started = audio_engine_start_hold(s_touch_target);
        if (!s_touch_started) ui_set_voice_status("音频忙或请先绑定");
    } else if ((code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) && s_touch_started) {
        audio_engine_end_hold(s_touch_target); s_touch_started = false;
    }
}
static void retry_event(lv_event_t *e) {
    (void)e;
    if (!audio_engine_retry_last()) ui_set_voice_status("音频忙或请先绑定");
}
static void listen_task(void *arg) {
    esp_err_t err = chat_client_play_next_unread();
    ui_set_voice_status(err == ESP_OK ? "播放结束" : "播放失败请重试");
    vTaskDelete(NULL);
}
static void listen_event(lv_event_t *e) {
    (void)e;
    if (xTaskCreate(listen_task, "parent_play", 6144, NULL, 4, NULL) != pdPASS) ui_set_voice_status("内存不足");
}
static void alarm_event(lv_event_t *e) { (void)e; rtc_scheduler_ack_active(); }
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
static void settings_close(lv_event_t *e) { (void)e; lv_obj_set_hidden(s_settings, true); }
static void settings_open(lv_event_t *e) { (void)e; lv_obj_set_hidden(s_settings, false); lv_obj_move_foreground(s_settings); }
static void keyboard_event(lv_event_t *e) {
    lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_READY || code == LV_EVENT_CANCEL) { lv_obj_set_hidden(s_keyboard, true); lv_obj_align(s_password, LV_ALIGN_TOP_LEFT, 5, 240); }
}
static void password_event(lv_event_t *e) { (void)e; lv_obj_align(s_password, LV_ALIGN_TOP_LEFT, 5, 50); lv_obj_move_foreground(s_password); lv_obj_set_hidden(s_keyboard, false); lv_obj_move_foreground(s_keyboard); }
static void scan_task(void *arg) {
    (void)arg; uint16_t count = 12; wifi_ap_record_t records[12];
    esp_err_t err = wifi_manager_scan(records, &count);
    if (esp_lv_adapter_lock(-1) == ESP_OK) {
        s_ap_count = 0; char options[512] = {0}; size_t used = 0;
        if (err == ESP_OK) for (int i = 0; i < count; i++) {
            // Newline separates dropdown options; skip SSIDs that cannot be represented faithfully.
            if (!records[i].ssid[0] || memchr(records[i].ssid, '\n', strnlen((char *)records[i].ssid, 32))) continue;
            int n = snprintf(options + used, sizeof(options) - used, "%s%.*s", used ? "\n" : "", 32, records[i].ssid);
            if (n < 0 || (size_t)n >= sizeof(options) - used) break;
            s_aps[s_ap_count++] = records[i]; used += n;
        }
        lv_dropdown_set_options(s_wifi_list, used ? options : "--");
        lv_label_set_text(s_wifi_status, err != ESP_OK ? "Scan failed; retry" : s_ap_count ? "Select Wi-Fi" : "No Wi-Fi found");
        s_wifi_working = false; esp_lv_adapter_unlock();
    }
    vTaskDelete(NULL);
}
static void scan_event(lv_event_t *e) {
    (void)e; if (s_wifi_working) return; s_wifi_working = true;
    lv_label_set_text(s_wifi_status, "Scanning...");
    if (xTaskCreate(scan_task, "wifi_scan", 6144, NULL, 4, NULL) != pdPASS) { s_wifi_working = false; lv_label_set_text(s_wifi_status, "Scan failed; retry"); }
}
typedef struct { char ssid[33]; char password[64]; } wifi_job_t;
static void connect_task(void *arg) {
    wifi_job_t *job = arg; esp_err_t err = wifi_manager_connect(job->ssid, job->password);
    memset(job, 0, sizeof(*job)); free(job);
    if (esp_lv_adapter_lock(-1) == ESP_OK) {
        lv_label_set_text(s_wifi_status, err == ESP_OK ? "Connected" : "Connection failed; retry");
        s_wifi_working = false; esp_lv_adapter_unlock();
    }
    vTaskDelete(NULL);
}
static void connect_event(lv_event_t *e) {
    (void)e; unsigned index = lv_dropdown_get_selected(s_wifi_list);
    if (s_wifi_working || index >= s_ap_count) return;
    wifi_job_t *job = calloc(1, sizeof(*job)); if (!job) return;
    memcpy(job->ssid, s_aps[index].ssid, 32);
    snprintf(job->password, sizeof(job->password), "%s", lv_textarea_get_text(s_password));
    lv_textarea_set_text(s_password, ""); lv_obj_set_hidden(s_keyboard, true); lv_obj_align(s_password, LV_ALIGN_TOP_LEFT, 5, 240);
    s_wifi_working = true; lv_label_set_text(s_wifi_status, "Connecting...");
    if (xTaskCreate(connect_task, "wifi_connect", 6144, job, 4, NULL) != pdPASS) {
        memset(job, 0, sizeof(*job)); free(job); s_wifi_working = false; lv_label_set_text(s_wifi_status, "Connection failed; retry");
    }
}
static void settings_init(lv_obj_t *screen) {
    lv_obj_t *open = make_button(screen, "SET", settings_open, NULL);
    lv_obj_set_size(open, 72, 42); lv_obj_align(open, LV_ALIGN_TOP_RIGHT, -8, 5);
    s_settings = lv_obj_create(screen); lv_obj_set_size(s_settings, 480, 480); lv_obj_center(s_settings);
    lv_obj_set_style_bg_color(s_settings, lv_color_hex(0x24394f), 0);
    lv_obj_set_style_text_color(s_settings, lv_color_hex(0xffffff), 0);
    lv_obj_set_scrollable(s_settings, false);
    lv_obj_t *title = lv_label_create(s_settings); lv_label_set_text(title, "Settings"); lv_obj_align(title, LV_ALIGN_TOP_LEFT, 5, 2);
    lv_obj_t *close = make_button(s_settings, "X", settings_close, NULL); lv_obj_set_size(close, 52, 42); lv_obj_align(close, LV_ALIGN_TOP_RIGHT, 0, 0);
    s_volume = lv_label_create(s_settings); lv_obj_align(s_volume, LV_ALIGN_TOP_LEFT, 5, 55);
    lv_obj_t *scan = make_button(s_settings, "Scan Wi-Fi", scan_event, NULL); lv_obj_set_size(scan, 180, 43); lv_obj_align(scan, LV_ALIGN_TOP_LEFT, 5, 92);
    s_wifi_status = lv_label_create(s_settings); lv_label_set_text(s_wifi_status, "Scan Wi-Fi"); lv_obj_align(s_wifi_status, LV_ALIGN_TOP_LEFT, 5, 145);
    s_wifi_list = lv_dropdown_create(s_settings); lv_obj_set_width(s_wifi_list, 300); lv_dropdown_set_options(s_wifi_list, "--"); lv_obj_align(s_wifi_list, LV_ALIGN_TOP_LEFT, 5, 180);
    s_password = lv_textarea_create(s_settings); lv_obj_set_size(s_password, 300, 48); lv_textarea_set_one_line(s_password, true);
    lv_textarea_set_password_mode(s_password, true); lv_textarea_set_max_length(s_password, 63); lv_textarea_set_placeholder_text(s_password, "Wi-Fi password");
    lv_obj_align(s_password, LV_ALIGN_TOP_LEFT, 5, 240); lv_obj_add_event_cb(s_password, password_event, LV_EVENT_CLICKED, NULL);
    lv_obj_t *connect = make_button(s_settings, "Connect", connect_event, NULL); lv_obj_align(connect, LV_ALIGN_TOP_LEFT, 5, 310);
    s_keyboard = lv_keyboard_create(s_settings); lv_keyboard_set_textarea(s_keyboard, s_password); lv_obj_set_style_text_font(s_keyboard, &lv_font_montserrat_14, 0); lv_obj_set_size(s_keyboard, 448, 210);
    lv_obj_align(s_keyboard, LV_ALIGN_BOTTOM_MID, 0, 0); lv_obj_add_event_cb(s_keyboard, keyboard_event, LV_EVENT_ALL, NULL); lv_obj_set_hidden(s_keyboard, true);
    lv_obj_set_hidden(s_settings, true);
}

void ui_state_init(void) {
    if (!pet_display_start()) { ESP_LOGE(TAG, "Display initialization failed"); return; }
    if (esp_lv_adapter_lock(-1) != ESP_OK) return;
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x17283b), 0);
    lv_obj_set_style_text_font(screen, &pet_font, 0);
    lv_obj_set_style_text_color(screen, lv_color_hex(0xffffff), 0);
    s_network = lv_label_create(screen); lv_obj_set_style_text_font(s_network, &pet_font, 0); lv_obj_align(s_network, LV_ALIGN_TOP_LEFT, 8, 15);
    lv_obj_t *face = lv_obj_create(screen);
    lv_obj_set_size(face, 140, 140); lv_obj_set_style_radius(face, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(face, lv_color_hex(0xffc873), 0); lv_obj_set_style_border_width(face, 0, 0);
    lv_obj_align(face, LV_ALIGN_TOP_MID, 0, 65);
    lv_obj_t *eyes = lv_label_create(face); lv_label_set_text(eyes, "  ^     ^  \n\n     w");
    lv_obj_set_style_text_color(eyes, lv_color_hex(0x493229), 0); lv_obj_center(eyes);
    s_title = lv_label_create(screen); lv_obj_set_style_text_font(s_title, &pet_font, 0); lv_obj_align(s_title, LV_ALIGN_TOP_MID, 0, 220);
    s_subtitle = lv_label_create(screen); lv_obj_set_style_text_font(s_subtitle, &pet_font, 0); lv_obj_align(s_subtitle, LV_ALIGN_TOP_MID, 0, 255);
    lv_obj_set_width(s_subtitle, 440); lv_obj_set_style_text_align(s_subtitle, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_t *test = make_button(screen, "按住问 AI", hold_event, NULL);
    lv_obj_remove_event_cb(test, hold_event); lv_obj_add_event_cb(test, hold_event, LV_EVENT_ALL, NULL);
    s_action_label = lv_obj_get_child(test, 0);
    lv_obj_set_width(test, 235); lv_obj_align(test, LV_ALIGN_TOP_MID, 0, 300);
    s_ai_tab = make_button(screen, "小铭同学", tab_event, (void *)(intptr_t)PET_PAGE_AI_CHAT);
    s_chat_tab = make_button(screen, "爸妈微聊", tab_event, (void *)(intptr_t)PET_PAGE_WECHAT);
    lv_obj_align(s_ai_tab, LV_ALIGN_BOTTOM_MID, -90, -25); lv_obj_align(s_chat_tab, LV_ALIGN_BOTTOM_MID, 90, -25);
    s_retry = make_button(screen, "重新发送", retry_event, NULL); lv_obj_align(s_retry, LV_ALIGN_TOP_MID, -85, 358);
    s_listen = make_button(screen, "收听家长语音", listen_event, NULL); lv_obj_set_width(s_listen, 180); lv_obj_align(s_listen, LV_ALIGN_TOP_MID, 92, 358);
    render_page(); network_timer(NULL); lv_timer_create(network_timer, 200, NULL);
    s_alarm_panel = lv_obj_create(screen); lv_obj_set_size(s_alarm_panel, 420, 300); lv_obj_center(s_alarm_panel);
    lv_obj_set_style_bg_color(s_alarm_panel, lv_color_hex(0x24394f), 0);
    lv_obj_t *alarm_title = lv_label_create(s_alarm_panel); lv_obj_set_style_text_font(alarm_title, &pet_font, 0);
    lv_label_set_text(alarm_title, "定时语音提醒"); lv_obj_align(alarm_title, LV_ALIGN_TOP_MID, 0, 45);
    lv_obj_t *ack = make_button(s_alarm_panel, "知道了", alarm_event, NULL); lv_obj_align(ack, LV_ALIGN_BOTTOM_MID, 0, -25);
    lv_obj_set_hidden(s_alarm_panel, true);
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
    if (device_pairing_is_paired()) lv_obj_set_hidden(s_pairing_panel, true);
    battery_init(); battery_update(); settings_init(screen); network_timer(NULL);
    esp_lv_adapter_unlock();
    xTaskCreate(touch_poll_task, "touch_poll", 2048, pet_display_input(), 4, NULL);
    ESP_LOGI(TAG, "Pet interface initialized");
}
void ui_switch_page(pet_page_t page) { if (s_title && esp_lv_adapter_lock(1000) == ESP_OK) { s_page = page; render_page(); esp_lv_adapter_unlock(); } }
void ui_set_voice_status(const char *status) {
    ESP_LOGI(TAG, "Voice status: %s", status);
    portENTER_CRITICAL(&s_status_lock); snprintf(s_status, sizeof(s_status), "%s", status); s_status_dirty = true; portEXIT_CRITICAL(&s_status_lock);
}
void ui_set_pairing_status(const char *code, const char *status) {
    if (!s_pairing_panel || esp_lv_adapter_lock(1000) != ESP_OK) return;
    if (device_pairing_is_paired()) lv_obj_set_hidden(s_pairing_panel, true);
    else {
        lv_obj_set_hidden(s_pairing_panel, false);
        if (code) { lv_label_set_text(s_pairing_code, code); lv_obj_center(s_pairing_code); }
        lv_label_set_text(s_pairing_status, status);
    }
    esp_lv_adapter_unlock();
}
void ui_on_touch_press_start(void) { s_touch_target = s_page == PET_PAGE_AI_CHAT ? AUDIO_TARGET_AI : AUDIO_TARGET_PARENT; s_touch_started = audio_engine_start_hold(s_touch_target); }
void ui_on_touch_press_end(void) { if (s_touch_started) audio_engine_end_hold(s_touch_target); s_touch_started = false; }
void ui_on_side_boot_key_hold_start(void) { audio_engine_start_hold(AUDIO_TARGET_AI); }
void ui_on_side_boot_key_hold_end(void) { audio_engine_end_hold(AUDIO_TARGET_AI); }
void ui_trigger_alarm_modal(const char *id, const char *title, const char *path) {
    (void)title; (void)path;
    if (!s_alarm_panel || esp_lv_adapter_lock(1000) != ESP_OK) return;
    s_alarm_active = true; snprintf(s_alarm_id, sizeof(s_alarm_id), "%s", id);
    lv_obj_set_hidden(s_alarm_panel, false); lv_obj_move_foreground(s_alarm_panel);
    esp_lv_adapter_unlock();
}
void ui_hide_alarm_modal(void) {
    if (!s_alarm_panel || esp_lv_adapter_lock(1000) != ESP_OK) return;
    s_alarm_active = false; lv_obj_set_hidden(s_alarm_panel, true); esp_lv_adapter_unlock();
}
void ui_ack_alarm_modal(void) { rtc_scheduler_ack_active(); }

int ui_get_battery_percent(void) { return atomic_load(&s_battery); }
