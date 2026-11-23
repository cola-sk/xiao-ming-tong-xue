import { deviceAccess } from '@/server/deviceAccess';
import { NextRequest, NextResponse } from 'next/server';
import { upsertDeviceHeartbeat } from '@/server/deviceStore';
import {
  ackVoiceSchedule,
  markChatMessagePlayed,
  listChatMessages,
  listVoiceSchedules,
  getPetAiConfig,
} from '@/server/appDataStore';
import { createHash } from 'node:crypto';

export const dynamic = 'force-dynamic';

/**
 * ESP32-S3 设备状态同步与事件上报 API (`/api/v1/device/sync`)
 * - 接收 ESP32-S3 周期性 HTTPS 心跳 (`heartbeat`) 或状态事件 (`alarm_ack`, `voice_read`)
 * - 更新 Neon PostgreSQL `devices` 表及关联的 `voice_schedules` / `chat_voice_messages` 状态
 * - 响应下行同步配置（服务端当前时间戳供 PCF85063 RTC 校时、待收听未读微聊数量与日程数；设备音量以设备本机设置为准）
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const deviceId = String(body.deviceId || '').trim();
  const event = String(body.event || 'heartbeat').trim();
  const access = await deviceAccess(request, deviceId);
  if (access.error) return access.error;

  if (!deviceId) {
    return NextResponse.json(
      { error: '缺少必填字段 deviceId' },
      { status: 400 }
    );
  }

  try {
    // 1) 更新设备心跳状态
    const device = await upsertDeviceHeartbeat({
      deviceId,
      macAddress: typeof body.macAddress === 'string' ? body.macAddress : undefined,
      firmwareVersion: typeof body.firmwareVersion === 'string' ? body.firmwareVersion : undefined,
      batteryPercent:
        typeof body.batteryPercent === 'number' ? body.batteryPercent : undefined,
      wifiRssi: typeof body.wifiRssi === 'number' ? body.wifiRssi : undefined,
    });

    // 2) 若携带业务确认事件，同步落库
    if (event === 'alarm_ack' && body.taskId) {
      await ackVoiceSchedule(String(body.taskId), access.deviceId || undefined);
    } else if (event === 'voice_read' && body.msgId) {
      await markChatMessagePlayed(String(body.msgId), access.deviceId || undefined);
    }

    // 3) 查询待下行同步的任务与未读消息摘要
    const [unreadMsgs, schedules, petConfig] = await Promise.all([
      listChatMessages({ deviceId, direction: 'parent_to_device', status: 'unread' }),
      listVoiceSchedules(deviceId),
      getPetAiConfig(deviceId),
    ]);

    return NextResponse.json({
      status: 'ok',
      serverTime: new Date().toISOString(),
      serverEpochSec: Math.floor(Date.now() / 1000),
      receivedEvent: event,
      config: {
        petName: petConfig?.petName ?? '小铭同学',
        voiceId: petConfig?.voiceId ?? 'zh_female_vv_uranus_bigtts',
        unreadMessagesCount: unreadMsgs.length,
        enabledSchedulesCount: schedules.filter(s => s.enabled).length,
        scheduleVersion: createHash('sha256').update(JSON.stringify([...schedules].sort((a, b) => a.id.localeCompare(b.id)))).digest('hex'),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '设备状态同步失败' },
      { status: 500 }
    );
  }
}
