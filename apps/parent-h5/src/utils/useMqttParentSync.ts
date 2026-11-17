'use client';

import { useEffect, useState } from 'react';
import mqtt, { MqttClient } from 'mqtt';
import { Toast } from 'antd-mobile';
import { useAppStore } from '../stores/useAppStore';

/**
 * 家长端 H5 EMQX Cloud Serverless WSS 实时监听 Hook
 * - 通过 `wss://<EMQX_HOST>:8084/mqtt` 订阅 `pet/{deviceId}/parent` 与 `pet/default/parent`
 * - 孩子在设备端发送微聊 (`new_child_voice`)、确认闹钟 (`alarm_ack`) 或听完家长语音 (`voice_read`) 后
 *   < 0.5 秒实时触发本地数据刷新与提示，未配置 EMQX 时自动降级为静默轮询模式
 */
export function useMqttParentSync(): { mqttConnected: boolean; wssConfigured: boolean } {
  const { selectedDeviceId, syncMessagesFromServer, syncSchedulesFromServer } = useAppStore();
  const [mqttConnected, setMqttConnected] = useState(false);
  const [wssConfigured, setWssConfigured] = useState(false);

  useEffect(() => {
    let client: MqttClient | null = null;
    let disposed = false;

    const initMqtt = async () => {
      try {
        const res = await fetch('/api/v1/mqtt/config', { cache: 'no-store' });
        if (!res.ok) return;
        const cfg = await res.json();
        if (!cfg.wssConfigured || !cfg.wssUrl || disposed) {
          setWssConfigured(false);
          return;
        }
        setWssConfigured(true);

        const targetDevice = selectedDeviceId || 'default';
        client = mqtt.connect(cfg.wssUrl, {
          username: cfg.username,
          password: cfg.password,
          clientId: `parent_h5_${Math.random().toString(16).slice(2, 10)}`,
          clean: true,
          reconnectPeriod: 5000,
          connectTimeout: 10000,
        });

        client.on('connect', () => {
          if (disposed) return;
          setMqttConnected(true);
          const topics = Array.from(
            new Set([`pet/${targetDevice}/parent`, 'pet/default/parent'])
          );
          client?.subscribe(topics, { qos: 1 });
        });

        client.on('close', () => {
          if (!disposed) setMqttConnected(false);
        });

        client.on('error', () => {
          if (!disposed) setMqttConnected(false);
        });

        client.on('message', (_topic, payloadBuf) => {
          if (disposed) return;
          try {
            const msg = JSON.parse(payloadBuf.toString());
            if (msg.event === 'new_child_voice') {
              void syncMessagesFromServer();
              Toast.show({
                content: `${msg.senderName || '宝贝'}发来一条新语音！`,
              });
            } else if (msg.event === 'voice_read') {
              void syncMessagesFromServer();
            } else if (msg.event === 'alarm_ack') {
              void syncSchedulesFromServer();
              Toast.show({
                icon: 'success',
                content: '宝贝已在设备端点击确认定时提醒！',
              });
            }
          } catch {
            // 忽略非 JSON 消息
          }
        });
      } catch {
        // 未配置或网络异常时保持静默降级
      }
    };

    void initMqtt();

    return () => {
      disposed = true;
      setMqttConnected(false);
      if (client) {
        client.end(true);
        client = null;
      }
    };
  }, [selectedDeviceId, syncMessagesFromServer, syncSchedulesFromServer]);

  return { mqttConnected, wssConfigured };
}
