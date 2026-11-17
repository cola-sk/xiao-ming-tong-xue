import { NextRequest, NextResponse } from 'next/server';
import {
  listChatMessages,
  createChatMessage,
  markChatMessagePlayed,
} from '@/server/appDataStore';
import { notifyDeviceNewVoice, notifyParentEvent } from '@/server/emqxPublisher';

export const dynamic = 'force-dynamic';

/**
 * 亲子双向微聊 RESTful API (`/api/v1/chat/messages`)
 * - GET: 获取指定设备下的微聊语音消息记录（支持按 direction / status 过滤）
 * - POST: 发送新微聊消息（支持附带录制的 audioBase64 WAV/MP3 原声；仅在未读期中转暂存，已读后立刻销毁，不长期落库）
 * - PATCH: 标记消息已读 (`played`) 并触发清空临时中转音频
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
  const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64 : undefined;
  const audioMime = typeof body.audioMime === 'string' ? body.audioMime : undefined;

  if (!asrText && !audioBase64) {
    return NextResponse.json(
      { error: '语音音频或消息文字不能同时为空' },
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
      asrText: asrText || `（${durationSec}秒原声语音）`,
      autoPlay,
      audioBase64,
      audioMime,
    });

    // 通过 EMQX Cloud Serverless HTTP API 毫秒级通知对端拉取新语音
    if (direction === 'parent_to_device') {
      await notifyDeviceNewVoice(deviceId, {
        msgId: message.id,
        senderName: message.senderName,
        autoPlay: message.autoPlay,
      });
    } else {
      await notifyParentEvent(deviceId, 'new_child_voice', {
        msgId: message.id,
        senderName: message.senderName,
      });
    }

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
