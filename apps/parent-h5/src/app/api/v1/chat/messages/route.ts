import { NextRequest, NextResponse } from 'next/server';
import {
  listChatMessages,
  createChatMessage,
  markChatMessagePlayed,
} from '@/server/appDataStore';

export const dynamic = 'force-dynamic';

/**
 * 亲子双向微聊 RESTful API (`/api/v1/chat/messages`)
 * - GET: 获取指定设备下的微聊语音消息记录（支持按 direction / status 过滤）
 * - POST: 发送新微聊消息（Parent <-> Device 双向，仅保存消息元数据与文字转写，音频流不永久落库）
 * - PATCH: 标记消息已读 (`played`)
 */
export async function GET(request: NextRequest) {
  const deviceId = request.nextUrl.searchParams.get('deviceId') || undefined;
  const directionParam = request.nextUrl.searchParams.get('direction');
  const statusParam = request.nextUrl.searchParams.get('status');

  const direction =
    directionParam === 'parent_to_device' || directionParam === 'device_to_parent'
      ? directionParam
      : undefined;
  const status =
    statusParam === 'unread' || statusParam === 'played' ? statusParam : undefined;

  try {
    const messages = await listChatMessages({
      deviceId,
      direction,
      status,
    });
    return NextResponse.json({
      status: 'ok',
      deviceId: deviceId || 'all',
      messages,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '获取微聊消息失败' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const asrText = String(body.asrText || '').trim();
  const direction =
    body.direction === 'device_to_parent' ? 'device_to_parent' : 'parent_to_device';
  const senderName = String(
    body.senderName || (direction === 'device_to_parent' ? '宝贝' : '妈妈')
  ).trim();
  const durationSec = Number(body.durationSec || 3);
  const autoPlay = Boolean(body.autoPlay);
  const deviceId = body.deviceId ? String(body.deviceId) : 'default';

  if (!asrText) {
    return NextResponse.json(
      { error: '消息内容不能为空' },
      { status: 400 }
    );
  }

  try {
    const message = await createChatMessage({
      id: body.id ? String(body.id) : undefined,
      deviceId,
      direction,
      senderName,
      durationSec,
      asrText,
      autoPlay,
    });
    return NextResponse.json({
      status: 'ok',
      message,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '发送微聊消息失败' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '').trim();
  if (!id) {
    return NextResponse.json({ error: '缺少消息 id' }, { status: 400 });
  }
  try {
    await markChatMessagePlayed(id);
    return NextResponse.json({ status: 'ok', id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '更新消息状态失败' },
      { status: 500 }
    );
  }
}
