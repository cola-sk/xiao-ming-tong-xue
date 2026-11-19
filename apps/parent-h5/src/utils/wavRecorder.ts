/**
 * 浏览器端 PCM -> WAV / MP3 录音器
 * - 声纹复刻 (`VoiceCloneModal`) 默认保持 24 kHz WAV 输出，无需变动。
 * - 亲子微聊 (`WeChatVoice`) 开启 MP3 压缩（重采样 16 kHz 单声道 + 32 kbps MP3），
 *   将 6 秒语音从 280–560 KB 压至 ~24 KB，并与 ESP32 MP3 解码器直接兼容；若编码失败自动回退 16 kHz WAV。
 */

import { Mp3Encoder } from '@breezystack/lamejs';

export interface WavRecorderOptions {
  outputFormat?: 'wav' | 'mp3';
  targetSampleRate?: number;
  mp3BitrateKbps?: number;
}

export interface WavRecorderResult {
  blob: Blob;
  base64: string;
  url: string;
  format: 'wav' | 'mp3';
  mime: 'audio/wav' | 'audio/mpeg';
}

export interface WavRecorderHandle {
  stop: () => Promise<WavRecorderResult>;
  cancel: () => Promise<void>;
}

function resampleMono(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!samples.length || fromRate === toRate || fromRate <= 0 || toRate <= 0) {
    return samples;
  }
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);

  if (fromRate > toRate) {
    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(samples.length, Math.max(start + 1, Math.ceil((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) {
        sum += samples[j];
      }
      out[i] = sum / (end - start);
    }
    return out;
  }

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = samples[Math.min(idx, samples.length - 1)];
    const s1 = samples[Math.min(idx + 1, samples.length - 1)];
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

function floatToInt16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return pcm;
}

function encodeWAV(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function encodeMP3(samples: Float32Array, sampleRate: number, bitrateKbps: number): Uint8Array {
  const pcm = floatToInt16(samples);
  const encoder = new Mp3Encoder(1, sampleRate, bitrateKbps);
  const chunks: Uint8Array[] = [];
  const blockSize = 1152;
  let totalBytes = 0;

  for (let i = 0; i < pcm.length; i += blockSize) {
    const chunk = encoder.encodeBuffer(pcm.subarray(i, i + blockSize));
    if (chunk.length > 0) {
      chunks.push(chunk);
      totalBytes += chunk.length;
    }
  }
  const tail = encoder.flush();
  if (tail.length > 0) {
    chunks.push(tail);
    totalBytes += tail.length;
  }

  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function startWavRecorder(options?: WavRecorderOptions): Promise<WavRecorderHandle> {
  const wantMp3 = options?.outputFormat === 'mp3';
  const targetRate = wantMp3 ? (options?.targetSampleRate ?? 16000) : (options?.targetSampleRate ?? 24000);
  const bitrateKbps = options?.mp3BitrateKbps ?? 32;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: targetRate,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx({ sampleRate: targetRate });
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];

  processor.onaudioprocess = e => {
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);

  let stopped = false;
  const close = async () => {
    if (stopped) return;
    stopped = true;
    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach(t => t.stop());
    await audioCtx.close().catch(() => {});
  };

  return {
    cancel: async () => {
      await close();
      chunks.length = 0;
    },
    stop: async () => {
      if (stopped) throw new Error('录音已经结束');
      const actualRate = audioCtx.sampleRate || targetRate;
      await close();

      const totalLength = chunks.reduce((acc, cur) => acc + cur.length, 0);
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }

      if (wantMp3) {
        const resampled = resampleMono(merged, actualRate, targetRate);
        try {
          const mp3Bytes = encodeMP3(resampled, targetRate, bitrateKbps);
          if (mp3Bytes.length > 0) {
            const base64 = bytesToBase64(mp3Bytes);
            const blob = new Blob([mp3Bytes.buffer as ArrayBuffer], { type: 'audio/mpeg' });
            const url = URL.createObjectURL(blob);
            return { blob, base64, url, format: 'mp3', mime: 'audio/mpeg' };
          }
        } catch (err) {
          console.warn('MP3 encode failed, falling back to 16kHz WAV:', err);
        }
        const wavFallback = encodeWAV(resampled, targetRate);
        const base64 = bytesToBase64(wavFallback);
        const blob = new Blob([wavFallback.buffer as ArrayBuffer], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        return { blob, base64, url, format: 'wav', mime: 'audio/wav' };
      }

      const wavBytes = encodeWAV(merged, actualRate);
      const base64 = bytesToBase64(wavBytes);
      const blob = new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      return { blob, base64, url, format: 'wav', mime: 'audio/wav' };
    },
  };
}
