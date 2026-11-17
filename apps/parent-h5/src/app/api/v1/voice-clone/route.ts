import { NextRequest, NextResponse } from 'next/server';
import {
  isDoubaoConfigured,
  uploadDoubaoVoiceClone,
  getDoubaoVoiceCloneStatus,
} from '../../../../server/doubaoVoice';

/**
 * 火山引擎豆包声音复刻 API (`/api/v1/voice-clone`)
 * - GET: 查询 `speaker_id` 复刻训练状态 (`/api/v1/mega_tts/status`) 及服务端配置状态
 * - POST: 上传爸爸/妈妈录制的 WAV/MP3 Base64 音频并触发豆包 MegaTTS 声音复刻 (`/api/v1/mega_tts/audio/upload`)
 */
export async function GET(request: NextRequest) {
  const speakerId = request.nextUrl.searchParams.get('speakerId');
  const configured = isDoubaoConfigured();

  if (!speakerId) {
    return NextResponse.json({
      configured,
    });
  }

  if (!configured) {
    return NextResponse.json(
      { error: '服务端尚未配置 DOUBAO_SPEECH_API_KEY', configured: false },
      { status: 400 }
    );
  }

  try {
    const statusResult = await getDoubaoVoiceCloneStatus(speakerId);
    return NextResponse.json({
      configured: true,
      ...statusResult,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '查询复刻状态失败', configured: true },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const speakerRole: '妈妈' | '爸爸' = body.speakerRole === '爸爸' ? '爸爸' : '妈妈';
  const audioBase64: string = body.audioBase64 || '';
  const audioFormat: 'wav' | 'mp3' = body.audioFormat === 'mp3' ? 'mp3' : 'wav';

  // 豆包声音复刻专属 Speaker ID：支持用户自定义或留空自动生成唯一 S_xxx
  const customSpeakerId = (body.speakerId || '').trim();
  const speakerId: string =
    customSpeakerId ||
    `S_${speakerRole === '爸爸' ? 'dad' : 'mom'}_${Date.now().toString(36)}`;

  if (!isDoubaoConfigured()) {
    return NextResponse.json(
      {
        error:
          '未检测到豆包语音密钥，请在 .env.local 中配置 DOUBAO_SPEECH_API_KEY',
        configured: false,
      },
      { status: 400 }
    );
  }

  if (!speakerId) {
    return NextResponse.json(
      {
        error:
          '请填写火山引擎「声音复刻」控制台分配的专属音色 ID（Speaker ID，通常以 S_ 开头）',
        configured: true,
      },
      { status: 400 }
    );
  }

  if (!audioBase64) {
    return NextResponse.json(
      { error: '未收到录音音频数据（audioBase64 为空）', configured: true },
      { status: 400 }
    );
  }

  try {
    const result = await uploadDoubaoVoiceClone({
      speakerId,
      audioBase64,
      audioFormat,
      modelType: body.modelType ?? 1,
    });

    return NextResponse.json({
      status: 'ok',
      provider: 'volcengine-doubao-megatts',
      providerVoiceId: result.speakerId,
      cloneStatus: result.status,
      speakerRole,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : '调用火山引擎豆包声音复刻接口失败',
        configured: true,
      },
      { status: 502 }
    );
  }
}
