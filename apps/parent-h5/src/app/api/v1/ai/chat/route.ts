import { transcribeDeviceAudio, SpeechRecognitionError } from '@/server/speechRecognition';
import { deviceAccess } from '@/server/deviceAccess';
import { NextRequest, NextResponse } from 'next/server';
import { isDoubaoConfigured, synthesizeDoubaoTts } from '@/server/doubaoVoice';
import { getPetAiConfig, appendAiChatLog } from '@/server/appDataStore';

export const maxDuration = 60;

/**
 * 清理回答中的 Emoji 和特殊符号，确保传给豆包语音 2.0 合成时发音自然流畅
 */
function sanitizeTextForTts(text: string): string {
  return text
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/[*#~`]/g, '')
    .trim();
}

/**
 * 豆包问答 (Volcengine Ark) + 豆包语音合成 (Doubao Speech V3) 一体化接口 (`/api/v1/ai/chat`)
 * 1. 自动读取设备配置的宠物人设与音色 (`pet_ai_configs`)
 * 2. 问答大脑（LLM）：调用火山方舟生成回答，并仅把问答文本记录写入 `ai_chat_logs`（音频不落库）
 * 3. 声音回复（TTS）：调用豆包语音 2.0 实时合成 MP3，支持返回 JSON 或直接返回 `audio/mpeg` 供 ESP32 播放
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const deviceId: string = String(body.deviceId || 'default');
  const access = await deviceAccess(request, deviceId);
  if (access.error) return access.error;
  let question = typeof body.question === 'string' ? body.question.trim().slice(0, 2000) : '';
  if (body.audioBase64 !== undefined) {
    try { question = await transcribeDeviceAudio(String(body.audioBase64), String(body.audioMime || 'audio/wav')); }
    catch (err) { return NextResponse.json({ error: err instanceof Error ? err.message : '语音识别失败' }, { status: err instanceof SpeechRecognitionError ? err.status : 502 }); }
  }
  if (!question) return NextResponse.json({ error: '请说一句话或输入问题' }, { status: 400 });
  const savedConfig = await getPetAiConfig(deviceId);

  const petName: string = body.petName || savedConfig.petName || '小铭同学';
  const voiceType: string = body.voiceType || savedConfig.voiceId || 'zh_female_vv_uranus_bigtts';
  const systemPrompt: string =
    body.systemPrompt ||
    savedConfig.customPrompt ||
    `你是5岁的智能语音萌宠“${petName}”，性格活泼温暖，回答小朋友的问题要简短有趣、纯口语化（不要使用Emoji表情符号或Markdown格式），每次不超过50字。`;

  const arkApiKey = process.env.ARK_API_KEY || process.env.DOUBAO_ARK_API_KEY || '';
  const deepseekKey = process.env.DEEPSEEK_API_KEY || '';
  const apiKey = arkApiKey || deepseekKey;

  const baseUrl =
    process.env.LLM_BASE_URL ||
    (arkApiKey ? 'https://ark.cn-beijing.volces.com/api/v3' : 'https://api.deepseek.com/v1');

  const candidateModels = arkApiKey
    ? Array.from(
        new Set([
          process.env.ARK_MODEL_ID || 'doubao-seed-2-0-mini-260428',
          'doubao-seed-2-0-mini-260428',
          'doubao-seed-evolving',
        ])
      )
    : [process.env.LLM_MODEL || 'deepseek-chat'];

  if (!apiKey) return NextResponse.json({ error: '服务端尚未配置 AI 对话' }, { status: 503 });
  let reply = '';
  let llmProvider = 'local-fallback';

  const llmDeadline = Date.now() + 20000;
  if (apiKey) {
    for (const model of candidateModels) {
      if (Date.now() >= llmDeadline) break;
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'system',
                content: `${systemPrompt} 请用纯中文口语直接回答，不要带表情符号，字数控制在50字以内。`,
              },
              { role: 'user', content: question },
            ],
            // 针对豆包 Seed 2.0 思考模型设置关闭深度思考或提供充足的 completion token
            thinking: { type: 'disabled' },
            max_tokens: 200,
            temperature: 0.7,
          }),
          cache: 'no-store',
          signal: AbortSignal.timeout(Math.max(1, Math.min(12000, llmDeadline - Date.now()))),
        });

        if (response.ok) {
          const data = await response.json();
          const content = data.choices?.[0]?.message?.content?.trim();
          if (content) {
            reply = content;
            llmProvider = model;
            break;
          }
        }
      } catch (err) {
        console.error(`LLM model ${model} call failed:`, err);
      }
    }
  }

  if (!reply) return NextResponse.json({ error: 'AI 暂时无法回答，请重试' }, { status: 502 });

  // 1) 仅将纯文本问答写入 ai_chat_logs 表（不存音频）
  const log = await appendAiChatLog({
    deviceId,
    childText: question,
    petReplyText: reply,
  }).catch(() => null);

  // 2) 立即调用豆包语音 V3 实时合成回答音频流（persist: false，不写入数据库，播放完即释放）
  let audioDataUrl: string | undefined;
  let audioBase64: string | undefined;
  if (isDoubaoConfigured()) {
    try {
      const cleanTtsText = sanitizeTextForTts(reply) || reply;
      const ttsResult = await synthesizeDoubaoTts({
        text: cleanTtsText,
        voiceType,
        isClonedVoice: voiceType.startsWith('S_'),
        persist: false,
        timeoutMs: 15000,
      });
      audioDataUrl = ttsResult.audioDataUrl;
      audioBase64 = ttsResult.audioBase64;
    } catch (err) {
      console.error('Doubao TTS synthesis in /api/v1/ai/chat failed:', err);
    }
  }

  if (body.responseFormat === 'mp3' && !audioBase64) return NextResponse.json({ error: '语音回复合成失败，请重试' }, { status: 502 });

  // 若 ESP32 请求直接返回 MP3 二进制流
  if (body.responseFormat === 'mp3' && audioBase64) {
    const mp3Buf = Buffer.from(audioBase64, 'base64');
    return new NextResponse(new Uint8Array(mp3Buf), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(mp3Buf.length),
        'X-Pet-Reply': encodeURIComponent(reply),
        'X-Pet-Question': encodeURIComponent(question),
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json({
    status: 'ok',
    provider: llmProvider,
    arkConfigured: Boolean(arkApiKey),
    reply,
    question,
    audioDataUrl,
    logId: log?.id,
  });
}
