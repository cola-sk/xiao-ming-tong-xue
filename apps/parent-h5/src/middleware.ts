import { NextRequest, NextResponse } from 'next/server';
import { authConfigured, FAMILY_COOKIE, validFamilySession } from './server/familyAuth';

function deviceAllowed(method: string, path: string): boolean {
  return (method === 'POST' && ['/api/v1/device/sync', '/api/v1/chat/messages', '/api/v1/ai/chat', '/api/v1/tts'].includes(path)) ||
    (method === 'GET' && (path === '/api/v1/chat/messages' || path === '/api/v1/schedules' || /^\/api\/v1\/chat\/messages\/[^/]+\/audio$/.test(path) || /^\/api\/v1\/audio\/[^/]+$/.test(path)));
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === '/api/v1/auth') return NextResponse.next();
  if (!authConfigured()) return NextResponse.json({ error: '服务端尚未配置访问凭证' }, { status: 503 });
  if (request.method === 'POST' && ['/api/v1/device/pairing/start', '/api/v1/device/pairing/poll'].includes(path)) return NextResponse.next();
  const token = request.headers.get('x-pet-device-token') || '';
  // Node route handlers validate the per-device credential against the database.
  if (token && deviceAllowed(request.method, path)) return NextResponse.next();
  if (!(await validFamilySession(request.cookies.get(FAMILY_COOKIE)?.value || ''))) {
    return NextResponse.json({ error: '请先登录' }, { status: 401 });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (!origin || origin !== request.nextUrl.origin) return NextResponse.json({ error: '请求来源不允许' }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };
