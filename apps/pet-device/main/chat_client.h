#pragma once

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Ask the cloud AI pet brain (POST /api/v1/ai/chat with responseFormat="mp3"),
 * receive real-time Doubao TTS audio, and play it on ES8311 speaker.
 */
esp_err_t chat_client_ask_ai(const char *question_text);

/**
 * Fetch unread parent->device messages from GET /api/v1/chat/messages.
 * Messages marked autoPlay=true are immediately played and acknowledged.
 */
esp_err_t chat_client_fetch_unread(void);

/**
 * Check if there is at least one unread parent message waiting to be tapped.
 */
bool chat_client_has_unread_message(void);

/**
 * Play the queued unread parent message (on child tap) and report voice_read ACK.
 */
esp_err_t chat_client_play_next_unread(void);

/**
 * Upload child's recorded WeChat voice message to parent App via POST /api/v1/chat/messages.
 */
esp_err_t chat_client_send_child_voice(const char *asr_text, int duration_sec);

#ifdef __cplusplus
}
#endif
