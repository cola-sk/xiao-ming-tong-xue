import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { findExistingAudioByText, saveSynthesizedAudio } from './audioStore';
import { getVoiceLoudnessRate } from './voiceSettings';

const VOLC_SPEECH_HOST = 'https://openspeech.bytedance.com';

export interface DoubaoConfig {
  /** 豆包语音 API Key (`X-Api-Key`) */
  apiKey: string;
  /** V3 声音复刻合成 Resource-Id，默认 seed-icl-2.0（兼容 seed-icl-1.0 / volc.megatts.default） */
  v3CloneResourceId: string;
  /** V3 豆包大模型 TTS Resource-Id，默认 seed-tts-2.0 */
  v3TtsResourceId: string;
  /** 声音复刻上传训练 Resource-Id，默认 volc.megatts.voiceclone */
  cloneUploadResourceId: string;
  defaultPetVoiceType: string;
}

export function getDoubaoConfig(): DoubaoConfig {
  return {
    apiKey: process.env.DOUBAO_SPEECH_API_KEY || '',
    v3CloneResourceId: process.env.VOLC_V3_CLONE_RESOURCE_ID || 'seed-icl-2.0',
    v3TtsResourceId: process.env.VOLC_V3_TTS_RESOURCE_ID || 'seed-tts-2.0',
    cloneUploadResourceId: process.env.VOLC_CLONE_RESOURCE_ID || 'volc.megatts.voiceclone',
    defaultPetVoiceType:
      process.env.VOLC_PET_VOICE_TYPE || 'zh_female_vv_uranus_bigtts',
  };
}

export function isDoubaoConfigured(): boolean {
  return Boolean(getDoubaoConfig().apiKey);
}

/** Voice clone V3 requires a speaker ID provisioned in the Volcengine console. */
async function callVoiceCloneV3(path: string, body: Record<string, unknown>) {
  const apiKey = getDoubaoConfig().apiKey;
  if (!apiKey) throw new Error('未配置豆包语音 API Key');
  const response = await fetch(`${VOLC_SPEECH_HOST}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || (typeof data.code === 'number' && data.code !== 0 && data.code !== 20000000)) {
    const logId = response.headers.get('X-Tt-Logid');
    throw new Error(`${data?.message || `火山引擎请求失败 (HTTP ${response.status})`}${logId ? ` (日志 ID: ${logId})` : ''}`);
  }
  return data;
}

export async function uploadDoubaoVoiceClone(params: {
  speakerId: string;
  audioBase64: string;
  audioFormat: 'wav' | 'mp3';
}) {
  const data = await callVoiceCloneV3('/api/v3/tts/voice_clone', {
    speaker_id: params.speakerId,
    audio: { data: params.audioBase64, format: params.audioFormat },
    language: 0,
  });
  return { speakerId: data.speaker_id || params.speakerId, status: data.status as number | undefined };
}

export async function getDoubaoVoiceCloneStatus(speakerId: string) {
  const data = await callVoiceCloneV3('/api/v3/tts/get_voice', { speaker_id: speakerId });
  if (typeof data.status !== 'number' || ![0, 1, 2, 3, 4].includes(data.status)) {
    throw new Error('火山引擎未返回有效的音色状态，请稍后重试');
  }
  return { speakerId: data.speaker_id || speakerId, status: data.status as number };
}

/**
 * 内部辅助：调用豆包语音 V3 单向流式接口 (`POST /api/v3/tts/unidirectional`)
 * 纯 `X-Api-Key` + `X-Api-Resource-Id` 鉴权，逐行解析 NDJSON Base64 音频分片并合并为完整 MP3
 */
async function synthesizeViaV3Unidirectional(params: {
  apiKey: string;
  resourceId: string;
  text: string;
  speaker: string;
  speedRatio?: number;
  loudnessRate: number;
  timeoutMs?: number;
}): Promise<{ audioBuffer: Buffer; resourceId: string }> {
  const response = await fetch(`${VOLC_SPEECH_HOST}/api/v3/tts/unidirectional`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': params.apiKey,
      'X-Api-Resource-Id': params.resourceId,
    },
    body: JSON.stringify({
      user: {
        uid: 'xiaoming_parent_h5',
      },
      req_params: {
        text: params.text,
        speaker: params.speaker,
        audio_params: {
          format: 'mp3',
          sample_rate: 24000,
          loudness_rate: params.loudnessRate,
          speech_rate: Math.round(((params.speedRatio ?? 1.0) - 1.0) * 100),
        },
      },
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(params.timeoutMs || 30000),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`豆包 V3 TTS HTTP ${response.status}: ${rawText.slice(0, 200)}`);
  }

  const audioChunks: Buffer[] = [];
  const lines = rawText.split(/\r?\n/).filter(l => l.trim().length > 0);
  for (const line of lines) {
    let packet: { code?: number; message?: string; data?: string };
    try {
      packet = JSON.parse(line);
    } catch {
      throw new Error('豆包 TTS 返回了无法解析的数据');
    }
    if (packet.code && packet.code !== 0 && packet.code !== 20000000) {
      throw new Error(packet.message || `豆包 V3 合成错误 (code: ${packet.code})`);
    }
    if (typeof packet.data === 'string' && packet.data.length > 0) {
      audioChunks.push(Buffer.from(packet.data, 'base64'));
    }
  }

  if (audioChunks.length === 0) {
    throw new Error('豆包 V3 接口未返回有效音频分片');
  }

  return {
    audioBuffer: Buffer.concat(audioChunks),
    resourceId: params.resourceId,
  };
}

/**
 * 3. 调用豆包语音 V3 接口合成语音 (`/api/v3/tts/unidirectional` + `X-Api-Key`)
 * @param params.persist 是否将生成的音频持久化保存到数据库 (`tts_audio_files`) 并生成 `/api/v1/audio/{md5}.mp3` 固定地址。
 *   - 仅「定时语音播报任务」传 `persist: true`（因为定时任务每天重复播放且需供 ESP32 下载缓存）。
 *   - 「AI 问答回复」与「临时试听/微聊」传 `persist: false`（默认），用完即走，绝不落库占用数据库空间！
 */
export async function synthesizeDoubaoTts(params: {
  text: string;
  voiceType?: string;
  isClonedVoice?: boolean;
  speedRatio?: number;
  persist?: boolean;
  loudnessRate?: number;
  timeoutMs?: number;
}) {
  const cfg = getDoubaoConfig();
  if (!cfg.apiKey) {
    throw new Error('未配置豆包语音 DOUBAO_SPEECH_API_KEY');
  }

  const speaker = params.voiceType || cfg.defaultPetVoiceType;
  const shouldPersist = Boolean(params.persist);
  const loudnessRate = params.loudnessRate !== undefined ? params.loudnessRate : await getVoiceLoudnessRate();
  const speed = params.speedRatio ?? 1;
  // Old cache entries have the default volume and speed. New variants need distinct keys.
  const cacheVoiceType = loudnessRate === 0 && speed === 1 ? speaker : `${speaker}|loudness=${loudnessRate}|speed=${speed}`;

  // 1) 仅当开启持久化 (persist = true，即定时语音任务) 时，才查询数据库是否已有缓存音频
  // Retraining can change a clone without changing its speaker ID.
  if (shouldPersist && !speaker.startsWith('S_')) {
    const existing = await findExistingAudioByText(cacheVoiceType, params.text);
    if (existing) {
      return {
        audioUrl: `/api/v1/audio/${existing.md5}.mp3`,
        audioBase64: existing.audioBase64,
        audioDataUrl: `data:audio/mp3;base64,${existing.audioBase64}`,
        audioMd5: existing.md5,
        durationMs: undefined,
        voiceType: speaker,
        cluster: 'cached:database',
        fromCache: true,
      };
    }
  }

  // 仅当音色编码以 S_ 开头（复刻专属 Speaker ID）时走 seed-icl-2.0；
  // 宠物玩具官方内置音色（如 zh_female_vv_uranus_bigtts）则走 seed-tts-2.0
  const isCustomClonedSpeaker = Boolean(speaker.startsWith('S_'));

  const candidateResourceIds = isCustomClonedSpeaker
    ? Array.from(
        new Set([
          cfg.v3CloneResourceId,
          'seed-icl-2.0',
          'seed-icl-1.0',
          'volc.megatts.default',
        ])
      )
    : Array.from(
        new Set([
          cfg.v3TtsResourceId,
          'seed-tts-2.0',
          'seed-tts-1.0',
          'volc.service_type.10029',
        ])
      );

  let lastError: Error | null = null;
  const deadline = Date.now() + (params.timeoutMs || 60000);
  for (const resourceId of candidateResourceIds) {
    if (Date.now() >= deadline) break;
    try {
      const { audioBuffer, resourceId: usedRes } = await synthesizeViaV3Unidirectional({
        apiKey: cfg.apiKey,
        resourceId,
        text: params.text,
        speaker,
        speedRatio: params.speedRatio,
        loudnessRate,
        timeoutMs: Math.max(1, Math.min(params.timeoutMs || 30000, deadline - Date.now())),
      });
      const audioBase64 = audioBuffer.toString('base64');
      const audioMd5 = createHash('md5').update(audioBuffer).digest('hex');

      // 2) 仅当 persist = true（定时语音任务）时才写入数据库生成永久 URL；AI 对话与临时消息直接返回流，不存数据库
      if (shouldPersist) {
        await saveSynthesizedAudio({
          md5: audioMd5,
          voiceType: cacheVoiceType,
          textContent: params.text,
          audioBase64,
        });
      }

      return {
        audioUrl: shouldPersist ? `/api/v1/audio/${audioMd5}.mp3` : undefined,
        audioBase64,
        audioDataUrl: `data:audio/mp3;base64,${audioBase64}`,
        audioMd5,
        durationMs: undefined,
        voiceType: speaker,
        cluster: `v3:${usedRes}`,
        fromCache: false,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError || new Error('豆包 V3 TTS 语音合成失败');
}
