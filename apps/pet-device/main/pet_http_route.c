#include "pet_http_auth.h"
#include <stdio.h>
#include <string.h>
#include <stdatomic.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "lwip/netdb.h"
#include "lwip/inet.h"

#define DNS_CACHE_TTL_US (300LL * 1000000LL)

static portMUX_TYPE s_route_lock = portMUX_INITIALIZER_UNLOCKED;
static char s_host[128], s_preferred[INET_ADDRSTRLEN], s_failed[INET_ADDRSTRLEN];
static char s_peers[4][INET_ADDRSTRLEN];
static size_t s_peer_count = 0;
static int64_t s_peers_ts_us = 0;
static _Atomic(SemaphoreHandle_t) s_net_lock = NULL;

static SemaphoreHandle_t get_net_lock(void) {
    SemaphoreHandle_t h = atomic_load(&s_net_lock);
    if (!h) {
        SemaphoreHandle_t created = xSemaphoreCreateMutex();
        if (created) {
            SemaphoreHandle_t expected = NULL;
            if (!atomic_compare_exchange_strong(&s_net_lock, &expected, created)) {
                vSemaphoreDelete(created);
                h = expected;
            } else {
                h = created;
            }
        }
    }
    return h;
}

bool pet_http_net_lock(uint32_t timeout_ms) {
    SemaphoreHandle_t h = get_net_lock();
    if (!h) return false;
    return xSemaphoreTake(h, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
}

void pet_http_net_unlock(void) {
    SemaphoreHandle_t h = atomic_load(&s_net_lock);
    if (h) xSemaphoreGive(h);
}

// ESP-TLS only connects to the first getaddrinfo result. Resolve and cache up to
// 4 A records and rotate away from a failed peer.
esp_http_client_handle_t pet_http_init(const esp_http_client_config_t *config) {
    size_t origin_len = strlen(CONFIG_PET_SERVER_URL);
    if (!config || !config->url || strncmp(config->url, CONFIG_PET_SERVER_URL, origin_len) ||
        (config->url[origin_len] && config->url[origin_len] != '/') ||
        strncmp(CONFIG_PET_SERVER_URL, "https://", 8))
        return config ? esp_http_client_init(config) : NULL;

    const char *host_start = CONFIG_PET_SERVER_URL + 8;
    size_t host_len = strcspn(host_start, "/:");
    if (!host_len || host_len >= sizeof(s_host) || host_start[host_len] == ':')
        return esp_http_client_init(config);

    char host[128] = {0}, preferred[INET_ADDRSTRLEN] = {0}, failed[INET_ADDRSTRLEN] = {0};
    char peers[4][INET_ADDRSTRLEN] = {0};
    size_t count = 0;
    int64_t now_us = esp_timer_get_time();
    bool cache_valid = false;

    portENTER_CRITICAL(&s_route_lock);
    if (!s_host[0]) { memcpy(s_host, host_start, host_len); s_host[host_len] = 0; }
    memcpy(host, s_host, sizeof(host));
    memcpy(preferred, s_preferred, sizeof(preferred));
    memcpy(failed, s_failed, sizeof(failed));
    if (s_peer_count > 0 && (now_us - s_peers_ts_us) < DNS_CACHE_TTL_US) {
        count = s_peer_count;
        memcpy(peers, s_peers, sizeof(peers));
        cache_valid = true;
    }
    portEXIT_CRITICAL(&s_route_lock);

    if (!cache_valid) {
        struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_STREAM };
        struct addrinfo *addresses = NULL;
        if (getaddrinfo(host, "443", &hints, &addresses) == 0 && addresses) {
            for (struct addrinfo *item = addresses; item && count < 4; item = item->ai_next) {
                const struct sockaddr_in *address = (const struct sockaddr_in *)item->ai_addr;
                if (inet_ntop(AF_INET, &address->sin_addr, peers[count], sizeof(peers[count]))) count++;
            }
            freeaddrinfo(addresses);
            if (count > 0) {
                portENTER_CRITICAL(&s_route_lock);
                s_peer_count = count;
                memcpy(s_peers, peers, sizeof(s_peers));
                s_peers_ts_us = now_us;
                portEXIT_CRITICAL(&s_route_lock);
            }
        } else if (addresses) {
            freeaddrinfo(addresses);
        }
    }

    if (!count) return esp_http_client_init(config);
    size_t selected = 0;
    for (size_t i = 0; i < count; i++) if (strcmp(peers[i], failed)) { selected = i; break; }
    for (size_t i = 0; i < count; i++) if (!strcmp(peers[i], preferred)) { selected = i; break; }

    char url[512];
    int len = snprintf(url, sizeof(url), "https://%s%s", peers[selected], config->url + 8 + host_len);
    if (len < 0 || len >= (int)sizeof(url)) return NULL;
    esp_http_client_config_t routed = *config;
    routed.url = url;
    // common_name controls both TLS SNI and certificate hostname verification.
    // s_host has static lifetime because ESP-TLS retains this pointer.
    routed.common_name = s_host;
    routed.addr_type = HTTP_ADDR_TYPE_INET;
    esp_http_client_handle_t client = esp_http_client_init(&routed);
    if (client) {
        esp_http_client_set_header(client, "Host", s_host);
        ESP_LOGI("pet_http", "HTTPS peer %s (%s)", peers[selected], s_host);
    }
    return client;
}

void pet_http_note_result(esp_http_client_handle_t client, esp_err_t result) {
    char url[512], peer[INET_ADDRSTRLEN];
    if (!client || esp_http_client_get_url(client, url, sizeof(url)) != ESP_OK || strncmp(url, "https://", 8)) return;
    size_t len = strcspn(url + 8, "/:");
    if (!len || len >= sizeof(peer)) return;
    memcpy(peer, url + 8, len); peer[len] = 0;
    struct in_addr parsed;
    if (inet_pton(AF_INET, peer, &parsed) != 1) return;
    // Only transport errors or 5xx should rotate away from the peer.
    int status = esp_http_client_get_status_code(client);
    bool reachable = result == ESP_OK || (status > 0 && status < 500);
    portENTER_CRITICAL(&s_route_lock);
    if (reachable) memcpy(s_preferred, peer, len + 1);
    else {
        memcpy(s_failed, peer, len + 1);
        if (!strcmp(s_preferred, peer)) s_preferred[0] = 0;
    }
    portEXIT_CRITICAL(&s_route_lock);
}
