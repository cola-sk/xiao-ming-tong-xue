idf_component_register(
    SRCS
        "main.c"
        "device_storage.c"
        "ui_state_machine.c"
        "pet_display.c"
        "pet_font.c"
        "audio_engine.c"
        "audio_download.c"
        "hardware_keys.c"
        "voice_encoder.c"
        "rtc_scheduler.c"
        "wifi_manager.c"
        "device_sync.c"
        "device_pairing.c"
        "pet_http_route.c"
        "chat_client.c"
        "chat_storage.c"
        "mqtt_client_mgr.c"
    INCLUDE_DIRS "."
    REQUIRES
        driver
        esp_wifi
        esp_netif
        nvs_flash
        spiffs
        esp_http_client
        espressif__esp_audio_codec
        esp-tls
        mqtt
        mbedtls
        json
        waveshare__esp32_s3_touch_amoled_2_16
        lvgl__lvgl
)

# Explicit opt-in check with a synthetic MP3; normal firmware never runs this.
if(PET_HARDWARE_SMOKE)
    if(NOT EXISTS "${PET_SMOKE_MP3}")
        message(FATAL_ERROR "PET_SMOKE_MP3 must point to synthetic test audio")
    endif()
    target_sources(${COMPONENT_LIB} PRIVATE "../tests/hardware_smoke.c")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE PET_HARDWARE_SMOKE=1)
    target_add_binary_data(${COMPONENT_LIB} "${PET_SMOKE_MP3}" BINARY RENAME_TO smoke_voice)
    if(EXISTS "${PET_SMOKE_PCM}")
        target_add_binary_data(${COMPONENT_LIB} "${PET_SMOKE_PCM}" BINARY RENAME_TO smoke_pcm)
        target_compile_definitions(${COMPONENT_LIB} PRIVATE PET_SMOKE_SPOKEN_PCM=1)
    endif()
endif()
