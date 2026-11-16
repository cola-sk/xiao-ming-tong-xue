// 豆包 TTS / 声音复刻与浏览器端语音播放工具

export function speakText(text: string, pitch = 1.25, rate = 1.05): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.pitch = pitch;
    utterance.rate = rate;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Ignore speech synthesis errors on restricted browsers
  }
}

export function speakBySourceType(
  text: string,
  sourceType: 'tts' | 'parent_clone' | 'record',
  speakerRole?: string | null
): void {
  if (sourceType === 'parent_clone') {
    const isDad = speakerRole?.includes('爸');
    speakText(text, isDad ? 0.82 : 1.06, 0.98);
    return;
  }
  speakText(text, 1.28, 1.05);
}

/**
 * 调用后端 `/api/v1/tts`（火山引擎豆包真实 TTS / 声音复刻合成）获取 MP3 DataURL 与 MD5
 */
export async function requestDoubaoTtsAudio(params: {
  text: string;
  voiceType?: string;
  isClonedVoice?: boolean;
  /** 仅「定时语音任务」传 true 保存到数据库生成永久地址；试听、AI回答与聊天均传 false（默认） */
  persist?: boolean;
}): Promise<{
  ok: boolean;
  audioUrl?: string;
  audioDataUrl?: string;
  audioMd5?: string;
  fromCache?: boolean;
  error?: string;
  configured?: boolean;
}> {
  try {
    const res = await fetch('/api/v1/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (!data.audioUrl && !data.audioDataUrl)) {
      return {
        ok: false,
        error: data.error || '豆包 TTS 合成未返回音频',
        configured: data.configured,
      };
    }
    return {
      ok: true,
      audioUrl: data.audioUrl,
      audioDataUrl: data.audioDataUrl,
      audioMd5: data.audioMd5,
      fromCache: data.fromCache,
      configured: true,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : '网络请求失败',
    };
  }
}

export function playAudioOrFallback(
  audioUrl: string | null | undefined,
  fallbackText?: string,
  sourceType: 'tts' | 'parent_clone' | 'record' = 'tts',
  speakerRole?: string | null
): Promise<void> {
  return new Promise(resolve => {
    if (typeof window === 'undefined') {
      resolve();
      return;
    }
    if (
      audioUrl &&
      (audioUrl.startsWith('/api/v1/audio/') ||
        audioUrl.startsWith('blob:') ||
        audioUrl.startsWith('data:audio/') ||
        audioUrl.startsWith('http://') ||
        audioUrl.startsWith('https://'))
    ) {
      const audio = new Audio(audioUrl);
      audio.onended = () => resolve();
      audio.onerror = () => {
        if (fallbackText) speakBySourceType(fallbackText, sourceType, speakerRole);
        setTimeout(resolve, 1800);
      };
      audio.play().catch(() => {
        if (fallbackText) speakBySourceType(fallbackText, sourceType, speakerRole);
        setTimeout(resolve, 1800);
      });
      return;
    }
    if (fallbackText) {
      speakBySourceType(fallbackText, sourceType, speakerRole);
    }
    setTimeout(resolve, Math.max(1500, (fallbackText?.length || 6) * 200));
  });
}
