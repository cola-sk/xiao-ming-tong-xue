#include "pet_http_auth.h"
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "esp_log.h"
#include "lwip/netdb.h"
#include "lwip/inet.h"

static portMUX_TYPE s_route_lock = portMUX_INITIALIZER_UNLOCKED;
static char s_host[128], s_preferred[INET_ADDRSTRLEN], s_failed[INET_ADDRSTRLEN];

// ESP-TLS only connects to the first getaddrinfo result. Resolve all available
// A records and move away from a failed peer, retaining the DNS TTL in lwIP.
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
    char preferred[INET_ADDRSTRLEN], failed[INET_ADDRSTRLEN];
    portENTER_CRITICAL(&s_route_lock);
    if (!s_host[0]) { memcpy(s_host, host_start, host_len); s_host[host_len] = 0; }
    memcpy(preferred, s_preferred, sizeof(preferred));
    memcpy(failed, s_failed, sizeof(failed));
    portEXIT_CRITICAL(&s_route_lock);

    struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_STREAM };
    struct addrinfo *addresses = NULL;
    if (getaddrinfo(s_host, "443", &hints, &addresses) || !addresses)
        return esp_http_client_init(config);
    char peers[4][INET_ADDRSTRLEN] = {0}; size_t count = 0;
    for (struct addrinfo *item = addresses; item && count < 4; item = item->ai_next) {
        const struct sockaddr_in *address = (const struct sockaddr_in *)item->ai_addr;
        if (inet_ntop(AF_INET, &address->sin_addr, peers[count], sizeof(peers[count]))) count++;
    }
    freeaddrinfo(addresses);
    if (!count) return esp_http_client_init(config);
    size_t selected = 0;
    for (size_t i = 0; i < count; i++) if (strcmp(peers[i], failed)) { selected = i; break; }
    for (size_t i = 0; i < count; i++) if (!strcmp(peers[i], preferred)) { selected = i; break; }

    char url[512];
    int len = snprintf(url, sizeof(url), "https://%s%s", peers[selected], config->url + 8 + host_len);
    if (len < 0 || len >= sizeof(url)) return NULL;
    esp_http_client_config_t routed = *config;
    routed.url = url;
    // common_name controls both TLS SNI and certificate hostname verification.
    // It has static lifetime because ESP-TLS retains this pointer.
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
    // Only routed requests use this wrapper. An HTTP error still proves the
    // peer was reachable; it must not be treated as a transport failure.
    bool reachable = result == ESP_OK || esp_http_client_get_status_code(client) > 0;
    portENTER_CRITICAL(&s_route_lock);
    if (reachable) memcpy(s_preferred, peer, len + 1);
    else {
        memcpy(s_failed, peer, len + 1);
        if (!strcmp(s_preferred, peer)) s_preferred[0] = 0;
    }
    portEXIT_CRITICAL(&s_route_lock);
}
