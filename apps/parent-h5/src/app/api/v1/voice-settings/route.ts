import { NextRequest, NextResponse } from 'next/server';
import { deviceAccess } from '@/server/deviceAccess';
import { getVoiceLoudnessRate, setVoiceLoudnessRate } from '@/server/voiceSettings';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const access = await deviceAccess(request);
  if (access.error) return access.error;
  try { return NextResponse.json({ loudnessRate: await getVoiceLoudnessRate() }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: '获取合成音量失败' }, { status: 503 }); }
}
export async function PATCH(request: NextRequest) {
  const access = await deviceAccess(request);
  if (access.error) return access.error;
  if (access.deviceId) {
    return NextResponse.json({ error: '仅家长端可修改合成音量' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  if (!Number.isInteger(body.loudnessRate) || body.loudnessRate < -50 || body.loudnessRate > 100) {
    return NextResponse.json({ error: '合成音量必须为 -50 到 100 的整数' }, { status: 400 });
  }
  try { await setVoiceLoudnessRate(body.loudnessRate); return NextResponse.json({ loudnessRate: body.loudnessRate }); }
  catch { return NextResponse.json({ error: '保存合成音量失败' }, { status: 503 }); }
}
