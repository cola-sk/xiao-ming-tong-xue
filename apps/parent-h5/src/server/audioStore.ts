import 'server-only';
import { createHash } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ensureNeonSchema, getNeonSql } from './neonDb';

/**
 * 豆包 TTS 音频持久化存储与 URL 托管服务 (`audioStore.ts`)
 *
 * 【仅用于功能二：定时语音播报】
 * 1. 按 `(voiceType + text)` 计算确定性 Key，合成一次后：
 *    - 优先写入 Vercel Neon PostgreSQL `tts_audio_files` 表（支持跨 Vercel Serverless 实例永久持久化）。
 *    - 若未配置 Neon 而配置了 Supabase，自动回退 Supabase `public.tts_audio_files`。
 *    - 同时写入进程内热缓存，加速同一容器内的重复请求。
 * 2. 对外统一返回标准 HTTP 地址：`/api/v1/audio/{md5}`（ESP32 与 H5 `<audio>` 标签均可直接通过 URL 播放，且带有 `Cache-Control: public, max-age=31536000, immutable` 供 Vercel Edge CDN 永久缓存）。
 */

interface StoredAudioRecord {
  md5: string;
  voiceType: string;
  textContent: string;
  mimeType: string;
  audioBase64: string;
  sizeBytes: number;
}

const memoryAudioCache = new Map<string, StoredAudioRecord>();
const textKeyToMd5Cache = new Map<string, string>();

function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key || !url.startsWith('https://')) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function makeTextVoiceKey(voiceType: string, text: string): string {
  return createHash('md5').update(`${voiceType}::${text.trim()}`).digest('hex');
}

/**
 * 检查是否已经为相同的 `(voiceType, text)` 生成并保存过音频，若已存在直接返回避免重复调用豆包计费
 */
export async function findExistingAudioByText(
  voiceType: string,
  text: string
): Promise<StoredAudioRecord | null> {
  const lookupKey = makeTextVoiceKey(voiceType, text);
  const cachedMd5 = textKeyToMd5Cache.get(lookupKey);
  if (cachedMd5 && memoryAudioCache.has(cachedMd5)) {
    return memoryAudioCache.get(cachedMd5)!;
  }

  // 1) 优先从 Neon PostgreSQL 查询
  const sql = getNeonSql();
  if (sql) {
    try {
      await ensureNeonSchema();
      const rows = await sql`
        SELECT md5, voice_type, text_content, mime_type, audio_base64, size_bytes
        FROM tts_audio_files
        WHERE voice_type = ${voiceType} AND text_content = ${text.trim()}
        LIMIT 1
      `;
      if (rows.length > 0 && rows[0].audio_base64) {
        const row = rows[0];
        const record: StoredAudioRecord = {
          md5: String(row.md5),
          voiceType: String(row.voice_type),
          textContent: String(row.text_content),
          mimeType: String(row.mime_type || 'audio/mpeg'),
          audioBase64: String(row.audio_base64),
          sizeBytes: Number(row.size_bytes || 0),
        };
        memoryAudioCache.set(record.md5, record);
        textKeyToMd5Cache.set(lookupKey, record.md5);
        return record;
      }
    } catch {
      // 忽略异常
    }
  }

  // 2) 回退兼容 Supabase
  const db = getSupabaseAdmin();
  if (db) {
    try {
      const { data } = await db
        .from('tts_audio_files')
        .select('md5,voice_type,text_content,mime_type,audio_base64,size_bytes')
        .eq('voice_type', voiceType)
        .eq('text_content', text.trim())
        .limit(1)
        .maybeSingle();

      if (data?.md5 && data?.audio_base64) {
        const record: StoredAudioRecord = {
          md5: data.md5,
          voiceType: data.voice_type,
          textContent: data.text_content,
          mimeType: data.mime_type || 'audio/mpeg',
          audioBase64: data.audio_base64,
          sizeBytes: data.size_bytes || 0,
        };
        memoryAudioCache.set(record.md5, record);
        textKeyToMd5Cache.set(lookupKey, record.md5);
        return record;
      }
    } catch {
      // Ignore DB lookup errors
    }
  }

  return null;
}

/**
 * 保存豆包合成的 MP3 Base64 到内存与数据库，并返回永久可访问的 `/api/v1/audio/{md5}` 地址
 */
export async function saveSynthesizedAudio(params: {
  md5: string;
  voiceType: string;
  textContent: string;
  audioBase64: string;
}): Promise<{ audioUrl: string; audioDataUrl: string; md5: string; sizeBytes: number }> {
  const sizeBytes = Buffer.from(params.audioBase64, 'base64').length;
  const record: StoredAudioRecord = {
    md5: params.md5,
    voiceType: params.voiceType,
    textContent: params.textContent.trim(),
    mimeType: 'audio/mpeg',
    audioBase64: params.audioBase64,
    sizeBytes,
  };

  memoryAudioCache.set(params.md5, record);
  textKeyToMd5Cache.set(makeTextVoiceKey(params.voiceType, params.textContent), params.md5);

  // 1) 优先持久化到 Neon PostgreSQL
  const sql = getNeonSql();
  if (sql) {
    try {
      await ensureNeonSchema();
      await sql`
        INSERT INTO tts_audio_files (
          md5, voice_type, text_content, mime_type, audio_base64, size_bytes
        ) VALUES (
          ${record.md5}, ${record.voiceType}, ${record.textContent},
          ${record.mimeType}, ${record.audioBase64}, ${record.sizeBytes}
        )
        ON CONFLICT (md5) DO UPDATE SET
          audio_base64 = EXCLUDED.audio_base64,
          size_bytes = EXCLUDED.size_bytes
      `;
    } catch {
      // Ignore DB write error
    }
  } else {
    // 2) 回退兼容 Supabase
    const db = getSupabaseAdmin();
    if (db) {
      try {
        await db.from('tts_audio_files').upsert(
          {
            md5: record.md5,
            voice_type: record.voiceType,
            text_content: record.textContent,
            mime_type: record.mimeType,
            audio_base64: record.audioBase64,
            size_bytes: record.sizeBytes,
          },
          { onConflict: 'md5' }
        );
      } catch {
        // Gracefully continue
      }
    }
  }

  return {
    audioUrl: `/api/v1/audio/${params.md5}`,
    audioDataUrl: `data:audio/mp3;base64,${params.audioBase64}`,
    md5: params.md5,
    sizeBytes,
  };
}

/**
 * 根据 MD5 读取已保存的音频二进制流（供 `/api/v1/audio/[md5]` 路由返回 `audio/mpeg`）
 */
export async function getAudioByMd5(md5: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const cleanMd5 = md5.replace(/\.mp3$/i, '');
  const mem = memoryAudioCache.get(cleanMd5);
  if (mem) {
    return {
      buffer: Buffer.from(mem.audioBase64, 'base64'),
      mimeType: mem.mimeType,
    };
  }

  const sql = getNeonSql();
  if (sql) {
    try {
      await ensureNeonSchema();
      const rows = await sql`
        SELECT audio_base64, mime_type
        FROM tts_audio_files
        WHERE md5 = ${cleanMd5}
        LIMIT 1
      `;
      if (rows.length > 0 && rows[0].audio_base64) {
        return {
          buffer: Buffer.from(String(rows[0].audio_base64), 'base64'),
          mimeType: String(rows[0].mime_type || 'audio/mpeg'),
        };
      }
    } catch {
      // Ignore DB error
    }
  }

  const db = getSupabaseAdmin();
  if (db) {
    try {
      const { data } = await db
        .from('tts_audio_files')
        .select('audio_base64,mime_type')
        .eq('md5', cleanMd5)
        .maybeSingle();
      if (data?.audio_base64) {
        return {
          buffer: Buffer.from(data.audio_base64, 'base64'),
          mimeType: data.mime_type || 'audio/mpeg',
        };
      }
    } catch {
      // Ignore DB error
    }
  }

  return null;
}
