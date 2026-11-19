import { NextRequest } from 'next/server';
import { claimPairing, limitPairing } from '@/server/devicePairing';
import { listDevicesWithStatus, registerDeviceFromParent } from '@/server/deviceStore';
import { getNeonSql } from '@/server/neonDb';
import { pairingResponse, pairingFailure, pairingClientKey } from '@/server/pairingApi';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try {
    await limitPairing(`claim:${pairingClientKey(request)}`, 10);
    const body = await request.json();
    const claimed = await claimPairing(String(body.code || ''), String(body.alias || ''), String(body.childNickname || ''));
    // PostgreSQL claims already create device metadata atomically; memory fallback is only for local development.
    if (!getNeonSql()) await registerDeviceFromParent(claimed);
    const device = (await listDevicesWithStatus()).find(d => d.id === claimed.deviceId);
    return pairingResponse({ status: 'ok', device });
  } catch (error) { return pairingFailure(error); }
}
