import { deviceAccess } from '@/server/deviceAccess';
import { NextRequest, NextResponse } from 'next/server';
import { isDoubaoConfigured, synthesizeDoubaoTts, getDoubaoVoiceCloneStatus } from '../../../../server/doubaoVoice';

/**
 * 火山引擎豆包语音合成 (TTS) API (`/api/v1/tts`)
 * - 支持传入复刻好的爸妈 `speaker_id` (`S_xxxxxx`, cluster=`volcano_icl`) 将任意文字合成为爸爸妈妈的真实模拟声音 MP3
 * - 支持传入豆包内置音色 (`BV700_V2_streaming` 等, cluster=`volcano_tts`) 合成「小铭同学」宠物语音 MP3
 */
export async function POST(request: NextRequest) {
  const access = await deviceAccess(request);
  if (access.error) return access.error;
  const body = await request.json().catch(() => ({}));
  const text: string = (body.text || '').trim();
  const voiceType: string = (body.voiceType || '').trim();
  const isClonedVoice: boolean = Boolean(body.isClonedVoice);
  const speedRatio: number = Number(body.speedRatio) || 1.0;
  // 只有定时语音任务才传 persist: true 保存到数据库；其他试听或对话均不落库
  const persist: boolean = !access.deviceId && Boolean(body.persist);

  if (!text) {
    return NextResponse.json({ error: '请输入要合成语音的文字内容' }, { status: 400 });
  }

  if (!isDoubaoConfigured()) {
    return NextResponse.json(
      {
        error:
          '未检测到豆包语音配置，请在 .env.local 中填入 DOUBAO_SPEECH_API_KEY',
        configured: false,
      },
      { status: 400 }
    );
  }

  try {
    if (isClonedVoice || voiceType.startsWith('S_')) {
      if (!voiceType.startsWith('S_')) return NextResponse.json({ error: '请选择有效的复刻音色' }, { status: 400 });
      const clone = await getDoubaoVoiceCloneStatus(voiceType);
      if (clone.status !== 2 && clone.status !== 4) return NextResponse.json({ error: '音色尚未训练成功，请先查询音色状态' }, { status: 409 });
    }
    const result = await synthesizeDoubaoTts({
      text,
      voiceType: voiceType || undefined,
      isClonedVoice,
      speedRatio,
      persist,
    });

    if (body.responseFormat === 'mp3') {
      const audio = Buffer.from(result.audioBase64, 'base64');
      return new NextResponse(new Uint8Array(audio), { headers: {
        'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length), 'Cache-Control': 'no-store',
      } });
    }
    return NextResponse.json({
      status: 'ok',
      provider: 'volcengine-doubao-tts',
      audioUrl: result.audioUrl,
      audioDataUrl: result.audioDataUrl,
      audioMd5: result.audioMd5,
      fromCache: result.fromCache,
      durationMs: result.durationMs,
      voiceType: result.voiceType,
      cluster: result.cluster,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : '豆包 TTS 语音合成失败',
        configured: true,
      },
      { status: 502 }
    );
  }
}
