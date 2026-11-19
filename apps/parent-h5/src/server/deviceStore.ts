import 'server-only';
import { ensureNeonSchema, getNeonSql } from './neonDb';
import { isDeviceBound } from './devicePairing';

export interface DeviceRecord {
  id: string;
  alias: string;
  childNickname: string;
  deviceModel: string;
  macAddress: string;
  firmwareVersion: string;
  batteryPercent: number;
  wifiRssi: number;
  volumeLevel: number;
  isOnline: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

const ONLINE_TTL_MS = 60 * 1000; // 60 秒内收到过 ESP32 心跳则判定为在线

// 仅当未配置 DATABASE_URL 时使用的内存兜底
const memoryDeviceMap = new Map<string, DeviceRecord>();

function computeIsOnline(lastSeenAt: string | Date | null | undefined): boolean {
  if (!lastSeenAt) return false;
  const ts = new Date(lastSeenAt).getTime();
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < ONLINE_TTL_MS;
}

function mapRow(row: Record<string, unknown>): DeviceRecord {
  const lastSeenAt = row.last_seen_at ? new Date(String(row.last_seen_at)).toISOString() : null;
  return {
    id: String(row.id),
    alias: String(row.alias || '小铭同学'),
    childNickname: String(row.child_nickname || '宝贝'),
    deviceModel: String(row.device_model || 'Waveshare ESP32-S3-Touch-AMOLED-2.16'),
    macAddress: String(row.mac_address || ''),
    firmwareVersion: String(row.firmware_version || '1.0.0'),
    batteryPercent: Number(row.battery_percent ?? 0),
    wifiRssi: Number(row.wifi_rssi ?? 0),
    volumeLevel: Number(row.volume_level ?? 80),
    isOnline: computeIsOnline(lastSeenAt),
    lastSeenAt,
    createdAt: row.created_at
      ? new Date(String(row.created_at)).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * ESP32 硬件上报心跳 / 状态同步 (`POST /api/v1/device/sync`)
 */
export async function upsertDeviceHeartbeat(params: {
  deviceId: string;
  macAddress?: string;
  firmwareVersion?: string;
  batteryPercent?: number;
  wifiRssi?: number;
}): Promise<DeviceRecord> {
  const sql = getNeonSql();
  const nowIso = new Date().toISOString();

  if (sql) {
    await ensureNeonSchema();
    const rows = await sql`
      INSERT INTO devices (
        id,
        mac_address,
        firmware_version,
        battery_percent,
        wifi_rssi,
        last_seen_at,
        updated_at
      ) VALUES (
        ${params.deviceId},
        ${params.macAddress || ''},
        ${params.firmwareVersion || '1.0.0'},
        ${params.batteryPercent ?? 100},
        ${params.wifiRssi ?? -50},
        NOW(),
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        mac_address = COALESCE(NULLIF(EXCLUDED.mac_address, ''), devices.mac_address),
        firmware_version = COALESCE(NULLIF(EXCLUDED.firmware_version, ''), devices.firmware_version),
        battery_percent = EXCLUDED.battery_percent,
        wifi_rssi = EXCLUDED.wifi_rssi,
        last_seen_at = NOW(),
        updated_at = NOW()
      RETURNING *
    `;
    return mapRow(rows[0] as Record<string, unknown>);
  }

  const existing = memoryDeviceMap.get(params.deviceId);
  const updated: DeviceRecord = {
    id: params.deviceId,
    alias: existing?.alias || `小铭同学 (${params.deviceId.slice(-4)})`,
    childNickname: existing?.childNickname || '宝贝',
    deviceModel: existing?.deviceModel || 'Waveshare ESP32-S3-Touch-AMOLED-2.16',
    macAddress: params.macAddress || existing?.macAddress || '',
    firmwareVersion: params.firmwareVersion || existing?.firmwareVersion || '1.0.0',
    batteryPercent: params.batteryPercent ?? existing?.batteryPercent ?? 100,
    wifiRssi: params.wifiRssi ?? existing?.wifiRssi ?? -50,
    volumeLevel: existing?.volumeLevel ?? 80,
    isOnline: true,
    lastSeenAt: nowIso,
    createdAt: existing?.createdAt || nowIso,
  };
  memoryDeviceMap.set(params.deviceId, updated);
  return updated;
}

/**
 * 家长端 H5 配对绑定设备（绑定初期 last_seen_at 为空，真实状态为离线，直到硬件连网发起心跳）
 */
export async function registerDeviceFromParent(params: {
  deviceId: string;
  alias: string;
  childNickname: string;
}): Promise<DeviceRecord> {
  const sql = getNeonSql();
  const nowIso = new Date().toISOString();

  if (sql) {
    await ensureNeonSchema();
    const rows = await sql`
      INSERT INTO devices (
        id,
        alias,
        child_nickname
      ) VALUES (
        ${params.deviceId},
        ${params.alias},
        ${params.childNickname}
      )
      ON CONFLICT (id) DO UPDATE SET
        alias = EXCLUDED.alias,
        child_nickname = EXCLUDED.child_nickname,
        updated_at = NOW()
      RETURNING *
    `;
    return mapRow(rows[0] as Record<string, unknown>);
  }

  const existing = memoryDeviceMap.get(params.deviceId);
  const record: DeviceRecord = {
    id: params.deviceId,
    alias: params.alias,
    childNickname: params.childNickname,
    deviceModel: 'Waveshare ESP32-S3-Touch-AMOLED-2.16',
    macAddress: existing?.macAddress || '',
    firmwareVersion: existing?.firmwareVersion || '1.0.0',
    batteryPercent: existing?.batteryPercent ?? 0,
    wifiRssi: existing?.wifiRssi ?? 0,
    volumeLevel: existing?.volumeLevel ?? 80,
    isOnline: existing ? computeIsOnline(existing.lastSeenAt) : false,
    lastSeenAt: existing?.lastSeenAt || null,
    createdAt: existing?.createdAt || nowIso,
  };
  memoryDeviceMap.set(params.deviceId, record);
  return record;
}

/**
 * 更新设备音量配置（下次 ESP32 心跳时自动下发同步）
 */
export async function updateDeviceVolume(
  deviceId: string,
  volumeLevel: number
): Promise<DeviceRecord | null> {
  const clamped = Math.max(10, Math.min(100, Math.round(volumeLevel)));
  const sql = getNeonSql();

  if (sql) {
    await ensureNeonSchema();
    const rows = await sql`
      UPDATE devices
      SET volume_level = ${clamped}, updated_at = NOW()
      WHERE id = ${deviceId}
      RETURNING *
    `;
    if (rows.length === 0) return null;
    return mapRow(rows[0] as Record<string, unknown>);
  }

  const existing = memoryDeviceMap.get(deviceId);
  if (!existing) return null;
  const updated = { ...existing, volumeLevel: clamped };
  memoryDeviceMap.set(deviceId, updated);
  return updated;
}

/**
 * 获取所有设备列表及真实实时在线状态
 */
export async function listDevicesWithStatus(): Promise<DeviceRecord[]> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    const rows = await sql`
      SELECT devices.* FROM devices
      JOIN device_credentials ON device_credentials.device_id = devices.id AND device_credentials.revoked_at IS NULL
      ORDER BY devices.created_at ASC
    `;
    return rows.map(r => mapRow(r as Record<string, unknown>));
  }

  const bound = await Promise.all(Array.from(memoryDeviceMap.values()).map(async device => await isDeviceBound(device.id) ? device : null));
  return bound.filter((d): d is DeviceRecord => d !== null).map(d => ({
    ...d,
    isOnline: computeIsOnline(d.lastSeenAt),
  }));
}

/**
 * 解绑/删除设备
 */
export async function deleteDeviceById(deviceId: string): Promise<void> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    await sql`DELETE FROM devices WHERE id = ${deviceId}`;
    return;
  }
  memoryDeviceMap.delete(deviceId);
}
