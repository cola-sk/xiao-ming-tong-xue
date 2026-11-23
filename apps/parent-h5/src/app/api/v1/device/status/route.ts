import { NextRequest, NextResponse } from 'next/server';
import {
  listDevicesWithStatus,
  updateDeviceVolume,
  updateDeviceAutoPlay,
  deleteDeviceById,
} from '@/server/deviceStore';

import { revokeDeviceCredential } from '@/server/devicePairing';

export const dynamic = 'force-dynamic';

/**
 * 家长端设备状态查询与绑定 API (`/api/v1/device/status`)
 */
export async function GET() {
  try {
    const devices = await listDevicesWithStatus();
    return NextResponse.json({
      status: 'ok',
      devices,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '获取设备状态失败' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || 'bind');

  try {
    if (action === 'autoPlay') {
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId || typeof body.enabled !== 'boolean') return NextResponse.json({ error: '参数无效' }, { status: 400 });
      const device = await updateDeviceAutoPlay(deviceId, body.enabled);
      if (!device) return NextResponse.json({ error: '设备不存在' }, { status: 404 });
      return NextResponse.json({ status: 'ok', device });
    }
    if (action === 'volume') {
      const deviceId = String(body.deviceId || '').trim();
      const volumeLevel = Number(body.volumeLevel);
      if (!deviceId || Number.isNaN(volumeLevel)) {
        return NextResponse.json({ error: '缺少 deviceId 或 volumeLevel' }, { status: 400 });
      }
      const updated = await updateDeviceVolume(deviceId, volumeLevel);

      return NextResponse.json({ status: 'ok', device: updated });
    }

    return NextResponse.json({ error: '请使用设备屏幕上的绑定码进行配对' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '设备操作失败' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const deviceId = request.nextUrl.searchParams.get('deviceId')?.trim();
  if (!deviceId) {
    return NextResponse.json({ error: '缺少 deviceId 参数' }, { status: 400 });
  }
  try {
    await revokeDeviceCredential(deviceId);
    await deleteDeviceById(deviceId);
    return NextResponse.json({ status: 'ok', deletedDeviceId: deviceId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '解绑设备失败' },
      { status: 500 }
    );
  }
}
