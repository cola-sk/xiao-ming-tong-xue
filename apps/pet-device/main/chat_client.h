#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
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
 * Play the queued unread parent message (downloading real recorded WAV via
 * GET /api/v1/chat/messages/{id}/audio or falling back to real-time TTS if text-only)
 * and report voice_read ACK so server purges the transient audio.
 */
esp_err_t chat_client_play_next_unread(void);

/**
 * Upload child's recorded WAV audio buffer + metadata to parent App via POST /api/v1/chat/messages.
 * If wav_data is NULL, sends text-only metadata.
 */
esp_err_t chat_client_send_child_voice_wav(const uint8_t *wav_data, size_t wav_len,
                                           const char *asr_text, int duration_sec);

esp_err_t chat_client_send_child_voice_audio(const uint8_t *audio, size_t audio_len,
                                            const char *mime, const char *asr_text, int duration_sec);
esp_err_t chat_client_send_child_recording(const char *message_id, const uint8_t *audio, size_t audio_len,
                                          const char *mime, int duration_sec);
esp_err_t chat_client_ask_ai_audio(const uint8_t *audio, size_t audio_len, const char *mime);

/**
 * Convenience wrapper for sending text/metadata voice notification.
 */
esp_err_t chat_client_send_child_voice(const char *asr_text, int duration_sec);

#ifdef __cplusplus
}
#endif
