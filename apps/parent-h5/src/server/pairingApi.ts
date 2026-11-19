import { NextRequest, NextResponse } from 'next/server';
import { PairingError } from './devicePairing';
export function pairingResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
export function pairingFailure(error: unknown) {
  return pairingResponse({ error: error instanceof PairingError ? error.message : '配对服务暂不可用，请稍后重试' }, error instanceof PairingError ? error.status : 503);
}
export function pairingClientKey(request: NextRequest) {
  // On Vercel this header is overwritten by the platform; never trust a client-supplied device ID as the sole rate limit.
  return request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}
