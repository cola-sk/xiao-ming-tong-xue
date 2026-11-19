import { deviceAccess } from '@/server/deviceAccess';
import { NextRequest, NextResponse } from 'next/server';
import {
  listVoiceSchedules,
  upsertVoiceSchedule,
  toggleVoiceSchedule,
  deleteVoiceScheduleById,
} from '@/server/appDataStore';

export const dynamic = 'force-dynamic';

/**
 * 定时语音播报任务管理 API (`/api/v1/schedules`)
 * - GET: 获取定时任务列表（含永久音频 URL 与 MD5，供家长端与 ESP32 PCF85063 RTC 同步）
 * - POST: 新增或更新定时任务
 * - PATCH: 切换启用开关
 * - DELETE: 删除定时任务
 */
export async function GET(request: NextRequest) {
  const requestedId = request.nextUrl.searchParams.get('deviceId') || undefined;
  const access = await deviceAccess(request, requestedId);
  if (access.error) return access.error;
  const deviceId = access.deviceId || requestedId;
  try {
    const schedules = await listVoiceSchedules(deviceId);
    return NextResponse.json({
      status: 'ok',
      deviceId: deviceId || 'all',
      schedules,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '获取定时任务失败' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  const timeStr = String(body.timeStr || '').trim();
  const textContent = String(body.textContent || '').trim();

  if (!title || !timeStr || !textContent) {
    return NextResponse.json(
      { error: '缺少必填字段 title / timeStr / textContent' },
      { status: 400 }
    );
  }

  try {
    const schedule = await upsertVoiceSchedule({
      id: body.id ? String(body.id) : undefined,
      deviceId: body.deviceId ? String(body.deviceId) : 'default',
      title,
      cronExpr: String(body.cronExpr || '30 7 * * 1,2,3,4,5'),
      timeStr,
      repeatDays: Array.isArray(body.repeatDays) ? body.repeatDays.map(Number) : [1, 2, 3, 4, 5],
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
      sourceType:
        body.sourceType === 'parent_clone'
          ? 'parent_clone'
          : body.sourceType === 'record'
          ? 'record'
          : 'tts',
      clonedVoiceId: body.clonedVoiceId ? String(body.clonedVoiceId) : null,
      clonedSpeakerRole: body.clonedSpeakerRole ? String(body.clonedSpeakerRole) : null,
      textContent,
      audioUrl: body.audioUrl ? String(body.audioUrl) : null,
      audioMd5: body.audioMd5 ? String(body.audioMd5) : null,
      repeatPlayCount: Number(body.repeatPlayCount ?? 2),
    });

    return NextResponse.json({
      status: 'ok',
      schedule,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '保存定时任务失败' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '').trim();
  if (!id) {
    return NextResponse.json({ error: '缺少任务 id' }, { status: 400 });
  }
  try {
    const updated = await toggleVoiceSchedule(
      id,
      typeof body.enabled === 'boolean' ? body.enabled : undefined
    );
    return NextResponse.json({ status: 'ok', schedule: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '更新任务开关失败' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id) {
    return NextResponse.json({ error: '缺少任务 id 参数' }, { status: 400 });
  }
  try {
    await deleteVoiceScheduleById(id);

    return NextResponse.json({ status: 'ok', deletedId: id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除定时任务失败' },
      { status: 500 }
    );
  }
}
