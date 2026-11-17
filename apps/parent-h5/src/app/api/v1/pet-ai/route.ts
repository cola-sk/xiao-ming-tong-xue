import { NextRequest, NextResponse } from 'next/server';
import {
  getPetAiConfig,
  upsertPetAiConfig,
  listAiChatLogs,
} from '@/server/appDataStore';

export const dynamic = 'force-dynamic';

/**
 * AI 宠物人设、音色配置与伴聊记录 API (`/api/v1/pet-ai`)
 * - GET: 获取当前设备绑定的宠物人设 Prompt、TTS 音色 ID、音量及最近问答文本日志
 * - PATCH: 更新 AI 宠物配置并持久化到 Neon PostgreSQL
 */
export async function GET(request: NextRequest) {
  const deviceId = request.nextUrl.searchParams.get('deviceId') || 'default';
  try {
    const [config, logs] = await Promise.all([
      getPetAiConfig(deviceId),
      listAiChatLogs(deviceId === 'default' ? undefined : deviceId),
    ]);
    return NextResponse.json({
      status: 'ok',
      deviceId,
      config,
      logs,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '获取 AI 宠物配置失败' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const deviceId = String(body.deviceId || 'default');
  try {
    const updated = await upsertPetAiConfig(deviceId, {
      petName: typeof body.petName === 'string' ? body.petName : undefined,
      personaId: typeof body.personaId === 'string' ? body.personaId : undefined,
      voiceId: typeof body.voiceId === 'string' ? body.voiceId : undefined,
      customPrompt: typeof body.customPrompt === 'string' ? body.customPrompt : undefined,
      volumeLevel: typeof body.volumeLevel === 'number' ? body.volumeLevel : undefined,
    });
    return NextResponse.json({
      status: 'ok',
      config: updated,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '更新 AI 宠物配置失败' },
      { status: 500 }
    );
  }
}
