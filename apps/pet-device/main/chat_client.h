#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CHAT_HISTORY_MAX 20

typedef enum {
    CHAT_SEND_SENT    = 0,
    CHAT_SEND_SENDING = 1,
    CHAT_SEND_FAILED  = 2,
} chat_send_state_t;

typedef struct {
    char id[48];
    char sender[32];
    char text[160];
    char audio_url[128];
    char time_str[8];
    char mime[24];
    int duration_sec;
    bool from_parent;
    bool unread;
    bool has_local_audio;
    chat_send_state_t send_state;
} chat_message_info_t;

typedef enum {
    CHAT_PLAY_IDLE        = 0,
    CHAT_PLAY_DOWNLOADING = 1,
    CHAT_PLAY_PLAYING     = 2,
} chat_play_phase_t;

void chat_client_init(void);
esp_err_t chat_client_fetch_history(void);
bool chat_client_get_unread_info(chat_message_info_t *out, int *out_unread_count);
int chat_client_get_history(chat_message_info_t *out, int max_items);
uint32_t chat_client_get_version(void);
bool chat_client_is_playing(void);
chat_play_phase_t chat_client_get_play_phase(void);
bool chat_client_is_uploading(void);
void chat_client_get_playing_id(char *out_id, size_t out_len);
esp_err_t chat_client_play_message(const char *msg_id);
void chat_client_prefetch_unread(void);
void chat_client_add_local_outgoing(const char *msg_id, const uint8_t *audio, size_t audio_len,
                                    const char *mime, int duration_sec);
void chat_client_set_send_state(const char *msg_id, chat_send_state_t state);
esp_err_t chat_client_retry_outgoing(const char *msg_id);

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
