import { NextRequest } from 'next/server';
import { startPairing, limitPairing } from '@/server/devicePairing';
import { pairingResponse, pairingFailure, pairingClientKey } from '@/server/pairingApi';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try {
    await limitPairing(`start:${pairingClientKey(request)}`, 12, 600000);
    const body = await request.json();
    const result = await startPairing(String(body.deviceId || ''), String(body.setupSecret || ''));
    return pairingResponse(result);
  } catch (error) { return pairingFailure(error); }
}
