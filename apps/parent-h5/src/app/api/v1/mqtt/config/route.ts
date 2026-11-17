import { NextResponse } from 'next/server';
import { getEmqxConfig, isEmqxPublishConfigured } from '@/server/emqxPublisher';

export const dynamic = 'force-dynamic';

/**
 * 获取 EMQX Cloud Serverless WSS 客户端配置 (`/api/v1/mqtt/config`)
 * - 供家长端 H5 建立实时 WebSocket (`wss://<host>:8084/mqtt`) 监听孩子语音与设备状态事件
 */
export async function GET() {
  const cfg = getEmqxConfig();
  const wssConfigured = Boolean(
    cfg.clientWssUrl && cfg.clientUsername && cfg.clientPassword
  );

  return NextResponse.json({
    status: 'ok',
    publishConfigured: isEmqxPublishConfigured(),
    wssConfigured,
    wssUrl: wssConfigured ? cfg.clientWssUrl : '',
    username: wssConfigured ? cfg.clientUsername : '',
    password: wssConfigured ? cfg.clientPassword : '',
  });
}
