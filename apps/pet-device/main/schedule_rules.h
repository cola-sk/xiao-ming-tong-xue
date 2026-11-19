#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <time.h>
// Empty repeat mask is one shot. Stamps include the year and survive reboot.
static inline int32_t schedule_date_stamp(const struct tm *t) {
    return (t->tm_year + 1900) * 1000 + t->tm_yday;
}
static inline bool schedule_is_due(bool enabled, int hour, int minute, unsigned mask,
                                    const struct tm *t, int32_t last_date) {
    if (!enabled || t->tm_year < 124 || hour < 0 || minute < 0 || hour > 23 || minute > 59 || hour != t->tm_hour || minute != t->tm_min) return false;
    unsigned weekday = t->tm_wday ? t->tm_wday : 7;
    if (mask && !(mask & (1U << weekday))) return false;
    return mask ? last_date != schedule_date_stamp(t) : last_date == 0;
}

static inline bool schedule_is_for_today(bool enabled, unsigned mask,
                                         const struct tm *t, int32_t last_date) {
    if (!enabled || t->tm_year < 124) return false;
    unsigned weekday = t->tm_wday ? t->tm_wday : 7;
    if (mask) return (mask & (1U << weekday)) != 0;
    return last_date == 0 || last_date == schedule_date_stamp(t);
}
