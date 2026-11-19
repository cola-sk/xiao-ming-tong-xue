#include "ui_state_machine.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <string.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
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
#include "btn_font_30.h"

LV_FONT_DECLARE(pet_font);

static const char *TAG = "ui_state";

// Sunny & fresh palette
#define COL_BG          0xF6FBF7
#define COL_CARD        0xFFFFFF
#define COL_BORDER      0xDCEBE1
#define COL_INK         0x1E2E2B
#define COL_MUTED       0x627873
#define COL_AI          0x1E82D0
#define COL_AI_DARK     0x1567A8
#define COL_AI_TINT     0xEAF6FF
#define COL_AI_BORDER   0xBAE6FD
#define COL_GREEN       0x1E9E68
#define COL_GREEN_DARK  0x157B50
#define COL_GREEN_TINT  0xECFDF5
#define COL_CHILD_BG    0xD1FAE5
#define COL_CHILD_BD    0x6EE7B7
#define COL_AMBER       0xF59E0B
#define COL_AMBER_BG    0xFFF8E7
#define COL_AMBER_BD    0xF8D88B
#define COL_AMBER_PILL  0xFDE68A
#define COL_AMBER_INK   0x92400E
#define COL_ALARM       0xF97316
#define COL_ALARM_BG    0xFFF7ED
#define COL_ALARM_RING  0xFFEDD5
#define COL_RED         0xEF4444
#define COL_RED_TINT    0xFEF2F2
#define COL_RED_INK     0xDC2626

static pet_page_t s_page = PET_PAGE_HOME;
static bool s_alarm_active;
static char s_alarm_id[48];
static bool s_touch_started;
static audio_target_t s_touch_target;

// Voice status shared with worker tasks
static portMUX_TYPE s_status_lock = portMUX_INITIALIZER_UNLOCKED;
static char s_status_buf[128];
static bool s_status_dirty;
static char s_active_status[128];
static int64_t s_status_expire_ms;
static bool s_voice_animating;
static ai_pet_state_t s_ai_state = AI_STATE_IDLE;

// Top-level views
static lv_obj_t *s_home_view, *s_ai_view, *s_sched_view, *s_chat_view;

// Home screen widgets
static lv_obj_t *s_home_net, *s_clock_label, *s_date_label;
static lv_obj_t *s_home_sched_card, *s_home_sched_badge, *s_home_sched_next;
static lv_obj_t *s_home_status_bar, *s_home_status_label, *s_home_retry_btn;
static lv_obj_t *s_home_waves[5];
static lv_obj_t *s_btn_ai, *s_btn_parent, *s_parent_badge, *s_parent_badge_lbl;
static char s_cache_net[96], s_cache_clock[16], s_cache_date[48];
static int s_last_unread_badge = -1;

// AI Chat sub-page widgets
static lv_obj_t *s_bot_halo, *s_bot_face;
static lv_obj_t *s_bot_eye_l, *s_bot_eye_r, *s_bot_glint_l, *s_bot_glint_r;
static lv_obj_t *s_bot_waves[5];
static lv_obj_t *s_ai_status_label, *s_ai_retry_btn, *s_ai_hold_btn;
static ai_pet_state_t s_bot_rendered_state = (ai_pet_state_t)-1;
static bool s_bot_was_blink;

// Schedule sub-page widgets
static lv_obj_t *s_sched_count_label, *s_sched_list;
static uint32_t s_rendered_sched_ver;
static int s_rendered_sched_min = -1;

// Parent chat & history sub-page widgets
static lv_obj_t *s_chat_list, *s_chat_status_label, *s_chat_retry_btn, *s_chat_hold_btn;
static uint32_t s_rendered_chat_ver;
static char s_bubble_ids[CHAT_HISTORY_MAX][48];

// Alarm overlay widgets
static lv_obj_t *s_alarm_panel, *s_alarm_ring, *s_alarm_bell_bg, *s_alarm_time, *s_alarm_title, *s_alarm_sub;

// Incoming parent message popup widgets
static lv_obj_t *s_msg_popup, *s_msg_icon_ring, *s_msg_icon_bg;
static lv_obj_t *s_msg_popup_title, *s_msg_popup_sub, *s_msg_play_btn, *s_msg_play_label;
static char s_popup_msg_id[48];
static char s_dismissed_msg_id[48];
static bool s_popup_visible;
static chat_play_phase_t s_popup_last_phase = CHAT_PLAY_IDLE;

// Pairing & Settings overlays
static lv_obj_t *s_pairing_panel, *s_pairing_code, *s_pairing_status;
static lv_obj_t *s_settings, *s_wifi_list, *s_wifi_status, *s_password, *s_keyboard, *s_volume;
static wifi_ap_record_t s_aps[12];
static uint16_t s_ap_count;
static bool s_wifi_working;

// Hardware battery PMU
static i2c_master_dev_handle_t s_pmu;
static atomic_int s_battery = -1;
static unsigned s_battery_ticks;
static unsigned s_anim_phase;

static const char *const WEEKDAY_ZH[7] = { "周日", "周一", "周二", "周三", "周四", "周五", "周六" };

static void battery_init(void) {
    i2c_device_config_t cfg = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x34, .scl_speed_hz = 100000 };
    if (i2c_master_bus_add_device(bsp_i2c_get_handle(), &cfg, &s_pmu) != ESP_OK) s_pmu = NULL;
}

static void battery_update(void) {
    uint8_t reg = 0xa4, value;
    if (s_pmu && i2c_master_transmit_receive(s_pmu, &reg, 1, &value, 1, 20) == ESP_OK && value <= 100) atomic_store(&s_battery, value);
    else atomic_store(&s_battery, -1);
}

static lv_obj_t *make_panel(lv_obj_t *parent, int32_t w, int32_t h, int32_t radius,
                            uint32_t bg_hex, uint32_t border_hex, int32_t border_w) {
    lv_obj_t *obj = lv_obj_create(parent);
    lv_obj_set_size(obj, w, h);
    lv_obj_set_style_radius(obj, radius, 0);
    lv_obj_set_style_bg_color(obj, lv_color_hex(bg_hex), 0);
    lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(obj, lv_color_hex(border_hex), 0);
    lv_obj_set_style_border_width(obj, border_w, 0);
    lv_obj_set_style_shadow_width(obj, 0, 0);
    lv_obj_set_style_pad_all(obj, 0, 0);
    lv_obj_set_scrollable(obj, false);
    lv_obj_set_clickable(obj, false);
    return obj;
}

static lv_obj_t *make_pill_btn(lv_obj_t *parent, int32_t w, int32_t h, int32_t radius,
                               uint32_t bg_hex, uint32_t fg_hex, const char *text,
                               lv_event_code_t ev_code, lv_event_cb_t cb, void *user) {
    lv_obj_t *btn = lv_button_create(parent);
    lv_obj_set_size(btn, w, h);
    lv_obj_set_style_radius(btn, radius, 0);
    lv_obj_set_style_bg_color(btn, lv_color_hex(bg_hex), 0);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(btn, 0, 0);
    lv_obj_set_style_shadow_width(btn, 0, 0);
    lv_obj_set_style_pad_all(btn, 0, 0);
    lv_obj_set_scrollable(btn, false);
    if (cb) lv_obj_add_event_cb(btn, cb, ev_code, user);
    if (text) {
        lv_obj_t *lbl = lv_label_create(btn);
        lv_obj_set_style_text_font(lbl, &pet_font, 0);
        lv_obj_set_style_text_color(lbl, lv_color_hex(fg_hex), 0);
        lv_label_set_text(lbl, text);
        lv_obj_center(lbl);
    }
    return btn;
}

static lv_obj_t *make_label(lv_obj_t *parent, const char *text, const lv_font_t *font, uint32_t hex) {
    lv_obj_t *lbl = lv_label_create(parent);
    lv_obj_set_style_text_font(lbl, font, 0);
    lv_obj_set_style_text_color(lbl, lv_color_hex(hex), 0);
    lv_label_set_text(lbl, text);
    return lbl;
}

static void set_label_if_changed(lv_obj_t *lbl, char *cache, size_t cap, const char *val) {
    if (!lbl || strcmp(cache, val) == 0) return;
    snprintf(cache, cap, "%s", val);
    lv_label_set_text(lbl, cache);
}

static bool is_placeholder_text(const char *text) {
    if (!text || !*text) return true;
    return strncmp(text, "（", 3) == 0 || text[0] == '(';
}

static void apply_hold_visual(audio_target_t target, bool holding) {
    if (target == AUDIO_TARGET_AI && s_ai_hold_btn) {
        lv_obj_set_style_bg_color(s_ai_hold_btn, lv_color_hex(holding ? COL_AI_DARK : COL_AI), 0);
        lv_obj_set_style_border_width(s_ai_hold_btn, holding ? 3 : 0, 0);
        lv_obj_set_style_border_color(s_ai_hold_btn, lv_color_hex(0xFFFFFF), 0);
    } else if (target == AUDIO_TARGET_PARENT && s_chat_hold_btn) {
        lv_obj_set_style_bg_color(s_chat_hold_btn, lv_color_hex(holding ? COL_GREEN_DARK : COL_GREEN), 0);
        lv_obj_set_style_border_width(s_chat_hold_btn, holding ? 3 : 0, 0);
        lv_obj_set_style_border_color(s_chat_hold_btn, lv_color_hex(0xFFFFFF), 0);
    }
}

static void refresh_schedules_ui(bool force) {
    time_t now = time(NULL);
    int cur_min = -1;
    if (now > 1700000000) {
        struct tm t;
        localtime_r(&now, &t);
        cur_min = t.tm_hour * 60 + t.tm_min;
    }
    uint32_t ver = rtc_scheduler_get_version();
    if (!force && ver == s_rendered_sched_ver && cur_min == s_rendered_sched_min) return;
    s_rendered_sched_ver = ver;
    s_rendered_sched_min = cur_min;

    pet_today_schedule_t *items = calloc(MAX_SCHEDULES, sizeof(pet_today_schedule_t));
    if (!items) return;
    bool clock_valid = false;
    int count = rtc_scheduler_get_today_schedules(items, MAX_SCHEDULES, &clock_valid);

    // Find next pending/ringing item (items are sorted by time ascending)
    int next_idx = -1;
    for (int i = 0; i < count; i++) {
        if (items[i].status == SCHEDULE_STATUS_RINGING) { next_idx = i; break; }
        if (items[i].status == SCHEDULE_STATUS_PENDING) {
            int im = (int)items[i].hour * 60 + items[i].minute;
            if (cur_min < 0 || im >= cur_min) {
                next_idx = i;
                break;
            }
        }
    }

    // Update Home summary card
    char badge[24], summary[96];
    if (!clock_valid) {
        snprintf(badge, sizeof(badge), "-- ›");
        snprintf(summary, sizeof(summary), "等待联网校时...");
    } else {
        snprintf(badge, sizeof(badge), "%d项 ›", count);
        if (count == 0) {
            snprintf(summary, sizeof(summary), "今天没有定时播放任务");
        } else if (next_idx >= 0) {
            snprintf(summary, sizeof(summary), "%s %02u:%02u %s",
                     items[next_idx].status == SCHEDULE_STATUS_RINGING ? "正在播" : "下一条",
                     items[next_idx].hour, items[next_idx].minute, items[next_idx].title);
        } else {
            snprintf(summary, sizeof(summary), "今日定时已全部播完");
        }
    }
    lv_label_set_text(s_home_sched_badge, badge);
    lv_label_set_text(s_home_sched_next, summary);

    // Rebuild Today's Schedule sub-page list only when visible (or forced)
    if (!s_sched_list || (lv_obj_is_hidden(s_sched_view) && !force)) { free(items); return; }

    char cnt_str[24];
    snprintf(cnt_str, sizeof(cnt_str), clock_valid ? "共 %d 项" : "--", count);
    lv_label_set_text(s_sched_count_label, cnt_str);
    lv_obj_clean(s_sched_list);

    if (!clock_valid || count == 0) {
        lv_obj_t *empty = make_panel(s_sched_list, 436, 150, 20, COL_CARD, COL_BORDER, 2);
        lv_obj_t *lbl = make_label(empty, !clock_valid ? "等待联网校时后展示今日定时" : "今天没有定时播放任务",
                                   &pet_font, COL_MUTED);
        lv_obj_center(lbl);
        free(items);
        return;
    }

    for (int i = 0; i < count; i++) {
        const pet_today_schedule_t *it = &items[i];
        int im = (int)it->hour * 60 + it->minute;
        bool is_ringing = it->status == SCHEDULE_STATUS_RINGING;
        bool is_done = it->status == SCHEDULE_STATUS_DONE;
        bool is_past = !is_ringing && !is_done && cur_min >= 0 && im < cur_min;
        bool is_next = (i == next_idx);
        uint32_t bg = is_ringing ? COL_ALARM_BG : (is_next ? 0xFFFBEB : COL_CARD);
        uint32_t bd = is_ringing ? COL_ALARM : (is_next ? COL_AMBER : 0xEDE5CF);
        int32_t bw = (is_ringing || is_next) ? 2 : 1;

        lv_obj_t *row = make_panel(s_sched_list, 436, 76, 18, bg, bd, bw);
        char tbuf[8];
        snprintf(tbuf, sizeof(tbuf), "%02u:%02u", it->hour, it->minute);
        lv_obj_t *time_lbl = make_label(row, tbuf, &lv_font_montserrat_24,
                                        is_ringing ? COL_ALARM : ((is_done || is_past) ? 0x94A3B8 : COL_INK));
        lv_obj_align(time_lbl, LV_ALIGN_LEFT_MID, 16, 0);

        lv_obj_t *title_lbl = make_label(row, it->title[0] ? it->title : "定时语音", &pet_font,
                                         (is_done || is_past) ? COL_MUTED : COL_INK);
        lv_label_set_long_mode(title_lbl, LV_LABEL_LONG_MODE_DOTS);
        lv_obj_set_width(title_lbl, 224);
        lv_obj_align(title_lbl, LV_ALIGN_LEFT_MID, 102, 0);

        const char *st_text = is_ringing ? "播报中" : (is_done ? "已播" : (is_past ? "已过" : (is_next ? "下一条" : "待播")));
        uint32_t st_bg = is_ringing ? COL_ALARM : ((is_done || is_past) ? 0xE2E8F0 : (is_next ? 0xFEF3C7 : COL_GREEN_TINT));
        uint32_t st_fg = is_ringing ? 0xFFFFFF : ((is_done || is_past) ? 0x64748B : (is_next ? 0xB45309 : COL_GREEN_DARK));

        lv_obj_t *pill = make_panel(row, 82, 34, 17, st_bg, st_bg, 0);
        lv_obj_align(pill, LV_ALIGN_RIGHT_MID, -12, 0);
        lv_obj_t *st_lbl = make_label(pill, st_text, &pet_font, st_fg);
        lv_obj_center(st_lbl);
    }
    free(items);
}

typedef struct {
    char msg_id[48];
} play_arg_t;

static void play_msg_task(void *arg) {
    play_arg_t *pa = (play_arg_t *)arg;
    esp_err_t err = chat_client_play_message(pa->msg_id);
    free(pa);
    if (err == ESP_OK) ui_set_voice_status("播放结束");
    else if (err == ESP_ERR_NOT_FINISHED) ui_set_voice_status("已停止");
    else if (err == ESP_ERR_NOT_FOUND) ui_set_voice_status("历史音频已清理");
    else if (err == ESP_ERR_INVALID_STATE) ui_set_voice_status("音频忙请稍候");
    else ui_set_voice_status("播放失败请重试");
    vTaskDelete(NULL);
}

static void start_play_message(const char *msg_id) {
    if (!msg_id || !*msg_id) return;
    if (chat_client_is_playing()) {
        char playing_id[48] = {0};
        chat_client_get_playing_id(playing_id, sizeof(playing_id));
        if (strcmp(playing_id, msg_id) == 0) {
            audio_engine_stop_playback();
            return;
        }
        ui_set_voice_status("正在播放请稍候");
        return;
    }
    play_arg_t *pa = calloc(1, sizeof(*pa));
    if (!pa) { ui_set_voice_status("内存不足"); return; }
    snprintf(pa->msg_id, sizeof(pa->msg_id), "%s", msg_id);
    if (xTaskCreate(play_msg_task, "msg_play", 12288, pa, 4, NULL) != pdPASS) {
        free(pa);
        ui_set_voice_status("内存不足");
    }
}

static void bubble_click_event(lv_event_t *e) {
    const char *msg_id = (const char *)lv_event_get_user_data(e);
    start_play_message(msg_id);
}

static void retry_msg_task(void *arg) {
    play_arg_t *pa = (play_arg_t *)arg;
    esp_err_t err = chat_client_retry_outgoing(pa->msg_id);
    free(pa);
    if (err == ESP_OK) ui_set_voice_status("发送成功");
    else if (err == ESP_ERR_INVALID_STATE) ui_set_voice_status("音频忙请稍候");
    else ui_set_voice_status("发送失败可点击重试");
    vTaskDelete(NULL);
}

static void bubble_retry_event(lv_event_t *e) {
    const char *msg_id = (const char *)lv_event_get_user_data(e);
    if (!msg_id || !*msg_id) return;
    if (audio_engine_is_busy() || chat_client_is_uploading()) {
        ui_set_voice_status("正在发送请稍候");
        return;
    }
    play_arg_t *pa = calloc(1, sizeof(*pa));
    if (!pa) { ui_set_voice_status("内存不足"); return; }
    snprintf(pa->msg_id, sizeof(pa->msg_id), "%s", msg_id);
    if (xTaskCreate(retry_msg_task, "msg_retry", 16384, pa, 4, NULL) != pdPASS) {
        free(pa);
        ui_set_voice_status("内存不足");
    }
}

static void refresh_chat_ui(bool force) {
    uint32_t ver = chat_client_get_version();
    if (!force && ver == s_rendered_chat_ver) return;
    s_rendered_chat_ver = ver;

    chat_message_info_t unread_msg = {0};
    int unread_count = 0;
    bool has_unread = chat_client_get_unread_info(&unread_msg, &unread_count);

    // Update Home unread badge
    if (unread_count != s_last_unread_badge) {
        s_last_unread_badge = unread_count;
        if (unread_count > 0) {
            char btxt[8];
            snprintf(btxt, sizeof(btxt), unread_count > 9 ? "9+" : "%d", unread_count);
            lv_label_set_text(s_parent_badge_lbl, btxt);
            lv_obj_set_hidden(s_parent_badge, false);
        } else {
            lv_obj_set_hidden(s_parent_badge, true);
        }
    }

    // Rebuild Parent Chat history list when visible (or forced)
    if (!s_chat_list || (lv_obj_is_hidden(s_chat_view) && !force)) return;

    chat_message_info_t *items = calloc(CHAT_HISTORY_MAX, sizeof(chat_message_info_t));
    if (!items) return;
    int count = chat_client_get_history(items, CHAT_HISTORY_MAX);
    char playing_id[48] = {0};
    chat_client_get_playing_id(playing_id, sizeof(playing_id));
    chat_play_phase_t play_phase = chat_client_get_play_phase();

    lv_obj_clean(s_chat_list);
    if (count == 0) {
        lv_obj_t *empty = make_panel(s_chat_list, 436, 170, 20, COL_CARD, COL_BORDER, 2);
        lv_obj_t *lbl = make_label(empty, "暂无聊天记录\n按住下方按钮给爸妈发语音", &pet_font, COL_MUTED);
        lv_obj_set_style_text_align(lbl, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_center(lbl);
        free(items);
        return;
    }

    for (int i = 0; i < count; i++) {
        const chat_message_info_t *m = &items[i];
        snprintf(s_bubble_ids[i], sizeof(s_bubble_ids[i]), "%s", m->id);
        bool is_playing = playing_id[0] && strcmp(playing_id, m->id) == 0;
        bool has_text = m->text[0] && !is_placeholder_text(m->text);
        bool playable = m->has_local_audio || m->audio_url[0] || has_text;
        bool is_failed = !m->from_parent && m->send_state == CHAT_SEND_FAILED;
        bool is_sending = !m->from_parent && m->send_state == CHAT_SEND_SENDING;

        lv_obj_t *row = lv_obj_create(s_chat_list);
        lv_obj_set_size(row, 440, LV_SIZE_CONTENT);
        lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(row, 0, 0);
        lv_obj_set_style_pad_all(row, 0, 0);
        lv_obj_set_scrollable(row, false);
        lv_obj_set_clickable(row, false);

        int32_t bubble_w = m->from_parent ? 344 : 326;
        int32_t content_w = bubble_w - 24;
        uint32_t bg = m->from_parent ? (m->unread ? 0xFFFBEB : COL_CARD) : COL_CHILD_BG;
        uint32_t bd = is_playing ? COL_AI :
                      (is_failed ? COL_RED : (m->from_parent ? (m->unread ? COL_AMBER : 0xCBE7D7) : COL_CHILD_BD));
        int32_t bw = (is_playing || is_failed || m->unread) ? 2 : 1;

        lv_obj_t *bubble = lv_button_create(row);
        lv_obj_set_width(bubble, bubble_w);
        lv_obj_set_height(bubble, LV_SIZE_CONTENT);
        lv_obj_set_style_radius(bubble, 18, 0);
        lv_obj_set_style_bg_color(bubble, lv_color_hex(bg), 0);
        lv_obj_set_style_bg_opa(bubble, LV_OPA_COVER, 0);
        lv_obj_set_style_border_color(bubble, lv_color_hex(bd), 0);
        lv_obj_set_style_border_width(bubble, bw, 0);
        lv_obj_set_style_shadow_width(bubble, 0, 0);
        lv_obj_set_style_pad_all(bubble, 12, 0);
        lv_obj_set_style_pad_row(bubble, 6, 0);
        lv_obj_set_flex_flow(bubble, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_scrollable(bubble, false);
        lv_obj_align(bubble, m->from_parent ? LV_ALIGN_TOP_LEFT : LV_ALIGN_TOP_RIGHT, 0, 0);
        lv_obj_add_event_cb(bubble, bubble_click_event, LV_EVENT_CLICKED, s_bubble_ids[i]);

        // Meta line: sender + time + unread/send tag
        char meta[72];
        snprintf(meta, sizeof(meta), "%s  %s%s", m->sender[0] ? m->sender : (m->from_parent ? "家长" : "宝贝"),
                 m->time_str[0] ? m->time_str : "--:--",
                 (m->from_parent && m->unread) ? "  • 未读" :
                 is_sending ? "  • 发送中" : (is_failed ? "  • 发送失败" : ""));
        lv_obj_t *meta_lbl = make_label(bubble, meta, &pet_font,
                                        ((m->from_parent && m->unread) || is_failed) ? COL_RED_INK : COL_MUTED);
        lv_obj_set_width(meta_lbl, content_w);

        // Voice action line
        char vline[64];
        if (is_playing) {
            snprintf(vline, sizeof(vline), "%s",
                     play_phase == CHAT_PLAY_DOWNLOADING ? LV_SYMBOL_STOP "  正在下载 · 点击取消" : LV_SYMBOL_STOP "  正在播放 · 点击停止");
        } else if (playable) snprintf(vline, sizeof(vline), LV_SYMBOL_VOLUME_MAX "  %d\" 语音  点击播放", m->duration_sec > 0 ? m->duration_sec : 3);
        else snprintf(vline, sizeof(vline), LV_SYMBOL_VOLUME_MAX "  %d\" 语音 (音频已清理)", m->duration_sec > 0 ? m->duration_sec : 3);
        lv_obj_t *voice_lbl = make_label(bubble, vline, &pet_font,
                                         is_playing ? (play_phase == CHAT_PLAY_DOWNLOADING ? COL_AMBER_INK : COL_AI_DARK) : (playable ? COL_INK : COL_MUTED));
        lv_obj_set_width(voice_lbl, content_w);

        if (has_text) {
            lv_obj_t *txt_lbl = make_label(bubble, m->text, &pet_font, 0x334155);
            lv_label_set_long_mode(txt_lbl, LV_LABEL_LONG_MODE_WRAP);
            lv_obj_set_width(txt_lbl, content_w);
        }

        if (is_sending || is_failed) {
            lv_obj_update_layout(row);
            if (is_sending) {
                lv_obj_t *sp = lv_spinner_create(row);
                lv_obj_set_size(sp, 32, 32);
                lv_spinner_set_anim_params(sp, 1000, 220);
                lv_obj_set_style_arc_color(sp, lv_color_hex(COL_AI), LV_PART_INDICATOR);
                lv_obj_set_style_arc_width(sp, 4, LV_PART_INDICATOR);
                lv_obj_set_style_arc_color(sp, lv_color_hex(0xD5E8DF), LV_PART_MAIN);
                lv_obj_set_style_arc_width(sp, 4, LV_PART_MAIN);
                lv_obj_set_clickable(sp, false);
                lv_obj_align_to(sp, bubble, LV_ALIGN_OUT_LEFT_MID, -12, 0);
            } else {
                lv_obj_t *retry_btn = make_pill_btn(row, 92, 40, 20, COL_RED, 0xFFFFFF,
                                                    LV_SYMBOL_REFRESH " 重试",
                                                    LV_EVENT_CLICKED, bubble_retry_event, s_bubble_ids[i]);
                lv_obj_align_to(retry_btn, bubble, LV_ALIGN_OUT_LEFT_MID, -10, 0);
            }
        }
    }
    free(items);
    lv_obj_update_layout(s_chat_list);
    lv_obj_scroll_to_y(s_chat_list, LV_COORD_MAX, LV_ANIM_OFF);
    (void)has_unread;
}

static void update_incoming_popup(void) {
    chat_message_info_t msg = {0};
    int unread_count = 0;
    bool has_unread = chat_client_get_unread_info(&msg, &unread_count);
    bool blocked = !device_pairing_is_paired() || s_alarm_active ||
                   !lv_obj_is_hidden(s_settings) ||
                   s_page == PET_PAGE_WECHAT ||
                   audio_engine_is_busy();

    bool show = !blocked && has_unread && unread_count > 0 && strcmp(msg.id, s_dismissed_msg_id) != 0;
    if (!show) {
        if (s_popup_visible) {
            s_popup_visible = false;
            s_popup_msg_id[0] = 0;
            s_popup_last_phase = CHAT_PLAY_IDLE;
            lv_obj_set_hidden(s_msg_popup, true);
        }
        return;
    }

    chat_play_phase_t phase = chat_client_get_play_phase();
    if (!s_popup_visible || strcmp(s_popup_msg_id, msg.id) != 0 || phase != s_popup_last_phase) {
        snprintf(s_popup_msg_id, sizeof(s_popup_msg_id), "%s", msg.id);
        s_popup_last_phase = phase;

        char head[64];
        snprintf(head, sizeof(head), "%s发来新消息", msg.sender[0] ? msg.sender : "家长");
        lv_label_set_text(s_msg_popup_title, head);

        char sub[128];
        if (!is_placeholder_text(msg.text)) {
            snprintf(sub, sizeof(sub), "“%.40s”  · %d条未读", msg.text, unread_count);
        } else {
            snprintf(sub, sizeof(sub), "%d秒语音消息 · 共 %d 条未读",
                     msg.duration_sec > 0 ? msg.duration_sec : 3, unread_count);
        }
        lv_label_set_text(s_msg_popup_sub, sub);

        uint32_t btn_col = phase == CHAT_PLAY_DOWNLOADING ? COL_AMBER :
                           (phase == CHAT_PLAY_PLAYING ? COL_AI : COL_GREEN);
        const char *btn_txt = phase == CHAT_PLAY_DOWNLOADING ? LV_SYMBOL_STOP "  下载中 · 点击取消" :
                              (phase == CHAT_PLAY_PLAYING ? LV_SYMBOL_STOP "  播放中 · 点击停止" : LV_SYMBOL_PLAY "  点击播放");
        lv_obj_set_style_bg_color(s_msg_play_btn, lv_color_hex(btn_col), 0);
        lv_label_set_text(s_msg_play_label, btn_txt);
        lv_obj_center(s_msg_play_label);

        if (!s_popup_visible) {
            s_popup_visible = true;
            lv_obj_set_hidden(s_msg_popup, false);
            lv_obj_move_foreground(s_msg_popup);
        }
    }
}

static void show_page(pet_page_t page) {
    if (s_touch_started) {
        audio_engine_end_hold(s_touch_target);
        apply_hold_visual(s_touch_target, false);
        s_touch_started = false;
    }
    if (s_page == PET_PAGE_WECHAT && page != PET_PAGE_WECHAT) {
        chat_message_info_t msg = {0};
        if (chat_client_get_unread_info(&msg, NULL)) {
            snprintf(s_dismissed_msg_id, sizeof(s_dismissed_msg_id), "%s", msg.id);
        }
    }
    if (s_page != page && !audio_engine_is_busy() && !chat_client_is_playing() && !chat_client_is_uploading()) {
        if (page == PET_PAGE_AI_CHAT || page == PET_PAGE_WECHAT) {
            s_active_status[0] = 0;
            s_status_expire_ms = 0;
            s_voice_animating = false;
        }
    }
    s_page = page;
    lv_obj_set_hidden(s_home_view, page != PET_PAGE_HOME);
    lv_obj_set_hidden(s_ai_view, page != PET_PAGE_AI_CHAT);
    lv_obj_set_hidden(s_chat_view, page != PET_PAGE_WECHAT);
    lv_obj_set_hidden(s_sched_view, page != PET_PAGE_SCHEDULES);

    if (page == PET_PAGE_SCHEDULES) refresh_schedules_ui(true);
    else if (page == PET_PAGE_WECHAT) refresh_chat_ui(true);
    else if (page == PET_PAGE_AI_CHAT) s_bot_rendered_state = (ai_pet_state_t)-1;
    update_incoming_popup();
}

static void nav_home_event(lv_event_t *e) { (void)e; show_page(PET_PAGE_HOME); }
static void nav_ai_event(lv_event_t *e) { (void)e; show_page(PET_PAGE_AI_CHAT); }
static void nav_sched_event(lv_event_t *e) { (void)e; show_page(PET_PAGE_SCHEDULES); }
static void nav_chat_event(lv_event_t *e) { (void)e; show_page(PET_PAGE_WECHAT); }

static void history_refresh_task(void *arg) {
    (void)arg;
    ui_set_voice_status("正在刷新消息");
    esp_err_t err = chat_client_fetch_history();
    ui_set_voice_status(err == ESP_OK ? "消息已刷新" : "刷新失败请检查网络");
    vTaskDelete(NULL);
}

static void chat_refresh_event(lv_event_t *e) {
    (void)e;
    if (xTaskCreate(history_refresh_task, "chat_sync", 12288, NULL, 4, NULL) != pdPASS) {
        ui_set_voice_status("内存不足");
    }
}

static void hold_btn_event(lv_event_t *e) {
    lv_event_code_t code = lv_event_get_code(e);
    audio_target_t target = (audio_target_t)(intptr_t)lv_event_get_user_data(e);
    if (code == LV_EVENT_PRESSED) {
        if (s_alarm_active) return;
        s_touch_target = target;
        s_touch_started = audio_engine_start_hold(target);
        if (s_touch_started) apply_hold_visual(target, true);
        else ui_set_voice_status("音频忙或请先绑定");
    } else if ((code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) && s_touch_started) {
        audio_engine_end_hold(s_touch_target);
        apply_hold_visual(s_touch_target, false);
        s_touch_started = false;
    }
}

static void retry_event(lv_event_t *e) {
    (void)e;
    if (!audio_engine_retry_last()) ui_set_voice_status("音频忙或请先绑定");
}

static void alarm_ack_event(lv_event_t *e) {
    (void)e;
    rtc_scheduler_ack_active();
}

static void msg_popup_close_event(lv_event_t *e) {
    (void)e;
    if (s_popup_msg_id[0]) snprintf(s_dismissed_msg_id, sizeof(s_dismissed_msg_id), "%s", s_popup_msg_id);
    s_popup_visible = false;
    lv_obj_set_hidden(s_msg_popup, true);
}

static void msg_popup_play_event(lv_event_t *e) {
    (void)e;
    if (s_popup_msg_id[0]) start_play_message(s_popup_msg_id);
}

static void update_bot_face(ai_pet_state_t st, unsigned phase) {
    if (!s_bot_face) return;
    bool state_changed = (s_bot_rendered_state != st);

    if (st == AI_STATE_IDLE) {
        bool blink = (phase % 28) >= 26;
        if (!state_changed && blink == s_bot_was_blink) return;
        if (state_changed) {
            lv_obj_set_style_bg_color(s_bot_halo, lv_color_hex(0xE0F2FE), 0);
            lv_obj_set_style_border_color(s_bot_halo, lv_color_hex(COL_AI_BORDER), 0);
            lv_obj_set_style_border_color(s_bot_face, lv_color_hex(0x60A5FA), 0);
            lv_obj_set_style_bg_color(s_bot_eye_l, lv_color_hex(0x38BDF8), 0);
            lv_obj_set_style_bg_color(s_bot_eye_r, lv_color_hex(0x38BDF8), 0);
            for (int i = 0; i < 5; i++) lv_obj_set_hidden(s_bot_waves[i], true);
        }
        lv_obj_set_size(s_bot_eye_l, 38, blink ? 6 : 48);
        lv_obj_set_size(s_bot_eye_r, 38, blink ? 6 : 48);
        lv_obj_set_style_radius(s_bot_eye_l, blink ? 3 : 18, 0);
        lv_obj_set_style_radius(s_bot_eye_r, blink ? 3 : 18, 0);
        lv_obj_align(s_bot_eye_l, LV_ALIGN_CENTER, -50, -14);
        lv_obj_align(s_bot_eye_r, LV_ALIGN_CENTER, 50, -14);
        lv_obj_set_hidden(s_bot_glint_l, blink);
        lv_obj_set_hidden(s_bot_glint_r, blink);
        s_bot_was_blink = blink;
        s_bot_rendered_state = st;
        return;
    }

    s_bot_was_blink = false;
    if (st == AI_STATE_LISTENING) {
        if (state_changed) {
            lv_obj_set_style_bg_color(s_bot_halo, lv_color_hex(0xBAE6FD), 0);
            lv_obj_set_style_border_color(s_bot_halo, lv_color_hex(0x38BDF8), 0);
            lv_obj_set_style_border_color(s_bot_face, lv_color_hex(0x0EA5E9), 0);
            lv_obj_set_style_bg_color(s_bot_eye_l, lv_color_hex(0x38BDF8), 0);
            lv_obj_set_style_bg_color(s_bot_eye_r, lv_color_hex(0x38BDF8), 0);
            lv_obj_set_size(s_bot_eye_l, 44, 52);
            lv_obj_set_size(s_bot_eye_r, 44, 52);
            lv_obj_set_style_radius(s_bot_eye_l, 20, 0);
            lv_obj_set_style_radius(s_bot_eye_r, 20, 0);
            lv_obj_align(s_bot_eye_l, LV_ALIGN_CENTER, -50, -16);
            lv_obj_align(s_bot_eye_r, LV_ALIGN_CENTER, 50, -16);
            lv_obj_set_hidden(s_bot_glint_l, false);
            lv_obj_set_hidden(s_bot_glint_r, false);
            for (int i = 0; i < 5; i++) {
                lv_obj_set_style_bg_color(s_bot_waves[i], lv_color_hex(0x7DD3FC), 0);
                lv_obj_set_hidden(s_bot_waves[i], false);
            }
        }
        static const uint8_t listen_h[4][5] = {
            { 8, 12, 16, 12, 8 },
            { 10, 16, 12, 14, 10 },
            { 12, 10, 18, 10, 12 },
            { 8, 14, 12, 16, 8 },
        };
        int row = phase & 3;
        for (int i = 0; i < 5; i++) lv_obj_set_height(s_bot_waves[i], listen_h[row][i]);
    } else if (st == AI_STATE_THINKING) {
        if (state_changed) {
            lv_obj_set_style_bg_color(s_bot_halo, lv_color_hex(0xEDE9FE), 0);
            lv_obj_set_style_border_color(s_bot_halo, lv_color_hex(0xC4B5FD), 0);
            lv_obj_set_style_border_color(s_bot_face, lv_color_hex(0xA78BFA), 0);
            lv_obj_set_style_bg_color(s_bot_eye_l, lv_color_hex(0x93C5FD), 0);
            lv_obj_set_style_bg_color(s_bot_eye_r, lv_color_hex(0x93C5FD), 0);
            lv_obj_set_size(s_bot_eye_l, 34, 26);
            lv_obj_set_size(s_bot_eye_r, 34, 26);
            lv_obj_set_style_radius(s_bot_eye_l, 12, 0);
            lv_obj_set_style_radius(s_bot_eye_r, 12, 0);
            lv_obj_set_hidden(s_bot_glint_l, false);
            lv_obj_set_hidden(s_bot_glint_r, false);
            lv_obj_set_hidden(s_bot_waves[0], true);
            lv_obj_set_hidden(s_bot_waves[4], true);
            for (int i = 1; i <= 3; i++) {
                lv_obj_set_style_bg_color(s_bot_waves[i], lv_color_hex(0xC4B5FD), 0);
                lv_obj_set_hidden(s_bot_waves[i], false);
            }
        }
        static const int8_t scan_x[4] = { -8, 0, 8, 0 };
        int dx = scan_x[(phase >> 1) & 3];
        lv_obj_align(s_bot_eye_l, LV_ALIGN_CENTER, -50 + dx, -14);
        lv_obj_align(s_bot_eye_r, LV_ALIGN_CENTER, 50 + dx, -14);
        int active_dot = ((phase >> 1) % 3) + 1;
        for (int i = 1; i <= 3; i++) lv_obj_set_height(s_bot_waves[i], i == active_dot ? 14 : 6);
    } else {
        if (state_changed) {
            lv_obj_set_style_bg_color(s_bot_halo, lv_color_hex(0xCFFAFE), 0);
            lv_obj_set_style_border_color(s_bot_halo, lv_color_hex(0x67E8F9), 0);
            lv_obj_set_style_border_color(s_bot_face, lv_color_hex(0x22D3EE), 0);
            lv_obj_set_style_bg_color(s_bot_eye_l, lv_color_hex(0x22D3EE), 0);
            lv_obj_set_style_bg_color(s_bot_eye_r, lv_color_hex(0x22D3EE), 0);
            lv_obj_set_hidden(s_bot_glint_l, false);
            lv_obj_set_hidden(s_bot_glint_r, false);
            for (int i = 0; i < 5; i++) {
                lv_obj_set_style_bg_color(s_bot_waves[i], lv_color_hex(0x22D3EE), 0);
                lv_obj_set_hidden(s_bot_waves[i], false);
            }
        }
        int dy = (phase & 1) ? -17 : -13;
        int eh = (phase & 1) ? 38 : 32;
        lv_obj_set_size(s_bot_eye_l, 42, eh);
        lv_obj_set_size(s_bot_eye_r, 42, eh);
        lv_obj_set_style_radius(s_bot_eye_l, 17, 0);
        lv_obj_set_style_radius(s_bot_eye_r, 17, 0);
        lv_obj_align(s_bot_eye_l, LV_ALIGN_CENTER, -50, dy);
        lv_obj_align(s_bot_eye_r, LV_ALIGN_CENTER, 50, dy);
        static const uint8_t speak_h[4][5] = {
            { 10, 22, 28, 22, 10 },
            { 18, 28, 16, 26, 14 },
            { 26, 14, 24, 18, 26 },
            { 14, 26, 20, 28, 16 },
        };
        int row = phase & 3;
        for (int i = 0; i < 5; i++) lv_obj_set_height(s_bot_waves[i], speak_h[row][i]);
    }
    s_bot_rendered_state = st;
}

static void anim_timer_cb(lv_timer_t *timer) {
    (void)timer;
    bool popup_playing = s_popup_visible && chat_client_get_play_phase() == CHAT_PLAY_PLAYING;
    bool ai_visible = (s_page == PET_PAGE_AI_CHAT);
    if (!s_alarm_active && !s_voice_animating && !popup_playing && !ai_visible) {
        if (s_anim_phase != 0) {
            s_anim_phase = 0;
            for (int i = 0; i < 5; i++) {
                lv_obj_set_hidden(s_home_waves[i], true);
            }
            if (s_alarm_bell_bg) lv_obj_align(s_alarm_bell_bg, LV_ALIGN_TOP_MID, 0, 50);
            if (s_alarm_ring) {
                lv_obj_set_size(s_alarm_ring, 144, 144);
                lv_obj_align(s_alarm_ring, LV_ALIGN_TOP_MID, 0, 28);
            }
            if (s_msg_icon_ring) {
                lv_obj_set_size(s_msg_icon_ring, 104, 104);
                lv_obj_align(s_msg_icon_ring, LV_ALIGN_TOP_MID, 0, 23);
            }
        }
        return;
    }

    s_anim_phase++;
    if (s_alarm_active) {
        static const int8_t dx[4] = { -6, 0, 6, 0 };
        int idx = s_anim_phase & 3;
        int ring_sz = (s_anim_phase & 2) ? 150 : 132;
        lv_obj_set_size(s_alarm_ring, ring_sz, ring_sz);
        lv_obj_align(s_alarm_ring, LV_ALIGN_TOP_MID, 0, 100 - ring_sz / 2);
        lv_obj_align(s_alarm_bell_bg, LV_ALIGN_TOP_MID, dx[idx], 50);
    }
    if (popup_playing) {
        int ring_sz = (s_anim_phase & 1) ? 112 : 96;
        lv_obj_set_size(s_msg_icon_ring, ring_sz, ring_sz);
        lv_obj_align(s_msg_icon_ring, LV_ALIGN_TOP_MID, 0, 75 - ring_sz / 2);
    } else if (s_popup_visible) {
        lv_obj_set_size(s_msg_icon_ring, 104, 104);
        lv_obj_align(s_msg_icon_ring, LV_ALIGN_TOP_MID, 0, 23);
    }
    if (s_voice_animating && s_page == PET_PAGE_HOME) {
        static const uint8_t heights[4][5] = {
            { 10, 20, 14, 24, 12 },
            { 18, 12, 24, 14, 20 },
            { 24, 16, 10, 22, 14 },
            { 12, 24, 18, 10, 22 },
        };
        int row = s_anim_phase & 3;
        for (int i = 0; i < 5; i++) {
            lv_obj_set_hidden(s_home_waves[i], false);
            lv_obj_set_height(s_home_waves[i], heights[row][i]);
        }
    } else {
        for (int i = 0; i < 5; i++) lv_obj_set_hidden(s_home_waves[i], true);
    }
    if (ai_visible) {
        update_bot_face(s_ai_state, s_anim_phase);
    }
}

static void ui_tick_timer(lv_timer_t *timer) {
    (void)timer;
    if (++s_battery_ticks >= 50) { battery_update(); s_battery_ticks = 0; }

    // 1. Top bar status
    int bat = atomic_load(&s_battery);
    const char *bat_sym = bat >= 80 ? LV_SYMBOL_BATTERY_FULL :
                          bat >= 50 ? LV_SYMBOL_BATTERY_3 :
                          bat >= 20 ? LV_SYMBOL_BATTERY_2 :
                          bat >= 0  ? LV_SYMBOL_BATTERY_1 : LV_SYMBOL_BATTERY_EMPTY;
    char net_txt[96], bat_txt[16];
    if (bat >= 0) snprintf(bat_txt, sizeof(bat_txt), "%d%%", bat);
    else snprintf(bat_txt, sizeof(bat_txt), "--");
    snprintf(net_txt, sizeof(net_txt), LV_SYMBOL_WIFI " %s   %s %s",
             wifi_manager_is_connected() ? "在线" : "未连", bat_sym, bat_txt);
    set_label_if_changed(s_home_net, s_cache_net, sizeof(s_cache_net), net_txt);
    if (s_volume) lv_label_set_text_fmt(s_volume, "当前音量：%d%%（家长端设置）", audio_engine_get_volume());

    // 2. Clock & date
    time_t now = time(NULL);
    char clk_txt[16], date_txt[48];
    if (now > 1700000000) {
        struct tm t;
        localtime_r(&now, &t);
        snprintf(clk_txt, sizeof(clk_txt), "%02d:%02d", t.tm_hour, t.tm_min);
        snprintf(date_txt, sizeof(date_txt), "%d月%d日  %s", t.tm_mon + 1, t.tm_mday, WEEKDAY_ZH[t.tm_wday % 7]);
    } else {
        snprintf(clk_txt, sizeof(clk_txt), "--:--");
        snprintf(date_txt, sizeof(date_txt), "等待联网同步时间");
    }
    set_label_if_changed(s_clock_label, s_cache_clock, sizeof(s_cache_clock), clk_txt);
    set_label_if_changed(s_date_label, s_cache_date, sizeof(s_cache_date), date_txt);

    // 3. Voice status & retry
    char incoming[128];
    bool dirty;
    portENTER_CRITICAL(&s_status_lock);
    dirty = s_status_dirty;
    s_status_dirty = false;
    memcpy(incoming, s_status_buf, sizeof(incoming));
    portEXIT_CRITICAL(&s_status_lock);

    int64_t now_ms = esp_timer_get_time() / 1000;
    bool can_retry_ai = audio_engine_can_retry_target(AUDIO_TARGET_AI);
    if (dirty) {
        snprintf(s_active_status, sizeof(s_active_status), "%s", incoming);
        s_voice_animating = strstr(s_active_status, "正在") != NULL;
        if (s_voice_animating) {
            s_status_expire_ms = 0;
        } else if (strstr(s_active_status, "失败") || strstr(s_active_status, "重发") || strstr(s_active_status, "重新发送")) {
            s_status_expire_ms = can_retry_ai ? 0 : now_ms + 4500;
        } else if (s_active_status[0]) {
            s_status_expire_ms = now_ms + 3000;
        } else {
            s_status_expire_ms = 0;
        }
    } else if (s_status_expire_ms > 0 && now_ms >= s_status_expire_ms) {
        s_active_status[0] = 0;
        s_status_expire_ms = 0;
        s_voice_animating = false;
    }

    bool ai_listening = (s_touch_started && s_touch_target == AUDIO_TARGET_AI) ||
                        (strstr(s_active_status, "正在录音") && s_page == PET_PAGE_AI_CHAT);
    bool ai_speaking = strstr(s_active_status, "正在播放") != NULL && !chat_client_is_playing();
    bool ai_thinking = !ai_listening && !ai_speaking && !chat_client_is_uploading() &&
                       (strstr(s_active_status, "正在思考") || strstr(s_active_status, "正在处理") ||
                        strstr(s_active_status, "正在连接") || strstr(s_active_status, "正在重试"));
    s_ai_state = ai_listening ? AI_STATE_LISTENING :
                 ai_speaking  ? AI_STATE_SPEAKING  :
                 ai_thinking  ? AI_STATE_THINKING  : AI_STATE_IDLE;

    bool is_err = strstr(s_active_status, "失败") || strstr(s_active_status, "太短") ||
                  strstr(s_active_status, "忙") || strstr(s_active_status, "不足") ||
                  strstr(s_active_status, "清理");
    bool is_ok = strstr(s_active_status, "成功") || strstr(s_active_status, "结束") ||
                 strstr(s_active_status, "已刷新");

    bool show_home_bar = s_active_status[0] != 0 || can_retry_ai;
    lv_obj_set_hidden(s_home_status_bar, !show_home_bar);
    if (show_home_bar) {
        uint32_t bar_bg = is_err ? COL_RED_TINT : (is_ok ? COL_GREEN_TINT : COL_AI_TINT);
        uint32_t bar_bd = is_err ? 0xFECACA : (is_ok ? 0xA7F3D0 : COL_AI_BORDER);
        uint32_t bar_fg = is_err ? COL_RED_INK : (is_ok ? COL_GREEN_DARK : COL_INK);
        lv_obj_set_style_bg_color(s_home_status_bar, lv_color_hex(bar_bg), 0);
        lv_obj_set_style_border_color(s_home_status_bar, lv_color_hex(bar_bd), 0);
        lv_obj_set_style_text_color(s_home_status_label, lv_color_hex(bar_fg), 0);
        lv_obj_set_width(s_home_status_label, s_voice_animating ? 286 : 330);
        lv_obj_align(s_home_status_label, LV_ALIGN_LEFT_MID, s_voice_animating ? 58 : 16, 0);
        lv_label_set_text(s_home_status_label, s_active_status[0] ? s_active_status : "上一条语音发送未完成");
        lv_obj_set_hidden(s_home_retry_btn, !can_retry_ai);
    }
    if (s_ai_status_label) {
        const char *ai_txt = s_active_status[0] ? s_active_status
            : (can_retry_ai ? "发送失败，可点击重发或重录" : "按住下方按钮，开始对话");
        uint32_t ai_fg = (is_err || (can_retry_ai && !s_active_status[0])) ? COL_RED_INK
                         : is_ok ? COL_GREEN_DARK
                         : (s_ai_state != AI_STATE_IDLE) ? COL_AI_DARK : COL_MUTED;
        lv_obj_set_style_text_color(s_ai_status_label, lv_color_hex(ai_fg), 0);
        lv_label_set_text(s_ai_status_label, ai_txt);
        lv_obj_set_hidden(s_ai_retry_btn, !can_retry_ai);
    }
    if (s_chat_status_label) {
        lv_label_set_text(s_chat_status_label, s_active_status[0] ? s_active_status : "点击气泡可播放，按住下方发送");
        lv_obj_set_hidden(s_chat_retry_btn, true);
    }

    // 4. Schedules, Chat History & Incoming Popup
    refresh_schedules_ui(false);
    refresh_chat_ui(false);
    update_incoming_popup();
}

static void touch_poll_task(void *arg) {
    while (1) {
        esp_lv_adapter_touch_notify_interrupt(arg);
        vTaskDelay(pdMS_TO_TICKS(30));
    }
}

// Settings overlay actions
static void settings_close(lv_event_t *e) { (void)e; lv_obj_set_hidden(s_settings, true); update_incoming_popup(); }
static void settings_open(lv_event_t *e) { (void)e; lv_obj_set_hidden(s_settings, false); lv_obj_move_foreground(s_settings); update_incoming_popup(); }
static void keyboard_event(lv_event_t *e) {
    lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_READY || code == LV_EVENT_CANCEL) {
        lv_obj_set_hidden(s_keyboard, true);
        lv_obj_align(s_password, LV_ALIGN_TOP_LEFT, 16, 240);
    }
}
static void password_event(lv_event_t *e) {
    (void)e;
    lv_obj_align(s_password, LV_ALIGN_TOP_LEFT, 16, 56);
    lv_obj_move_foreground(s_password);
    lv_obj_set_hidden(s_keyboard, false);
    lv_obj_move_foreground(s_keyboard);
}
static void scan_task(void *arg) {
    (void)arg; uint16_t count = 12; wifi_ap_record_t records[12];
    esp_err_t err = wifi_manager_scan(records, &count);
    if (esp_lv_adapter_lock(-1) == ESP_OK) {
        s_ap_count = 0; char options[512] = {0}; size_t used = 0;
        if (err == ESP_OK) for (int i = 0; i < count; i++) {
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
    if (xTaskCreate(scan_task, "wifi_scan", 6144, NULL, 4, NULL) != pdPASS) {
        s_wifi_working = false; lv_label_set_text(s_wifi_status, "Scan failed; retry");
    }
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
    lv_textarea_set_text(s_password, ""); lv_obj_set_hidden(s_keyboard, true); lv_obj_align(s_password, LV_ALIGN_TOP_LEFT, 16, 240);
    s_wifi_working = true; lv_label_set_text(s_wifi_status, "Connecting...");
    if (xTaskCreate(connect_task, "wifi_connect", 6144, job, 4, NULL) != pdPASS) {
        memset(job, 0, sizeof(*job)); free(job); s_wifi_working = false; lv_label_set_text(s_wifi_status, "Connection failed; retry");
    }
}

static void build_home_view(lv_obj_t *screen) {
    s_home_view = make_panel(screen, 480, 480, 0, COL_BG, COL_BG, 0);

    // 1. Top bar
    s_home_net = make_label(s_home_view, LV_SYMBOL_WIFI " --   " LV_SYMBOL_BATTERY_EMPTY " --", &pet_font, COL_MUTED);
    lv_obj_align(s_home_net, LV_ALIGN_TOP_LEFT, 18, 22);
    lv_obj_t *set_btn = make_pill_btn(s_home_view, 96, 38, 19, 0xE6F2EB, COL_INK,
                                      LV_SYMBOL_SETTINGS " 设置", LV_EVENT_CLICKED, settings_open, NULL);
    lv_obj_align(set_btn, LV_ALIGN_TOP_RIGHT, -16, 14);

    // 2. Clock & date
    s_clock_label = make_label(s_home_view, "--:--", &lv_font_montserrat_48, 0x163832);
    lv_obj_align(s_clock_label, LV_ALIGN_TOP_MID, 0, 68);
    s_date_label = make_label(s_home_view, "等待联网同步时间", &pet_font, COL_MUTED);
    lv_obj_align(s_date_label, LV_ALIGN_TOP_MID, 0, 128);

    // 3. Today's Schedule Entry Card
    s_home_sched_card = make_panel(s_home_view, 448, 96, 22, COL_AMBER_BG, COL_AMBER_BD, 2);
    lv_obj_align(s_home_sched_card, LV_ALIGN_TOP_MID, 0, 174);
    lv_obj_set_clickable(s_home_sched_card, true);
    lv_obj_add_event_cb(s_home_sched_card, nav_sched_event, LV_EVENT_CLICKED, NULL);

    lv_obj_t *bell_circle = make_panel(s_home_sched_card, 52, 52, LV_RADIUS_CIRCLE, COL_AMBER, COL_AMBER, 0);
    lv_obj_align(bell_circle, LV_ALIGN_LEFT_MID, 14, 0);
    lv_obj_t *bell_icon = make_label(bell_circle, LV_SYMBOL_BELL, &lv_font_montserrat_24, 0xFFFFFF);
    lv_obj_center(bell_icon);

    lv_obj_t *sched_title = make_label(s_home_sched_card, "今日定时播放", &pet_font, COL_AMBER_INK);
    lv_obj_align(sched_title, LV_ALIGN_TOP_LEFT, 80, 14);

    lv_obj_t *pill = make_panel(s_home_sched_card, 74, 28, 14, COL_AMBER_PILL, COL_AMBER_PILL, 0);
    lv_obj_align(pill, LV_ALIGN_TOP_RIGHT, -14, 12);
    s_home_sched_badge = make_label(pill, "0项 ›", &pet_font, COL_AMBER_INK);
    lv_obj_center(s_home_sched_badge);

    s_home_sched_next = make_label(s_home_sched_card, "等待联网校时...", &pet_font, 0x78350F);
    lv_label_set_long_mode(s_home_sched_next, LV_LABEL_LONG_MODE_DOTS);
    lv_obj_set_width(s_home_sched_next, 348);
    lv_obj_align(s_home_sched_next, LV_ALIGN_TOP_LEFT, 80, 50);

    // 4. Dynamic Voice Status & Retry Bar (hidden when idle)
    s_home_status_bar = make_panel(s_home_view, 448, 46, 16, COL_AI_TINT, COL_AI_BORDER, 1);
    lv_obj_align(s_home_status_bar, LV_ALIGN_TOP_MID, 0, 286);
    for (int i = 0; i < 5; i++) {
        s_home_waves[i] = make_panel(s_home_status_bar, 4, 12, 2, COL_AI, COL_AI, 0);
        lv_obj_align(s_home_waves[i], LV_ALIGN_LEFT_MID, 14 + i * 8, 0);
        lv_obj_set_hidden(s_home_waves[i], true);
    }
    s_home_status_label = make_label(s_home_status_bar, "", &pet_font, COL_INK);
    lv_label_set_long_mode(s_home_status_label, LV_LABEL_LONG_MODE_DOTS);
    lv_obj_set_width(s_home_status_label, 290);
    lv_obj_align(s_home_status_label, LV_ALIGN_LEFT_MID, 58, 0);

    s_home_retry_btn = make_pill_btn(s_home_status_bar, 82, 34, 17, COL_AMBER, 0xFFFFFF,
                                     "重发", LV_EVENT_CLICKED, retry_event, NULL);
    lv_obj_align(s_home_retry_btn, LV_ALIGN_RIGHT_MID, -8, 0);
    lv_obj_set_hidden(s_home_retry_btn, true);
    lv_obj_set_hidden(s_home_status_bar, true);

    // 5. Persistent Bottom Dual Buttons (premium frosted style with custom Bot & WeChat icons)
    s_btn_ai = make_pill_btn(s_home_view, 218, 114, 26, COL_AI, 0xFFFFFF, NULL,
                             LV_EVENT_CLICKED, nav_ai_event, NULL);
    lv_obj_set_style_bg_opa(s_btn_ai, LV_OPA_90, 0);
    lv_obj_set_style_border_width(s_btn_ai, 1, 0);
    lv_obj_set_style_border_color(s_btn_ai, lv_color_hex(0x93C5FD), 0);
    lv_obj_set_style_border_opa(s_btn_ai, LV_OPA_50, 0);
    lv_obj_set_style_shadow_width(s_btn_ai, 14, 0);
    lv_obj_set_style_shadow_color(s_btn_ai, lv_color_hex(0x0284C7), 0);
    lv_obj_set_style_shadow_opa(s_btn_ai, LV_OPA_20, 0);
    lv_obj_set_style_shadow_offset_y(s_btn_ai, 5, 0);
    lv_obj_align(s_btn_ai, LV_ALIGN_BOTTOM_LEFT, 16, -18);
    lv_obj_t *ai_t = make_label(s_btn_ai, SYMBOL_BOT " AI 聊天", &s_btn_font, 0xFFFFFF);
    lv_obj_set_style_text_opa(ai_t, LV_OPA_90, 0);
    lv_obj_set_style_text_letter_space(ai_t, 2, 0);
    lv_obj_align(ai_t, LV_ALIGN_CENTER, 0, 0);

    s_btn_parent = make_pill_btn(s_home_view, 218, 114, 26, COL_GREEN, 0xFFFFFF, NULL,
                                 LV_EVENT_CLICKED, nav_chat_event, NULL);
    lv_obj_set_style_bg_opa(s_btn_parent, LV_OPA_90, 0);
    lv_obj_set_style_border_width(s_btn_parent, 1, 0);
    lv_obj_set_style_border_color(s_btn_parent, lv_color_hex(0x86EFAC), 0);
    lv_obj_set_style_border_opa(s_btn_parent, LV_OPA_50, 0);
    lv_obj_set_style_shadow_width(s_btn_parent, 14, 0);
    lv_obj_set_style_shadow_color(s_btn_parent, lv_color_hex(0x059669), 0);
    lv_obj_set_style_shadow_opa(s_btn_parent, LV_OPA_20, 0);
    lv_obj_set_style_shadow_offset_y(s_btn_parent, 5, 0);
    lv_obj_align(s_btn_parent, LV_ALIGN_BOTTOM_RIGHT, -16, -18);
    lv_obj_t *pa_t = make_label(s_btn_parent, SYMBOL_CHAT " 爸妈聊天", &s_btn_font, 0xFFFFFF);
    lv_obj_set_style_text_opa(pa_t, LV_OPA_90, 0);
    lv_obj_set_style_text_letter_space(pa_t, 2, 0);
    lv_obj_align(pa_t, LV_ALIGN_CENTER, 0, 0);

    s_parent_badge = make_panel(s_home_view, 32, 32, LV_RADIUS_CIRCLE, COL_RED, 0xFFFFFF, 2);
    lv_obj_align(s_parent_badge, LV_ALIGN_BOTTOM_RIGHT, -10, -106);
    s_parent_badge_lbl = make_label(s_parent_badge, "1", &pet_font, 0xFFFFFF);
    lv_obj_center(s_parent_badge_lbl);
    lv_obj_set_hidden(s_parent_badge, true);
}

static void build_ai_view(lv_obj_t *screen) {
    s_ai_view = make_panel(screen, 480, 480, 0, 0xF2F8FF, 0xF2F8FF, 0);

    lv_obj_t *back = make_pill_btn(s_ai_view, 96, 40, 20, 0xDCEEFF, COL_INK,
                                   LV_SYMBOL_LEFT " 返回", LV_EVENT_CLICKED, nav_home_event, NULL);
    lv_obj_align(back, LV_ALIGN_TOP_LEFT, 14, 12);
    lv_obj_t *title = make_label(s_ai_view, "和 AI 聊天", &pet_font, COL_INK);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 18);

    // Expressive glowing Bot face visor
    s_bot_halo = make_panel(s_ai_view, 276, 174, 44, 0xE0F2FE, COL_AI_BORDER, 2);
    lv_obj_align(s_bot_halo, LV_ALIGN_TOP_MID, 0, 74);
    s_bot_face = make_panel(s_bot_halo, 256, 154, 36, 0x152232, 0x60A5FA, 3);
    lv_obj_center(s_bot_face);

    s_bot_eye_l = make_panel(s_bot_face, 38, 48, 18, 0x38BDF8, 0x38BDF8, 0);
    lv_obj_align(s_bot_eye_l, LV_ALIGN_CENTER, -50, -14);
    s_bot_glint_l = make_panel(s_bot_eye_l, 10, 10, LV_RADIUS_CIRCLE, 0xFFFFFF, 0xFFFFFF, 0);
    lv_obj_align(s_bot_glint_l, LV_ALIGN_TOP_RIGHT, -7, 8);

    s_bot_eye_r = make_panel(s_bot_face, 38, 48, 18, 0x38BDF8, 0x38BDF8, 0);
    lv_obj_align(s_bot_eye_r, LV_ALIGN_CENTER, 50, -14);
    s_bot_glint_r = make_panel(s_bot_eye_r, 10, 10, LV_RADIUS_CIRCLE, 0xFFFFFF, 0xFFFFFF, 0);
    lv_obj_align(s_bot_glint_r, LV_ALIGN_TOP_RIGHT, -7, 8);

    for (int i = 0; i < 5; i++) {
        s_bot_waves[i] = make_panel(s_bot_face, 7, 14, 3, 0x38BDF8, 0x38BDF8, 0);
        lv_obj_align(s_bot_waves[i], LV_ALIGN_CENTER, (i - 2) * 16, 40);
        lv_obj_set_hidden(s_bot_waves[i], true);
    }

    s_ai_status_label = make_label(s_ai_view, "按住下方按钮，开始对话", &pet_font, COL_MUTED);
    lv_label_set_long_mode(s_ai_status_label, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_width(s_ai_status_label, 420);
    lv_obj_set_style_text_align(s_ai_status_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_ai_status_label, LV_ALIGN_TOP_MID, 0, 268);

    s_ai_retry_btn = make_pill_btn(s_ai_view, 152, 42, 21, COL_AMBER, 0xFFFFFF,
                                   LV_SYMBOL_REFRESH " 重新发送", LV_EVENT_CLICKED, retry_event, NULL);
    lv_obj_align(s_ai_retry_btn, LV_ALIGN_TOP_MID, 0, 326);
    lv_obj_set_hidden(s_ai_retry_btn, true);

    s_ai_hold_btn = make_pill_btn(s_ai_view, 444, 76, 38, COL_AI, 0xFFFFFF, NULL,
                                  LV_EVENT_ALL, hold_btn_event, (void *)(intptr_t)AUDIO_TARGET_AI);
    lv_obj_align(s_ai_hold_btn, LV_ALIGN_BOTTOM_MID, 0, -14);
    lv_obj_t *ai_hold_lbl = make_label(s_ai_hold_btn, "按住说话，问问 AI", &s_btn_font, 0xFFFFFF);
    lv_obj_set_style_text_opa(ai_hold_lbl, LV_OPA_COVER, 0);
    lv_obj_center(ai_hold_lbl);
    lv_obj_set_hidden(s_ai_view, true);
}

static void build_schedule_view(lv_obj_t *screen) {
    s_sched_view = make_panel(screen, 480, 480, 0, 0xFFFDF7, 0xFFFDF7, 0);

    lv_obj_t *back = make_pill_btn(s_sched_view, 96, 40, 20, 0xFEF3C7, COL_AMBER_INK,
                                   LV_SYMBOL_LEFT " 返回", LV_EVENT_CLICKED, nav_home_event, NULL);
    lv_obj_align(back, LV_ALIGN_TOP_LEFT, 14, 12);
    lv_obj_t *title = make_label(s_sched_view, "今日定时播放", &pet_font, COL_INK);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 18);
    s_sched_count_label = make_label(s_sched_view, "共 0 项", &pet_font, COL_AMBER_INK);
    lv_obj_align(s_sched_count_label, LV_ALIGN_TOP_RIGHT, -16, 18);

    s_sched_list = lv_obj_create(s_sched_view);
    lv_obj_set_size(s_sched_list, 456, 404);
    lv_obj_align(s_sched_list, LV_ALIGN_TOP_MID, 0, 64);
    lv_obj_set_style_bg_opa(s_sched_list, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(s_sched_list, 0, 0);
    lv_obj_set_style_pad_all(s_sched_list, 6, 0);
    lv_obj_set_style_pad_row(s_sched_list, 10, 0);
    lv_obj_set_flex_flow(s_sched_list, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_hidden(s_sched_view, true);
}

static void build_chat_view(lv_obj_t *screen) {
    s_chat_view = make_panel(screen, 480, 480, 0, 0xF4FAF6, 0xF4FAF6, 0);

    lv_obj_t *back = make_pill_btn(s_chat_view, 96, 40, 20, 0xE2F2E8, COL_INK,
                                   LV_SYMBOL_LEFT " 返回", LV_EVENT_CLICKED, nav_home_event, NULL);
    lv_obj_align(back, LV_ALIGN_TOP_LEFT, 14, 12);
    lv_obj_t *title = make_label(s_chat_view, "和爸妈聊天", &pet_font, COL_INK);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 18);
    lv_obj_t *refresh = make_pill_btn(s_chat_view, 46, 40, 20, 0xE2F2E8, COL_INK,
                                      LV_SYMBOL_REFRESH, LV_EVENT_CLICKED, chat_refresh_event, NULL);
    lv_obj_align(refresh, LV_ALIGN_TOP_RIGHT, -14, 12);

    s_chat_list = lv_obj_create(s_chat_view);
    lv_obj_set_size(s_chat_list, 456, 286);
    lv_obj_align(s_chat_list, LV_ALIGN_TOP_MID, 0, 62);
    lv_obj_set_style_bg_opa(s_chat_list, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(s_chat_list, 0, 0);
    lv_obj_set_style_pad_all(s_chat_list, 6, 0);
    lv_obj_set_style_pad_row(s_chat_list, 10, 0);
    lv_obj_set_flex_flow(s_chat_list, LV_FLEX_FLOW_COLUMN);

    lv_obj_t *st_row = make_panel(s_chat_view, 444, 30, 0, 0xF4FAF6, 0xF4FAF6, 0);
    lv_obj_align(st_row, LV_ALIGN_TOP_MID, 0, 352);
    s_chat_status_label = make_label(st_row, "点击气泡可播放，按住下方发送", &pet_font, COL_MUTED);
    lv_label_set_long_mode(s_chat_status_label, LV_LABEL_LONG_MODE_DOTS);
    lv_obj_set_width(s_chat_status_label, 440);
    lv_obj_align(s_chat_status_label, LV_ALIGN_LEFT_MID, 2, 0);
    s_chat_retry_btn = make_pill_btn(st_row, 80, 28, 14, COL_AMBER, 0xFFFFFF,
                                     "重发", LV_EVENT_CLICKED, retry_event, NULL);
    lv_obj_align(s_chat_retry_btn, LV_ALIGN_RIGHT_MID, 0, 0);
    lv_obj_set_hidden(s_chat_retry_btn, true);

    s_chat_hold_btn = make_pill_btn(s_chat_view, 444, 76, 38, COL_GREEN, 0xFFFFFF, NULL,
                                    LV_EVENT_ALL, hold_btn_event, (void *)(intptr_t)AUDIO_TARGET_PARENT);
    lv_obj_align(s_chat_hold_btn, LV_ALIGN_BOTTOM_MID, 0, -14);
    lv_obj_t *chat_hold_lbl = make_label(s_chat_hold_btn, "按住说话，发给爸妈", &s_btn_font, 0xFFFFFF);
    lv_obj_set_style_text_opa(chat_hold_lbl, LV_OPA_COVER, 0);
    lv_obj_center(chat_hold_lbl);
    lv_obj_set_hidden(s_chat_view, true);
}

static void build_alarm_overlay(lv_obj_t *screen) {
    s_alarm_panel = make_panel(screen, 480, 480, 0, COL_ALARM_BG, COL_ALARM_BG, 0);
    lv_obj_set_clickable(s_alarm_panel, true);
    lv_obj_t *card = make_panel(s_alarm_panel, 432, 420, 28, COL_CARD, COL_ALARM, 3);
    lv_obj_center(card);

    s_alarm_ring = make_panel(card, 144, 144, LV_RADIUS_CIRCLE, COL_ALARM_RING, 0xFDBA74, 2);
    lv_obj_align(s_alarm_ring, LV_ALIGN_TOP_MID, 0, 28);

    s_alarm_bell_bg = make_panel(card, 100, 100, LV_RADIUS_CIRCLE, COL_ALARM, COL_ALARM, 0);
    lv_obj_align(s_alarm_bell_bg, LV_ALIGN_TOP_MID, 0, 50);
    lv_obj_t *bell = make_label(s_alarm_bell_bg, LV_SYMBOL_BELL, &lv_font_montserrat_48, 0xFFFFFF);
    lv_obj_center(bell);

    s_alarm_time = make_label(card, "08:00", &lv_font_montserrat_48, 0xEA580C);
    lv_obj_align(s_alarm_time, LV_ALIGN_TOP_MID, 0, 182);

    s_alarm_title = make_label(card, "定时语音提醒", &pet_font, COL_INK);
    lv_label_set_long_mode(s_alarm_title, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_width(s_alarm_title, 380);
    lv_obj_set_style_text_align(s_alarm_title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_alarm_title, LV_ALIGN_TOP_MID, 0, 244);

    s_alarm_sub = make_label(card, "定时语音播报中...", &pet_font, 0x9A3412);
    lv_obj_align(s_alarm_sub, LV_ALIGN_TOP_MID, 0, 298);

    lv_obj_t *ack = make_pill_btn(card, 240, 58, 29, COL_ALARM, 0xFFFFFF,
                                  "知道了 · 停止", LV_EVENT_PRESSED, alarm_ack_event, NULL);
    lv_obj_align(ack, LV_ALIGN_BOTTOM_MID, 0, -24);
    lv_obj_set_hidden(s_alarm_panel, true);
}

static void build_msg_popup(lv_obj_t *screen) {
    s_msg_popup = make_panel(screen, 480, 480, 0, 0x1E2E2B, 0x1E2E2B, 0);
    lv_obj_set_style_bg_opa(s_msg_popup, LV_OPA_50, 0);
    lv_obj_set_clickable(s_msg_popup, true);

    lv_obj_t *card = make_panel(s_msg_popup, 428, 340, 28, COL_CARD, COL_GREEN, 3);
    lv_obj_center(card);

    lv_obj_t *close_btn = make_pill_btn(card, 46, 46, LV_RADIUS_CIRCLE, 0xF1F5F9, 0x64748B,
                                        LV_SYMBOL_CLOSE, LV_EVENT_CLICKED, msg_popup_close_event, NULL);
    lv_obj_align(close_btn, LV_ALIGN_TOP_RIGHT, -14, 14);

    s_msg_icon_ring = make_panel(card, 104, 104, LV_RADIUS_CIRCLE, COL_CHILD_BG, COL_CHILD_BG, 0);
    lv_obj_align(s_msg_icon_ring, LV_ALIGN_TOP_MID, 0, 23);
    s_msg_icon_bg = make_panel(card, 78, 78, LV_RADIUS_CIRCLE, COL_GREEN, COL_GREEN, 0);
    lv_obj_align(s_msg_icon_bg, LV_ALIGN_TOP_MID, 0, 36);
    lv_obj_t *icon = make_label(s_msg_icon_bg, LV_SYMBOL_VOLUME_MAX, &lv_font_montserrat_24, 0xFFFFFF);
    lv_obj_center(icon);

    s_msg_popup_title = make_label(card, "家长发来新消息", &pet_font, COL_INK);
    lv_obj_set_width(s_msg_popup_title, 380);
    lv_obj_set_style_text_align(s_msg_popup_title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_msg_popup_title, LV_ALIGN_TOP_MID, 0, 140);

    s_msg_popup_sub = make_label(card, "点击下方按钮收听语音", &pet_font, COL_MUTED);
    lv_label_set_long_mode(s_msg_popup_sub, LV_LABEL_LONG_MODE_DOTS);
    lv_obj_set_width(s_msg_popup_sub, 380);
    lv_obj_set_style_text_align(s_msg_popup_sub, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_msg_popup_sub, LV_ALIGN_TOP_MID, 0, 178);

    s_msg_play_btn = make_pill_btn(card, 280, 66, 33, COL_GREEN, 0xFFFFFF,
                                   LV_SYMBOL_PLAY "  点击播放",
                                   LV_EVENT_CLICKED, msg_popup_play_event, NULL);
    lv_obj_align(s_msg_play_btn, LV_ALIGN_BOTTOM_MID, 0, -28);
    s_msg_play_label = lv_obj_get_child(s_msg_play_btn, 0);

    lv_obj_set_hidden(s_msg_popup, true);
}

static void build_pairing_and_settings(lv_obj_t *screen) {
    s_pairing_panel = make_panel(screen, 444, 316, 26, COL_CARD, COL_AMBER, 3);
    lv_obj_set_clickable(s_pairing_panel, true);
    lv_obj_center(s_pairing_panel);
    lv_obj_t *pair_title = make_label(s_pairing_panel, "绑定小铭同学", &pet_font, COL_INK);
    lv_obj_align(pair_title, LV_ALIGN_TOP_MID, 0, 22);
    s_pairing_code = make_label(s_pairing_panel, "--------", &lv_font_montserrat_24, COL_AI_DARK);
    lv_obj_align(s_pairing_code, LV_ALIGN_CENTER, 0, -10);
    s_pairing_status = make_label(s_pairing_panel, "联网后获取绑定码\n家长端家庭设备中输入\n绑定码10分钟内有效", &pet_font, COL_MUTED);
    lv_obj_set_width(s_pairing_status, 396);
    lv_obj_set_style_text_align(s_pairing_status, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_pairing_status, LV_ALIGN_BOTTOM_MID, 0, -20);
    if (device_pairing_is_paired()) lv_obj_set_hidden(s_pairing_panel, true);

    s_settings = make_panel(screen, 480, 480, 0, COL_BG, COL_BG, 0);
    lv_obj_set_clickable(s_settings, true);
    lv_obj_t *title = make_label(s_settings, "设备设置", &pet_font, COL_INK);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 16, 18);
    lv_obj_t *close = make_pill_btn(s_settings, 52, 40, 20, 0xE2E8F0, COL_INK,
                                    LV_SYMBOL_CLOSE, LV_EVENT_CLICKED, settings_close, NULL);
    lv_obj_align(close, LV_ALIGN_TOP_RIGHT, -14, 12);

    s_volume = make_label(s_settings, "当前音量：80%", &pet_font, COL_MUTED);
    lv_obj_align(s_volume, LV_ALIGN_TOP_LEFT, 16, 66);

    lv_obj_t *scan = make_pill_btn(s_settings, 180, 44, 22, COL_AI, 0xFFFFFF,
                                   "Scan Wi-Fi", LV_EVENT_CLICKED, scan_event, NULL);
    lv_obj_align(scan, LV_ALIGN_TOP_LEFT, 16, 102);

    s_wifi_status = make_label(s_settings, "Scan Wi-Fi", &pet_font, COL_MUTED);
    lv_obj_align(s_wifi_status, LV_ALIGN_TOP_LEFT, 16, 154);

    s_wifi_list = lv_dropdown_create(s_settings);
    lv_obj_set_width(s_wifi_list, 320);
    lv_dropdown_set_options(s_wifi_list, "--");
    lv_obj_align(s_wifi_list, LV_ALIGN_TOP_LEFT, 16, 186);

    s_password = lv_textarea_create(s_settings);
    lv_obj_set_size(s_password, 320, 48);
    lv_textarea_set_one_line(s_password, true);
    lv_textarea_set_password_mode(s_password, true);
    lv_textarea_set_max_length(s_password, 63);
    lv_textarea_set_placeholder_text(s_password, "Wi-Fi password");
    lv_obj_align(s_password, LV_ALIGN_TOP_LEFT, 16, 240);
    lv_obj_add_event_cb(s_password, password_event, LV_EVENT_CLICKED, NULL);

    lv_obj_t *connect = make_pill_btn(s_settings, 160, 48, 24, COL_GREEN, 0xFFFFFF,
                                      "Connect", LV_EVENT_CLICKED, connect_event, NULL);
    lv_obj_align(connect, LV_ALIGN_TOP_LEFT, 16, 308);

    s_keyboard = lv_keyboard_create(s_settings);
    lv_keyboard_set_textarea(s_keyboard, s_password);
    lv_obj_set_style_text_font(s_keyboard, &lv_font_montserrat_14, 0);
    lv_obj_set_size(s_keyboard, 448, 210);
    lv_obj_align(s_keyboard, LV_ALIGN_BOTTOM_MID, 0, -6);
    lv_obj_add_event_cb(s_keyboard, keyboard_event, LV_EVENT_ALL, NULL);
    lv_obj_set_hidden(s_keyboard, true);
    lv_obj_set_hidden(s_settings, true);
}

void ui_state_init(void) {
    if (!pet_display_start()) { ESP_LOGE(TAG, "Display initialization failed"); return; }
    if (esp_lv_adapter_lock(-1) != ESP_OK) return;

    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(COL_BG), 0);
    lv_obj_set_style_text_font(screen, &pet_font, 0);
    lv_obj_set_style_text_color(screen, lv_color_hex(COL_INK), 0);
    lv_obj_set_scrollable(screen, false);

    build_home_view(screen);
    build_ai_view(screen);
    build_schedule_view(screen);
    build_chat_view(screen);
    build_alarm_overlay(screen);
    build_msg_popup(screen);
    build_pairing_and_settings(screen);

    battery_init();
    battery_update();
    lv_timer_t *tick = lv_timer_create(ui_tick_timer, 200, NULL);
    if (tick) lv_timer_ready(tick);
    lv_timer_create(anim_timer_cb, 120, NULL);

    esp_lv_adapter_unlock();
    xTaskCreate(touch_poll_task, "touch_poll", 2048, pet_display_input(), 4, NULL);
    ESP_LOGI(TAG, "Fresh sunny pet interface initialized");
}

void ui_switch_page(pet_page_t page) {
    if (s_home_view && esp_lv_adapter_lock(1000) == ESP_OK) {
        show_page(page);
        esp_lv_adapter_unlock();
    }
}

void ui_set_voice_status(const char *status) {
    if (!status) return;
    ESP_LOGI(TAG, "Voice status: %s", status);
    portENTER_CRITICAL(&s_status_lock);
    snprintf(s_status_buf, sizeof(s_status_buf), "%s", status);
    s_status_dirty = true;
    portEXIT_CRITICAL(&s_status_lock);
}

void ui_set_pairing_status(const char *code, const char *status) {
    if (!s_pairing_panel || esp_lv_adapter_lock(1000) != ESP_OK) return;
    if (device_pairing_is_paired()) {
        lv_obj_set_hidden(s_pairing_panel, true);
    } else {
        lv_obj_set_hidden(s_pairing_panel, false);
        lv_obj_move_foreground(s_pairing_panel);
        if (code) { lv_label_set_text(s_pairing_code, code); lv_obj_center(s_pairing_code); }
        if (status) lv_label_set_text(s_pairing_status, status);
    }
    esp_lv_adapter_unlock();
}

void ui_set_key_hold_state(int target, bool holding) {
    if (!s_home_view || esp_lv_adapter_lock(200) != ESP_OK) return;
    apply_hold_visual((audio_target_t)target, holding);
    esp_lv_adapter_unlock();
}

void ui_on_touch_press_start(void) {
    s_touch_target = s_page == PET_PAGE_WECHAT ? AUDIO_TARGET_PARENT : AUDIO_TARGET_AI;
    s_touch_started = audio_engine_start_hold(s_touch_target);
}
void ui_on_touch_press_end(void) {
    if (s_touch_started) audio_engine_end_hold(s_touch_target);
    s_touch_started = false;
}
void ui_on_side_boot_key_hold_start(void) { audio_engine_start_hold(AUDIO_TARGET_AI); }
void ui_on_side_boot_key_hold_end(void) { audio_engine_end_hold(AUDIO_TARGET_AI); }

void ui_trigger_alarm_modal(const char *id, const char *title, const char *path) {
    (void)path;
    if (!s_alarm_panel || esp_lv_adapter_lock(1000) != ESP_OK) return;
    s_alarm_active = true;
    snprintf(s_alarm_id, sizeof(s_alarm_id), "%s", id ? id : "");

    time_t now = time(NULL);
    char tbuf[8] = "08:00";
    if (now > 1700000000) {
        struct tm t;
        localtime_r(&now, &t);
        snprintf(tbuf, sizeof(tbuf), "%02d:%02d", t.tm_hour, t.tm_min);
    }
    lv_label_set_text(s_alarm_time, tbuf);
    lv_label_set_text(s_alarm_title, (title && *title) ? title : "定时语音提醒");
    if (s_alarm_sub) lv_label_set_text(s_alarm_sub, "定时语音播报中...");
    lv_obj_set_hidden(s_alarm_panel, false);
    lv_obj_move_foreground(s_alarm_panel);
    update_incoming_popup();
    esp_lv_adapter_unlock();
}

void ui_set_alarm_modal_subtitle(const char *subtitle) {
    if (!s_alarm_sub || esp_lv_adapter_lock(1000) != ESP_OK) return;
    lv_label_set_text(s_alarm_sub, (subtitle && *subtitle) ? subtitle : "");
    esp_lv_adapter_unlock();
}

void ui_hide_alarm_modal(void) {
    if (!s_alarm_panel || esp_lv_adapter_lock(1000) != ESP_OK) return;
    s_alarm_active = false;
    lv_obj_set_hidden(s_alarm_panel, true);
    update_incoming_popup();
    esp_lv_adapter_unlock();
}

void ui_ack_alarm_modal(void) { rtc_scheduler_ack_active(); }
int ui_get_battery_percent(void) { return atomic_load(&s_battery); }
