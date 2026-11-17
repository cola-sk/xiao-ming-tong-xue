// Shared by middleware and the login route; uses Web Crypto in both runtimes.
export const FAMILY_COOKIE = 'pet_family_session';
const MAX_AGE = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function digest(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

export function authConfigured(): boolean {
  return Boolean(process.env.PET_FAMILY_USERNAME) &&
    (process.env.PET_FAMILY_PASSWORD || '').length >= 10 &&
    (process.env.PET_SESSION_SECRET || '').length >= 32 &&
    (process.env.PET_DEVICE_TOKEN || '').length >= 32;
}

export async function safeEqual(a: string, b: string): Promise<boolean> {
  // Compare fixed-length hashes to avoid leaking the matching prefix or input length.
  const x = await digest(a);
  const y = await digest(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(process.env.PET_SESSION_SECRET || ''),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
}

export async function createFamilySession(): Promise<string> {
  const expires = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${expires}.${nonce}`;
  return `${payload}.${await sign(payload)}`;
}

export async function validFamilySession(value: string): Promise<boolean> {
  if (!authConfigured()) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || !/^\d{10}$/.test(parts[0]) || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return false;
  const expires = Number(parts[0]);
  const now = Math.floor(Date.now() / 1000);
  if (expires <= now || expires > now + MAX_AGE) return false;
  return safeEqual(parts[2], await sign(`${parts[0]}.${parts[1]}`));
}
