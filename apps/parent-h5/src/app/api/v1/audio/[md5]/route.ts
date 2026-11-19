import { deviceAccess } from '@/server/deviceAccess';
import { listVoiceSchedules } from '@/server/appDataStore';
import { NextRequest, NextResponse } from 'next/server';
import { getAudioByMd5 } from '@/server/audioStore';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: { md5: string } }
) {
  const md5 = context.params.md5 || '';
  const cleanMd5 = md5.replace(/\.mp3$/i, '').trim().toLowerCase();
  const access = await deviceAccess(request);
  if (access.error) return access.error;
  if (access.deviceId) {
    const schedules = await listVoiceSchedules(access.deviceId);
    const matched = schedules.some(
      s =>
        (s.audioMd5 || '').trim().toLowerCase() === cleanMd5 ||
        (s.audioUrl || '').toLowerCase().includes(cleanMd5)
    );
    if (!matched) {
      console.warn('[audio/md5] 404 schedule mismatch', {
        deviceId: access.deviceId,
        cleanMd5,
        schedules: schedules.map(s => ({ id: s.id, deviceId: s.deviceId, audioMd5: s.audioMd5 })),
      });
      return NextResponse.json({ error: '音频不存在' }, { status: 404 });
    }
  }
  const audio = await getAudioByMd5(cleanMd5);

  if (!audio) {
    return NextResponse.json(
      { error: 'Audio file not found in cache or database' },
      { status: 404 }
    );
  }

  return new NextResponse(new Uint8Array(audio.buffer), {
    status: 200,
    headers: {
      'Content-Type': audio.mimeType,
      'Content-Length': String(audio.buffer.length),
      'Cache-Control': 'private, no-store',
    },
  });
}
