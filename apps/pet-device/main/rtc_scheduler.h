#pragma once
#include <stdint.h>

/**
 * 本地定时任务调度器 (PCF85063 硬件 RTC 芯片 + LittleFS/TF卡音频预下载缓存)
 */
void rtc_scheduler_init(void);
void rtc_scheduler_sync_from_json(const char *schedules_json);
