import 'server-only';

/**
 * EMQX Cloud Serverless HTTP Publish API 客户端 (`emqxPublisher.ts`)
 *
 * 【为什么 Vercel 端用 HTTP Publish API，而不用 TCP MQTT 长连？】
 * Vercel Serverless Functions 是短生命周期无状态容器，使用 EMQX Cloud 提供的
 * `POST https://<EMQX_HOST>:8443/api/v5/publish` REST 接口可零握手成本、
 * < 100ms 将唤醒信令推给常连 `mqtts://:8883` 的 ESP32 设备与常连 `wss://:8084/mqtt` 的家长端 H5。
 */

export interface EmqxServerConfig {
  host: string;
  httpPort: number;
  appId: string;
  appSecret: string;
  clientWssUrl: string;
  clientUsername: string;
  clientPassword: string;
}

export function getEmqxConfig(): EmqxServerConfig {
  const host = (process.env.EMQX_HOST || '').trim();
  const httpPort = Number(process.env.EMQX_HTTP_PORT || 8443);
  const appId = (process.env.EMQX_APP_ID || '').trim();
  const appSecret = (process.env.EMQX_APP_SECRET || '').trim();
  const wssPort = Number(process.env.EMQX_WSS_PORT || 8084);
  const clientWssUrl =
    (process.env.EMQX_WSS_URL || '').trim() ||
    (host ? `wss://${host}:${wssPort}/mqtt` : '');

  return {
    host,
    httpPort,
    appId,
    appSecret,
    clientWssUrl,
    clientUsername: (process.env.EMQX_CLIENT_USERNAME || '').trim(),
    clientPassword: (process.env.EMQX_CLIENT_PASSWORD || '').trim(),
  };
}

export function isEmqxPublishConfigured(): boolean {
  const cfg = getEmqxConfig();
  return Boolean(cfg.host && cfg.appId && cfg.appSecret);
}

/**
 * 通过 EMQX Serverless HTTP API (`/api/v5/publish`) 向指定 Topic 推送 QoS 1 信令
 */
export async function publishEmqxNotification(
  topic: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const cfg = getEmqxConfig();
  if (!cfg.host || !cfg.appId || !cfg.appSecret) {
    return false;
  }

  const url = `https://${cfg.host}:${cfg.httpPort}/api/v5/publish`;
  const auth = Buffer.from(`${cfg.appId}:${cfg.appSecret}`).toString('base64');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        topic,
        qos: 1,
        retain: false,
        payload_encoding: 'plain',
        payload: JSON.stringify({
          ...payload,
          ts: Date.now(),
        }),
      }),
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`EMQX publish failed (${res.status}): ${errText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('EMQX publish request error:', err);
    return false;
  }
}

/**
 * 通知 ESP32-S3：收到家长发来的新微聊语音
 */
export async function notifyDeviceNewVoice(
  deviceId: string,
  meta: { msgId: string; senderName: string; autoPlay: boolean }
): Promise<void> {
  const target = deviceId && deviceId !== 'all' ? deviceId : 'default';
  await publishEmqxNotification(`pet/${target}/notify`, {
    event: 'new_voice_msg',
    msgId: meta.msgId,
    senderName: meta.senderName,
    autoPlay: meta.autoPlay,
  });
}

/**
 * 通知 ESP32-S3：云端定时语音日程有更新，立刻拉取同步
 */
export async function notifyDeviceSchedulesChanged(deviceId?: string): Promise<void> {
  const target = deviceId && deviceId !== 'all' ? deviceId : 'default';
  await publishEmqxNotification(`pet/${target}/notify`, {
    event: 'schedules_updated',
  });
}

/**
 * 通知 ESP32-S3：云端音量或宠物人设配置变更
 */
export async function notifyDeviceConfigChanged(
  deviceId: string,
  volumeLevel?: number
): Promise<void> {
  const target = deviceId && deviceId !== 'all' ? deviceId : 'default';
  await publishEmqxNotification(`pet/${target}/notify`, {
    event: 'config_updated',
    volumeLevel,
  });
}

/**
 * 通知家长端 H5（WSS）：孩子上传新语音 / 点击屏幕确认闹钟 / 收听家长语音
 */
export async function notifyParentEvent(
  deviceId: string,
  event: 'new_child_voice' | 'alarm_ack' | 'voice_read',
  extra?: Record<string, unknown>
): Promise<void> {
  const target = deviceId && deviceId !== 'all' ? deviceId : 'default';
  await publishEmqxNotification(`pet/${target}/parent`, {
    event,
    deviceId: target,
    ...extra,
  });
}
