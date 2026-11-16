import { NextRequest, NextResponse } from 'next/server';

/**
 * ESP32-S3 设备状态同步与事件上报 API (`/api/v1/device/sync`)
 * - 接收设备上报的 `alarm_ack`（孩子点击触摸屏确认闹钟）、`voice_read`（孩子收听微聊语音）、`battery_percent`（AXP2101 电量）
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json({
    status: 'ok',
    serverTime: new Date().toISOString(),
    receivedEvent: body.event || 'heartbeat',
  });
}
