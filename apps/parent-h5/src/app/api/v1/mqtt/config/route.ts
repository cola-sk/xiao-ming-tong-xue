import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// MQTT is disabled; do not expose broker credentials.
export async function GET() {
  return NextResponse.json({ status: 'disabled', publishConfigured: false, wssConfigured: false });
}
