#include <assert.h>
#include <stdio.h>
#include "../main/schedule_rules.h"
int main(void) {
    struct tm monday = { .tm_year = 126, .tm_yday = 22, .tm_wday = 1, .tm_hour = 8, .tm_min = 30 };
    assert(schedule_is_due(true, 8, 30, 0xfe, &monday, 0));
    assert(!schedule_is_due(false, 8, 30, 0xfe, &monday, 0));
    assert(!schedule_is_due(true, 8, 31, 0xfe, &monday, 0));
    assert(!schedule_is_due(true, 8, 30, 1 << 7, &monday, 0));
    assert(!schedule_is_due(true, 8, 30, 0xfe, &monday, schedule_date_stamp(&monday)));
    assert(schedule_is_due(true, 8, 30, 0xfe, &monday, 2025022));
    assert(schedule_is_due(true, 8, 30, 0, &monday, 0));
    assert(!schedule_is_due(true, 8, 30, 0, &monday, 2025022));
    monday.tm_wday = 0;
    assert(schedule_is_due(true, 8, 30, 1 << 7, &monday, 0));
    monday.tm_year = 70;
    assert(!schedule_is_due(true, 8, 30, 0xfe, &monday, 0));

    // Today-filter assertions
    struct tm mon = { .tm_year = 126, .tm_yday = 22, .tm_wday = 1, .tm_hour = 8, .tm_min = 30 };
    struct tm sun = { .tm_year = 126, .tm_yday = 28, .tm_wday = 0, .tm_hour = 8, .tm_min = 30 };
    struct tm invalid = { .tm_year = 70, .tm_yday = 0, .tm_wday = 1, .tm_hour = 8, .tm_min = 30 };
    assert(!schedule_is_for_today(false, 0xfe, &mon, 0));
    assert(!schedule_is_for_today(true, 0xfe, &invalid, 0));
    assert(schedule_is_for_today(true, 1U << 1, &mon, 0));
    assert(!schedule_is_for_today(true, 1U << 2, &mon, 0));
    assert(schedule_is_for_today(true, 1U << 7, &sun, 0));
    assert(schedule_is_for_today(true, 0, &mon, 0));
    assert(schedule_is_for_today(true, 0, &mon, schedule_date_stamp(&mon)));
    assert(!schedule_is_for_today(true, 0, &mon, schedule_date_stamp(&mon) - 1));

    puts("Scheduler: weekday, one-shot, reboot deduplication, year rollover and invalid clock passed");
}
