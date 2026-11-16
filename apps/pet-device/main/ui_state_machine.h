#pragma once
#include <stdbool.h>
#include <stdint.h>

/**
 * 微雪 ESP32-S3-Touch-AMOLED-2.16 (480x480) 界面与交互状态机
 * 1. PAGE_AI_PET: 主页 AI 伴聊 (按住触摸屏录音 -> 云端 ASR/LLM/TTS -> 播报)
 * 2. PAGE_WECHAT: 副页 爸妈微聊 (收听家长语音 / 按住屏幕或侧面按键发微信语音)
 * 3. MODAL_ALARM: 全局弹窗 定时语音提醒 (PCF85063 硬件 RTC 唤醒 -> 点击屏幕确认 alarm_ack)
 */

typedef enum {
    PET_PAGE_AI_CHAT = 0,
    PET_PAGE_WECHAT  = 1,
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
