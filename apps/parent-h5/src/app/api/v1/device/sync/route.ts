import { NextRequest, NextResponse } from 'next/server';
import { upsertDeviceHeartbeat } from '@/server/deviceStore';

/**
 * ESP32-S3 设备状态同步与事件上报 API (`/api/v1/device/sync`)
 * - 接收 ESP32-S3 周期性 HTTPS 心跳 (`heartbeat`) 或状态事件 (`alarm_ack`, `voice_read`)
 * - 写入 Neon PostgreSQL `devices` 表更新 `last_seen_at`、`battery_percent`、`wifi_rssi`
 * - 响应下行同步配置（服务端当前时间戳供 PCF85063 RTC 校时、ES8311 音量等）
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const deviceId = String(body.deviceId || '').trim();

  if (!deviceId) {
    return NextResponse.json(
      { error: '缺少必填字段 deviceId' },
      { status: 400 }
    );
  }

  try {
    const device = await upsertDeviceHeartbeat({
      deviceId,
      macAddress: typeof body.macAddress === 'string' ? body.macAddress : undefined,
      firmwareVersion: typeof body.firmwareVersion === 'string' ? body.firmwareVersion : undefined,
      batteryPercent:
        typeof body.batteryPercent === 'number' ? body.batteryPercent : undefined,
      wifiRssi: typeof body.wifiRssi === 'number' ? body.wifiRssi : undefined,
    });

    return NextResponse.json({
      status: 'ok',
      serverTime: new Date().toISOString(),
      serverEpochSec: Math.floor(Date.now() / 1000),
      receivedEvent: body.event || 'heartbeat',
      config: {
        volumeLevel: device.volumeLevel,
        heartbeatIntervalSec: 15,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '设备状态同步失败' },
      { status: 500 }
    );
  }
}
