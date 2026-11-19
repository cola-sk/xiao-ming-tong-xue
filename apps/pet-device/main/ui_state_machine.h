#pragma once
#include <stdbool.h>
#include <stdint.h>

/**
 * 微雪 ESP32-S3-Touch-AMOLED-2.16 (480x480) 界面与交互状态机
 * 1. PET_PAGE_HOME: 清爽首页 (时钟 / 今日定时入口 / 进入和AI聊天 / 进入和爸妈聊天)
 * 2. PET_PAGE_WECHAT: 和爸妈聊天 (双向消息历史点击播放 + 底部按住说话)
 * 3. PET_PAGE_SCHEDULES: 今日定时播放列表
 * 4. PET_PAGE_AI_CHAT: 和 AI 聊天 (卡通 Bot 眼睛动效 + 状态提示 + 底部按住说话)
 * 5. 浮层: 闹钟动效弹窗 (播完自动消失 / 点击知道了确认) & 家长新消息弹窗 (点击播放 / 关闭)
 */

typedef enum {
    PET_PAGE_HOME      = 0,
    PET_PAGE_WECHAT    = 1,
    PET_PAGE_SCHEDULES = 2,
    PET_PAGE_AI_CHAT   = 3,
} pet_page_t;

typedef enum {
    AI_STATE_IDLE = 0,
    AI_STATE_LISTENING,
    AI_STATE_THINKING,
    AI_STATE_SPEAKING,
} ai_pet_state_t;

void ui_state_init(void);
void ui_switch_page(pet_page_t target_page);
void ui_on_touch_press_start(void);
void ui_on_touch_press_end(void);
void ui_on_side_boot_key_hold_start(void);
void ui_on_side_boot_key_hold_end(void);
void ui_trigger_alarm_modal(const char *task_id, const char *title, const char *audio_path);
void ui_ack_alarm_modal(void);
void ui_set_voice_status(const char *status);
void ui_set_pairing_status(const char *code, const char *status);

void ui_hide_alarm_modal(void);
void ui_set_key_hold_state(int target, bool holding);

// Returns -1 when the PMU battery reading is unavailable.
int ui_get_battery_percent(void);
