#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Start the EMQX Cloud Serverless MQTT over TLS (8883) background client.
 * Subscribes to `pet/<deviceId>/notify` for sub-second push wakeups
 * (new parent voice messages, schedule updates, volume config changes).
 */
esp_err_t mqtt_client_mgr_start(void);

#ifdef __cplusplus
}
#endif
