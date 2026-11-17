#include "ui_state_machine.h"
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "audio_engine.h"
#include "chat_client.h"
#include "device_sync.h"

static const char *TAG = "ui_state";

#define SIDE_BOOT_GPIO GPIO_NUM_0

static pet_page_t s_current_page = PET_PAGE_AI_CHAT;
static ai_pet_state_t s_ai_state = AI_STATE_IDLE;
static bool s_alarm_modal_active = false;
static char s_active_alarm_task_id[48] = {0};

static void side_key_monitor_task(void *arg) {
    bool prev_pressed = false;
    TickType_t press_start_tick = 0;

    while (1) {
        bool pressed = (gpio_get_level(SIDE_BOOT_GPIO) == 0);
        if (pressed && !prev_pressed) {
            vTaskDelay(pdMS_TO_TICKS(30)); // debounce
            if (gpio_get_level(SIDE_BOOT_GPIO) == 0) {
                prev_pressed = true;
                press_start_tick = xTaskGetTickCount();
                ui_on_side_boot_key_hold_start();
            }
        } else if (!pressed && prev_pressed) {
            prev_pressed = false;
            TickType_t held_ms = (xTaskGetTickCount() - press_start_tick) * portTICK_PERIOD_MS;
            if (held_ms < 500) {
                // 短按侧面键：快捷切换主页 AI 聊天 <-> 副页爸妈微聊
                audio_engine_stop_capture();
                ui_switch_page(s_current_page == PET_PAGE_AI_CHAT ? PET_PAGE_WECHAT : PET_PAGE_AI_CHAT);
            } else {
                ui_on_side_boot_key_hold_end();
            }
        }
        vTaskDelay(pdMS_TO_TICKS(30));
    }
}

void ui_state_init(void) {
    s_current_page = PET_PAGE_AI_CHAT;
    s_ai_state = AI_STATE_IDLE;
    s_alarm_modal_active = false;
    memset(s_active_alarm_task_id, 0, sizeof(s_active_alarm_task_id));

    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << SIDE_BOOT_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);
    xTaskCreate(side_key_monitor_task, "side_key_task", 4096, NULL, 6, NULL);

    ESP_LOGI(TAG, "LVGL UI State Machine initialized (480x480 CO5300 + CST9220 + GPIO0)");
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
        audio_engine_start_capture_stream(CONFIG_PET_SERVER_URL "/api/v1/ai/chat");
    } else {
        if (chat_client_has_unread_message()) {
            chat_client_play_next_unread();
        } else {
            audio_engine_start_capture_file("/sdcard/wechat_out.opus");
        }
    }
}

void ui_on_touch_press_end(void) {
    if (s_current_page == PET_PAGE_AI_CHAT && s_ai_state == AI_STATE_LISTENING) {
        s_ai_state = AI_STATE_THINKING;
        audio_engine_stop_capture();
        chat_client_ask_ai("小铭同学，讲个有趣的科学小知识吧");
        s_ai_state = AI_STATE_IDLE;
    } else if (s_current_page == PET_PAGE_WECHAT) {
        audio_engine_stop_capture();
        chat_client_send_child_voice("爸爸妈妈，我想你们啦！", 4);
    }
}

void ui_on_side_boot_key_hold_start(void) {
    ESP_LOGI(TAG, "Side BOOT key held: shortcut recording for Parent WeChat voice");
    audio_engine_start_capture_file("/sdcard/wechat_shortcut.opus");
}

void ui_on_side_boot_key_hold_end(void) {
    audio_engine_stop_capture();
    ESP_LOGI(TAG, "Side BOOT key released: sending voice message to Mom/Dad");
    chat_client_send_child_voice("妈妈我写完作业啦，你什么时候回家呀？", 5);
}

void ui_trigger_alarm_modal(const char *task_id, const char *title, const char *audio_path) {
    s_alarm_modal_active = true;
    snprintf(s_active_alarm_task_id, sizeof(s_active_alarm_task_id), "%s", task_id ? task_id : "");
    ESP_LOGI(TAG, "Alarm Modal Ringing: [%s] %s -> %s", s_active_alarm_task_id, title ? title : "", audio_path ? audio_path : "");
    audio_engine_play_local_file(audio_path ? audio_path : "/sdcard/alarm.mp3");
}

void ui_ack_alarm_modal(void) {
    if (!s_alarm_modal_active) return;
    s_alarm_modal_active = false;
    audio_engine_stop_playback();
    ESP_LOGI(TAG, "Child tapped screen to ACK alarm [%s] -> sending alarm_ack", s_active_alarm_task_id);
    if (strlen(s_active_alarm_task_id) > 0) {
        device_sync_send_alarm_ack(s_active_alarm_task_id);
        memset(s_active_alarm_task_id, 0, sizeof(s_active_alarm_task_id));
    }
}
