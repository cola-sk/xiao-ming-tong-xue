import { NextRequest, NextResponse } from 'next/server';

/**
 * 亲子双向微聊 RESTful API 骨架 (`/api/v1/chat/messages`)
 * - GET: 获取指定设备或家庭下的微聊语音消息记录
 * - POST: 上传新的语音消息并触发 MQTT 通知（Parent <-> Device 双向通用）
 */
export async function GET(request: NextRequest) {
  const deviceId = request.nextUrl.searchParams.get('deviceId') || 'esp32_pet_001';
  return NextResponse.json({
    deviceId,
    status: 'ok',
    message: 'Chat messages API ready (connects to Supabase chat_voice_messages & MQTT gateway)',
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json({
    status: 'ok',
    msgId: `msg_${Date.now()}`,
    mqttTopic: `pet/${body.deviceId || 'esp32_pet_001'}/voice`,
    payload: body,
  });
}
