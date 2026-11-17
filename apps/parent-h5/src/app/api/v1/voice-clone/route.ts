import { NextRequest, NextResponse } from 'next/server';
import { isDoubaoConfigured, uploadDoubaoVoiceClone, getDoubaoVoiceCloneStatus } from '@/server/doubaoVoice';
import { listVoiceCloneProfiles, saveVoiceCloneProfile, updateVoiceCloneStatus, deleteVoiceCloneProfileById } from '@/server/appDataStore';

export const dynamic = 'force-dynamic';
// 3 MiB binary becomes ~4 MiB Base64, leaving headroom under Vercel's request limit.
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const SPEAKER_ID = /^S_[a-zA-Z0-9_-]{1,252}$/;

function profileStatus(status?: number): 'training' | 'ready' | 'failed' | 'unknown' {
  if (status === 2 || status === 4) return 'ready';
  if (status === 1) return 'training';
  if (status === 3) return 'failed';
  return 'unknown';
}

export async function GET(request: NextRequest) {
  const speakerId = request.nextUrl.searchParams.get('speakerId');
  const configured = isDoubaoConfigured();
  if (!speakerId) {
    try {
      return NextResponse.json({ configured, profiles: await listVoiceCloneProfiles() });
    } catch {
      return NextResponse.json({ error: '读取音色列表失败，请稍后重试' }, { status: 500 });
    }
  }
  if (!SPEAKER_ID.test(speakerId)) return NextResponse.json({ error: '音色 ID 格式无效' }, { status: 400 });
  if (!configured) return NextResponse.json({ error: '服务端尚未配置豆包语音密钥' }, { status: 503 });
  try {
    const result = await getDoubaoVoiceCloneStatus(speakerId);
    await updateVoiceCloneStatus(speakerId, profileStatus(result.status));
    return NextResponse.json({ configured: true, ...result, profileStatus: profileStatus(result.status) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '查询音色状态失败' }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: '请求格式无效' }, { status: 400 });
  const speakerRole = body.speakerRole === '爸爸' ? '爸爸' : '妈妈';
  const speakerId = typeof body.speakerId === 'string' ? body.speakerId.trim() : '';
  const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64 : '';
  const audioFormat = body.audioFormat;
  if (!SPEAKER_ID.test(speakerId)) return NextResponse.json({ error: '请填写火山引擎控制台已开通的 S_ 音色 ID' }, { status: 400 });
  if (audioFormat !== 'wav' && audioFormat !== 'mp3') return NextResponse.json({ error: '仅支持 WAV 或 MP3 文件' }, { status: 400 });
  if (!audioBase64 || audioBase64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audioBase64)) {
    return NextResponse.json({ error: '音频无效或超过 3 MB，请重新选择' }, { status: 400 });
  }
  const bytes = Buffer.from(audioBase64, 'base64');
  const isWav = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  const isMp3 = bytes.length >= 3 && (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
  if (bytes.length > MAX_AUDIO_BYTES || (audioFormat === 'wav' ? !isWav : !isMp3)) {
    return NextResponse.json({ error: '文件内容与所选音频格式不符，请选择有效的 WAV 或 MP3 文件' }, { status: 400 });
  }
  if (!isDoubaoConfigured()) return NextResponse.json({ error: '服务端尚未配置豆包语音密钥' }, { status: 503 });

  let result: Awaited<ReturnType<typeof uploadDoubaoVoiceClone>>;
  try {
    result = await uploadDoubaoVoiceClone({ speakerId, audioBase64, audioFormat });
  } catch (err) {
    // The provider may have accepted a request before the connection failed. Do not auto-retry training.
    return NextResponse.json({ error: err instanceof Error ? err.message : '上传复刻音频失败，请先查询音色状态再重试' }, { status: 502 });
  }
  try {
    const profile = await saveVoiceCloneProfile({
      speakerRole,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 30) : `${speakerRole}的声音`,
      sampleText: typeof body.sampleText === 'string' ? body.sampleText.trim().slice(0, 500) : '',
      providerVoiceId: result.speakerId,
      status: result.status === undefined ? 'training' : profileStatus(result.status),
    });
    return NextResponse.json({ status: 'ok', providerVoiceId: result.speakerId, cloneStatus: result.status ?? null, profile });
  } catch {
    return NextResponse.json({ error: `音频已提交，但音色档案保存失败。音色 ID：${result.speakerId}；请先查询状态，避免重复提交训练。` }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: '缺少音色档案 ID' }, { status: 400 });
  try {
    await deleteVoiceCloneProfileById(id);
    return NextResponse.json({ status: 'ok', deletedId: id });
  } catch {
    return NextResponse.json({ error: '删除音色档案失败，请稍后重试' }, { status: 500 });
  }
}
