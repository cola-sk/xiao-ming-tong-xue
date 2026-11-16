import { NextRequest, NextResponse } from 'next/server';

/**
 * 定时语音播报任务管理 API 骨架 (`/api/v1/schedules`)
 * - GET: 设备或家长端拉取定时任务列表（含音频 URL 与 MD5，供 ESP32 静默预下载）
 * - POST: 新增/更新定时任务，生成 TTS/转码音频存入 OSS 并通过 MQTT 通知设备更新 PCF85063 RTC
 */
export async function GET(request: NextRequest) {
  const deviceId = request.nextUrl.searchParams.get('deviceId') || 'esp32_pet_001';
  return NextResponse.json({
    deviceId,
    status: 'ok',
    message: 'Voice schedules API ready (syncs with ESP32 PCF85063 RTC & Flash/TF storage)',
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json({
    status: 'ok',
    taskId: `sched_${Date.now()}`,
    mqttTopic: `pet/${body.deviceId || 'esp32_pet_001'}/schedules`,
    payload: body,
  });
}
