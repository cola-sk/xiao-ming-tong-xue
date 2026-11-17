import { NextRequest, NextResponse } from 'next/server';
import { authConfigured, createFamilySession, FAMILY_COOKIE, safeEqual, validFamilySession } from '@/server/familyAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return NextResponse.json({ configured: authConfigured(), authenticated: await validFamilySession(request.cookies.get(FAMILY_COOKIE)?.value || '') }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  if (!authConfigured()) return NextResponse.json({ error: '服务端尚未配置家庭访问凭证' }, { status: 503 });
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) return NextResponse.json({ error: '请求来源不允许' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const [usernameMatches, passwordMatches] = await Promise.all([
    safeEqual(username, process.env.PET_FAMILY_USERNAME || ''),
    safeEqual(password, process.env.PET_FAMILY_PASSWORD || ''),
  ]);
  if (username.length > 1024 || password.length > 1024 || !usernameMatches || !passwordMatches) {
    return NextResponse.json({ error: '用户名或密码不正确' }, { status: 401 });
  }
  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(FAMILY_COOKIE, await createFamilySession(), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 7 * 24 * 60 * 60,
  });
  return response;
}

export async function DELETE(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) return NextResponse.json({ error: '请求来源不允许' }, { status: 403 });
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(FAMILY_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0 });
  return response;
}
