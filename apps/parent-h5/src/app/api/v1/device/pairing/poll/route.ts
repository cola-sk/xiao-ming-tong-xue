import { NextRequest } from 'next/server';
import { pollPairing, limitPairing } from '@/server/devicePairing';
import { pairingResponse, pairingFailure, pairingClientKey } from '@/server/pairingApi';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try {
    await limitPairing(`poll:${pairingClientKey(request)}`, 120);
    const body = await request.json();
    return pairingResponse(await pollPairing(String(body.deviceId || ''), String(body.setupSecret || '')));
  } catch (error) { return pairingFailure(error); }
}
