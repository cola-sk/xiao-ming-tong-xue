import 'server-only';
import { ensureNeonSchema, getNeonSql } from './neonDb';

let memoryLoudnessRate = 0;

export async function getVoiceLoudnessRate(): Promise<number> {
  const sql = getNeonSql();
  if (!sql) return memoryLoudnessRate;
  await ensureNeonSchema();
  const rows = await sql`SELECT loudness_rate FROM family_voice_settings WHERE id = 'family'`;
  const value = Number(rows[0]?.loudness_rate ?? 0);
  return Number.isInteger(value) && value >= -50 && value <= 100 ? value : 0;
}

export async function setVoiceLoudnessRate(value: number): Promise<void> {
  if (!Number.isInteger(value) || value < -50 || value > 100) throw new RangeError('合成音量必须为 -50 到 100 的整数');
  const sql = getNeonSql();
  if (!sql) { memoryLoudnessRate = value; return; }
  await ensureNeonSchema();
  await sql`INSERT INTO family_voice_settings (id, loudness_rate) VALUES ('family', ${value}) ON CONFLICT (id) DO UPDATE SET loudness_rate = EXCLUDED.loudness_rate`;
}
