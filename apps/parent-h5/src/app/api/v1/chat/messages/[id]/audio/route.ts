import { deviceAccess } from '@/server/deviceAccess';
import { NextRequest, NextResponse } from 'next/server';
import { getTransientChatAudio } from '@/server/appDataStore';

export const dynamic = 'force-dynamic';

/**
 * 亲子微聊未读音频临时投递接口 (`GET /api/v1/chat/messages/[id]/audio`)
 * - 供 ESP32 设备或家长 H5 拉取对方按住录制的 WAV/MP3 原声音频
 * - 音频仅在 `unread` 期间暂存，对方播放并上报 `voice_read` 后即刻清除，不在数据库长期留存
 */
export async function GET(
  request: NextRequest,
  context: { params: { id: string } }
) {
  const access = await deviceAccess(request);
  if (access.error) return access.error;
  const id = context.params.id || '';
  const audio = await getTransientChatAudio(id, access.deviceId || undefined);

  if (!audio) {
    return NextResponse.json(
      { error: 'Chat audio not found or already cleaned up after read' },
      { status: 404 }
    );
  }

  return new NextResponse(new Uint8Array(audio.buffer), {
    status: 200,
    headers: {
      'Content-Type': audio.mimeType,
      'Content-Length': String(audio.buffer.length),
      'Cache-Control': 'no-store',
    },
  });
}
