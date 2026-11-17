import 'server-only';
import { neon, NeonQueryFunction } from '@neondatabase/serverless';

let schemaReadyPromise: Promise<void> | null = null;

/**
 * 获取 Neon PostgreSQL 查询客户端（未配置 DATABASE_URL 时返回 null）
 */
export function getNeonSql(): NeonQueryFunction<false, false> | null {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!url) return null;
  return neon(url);
}

/**
 * 自动初始化「小铭同学」全量业务表结构（幂等执行，每个实例生命周期只跑一次）
 */
export async function ensureNeonSchema(): Promise<void> {
  const sql = getNeonSql();
  if (!sql) return;

  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      // 1. 硬件设备表 (devices)
      await sql`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          alias TEXT NOT NULL DEFAULT '小铭同学',
          child_nickname TEXT NOT NULL DEFAULT '宝贝',
          device_model TEXT NOT NULL DEFAULT 'Waveshare ESP32-S3-Touch-AMOLED-2.16',
          mac_address TEXT NOT NULL DEFAULT '',
          firmware_version TEXT NOT NULL DEFAULT '1.0.0',
          battery_percent INTEGER NOT NULL DEFAULT 0,
          wifi_rssi INTEGER NOT NULL DEFAULT 0,
          volume_level INTEGER NOT NULL DEFAULT 80,
          last_seen_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      // 2. AI 宠物人设与音色配置表 (pet_ai_configs)
      await sql`
        CREATE TABLE IF NOT EXISTS pet_ai_configs (
          device_id TEXT PRIMARY KEY,
          pet_name TEXT NOT NULL DEFAULT '小铭同学',
          persona_id TEXT NOT NULL DEFAULT 'lively_puppy',
          voice_id TEXT NOT NULL DEFAULT 'zh_female_vv_uranus_bigtts',
          custom_prompt TEXT NOT NULL DEFAULT '你是5岁的智能语音萌宠“小铭同学”，性格活泼温暖，回答小朋友的问题要简短有趣、纯口语化，每次不超过50字。',
          volume_level INTEGER NOT NULL DEFAULT 80,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      // 3. AI 宠物伴聊历史文本表 (ai_chat_logs) —— 仅存文本，不存储音频
      await sql`
        CREATE TABLE IF NOT EXISTS ai_chat_logs (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL DEFAULT 'default',
          child_text TEXT NOT NULL,
          pet_reply_text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      // 4. 定时语音播报专用 MP3 持久化表 (tts_audio_files)
      await sql`
        CREATE TABLE IF NOT EXISTS tts_audio_files (
          md5 TEXT PRIMARY KEY,
          voice_type TEXT NOT NULL,
          text_content TEXT NOT NULL,
          mime_type TEXT NOT NULL DEFAULT 'audio/mpeg',
          audio_base64 TEXT NOT NULL,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      // 5. 爸妈声音克隆档案表 (voice_clone_profiles)
      await sql`
        CREATE TABLE IF NOT EXISTS voice_clone_profiles (
          id TEXT PRIMARY KEY,
          speaker_role TEXT NOT NULL DEFAULT '妈妈',
          title TEXT NOT NULL,
          sample_text TEXT NOT NULL DEFAULT '',
          provider_voice_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ready',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      // 6. 定时语音播报任务表 (voice_schedules)
      await sql`
        CREATE TABLE IF NOT EXISTS voice_schedules (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL DEFAULT 'default',
          title TEXT NOT NULL,
          cron_expr TEXT NOT NULL,
          time_str TEXT NOT NULL,
          repeat_days JSONB NOT NULL DEFAULT '[1,2,3,4,5,6,7]'::jsonb,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          source_type TEXT NOT NULL DEFAULT 'tts',
          cloned_voice_id TEXT,
          cloned_speaker_role TEXT,
          text_content TEXT NOT NULL,
          audio_url TEXT,
          audio_md5 TEXT,
          repeat_play_count INTEGER NOT NULL DEFAULT 2,
          last_ack_status TEXT NOT NULL DEFAULT 'idle',
          last_ack_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      // 7. 亲子双向微聊消息表 (chat_voice_messages) —— 元数据与 ASR 文本持久化；音频不长期存库
      await sql`
        CREATE TABLE IF NOT EXISTS chat_voice_messages (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL DEFAULT 'default',
          direction TEXT NOT NULL,
          sender_name TEXT NOT NULL DEFAULT '妈妈',
          audio_url TEXT NOT NULL DEFAULT '',
          duration_sec INTEGER NOT NULL DEFAULT 3,
          asr_text TEXT NOT NULL DEFAULT '',
          auto_play BOOLEAN NOT NULL DEFAULT FALSE,
          status TEXT NOT NULL DEFAULT 'unread',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
    })().catch(err => {
      schemaReadyPromise = null;
      throw err;
    });
  }

  return schemaReadyPromise;
}
