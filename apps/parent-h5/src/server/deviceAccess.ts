import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { authenticateDeviceToken } from './devicePairing';

// No header means a family session already validated by middleware.
export async function deviceAccess(request: NextRequest, requestedDeviceId?: string) {
  const token = request.headers.get('x-pet-device-token');
  if (token === null) return { deviceId: null, error: null };
  try {
    const deviceId = await authenticateDeviceToken(token);
    if (!deviceId) return { deviceId: null, error: NextResponse.json({ error: '设备凭证已失效，请重新绑定' }, { status: 401 }) };
    if (requestedDeviceId !== undefined && requestedDeviceId !== deviceId) {
      return { deviceId: null, error: NextResponse.json({ error: '无权访问其他设备' }, { status: 403 }) };
    }
    return { deviceId, error: null };
  } catch {
    return { deviceId: null, error: NextResponse.json({ error: '设备鉴权暂不可用' }, { status: 503 }) };
  }
}
