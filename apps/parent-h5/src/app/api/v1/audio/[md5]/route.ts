import { NextRequest, NextResponse } from 'next/server';
import { getAudioByMd5 } from '@/server/audioStore';

/**
 * 托管豆包合成音频的永久 HTTP 地址 (`GET /api/v1/audio/[md5]`)
 * - 支持 `/api/v1/audio/e10adc3949ba59abbe56e057f20f883e` 或 `/api/v1/audio/e10adc3949ba59abbe56e057f20f883e.mp3`
 * - 设置 `Cache-Control: public, max-age=31536000, immutable`，部署到 Vercel 后由 Vercel CDN 边缘节点永久缓存，ESP32 设备与 H5 端直接通过该地址零成本高速播放！
 */
export async function GET(
  _request: NextRequest,
  context: { params: { md5: string } }
) {
  const md5 = context.params.md5 || '';
  const audio = await getAudioByMd5(md5);

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
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
