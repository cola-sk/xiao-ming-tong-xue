import 'server-only';
import { randomUUID } from 'node:crypto';
import { getDoubaoConfig } from './doubaoVoice';

export class SpeechRecognitionError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

export async function transcribeDeviceAudio(audioBase64: string, mime: string): Promise<string> {
  if (!['audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mpeg'].includes(mime) ||
      !audioBase64 || audioBase64.length > 1500000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64)) {
    throw new SpeechRecognitionError('语音格式或大小无效', 400);
  }
  const audio = Buffer.from(audioBase64, 'base64');
  const validHeader = mime.includes('wav') ? audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE'
    : mime === 'audio/ogg' ? audio.toString('ascii', 0, 4) === 'OggS'
    : audio.toString('ascii', 0, 3) === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);
  if (!validHeader) throw new SpeechRecognitionError('语音文件头与格式不一致', 400);
  const apiKey = getDoubaoConfig().apiKey;
  if (!apiKey) throw new SpeechRecognitionError('服务端尚未配置语音识别', 503);
  let response: Response;
  try {
    response = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-Api-Key': apiKey,
        'X-Api-Resource-Id': process.env.VOLC_ASR_RESOURCE_ID || 'volc.bigasr.auc_turbo',
        'X-Api-Request-Id': randomUUID(), 'X-Api-Sequence': '-1',
      },
      body: JSON.stringify({ user: { uid: 'xiaoming_device' }, audio: { data: audioBase64 },
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true } }),
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
  } catch { throw new SpeechRecognitionError('语音识别连接失败，请重试'); }
  const result = await response.json().catch(() => null);
  const code = response.headers.get('X-Api-Status-Code');
  if (code === '20000003' || code === '45000002') throw new SpeechRecognitionError('没有听清，请重新说一句话', 422);
  if (!response.ok || code !== '20000000') {
    if (response.status === 401 || response.status === 403)
      throw new SpeechRecognitionError('语音识别服务未授权，请检查 ASR 开通状态', 503);
    throw new SpeechRecognitionError('语音识别失败，请重试');
  }
  const text = typeof result?.result?.text === 'string' ? result.result.text.trim() : '';
  if (!text) throw new SpeechRecognitionError('没有听清，请重新说一句话', 422);
  return text.slice(0, 2000);
}
