import 'server-only';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { ensureNeonSchema, getNeonSql } from './neonDb';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const DEVICE_ID = /^[a-zA-Z0-9_-]{4,64}$/;
const SETUP_SECRET = /^[a-f0-9]{64}$/;
export class PairingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
interface Pairing {
  device_id: string; code: string; setup_hash: string; token_nonce: string;
  expires_at: string; claimed_at: string | null;
}
interface Credential { token_hash: string; revoked: boolean; }
const sessions = new Map<string, Pairing>();
const credentials = new Map<string, Credential>();
const limits = new Map<string, { count: number; expires: number }>();
export const hashDeviceSecret = (value: string) => createHash('sha256').update(value).digest('hex');
function equal(a: string, b: string) { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function mintToken(session: Pairing) {
  const secret = process.env.PET_SESSION_SECRET || '';
  if (secret.length < 32) throw new PairingError('服务端尚未配置会话密钥', 503);
  return createHmac('sha256', secret).update(`pet-device-v1:${session.device_id}:${session.token_nonce}`).digest('hex');
}
function validate(deviceId: string, setupSecret: string) {
  if (!DEVICE_ID.test(deviceId) || !SETUP_SECRET.test(setupSecret)) throw new PairingError('无效的设备配对请求');
}
async function ready() {
  if (process.env.NODE_ENV === 'production' && !getNeonSql()) throw new PairingError('配对服务需要持久数据库', 503);
  await ensureNeonSchema();
}

// A database counter also applies across serverless instances. Keys are hashed, never raw IPs.
export async function limitPairing(key: string, maximum: number, windowMs = 60000) {
  await ready();
  const bucket = `${hashDeviceSecret(key)}:${Math.floor(Date.now() / windowMs)}`;
  const sql = getNeonSql();
  let count: number;
  if (sql) {
    const rows = await sql`
      INSERT INTO device_pairing_limits (bucket, count, expires_at)
      VALUES (${bucket}, 1, NOW() + ${windowMs * 2} * INTERVAL '1 millisecond')
      ON CONFLICT (bucket) DO UPDATE SET count = device_pairing_limits.count + 1
      RETURNING count`;
    count = Number(rows[0].count);
  } else {
    for (const [k, value] of limits) if (value.expires < Date.now()) limits.delete(k);
    const entry = limits.get(bucket) || { count: 0, expires: Date.now() + windowMs * 2 };
    count = ++entry.count; limits.set(bucket, entry);
  }
  if (count > maximum) throw new PairingError('操作过于频繁，请稍后重试', 429);
}

export async function startPairing(deviceId: string, setupSecret: string) {
  validate(deviceId, setupSecret); await ready();
  const setupHash = hashDeviceSecret(setupSecret);
  const sql = getNeonSql();
  const active = sql
    ? (await sql`SELECT device_id FROM device_credentials WHERE device_id = ${deviceId} AND revoked_at IS NULL`).length > 0
    : Boolean(credentials.get(deviceId) && !credentials.get(deviceId)!.revoked);
  if (active) throw new PairingError('设备已绑定，请先在家长端解绑', 409);
  const prior = sql
    ? (await sql`SELECT * FROM device_pairing_sessions WHERE device_id = ${deviceId}`)[0] as unknown as Pairing | undefined
    : sessions.get(deviceId);
  if (prior && new Date(prior.expires_at).getTime() > Date.now()) {
    if (!equal(prior.setup_hash, setupHash)) throw new PairingError('设备已有有效绑定码，请稍后重试', 409);
    return { code: prior.code, expiresAt: new Date(prior.expires_at).toISOString() };
  }
  const entry: Pairing = {
    device_id: deviceId, code: String(randomInt(10000000, 100000000)), setup_hash: setupHash,
    token_nonce: randomBytes(32).toString('hex'), expires_at: new Date(Date.now() + PAIRING_TTL_MS).toISOString(), claimed_at: null,
  };
  if (sql) {
    await sql`DELETE FROM device_pairing_limits WHERE expires_at < NOW()`;
    const rows = await sql`
      INSERT INTO device_pairing_sessions (device_id, code, setup_hash, token_nonce, expires_at)
      VALUES (${deviceId}, ${entry.code}, ${setupHash}, ${entry.token_nonce}, ${entry.expires_at})
      ON CONFLICT (device_id) DO UPDATE SET code = EXCLUDED.code, setup_hash = EXCLUDED.setup_hash,
        token_nonce = EXCLUDED.token_nonce, expires_at = EXCLUDED.expires_at, claimed_at = NULL
      WHERE device_pairing_sessions.expires_at <= NOW()
      RETURNING device_id`;
    if (!rows.length) throw new PairingError('绑定码正在生成，请重试', 409);
  } else {
    for (const [id, value] of sessions) if (new Date(value.expires_at).getTime() <= Date.now()) sessions.delete(id);
    sessions.set(deviceId, entry);
  }
  return { code: entry.code, expiresAt: entry.expires_at };
}

export async function claimPairing(code: string, alias: string, childNickname: string) {
  if (!/^\d{8}$/.test(code)) throw new PairingError('请输入设备屏幕上的8位绑定码');
  await ready();
  const sql = getNeonSql();
  const entry = sql
    ? (await sql`SELECT * FROM device_pairing_sessions WHERE code = ${code}`)[0] as unknown as Pairing | undefined
    : Array.from(sessions.values()).find(s => s.code === code);
  if (!entry || entry.claimed_at || new Date(entry.expires_at).getTime() <= Date.now()) throw new PairingError('绑定码无效、已使用或已过期', 409);
  const tokenHash = hashDeviceSecret(mintToken(entry));
  const cleanAlias = alias.trim().slice(0, 80) || `${childNickname.trim().slice(0, 40) || '宝贝'}的小铭同学`;
  const nickname = childNickname.trim().slice(0, 40) || '宝贝';
  if (sql) {
    // Claim, metadata and credential are committed together; only one claimant can win.
    const rows = await sql`
      WITH claimed AS (
        UPDATE device_pairing_sessions SET claimed_at = NOW()
        WHERE device_id = ${entry.device_id} AND code = ${code} AND claimed_at IS NULL AND expires_at > NOW()
          AND NOT EXISTS (SELECT 1 FROM device_credentials WHERE device_id = ${entry.device_id} AND revoked_at IS NULL)
        RETURNING device_id
      ), registered AS (
        INSERT INTO devices (id, alias, child_nickname)
        SELECT device_id, ${cleanAlias}, ${nickname} FROM claimed
        ON CONFLICT (id) DO UPDATE SET alias = EXCLUDED.alias, child_nickname = EXCLUDED.child_nickname, updated_at = NOW()
        RETURNING id
      ), credential AS (
        INSERT INTO device_credentials (device_id, token_hash)
        SELECT device_id, ${tokenHash} FROM claimed
        ON CONFLICT (device_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, revoked_at = NULL, created_at = NOW()
        WHERE device_credentials.revoked_at IS NOT NULL
        RETURNING device_id
      ) SELECT registered.id FROM registered JOIN credential ON registered.id = credential.device_id`;
    if (!rows.length) throw new PairingError('绑定码已使用，请刷新设备绑定码', 409);
  } else {
    if (credentials.has(entry.device_id) && !credentials.get(entry.device_id)!.revoked) throw new PairingError('设备已绑定', 409);
    entry.claimed_at = new Date().toISOString();
    credentials.set(entry.device_id, { token_hash: tokenHash, revoked: false });
  }
  return { deviceId: entry.device_id, alias: cleanAlias, childNickname: nickname };
}

export async function pollPairing(deviceId: string, setupSecret: string) {
  validate(deviceId, setupSecret); await ready();
  const sql = getNeonSql();
  const entry = sql
    ? (await sql`SELECT * FROM device_pairing_sessions WHERE device_id = ${deviceId}`)[0] as unknown as Pairing | undefined
    : sessions.get(deviceId);
  if (!entry || !equal(entry.setup_hash, hashDeviceSecret(setupSecret))) throw new PairingError('配对会话无效', 401);
  if (new Date(entry.expires_at).getTime() <= Date.now()) throw new PairingError('绑定码已过期', 410);
  if (!entry.claimed_at) return { status: 'pending' as const };
  const token = mintToken(entry);
  if (await authenticateDeviceToken(token) !== deviceId) throw new PairingError('绑定已撤销', 410);
  // Retrying with the same setup proof returns the same token until expiry (safe across lost responses/reboots).
  return { status: 'paired' as const, deviceId, token };
}

export async function authenticateDeviceToken(token: string): Promise<string | null> {
  if (!SETUP_SECRET.test(token)) return null;
  await ready();
  const sql = getNeonSql(); const hash = hashDeviceSecret(token);
  if (sql) {
    const rows = await sql`SELECT device_id FROM device_credentials WHERE token_hash = ${hash} AND revoked_at IS NULL`;
    return rows.length ? String(rows[0].device_id) : null;
  }
  for (const [id, credential] of credentials) if (!credential.revoked && equal(credential.token_hash, hash)) return id;
  return null;
}

export async function isDeviceBound(deviceId: string) {
  await ready(); const sql = getNeonSql();
  if (sql) return (await sql`SELECT device_id FROM device_credentials WHERE device_id = ${deviceId} AND revoked_at IS NULL`).length > 0;
  const credential = credentials.get(deviceId);
  return Boolean(credential && !credential.revoked);
}

export async function revokeDeviceCredential(deviceId: string) {
  await ready(); const sql = getNeonSql();
  if (sql) {
    await sql.transaction([
      sql`UPDATE device_credentials SET revoked_at = NOW() WHERE device_id = ${deviceId}`,
      sql`DELETE FROM device_pairing_sessions WHERE device_id = ${deviceId}`,
      sql`DELETE FROM devices WHERE id = ${deviceId}`,
    ]);
  } else { const credential = credentials.get(deviceId); if (credential) credential.revoked = true; sessions.delete(deviceId); }
}
