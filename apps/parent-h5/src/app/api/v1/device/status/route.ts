import { NextRequest, NextResponse } from 'next/server';
import {
  listDevicesWithStatus,
  registerDeviceFromParent,
  updateDeviceVolume,
  deleteDeviceById,
} from '@/server/deviceStore';
import { notifyDeviceConfigChanged } from '@/server/emqxPublisher';

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
    if (action === 'volume') {
      const deviceId = String(body.deviceId || '').trim();
      const volumeLevel = Number(body.volumeLevel);
      if (!deviceId || Number.isNaN(volumeLevel)) {
        return NextResponse.json({ error: '缺少 deviceId 或 volumeLevel' }, { status: 400 });
      }
      const updated = await updateDeviceVolume(deviceId, volumeLevel);
      await notifyDeviceConfigChanged(deviceId, updated?.volumeLevel ?? volumeLevel);
      return NextResponse.json({ status: 'ok', device: updated });
    }

    const deviceId = String(body.deviceId || '').trim();
    const alias = String(body.alias || '').trim();
    const childNickname = String(body.childNickname || '').trim();

    if (!deviceId) {
      return NextResponse.json(
        { error: '请填写设备 ID（可在 ESP32 串口日志或屏幕配对界面查看，如 esp32_pet_a1b2）' },
        { status: 400 }
      );
    }

    const device = await registerDeviceFromParent({
      deviceId,
      alias: alias || `${childNickname || '宝贝'}的小铭同学`,
      childNickname: childNickname || '宝贝',
    });

    return NextResponse.json({ status: 'ok', device });
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
    await deleteDeviceById(deviceId);
    return NextResponse.json({ status: 'ok', deletedDeviceId: deviceId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '解绑设备失败' },
      { status: 500 }
    );
  }
}
