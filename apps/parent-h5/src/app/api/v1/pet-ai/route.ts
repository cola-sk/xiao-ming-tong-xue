import { NextRequest, NextResponse } from 'next/server';

/**
 * AI 宠物人设与音色配置 API 骨架 (`/api/v1/pet-ai`)
 * - GET: 获取当前设备绑定的宠物人设 Prompt、TTS 音色 ID 与音量设置
 * - PATCH: 更新 AI 宠物配置
 */
export async function GET(request: NextRequest) {
  const deviceId = request.nextUrl.searchParams.get('deviceId') || 'esp32_pet_001';
  return NextResponse.json({
    deviceId,
    status: 'ok',
    message: 'Pet AI persona & voice configuration API ready',
  });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json({
    status: 'ok',
    updated: body,
  });
}
