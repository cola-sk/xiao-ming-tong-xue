import 'server-only';
import { ensureNeonSchema, getNeonSql } from './neonDb';

export interface PetAiConfigRecord {
  deviceId: string;
  petName: string;
  personaId: string;
  voiceId: string;
  customPrompt: string;
  volumeLevel: number;
  updatedAt: string;
}

export interface AiChatLogRecord {
  id: string;
  deviceId: string;
  childText: string;
  petReplyText: string;
  createdAt: string;
}

export interface VoiceCloneRecord {
  id: string;
  speakerRole: '妈妈' | '爸爸';
  title: string;
  sampleText: string;
  providerVoiceId: string;
  status: string;
  createdAt: string;
}

export interface VoiceScheduleRecord {
  id: string;
  deviceId: string;
  title: string;
  cronExpr: string;
  timeStr: string;
  repeatDays: number[];
  enabled: boolean;
  sourceType: 'tts' | 'parent_clone' | 'record';
  clonedVoiceId: string | null;
  clonedSpeakerRole: string | null;
  textContent: string;
  audioUrl: string | null;
  audioMd5: string | null;
  repeatPlayCount: number;
  lastAckStatus: 'idle' | 'ringing' | 'confirmed';
  lastAckAt: string | null;
  createdAt: string;
}

export interface ChatVoiceMessageRecord {
  id: string;
  deviceId: string;
  direction: 'parent_to_device' | 'device_to_parent';
  senderName: string;
  audioUrl: string;
  durationSec: number;
  asrText: string;
  autoPlay: boolean;
  status: 'unread' | 'played';
  createdAt: string;
}

// 内存兜底（仅当无 DATABASE_URL 时生效）
const memPetConfigs = new Map<string, PetAiConfigRecord>();
const memChatLogs: AiChatLogRecord[] = [];
const memVoiceClones = new Map<string, VoiceCloneRecord>();
const memSchedules = new Map<string, VoiceScheduleRecord>();
const memChatMessages = new Map<string, ChatVoiceMessageRecord>();

// ==================== 1. AI 宠物配置 & 对话日志 ====================

export async function getPetAiConfig(deviceId = 'default'): Promise<PetAiConfigRecord> {
  const key = deviceId || 'default';
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    const rows = await sql`
      SELECT * FROM pet_ai_configs WHERE device_id = ${key} LIMIT 1
    `;
    if (rows.length > 0) {
      const r = rows[0];
      return {
        deviceId: String(r.device_id),
        petName: String(r.pet_name),
        personaId: String(r.persona_id),
        voiceId: String(r.voice_id),
        customPrompt: String(r.custom_prompt),
        volumeLevel: Number(r.volume_level ?? 80),
        updatedAt: new Date(String(r.updated_at)).toISOString(),
      };
    }
  }

  return (
    memPetConfigs.get(key) || {
      deviceId: key,
      petName: '小铭同学',
      personaId: 'lively_puppy',
      voiceId: 'zh_female_vv_uranus_bigtts',
      customPrompt:
        '你是5岁的智能语音萌宠“小铭同学”，性格活泼温暖，喜欢用通俗比喻回答十万个为什么，每次回答不超过50字。',
      volumeLevel: 80,
      updatedAt: new Date().toISOString(),
    }
  );
}

export async function upsertPetAiConfig(
  deviceId: string,
  updates: Partial<Omit<PetAiConfigRecord, 'deviceId' | 'updatedAt'>>
): Promise<PetAiConfigRecord> {
  const key = deviceId || 'default';
  const current = await getPetAiConfig(key);
  const next: PetAiConfigRecord = {
    deviceId: key,
    petName: updates.petName ?? current.petName,
    personaId: updates.personaId ?? current.personaId,
    voiceId: updates.voiceId ?? current.voiceId,
    customPrompt: updates.customPrompt ?? current.customPrompt,
    volumeLevel: updates.volumeLevel ?? current.volumeLevel,
    updatedAt: new Date().toISOString(),
  };

  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    await sql`
      INSERT INTO pet_ai_configs (
        device_id, pet_name, persona_id, voice_id, custom_prompt, volume_level, updated_at
      ) VALUES (
        ${next.deviceId}, ${next.petName}, ${next.personaId}, ${next.voiceId}, ${next.customPrompt}, ${next.volumeLevel}, NOW()
      )
      ON CONFLICT (device_id) DO UPDATE SET
        pet_name = EXCLUDED.pet_name,
        persona_id = EXCLUDED.persona_id,
        voice_id = EXCLUDED.voice_id,
        custom_prompt = EXCLUDED.custom_prompt,
        volume_level = EXCLUDED.volume_level,
        updated_at = NOW()
    `;
  } else {
    memPetConfigs.set(key, next);
  }

  return next;
}

export async function listAiChatLogs(deviceId?: string, limit = 30): Promise<AiChatLogRecord[]> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    const rows = deviceId
      ? await sql`
          SELECT * FROM ai_chat_logs WHERE device_id = ${deviceId}
          ORDER BY created_at DESC LIMIT ${limit}
        `
      : await sql`
          SELECT * FROM ai_chat_logs ORDER BY created_at DESC LIMIT ${limit}
        `;
    return rows.map(r => ({
      id: String(r.id),
      deviceId: String(r.device_id),
      childText: String(r.child_text),
      petReplyText: String(r.pet_reply_text),
      createdAt: new Date(String(r.created_at)).toISOString(),
    }));
  }

  return memChatLogs
    .filter(l => !deviceId || l.deviceId === deviceId)
    .slice(0, limit);
}

export async function appendAiChatLog(params: {
  deviceId?: string;
  childText: string;
  petReplyText: string;
}): Promise<AiChatLogRecord> {
  const record: AiChatLogRecord = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    deviceId: params.deviceId || 'default',
    childText: params.childText,
    petReplyText: params.petReplyText,
    createdAt: new Date().toISOString(),
  };

  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    await sql`
      INSERT INTO ai_chat_logs (id, device_id, child_text, pet_reply_text)
      VALUES (${record.id}, ${record.deviceId}, ${record.childText}, ${record.petReplyText})
    `;
  } else {
    memChatLogs.unshift(record);
  }

  return record;
}

// ==================== 2. 爸妈声音克隆档案 ====================

export async function listVoiceCloneProfiles(): Promise<VoiceCloneRecord[]> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    const rows = await sql`
      SELECT * FROM voice_clone_profiles ORDER BY created_at DESC
    `;
    return rows.map(r => ({
      id: String(r.id),
      speakerRole: r.speaker_role === '爸爸' ? '爸爸' : '妈妈',
      title: String(r.title),
      sampleText: String(r.sample_text || ''),
      providerVoiceId: String(r.provider_voice_id),
      status: String(r.status || 'ready'),
      createdAt: new Date(String(r.created_at)).toISOString(),
    }));
  }

  return Array.from(memVoiceClones.values());
}

export async function saveVoiceCloneProfile(params: {
  id?: string;
  speakerRole: '妈妈' | '爸爸';
  title: string;
  sampleText: string;
  providerVoiceId: string;
  status?: string;
}): Promise<VoiceCloneRecord> {
  const record: VoiceCloneRecord = {
    id: params.id || `clone_${Date.now()}`,
    speakerRole: params.speakerRole,
    title: params.title,
    sampleText: params.sampleText,
    providerVoiceId: params.providerVoiceId,
    status: params.status || 'ready',
    createdAt: new Date().toISOString(),
  };

  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    await sql`
      INSERT INTO voice_clone_profiles (
        id, speaker_role, title, sample_text, provider_voice_id, status
      ) VALUES (
        ${record.id}, ${record.speakerRole}, ${record.title}, ${record.sampleText}, ${record.providerVoiceId}, ${record.status}
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        provider_voice_id = EXCLUDED.provider_voice_id,
        status = EXCLUDED.status
    `;
  } else {
    memVoiceClones.set(record.id, record);
  }

  return record;
}

export async function updateVoiceCloneStatus(speakerId: string, status: string): Promise<void> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    await sql`UPDATE voice_clone_profiles SET status = ${status} WHERE provider_voice_id = ${speakerId}`;
  } else {
    for (const profile of memVoiceClones.values()) {
      if (profile.providerVoiceId === speakerId) profile.status = status;
    }
  }
}

export async function deleteVoiceCloneProfileById(id: string): Promise<void> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    await sql`DELETE FROM voice_clone_profiles WHERE id = ${id}`;
    return;
  }
  memVoiceClones.delete(id);
}

// ==================== 3. 定时语音播报任务 ====================

function mapScheduleRow(r: Record<string, unknown>): VoiceScheduleRecord {
  let repeatDays: number[] = [1, 2, 3, 4, 5, 6, 7];
  if (Array.isArray(r.repeat_days)) {
    repeatDays = r.repeat_days.map(Number);
  } else if (typeof r.repeat_days === 'string') {
    try {
      const parsed = JSON.parse(r.repeat_days);
      if (Array.isArray(parsed)) repeatDays = parsed.map(Number);
    } catch {
      // ignore
    }
  }
  return {
    id: String(r.id),
    deviceId: String(r.device_id || 'default'),
    title: String(r.title),
    cronExpr: String(r.cron_expr),
    timeStr: String(r.time_str),
    repeatDays,
    enabled: Boolean(r.enabled),
    sourceType:
      r.source_type === 'parent_clone'
        ? 'parent_clone'
        : r.source_type === 'record'
        ? 'record'
        : 'tts',
    clonedVoiceId: r.cloned_voice_id ? String(r.cloned_voice_id) : null,
    clonedSpeakerRole: r.cloned_speaker_role ? String(r.cloned_speaker_role) : null,
    textContent: String(r.text_content),
    audioUrl: r.audio_url ? String(r.audio_url) : null,
    audioMd5: r.audio_md5 ? String(r.audio_md5) : null,
    repeatPlayCount: Number(r.repeat_play_count ?? 2),
    lastAckStatus:
      r.last_ack_status === 'confirmed'
        ? 'confirmed'
        : r.last_ack_status === 'ringing'
        ? 'ringing'
        : 'idle',
    lastAckAt: r.last_ack_at ? new Date(String(r.last_ack_at)).toISOString() : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
  };
}

export async function listVoiceSchedules(deviceId?: string): Promise<VoiceScheduleRecord[]> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    const rows =
      deviceId && deviceId !== 'all'
        ? await sql`
            SELECT * FROM voice_schedules
            WHERE device_id = ${deviceId} OR device_id = 'default'
            ORDER BY time_str ASC
          `
        : await sql`
            SELECT * FROM voice_schedules ORDER BY time_str ASC
          `;
    return rows.map(r => mapScheduleRow(r as Record<string, unknown>));
  }

  return Array.from(memSchedules.values()).filter(
    s => !deviceId || deviceId === 'all' || s.deviceId === deviceId || s.deviceId === 'default'
  );
}

export async function upsertVoiceSchedule(
  params: Omit<VoiceScheduleRecord, 'id' | 'createdAt' | 'lastAckStatus' | 'lastAckAt'> & {
    id?: string;
  }
): Promise<VoiceScheduleRecord> {
  const id = params.id || `sched_${Date.now()}`;
  const repeatDaysJson = JSON.stringify(params.repeatDays);
  // 不把巨大的 data:audio/mp3;base64 存入数据库字段，只保存规范 HTTP 路径 `/api/v1/audio/{md5}`
  const safeAudioUrl =
    params.audioUrl && !params.audioUrl.startsWith('data:') ? params.audioUrl : null;

  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    const rows = await sql`
      INSERT INTO voice_schedules (
        id, device_id, title, cron_expr, time_str, repeat_days, enabled,
        source_type, cloned_voice_id, cloned_speaker_role, text_content,
        audio_url, audio_md5, repeat_play_count, updated_at
      ) VALUES (
        ${id}, ${params.deviceId || 'default'}, ${params.title}, ${params.cronExpr},
        ${params.timeStr}, ${repeatDaysJson}::jsonb, ${params.enabled},
        ${params.sourceType}, ${params.clonedVoiceId || null}, ${params.clonedSpeakerRole || null},
        ${params.textContent}, ${safeAudioUrl}, ${params.audioMd5 || null},
        ${params.repeatPlayCount}, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        device_id = EXCLUDED.device_id,
        title = EXCLUDED.title,
        cron_expr = EXCLUDED.cron_expr,
        time_str = EXCLUDED.time_str,
        repeat_days = EXCLUDED.repeat_days,
        enabled = EXCLUDED.enabled,
        source_type = EXCLUDED.source_type,
        cloned_voice_id = EXCLUDED.cloned_voice_id,
        cloned_speaker_role = EXCLUDED.cloned_speaker_role,
        text_content = EXCLUDED.text_content,
        audio_url = COALESCE(EXCLUDED.audio_url, voice_schedules.audio_url),
        audio_md5 = COALESCE(EXCLUDED.audio_md5, voice_schedules.audio_md5),
        repeat_play_count = EXCLUDED.repeat_play_count,
        updated_at = NOW()
      RETURNING *
    `;
    return mapScheduleRow(rows[0] as Record<string, unknown>);
  }

  const existing = memSchedules.get(id);
  const record: VoiceScheduleRecord = {
    id,
    deviceId: params.deviceId || 'default',
    title: params.title,
    cronExpr: params.cronExpr,
    timeStr: params.timeStr,
    repeatDays: params.repeatDays,
    enabled: params.enabled,
    sourceType: params.sourceType,
    clonedVoiceId: params.clonedVoiceId || null,
    clonedSpeakerRole: params.clonedSpeakerRole || null,
    textContent: params.textContent,
    audioUrl: safeAudioUrl ?? existing?.audioUrl ?? null,
    audioMd5: params.audioMd5 ?? existing?.audioMd5 ?? null,
    repeatPlayCount: params.repeatPlayCount,
    lastAckStatus: existing?.lastAckStatus || 'idle',
    lastAckAt: existing?.lastAckAt || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  memSchedules.set(id, record);
  return record;
}

export async function toggleVoiceSchedule(id: string, enabled?: boolean): Promise<VoiceScheduleRecord | null> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    const rows =
      typeof enabled === 'boolean'
        ? await sql`
            UPDATE voice_schedules SET enabled = ${enabled}, updated_at = NOW()
            WHERE id = ${id} RETURNING *
          `
        : await sql`
            UPDATE voice_schedules SET enabled = NOT enabled, updated_at = NOW()
            WHERE id = ${id} RETURNING *
          `;
    return rows.length > 0 ? mapScheduleRow(rows[0] as Record<string, unknown>) : null;
  }

  const existing = memSchedules.get(id);
  if (!existing) return null;
  const updated = {
    ...existing,
    enabled: typeof enabled === 'boolean' ? enabled : !existing.enabled,
  };
  memSchedules.set(id, updated);
  return updated;
}

export async function ackVoiceSchedule(id: string): Promise<void> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    await sql`
      UPDATE voice_schedules
      SET last_ack_status = 'confirmed', last_ack_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
    `;
    return;
  }
  const existing = memSchedules.get(id);
  if (existing) {
    memSchedules.set(id, {
      ...existing,
      lastAckStatus: 'confirmed',
      lastAckAt: new Date().toISOString(),
    });
  }
}

export async function deleteVoiceScheduleById(id: string): Promise<void> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    await sql`DELETE FROM voice_schedules WHERE id = ${id}`;
    return;
  }
  memSchedules.delete(id);
}

// ==================== 4. 亲子双向微聊语音消息 ====================

function mapChatMsgRow(r: Record<string, unknown>): ChatVoiceMessageRecord {
  return {
    id: String(r.id),
    deviceId: String(r.device_id || 'default'),
    direction: r.direction === 'device_to_parent' ? 'device_to_parent' : 'parent_to_device',
    senderName: String(r.sender_name || '妈妈'),
    audioUrl: String(r.audio_url || ''),
    durationSec: Number(r.duration_sec ?? 3),
    asrText: String(r.asr_text || ''),
    autoPlay: Boolean(r.auto_play),
    status: r.status === 'played' ? 'played' : 'unread',
    createdAt: new Date(String(r.created_at)).toISOString(),
  };
}

export async function listChatMessages(params?: {
  deviceId?: string;
  direction?: 'parent_to_device' | 'device_to_parent';
  status?: 'unread' | 'played';
  limit?: number;
}): Promise<ChatVoiceMessageRecord[]> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    const deviceId = params?.deviceId && params.deviceId !== 'all' ? params.deviceId : null;
    const direction = params?.direction || null;
    const status = params?.status || null;
    const rows = await sql`
      SELECT id, device_id, direction, sender_name, audio_url, duration_sec, asr_text, auto_play, status, created_at
      FROM chat_voice_messages
      WHERE (${deviceId}::text IS NULL OR device_id = ${deviceId})
        AND (${direction}::text IS NULL OR direction = ${direction})
        AND (${status}::text IS NULL OR status = ${status})
      ORDER BY created_at ASC, id ASC
      LIMIT ${params?.limit ?? null}
    `;
    return rows.map(r => mapChatMsgRow(r as Record<string, unknown>));
  }

  return Array.from(memChatMessages.values()).filter(m => {
    if (
      params?.deviceId &&
      params.deviceId !== 'all' &&
      m.deviceId !== params.deviceId
    ) {
      return false;
    }
    if (params?.direction && m.direction !== params.direction) return false;
    if (params?.status && m.status !== params.status) return false;
    return true;
  }).slice(0, params?.limit);
}

const memTransientAudio = new Map<string, { base64: string; mimeType: string }>();

export async function createChatMessage(params: {
  id?: string;
  deviceId?: string;
  direction: 'parent_to_device' | 'device_to_parent';
  senderName: string;
  durationSec: number;
  asrText: string;
  autoPlay: boolean;
  audioBase64?: string;
  audioMime?: string;
}): Promise<ChatVoiceMessageRecord> {
  const id = params.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const hasTransientAudio = Boolean(params.audioBase64 && params.audioBase64.length > 0);
  const audioUrl = hasTransientAudio ? `/api/v1/chat/messages/${id}/audio` : '';
  const mime = params.audioMime || 'audio/wav';

  // 聊天语音不长期持久化保存：仅在未读中转投递期暂存，对方播放确认 (`voice_read` / `played`) 后立刻置 NULL 销毁
  const record: ChatVoiceMessageRecord = {
    id,
    deviceId: params.deviceId || 'default',
    direction: params.direction,
    senderName: params.senderName,
    audioUrl,
    durationSec: Math.max(1, Number(params.durationSec || 3)),
    asrText: params.asrText,
    autoPlay: Boolean(params.autoPlay),
    status: 'unread',
    createdAt: new Date().toISOString(),
  };

  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    await sql`
      INSERT INTO chat_voice_messages (
        id, device_id, direction, sender_name, audio_url,
        pending_audio_base64, pending_audio_mime,
        duration_sec, asr_text, auto_play, status
      ) VALUES (
        ${record.id}, ${record.deviceId}, ${record.direction}, ${record.senderName},
        ${record.audioUrl}, ${hasTransientAudio ? params.audioBase64! : null}, ${hasTransientAudio ? mime : null},
        ${record.durationSec}, ${record.asrText}, ${record.autoPlay}, ${record.status}
      )
    `;
  } else {
    memChatMessages.set(record.id, record);
    if (hasTransientAudio) {
      memTransientAudio.set(record.id, { base64: params.audioBase64!, mimeType: mime });
    }
  }

  return record;
}

/**
 * 拉取未读微聊消息的临时中转音频（用于发声播放；已读清理后返回 null）
 */
export async function getTransientChatAudio(
  msgId: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const cleanId = msgId.replace(/\.(wav|mp3|webm)$/i, '');
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    const rows = await sql`
      SELECT pending_audio_base64, pending_audio_mime
      FROM chat_voice_messages
      WHERE id = ${cleanId}
      LIMIT 1
    `;
    if (rows.length > 0 && rows[0].pending_audio_base64) {
      return {
        buffer: Buffer.from(String(rows[0].pending_audio_base64), 'base64'),
        mimeType: String(rows[0].pending_audio_mime || 'audio/wav'),
      };
    }
    return null;
  }

  const mem = memTransientAudio.get(cleanId);
  if (!mem) return null;
  return {
    buffer: Buffer.from(mem.base64, 'base64'),
    mimeType: mem.mimeType,
  };
}

/**
 * 标记消息已读并立即销毁中转音频数据（阅后即焚，不长期保存聊天录音）
 */
export async function markChatMessagePlayed(id: string): Promise<void> {
  const sql = getNeonSql();
  if (sql) {
    await ensureNeonSchema();
    await sql`
      UPDATE chat_voice_messages
      SET status = 'played',
          audio_url = '',
          pending_audio_base64 = NULL,
          pending_audio_mime = NULL
      WHERE id = ${id}
    `;
    return;
  }
  memTransientAudio.delete(id);
  const existing = memChatMessages.get(id);
  if (existing) {
    memChatMessages.set(id, { ...existing, status: 'played', audioUrl: '' });
  }
}
