'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Popup, Toast, Dialog } from 'antd-mobile';
import { DeleteOutline } from 'antd-mobile-icons';
import { useAppStore } from '../../stores/useAppStore';
import { VoiceCloneProfile } from '../../services/types';
import { IconMic, IconVolume, IconSparkle, IconCheck } from '../../components/Icons';
import {
  playAudioOrFallback,
  playAudioStrict,
  requestDoubaoTtsAudio,
} from '../../utils/voiceSynth';
import { startWavRecorder, WavRecorderHandle } from '../../utils/wavRecorder';

interface Props {
  visible: boolean;
  onClose: () => void;
  initialMode?: 'list' | 'create' | 'retrain';
  initialProfile?: VoiceCloneProfile | null;
}

const DEFAULT_SAMPLE_SCRIPT =
  '堂堂、正正，今天在学校开心吗？记得按时喝水，早点刷牙睡觉哦，遇到不懂的问题可以问小铭同学！';

export const VoiceCloneModal: React.FC<Props> = ({
  visible,
  onClose,
  initialMode = 'list',
  initialProfile = null,
}) => {
  const {
    voiceClones,
    addVoiceCloneProfile,
    deleteVoiceCloneProfile,
    syncVoiceClonesFromServer,
  } = useAppStore();

  const [mode, setMode] = useState<'list' | 'create' | 'retrain'>('list');
  const [editingProfile, setEditingProfile] = useState<VoiceCloneProfile | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [title, setTitle] = useState('');
  const [speakerIdInput, setSpeakerIdInput] = useState('');
  const [doubaoConfigured, setDoubaoConfigured] = useState<boolean | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [recordedWavUrl, setRecordedWavUrl] = useState<string>('');
  const [recordedWavBase64, setRecordedWavBase64] = useState<string>('');
  const [audioFormat, setAudioFormat] = useState<'wav' | 'mp3'>('wav');
  const [isCloning, setIsCloning] = useState(false);
  const [synthesizingId, setSynthesizingId] = useState<string>('');
  const [checkingId, setCheckingId] = useState<string>('');
  const [testText, setTestText] = useState('宝贝，八点半啦，快去刷牙洗脸准备睡觉吧！');

  const timerRef = useRef<number | null>(null);
  const wavRecorderRef = useRef<WavRecorderHandle | null>(null);

  const loadProfiles = async () => {
    try {
      const response = await fetch('/api/v1/voice-clone', { cache: 'no-store' });
      if (!response.ok) throw new Error('音色列表加载失败');
      const data = await response.json();
      if (!Array.isArray(data.profiles)) throw new Error('音色列表格式无效');
      useAppStore.setState(state => ({
        voiceClones: data.profiles.map((profile: VoiceCloneProfile) => ({
          ...profile, familyId: state.family.id,
        })),
      }));
      setDoubaoConfigured(Boolean(data.configured));
      setLoadError(false);
      setProfilesLoaded(true);
    } catch {
      setLoadError(true);
    }
  };

  useEffect(() => {
    if (!visible) return;
    if (initialMode === 'create') {
      openCreate();
    } else if (initialMode === 'retrain' && initialProfile) {
      openRetrain(initialProfile);
    } else {
      setMode('list');
    }
    setProfilesLoaded(false);
    void loadProfiles();
  // Refresh when opening the manager.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialMode, initialProfile]);

  useEffect(() => {
    if (!visible) return;
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      const recorder = wavRecorderRef.current;
      wavRecorderRef.current = null;
      if (recorder) void recorder.cancel().catch(() => {});
      setIsRecording(false);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const trainingIds = [...new Set(voiceClones.filter(v => v.status === 'training').map(v => v.providerVoiceId))];
    if (trainingIds.length === 0) return;
    let disposed = false;
    const timer = window.setInterval(async () => {
      const results = await Promise.allSettled(trainingIds.map(id =>
        fetch(`/api/v1/voice-clone?speakerId=${encodeURIComponent(id)}`, { cache: 'no-store' })
      ));
      if (!disposed && results.some(result => result.status === 'fulfilled' && result.value.ok)) {
        await syncVoiceClonesFromServer();
      }
    }, 15000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [visible, voiceClones, syncVoiceClonesFromServer]);

  const openCreate = () => {
    setEditingProfile(null);
    setTitle('');
    setSpeakerIdInput('');
    setRecordedWavUrl('');
    setRecordedWavBase64('');
    setMode('create');
  };

  const openRetrain = (profile: VoiceCloneProfile) => {
    setEditingProfile(profile);
    setTitle(profile.title);
    setSpeakerIdInput(profile.providerVoiceId);
    setRecordedWavUrl('');
    setRecordedWavBase64('');
    setMode('retrain');
  };

  const startRecordSample = async () => {
    if (isRecording) return;
    try {
      const handle = await startWavRecorder();
      wavRecorderRef.current = handle;
      setIsRecording(true);
      setRecordSec(1);
      timerRef.current = window.setInterval(() => {
        setRecordSec(s => s + 1);
      }, 1000);
    } catch {
      Toast.show({ icon: 'fail', content: '无法访问麦克风，请允许浏览器麦克风权限后重试' });
    }
  };

  const stopRecordSample = async () => {
    if (!isRecording) return;
    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (wavRecorderRef.current) {
      const { url, base64 } = await wavRecorderRef.current.stop();
      wavRecorderRef.current = null;
      setRecordedWavUrl(url);
      setRecordedWavBase64(base64);
      setAudioFormat('wav');
    }
  };

  const handleUploadSampleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size === 0 || file.size > 3 * 1024 * 1024) {
      Toast.show({ icon: 'fail', content: '音频文件需大于 0 且不超过 3 MB' });
      return;
    }
    try {
      const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const wav = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WAVE';
      const mp3 = bytes.length >= 3 && (String.fromCharCode(...bytes.slice(0, 3)) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
      if (!wav && !mp3) throw new Error('请选择有效的 WAV 或 MP3 文件');
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      if (!base64) throw new Error('读取文件失败');
      setRecordedWavUrl(URL.createObjectURL(file));
      setRecordedWavBase64(base64);
      setAudioFormat(wav ? 'wav' : 'mp3');
      setRecordSec(0);
      Toast.show({ icon: 'success', content: `已载入音频文件：${file.name}` });
    } catch (err) {
      Toast.show({ icon: 'fail', content: err instanceof Error ? err.message : '读取文件失败' });
    }
  };

  const handleSubmitClone = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      Toast.show({ content: '请先输入声音名称（如：妈妈、爸爸、爷爷讲故事）' });
      return;
    }
    if (!recordedWavBase64) {
      Toast.show({ content: '请先录制或上传 WAV/MP3 声音样本' });
      return;
    }

    const resolvedSpeakerId = speakerIdInput.trim();
    if (!/^S_[a-zA-Z0-9_-]+$/.test(resolvedSpeakerId)) {
      Toast.show({ content: '请填写火山引擎控制台已开通的 S_ 音色 ID' });
      return;
    }

    const resolvedRole = trimmedTitle.slice(0, 20);

    setIsCloning(true);
    try {
      const res = await fetch('/api/v1/voice-clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          speakerRole: resolvedRole,
          title: trimmedTitle,
          profileId: editingProfile?.id,
          speakerId: resolvedSpeakerId,
          audioBase64: recordedWavBase64,
          audioFormat,
          sampleText: DEFAULT_SAMPLE_SCRIPT,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        Toast.show({ icon: 'fail', content: data.error || '豆包声音复刻上传失败' });
        return;
      }

      const finalVoiceId = data.providerVoiceId || resolvedSpeakerId;
      addVoiceCloneProfile({
        id: data.profile?.id,
        speakerRole: resolvedRole,
        title: trimmedTitle,
        sampleText: DEFAULT_SAMPLE_SCRIPT,
        sampleAudioUrl: recordedWavUrl,
        providerVoiceId: finalVoiceId,
        status: data.profile?.status || 'training',
      });
      setRecordedWavUrl('');
      setRecordedWavBase64('');
      setSpeakerIdInput('');
      void syncVoiceClonesFromServer();
      Toast.show({
        icon: 'success',
        content: editingProfile ? '已提交重新复刻，请等待训练完成' : '已提交复刻，请等待训练完成',
      });
      if (initialMode !== 'list') {
        onClose();
      } else {
        setMode('list');
      }
    } catch {
      Toast.show({ icon: 'fail', content: '连接失败，请先查询音色状态后再决定是否重试' });
    } finally {
      setIsCloning(false);
    }
  };

  const handleCheckStatus = async (vc: VoiceCloneProfile) => {
    setCheckingId(vc.id);
    try {
      const res = await fetch(
        `/api/v1/voice-clone?speakerId=${encodeURIComponent(vc.providerVoiceId)}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        Toast.show({ icon: 'fail', content: data.error || '查询状态失败' });
        return;
      }
      const statusMap: Record<number, string> = {
        0: '未找到 (0)',
        1: '正在复刻训练中 (1)',
        2: '训练成功可用 (2)',
        3: '训练失败 (3)',
        4: '已激活可用 (4)',
      };
      await syncVoiceClonesFromServer();
      Toast.show({
        icon: data.status === 2 || data.status === 4 ? 'success' : undefined,
        content: `豆包音色 ${vc.providerVoiceId} 状态：${statusMap[data.status] || data.status}`,
      });
    } catch {
      Toast.show({ icon: 'fail', content: '查询失败，请检查网络后重试' });
    } finally {
      setCheckingId('');
    }
  };

  const handleTestSynthesize = async (vc: VoiceCloneProfile) => {
    if (!testText.trim() || synthesizingId) return;
    setSynthesizingId(vc.id);
    try {
      const statusRes = await fetch(`/api/v1/voice-clone?speakerId=${encodeURIComponent(vc.providerVoiceId)}`, { cache: 'no-store' });
      const statusData = await statusRes.json();
      await syncVoiceClonesFromServer();
      if (!statusRes.ok || ![2, 4].includes(statusData.status)) {
        Toast.show({ icon: 'fail', content: statusData.error || '音色尚未训练成功，请查询状态' });
        return;
      }
      const res = await requestDoubaoTtsAudio({
        text: testText.trim(),
        voiceType: vc.providerVoiceId,
        isClonedVoice: true,
      });
      if (res.ok && res.audioDataUrl) {
        Toast.show({ icon: 'success', content: '豆包克隆语音合成成功，正在播放真实音频' });
        await playAudioStrict(res.audioDataUrl);
      } else {
        Toast.show({ icon: 'fail', content: res.error || '合成失败，请稍后重试' });
      }
    } catch {
      Toast.show({ icon: 'fail', content: '试听失败，请检查网络后重试' });
    } finally {
      setSynthesizingId('');
    }
  };

  return (
    <Popup
      visible={visible}
      onMaskClick={() => !isCloning && onClose()}
      position="bottom"
      bodyStyle={{
        height: '88vh',
        borderTopLeftRadius: '22px',
        borderTopRightRadius: '22px',
        background: '#FFFFFF',
      }}
    >
      <div className="flex flex-col h-full text-[#1F2937]">
        {/* Header */}
        <div className="px-4 py-3 bg-[#F9FAFB] border-b border-[#E5E7EB] flex items-center justify-between">
          <div>
            <h3 className="text-h2 text-[#1F2937]">{mode === 'list' ? '我的声音' : mode === 'create' ? '新建声音' : '重新复刻声音'}</h3>
            <p className="text-[11px] text-[#6B7280]">
              录制样本并训练专属音色
            </p>
          </div>
          <button type="button" onClick={onClose} className="kid-btn kid-btn-ghost kid-btn-sm">
            关闭
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto flex-1 min-h-0 space-y-3.5">
          {doubaoConfigured === false && (
            <div className="p-3 rounded-xl bg-[#FFF8E8] border border-[#E8D9C8] text-xs text-[#9B742F] space-y-1">
              <div className="font-bold">尚未配置新版豆包语音 API Key</div>
              <p>
                服务暂不可用，请联系管理员检查语音服务配置。
              </p>
            </div>
          )}

          {/* 1. 已复刻的爸妈音色库 */}
          {mode === 'list' && <div className="kid-card space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-caption font-bold text-[#1F2937]">
                我的声音 ({voiceClones.length})
              </span>
              <button type="button" onClick={openCreate} className="kid-btn kid-btn-primary kid-btn-sm">新建声音</button>
            </div>
            {loadError && <div role="alert" className="text-xs text-red-600">音色列表加载失败，请检查网络。 <button type="button" onClick={() => void loadProfiles()} className="underline">重新加载</button></div>}

            <div className="space-y-2">
              {!profilesLoaded && !loadError ? <div className="text-center py-5 text-xs text-[#8B8A80]">正在加载声音…</div> : voiceClones.length === 0 && !loadError ? (
                <div className="text-center py-5 text-xs text-[#8B8A80] bg-[#FAF8F5] rounded-xl border border-dashed border-[#E8D9C8]">
                  暂无声音，点击“新建声音”开始复刻
                </div>
              ) : (
                voiceClones.map(vc => (
                  <div
                    key={vc.id}
                    className="p-2.5 rounded-xl bg-[#FAF8F5] border border-[#E8D9C8] flex items-center justify-between gap-2 flex-wrap"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-xs text-[#242620] truncate">{vc.title}</span>
                      </div>
                      <div className="text-[10px] text-[#77786F] mt-1 font-mono truncate">
                        音色 ID: {vc.providerVoiceId} · {({ ready: '可用', training: '训练中', failed: '训练失败', unknown: '状态待确认' } as const)[vc.status] || '状态待确认'}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={checkingId === vc.id}
                        onClick={() => handleCheckStatus(vc)}
                        className="kid-btn kid-btn-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px]"
                      >
                        <span>{checkingId === vc.id ? '查询中…' : '查状态'}</span>
                      </button>
                      <button
                        type="button"
                        disabled={synthesizingId === vc.id}
                        onClick={() => handleTestSynthesize(vc)}
                        className="kid-btn kid-btn-primary kid-btn-sm !h-6 !min-h-[24px] !px-2.5 !text-[11px]"
                      >
                        <IconVolume className="w-3 h-3" />
                        <span>
                          {synthesizingId === vc.id ? '豆包合成中…' : '豆包TTS合成试听'}
                        </span>
                      </button>
                      <button type="button" disabled={vc.status === 'training'} onClick={() => openRetrain(vc)} className="kid-btn kid-btn-ghost kid-btn-sm !text-[11px]">重新复刻</button>
                      <button
                        type="button"
                        onClick={() => void deleteVoiceCloneProfile(vc.id).catch(() => Toast.show({ icon: 'fail', content: '删除失败，请重试' }))}
                        className="kid-btn kid-btn-danger-ghost kid-btn-sm !h-6 !min-h-[24px] !px-1.5"
                        title="删除此音色"
                      >
                        <DeleteOutline />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* 输入任意文字测试豆包克隆 TTS */}
            {voiceClones.length > 0 && (
              <div className="pt-2 border-t border-[#F0EFEA]">
                <label className="text-[11px] text-[#6B7280] block mb-1">
                  输入任意文字，点击上方「豆包TTS合成试听」直接生成爸妈真实模拟语音：
                </label>
                <input
                  type="text"
                  value={testText}
                  onChange={e => setTestText(e.target.value)}
                  className="kid-input !text-xs"
                  placeholder="输入任意文字，调用豆包 /api/v1/tts 合成 MP3"
                />
              </div>
            )}
          </div>}

          {/* 2. 录制并上传新声音复刻 */}
          {mode !== 'list' && <div className="kid-card-highlight space-y-3">
            {initialMode === 'list' && (
              <button type="button" onClick={() => setMode('list')} className="kid-btn kid-btn-ghost kid-btn-sm">← 返回我的声音</button>
            )}
            {mode === 'retrain' && <p className="text-xs text-[#9B742F]">将更新此音色并消耗一次训练机会。已有定时任务音频不会自动更新，需要重新保存任务。</p>}
            <div className="flex items-center justify-between">
              <span className="text-h3 text-[#242620] inline-flex items-center gap-1.5">
                <IconSparkle className="w-4 h-4 text-[#B96043]" />
                <span>{mode === 'create' ? '录制样本创建声音' : '录制新样本更新声音'}</span>
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="text-caption text-[#1F2937] block mb-1">声音名称 *</label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="例如：妈妈、爸爸、爷爷讲故事"
                  className="kid-input"
                  maxLength={30}
                />
              </div>
              <div>
                <label className="text-caption text-[#1F2937] block mb-1">
                  火山引擎已开通的音色 ID
                </label>
                <input
                  type="text"
                  value={speakerIdInput}
                  onChange={e => setSpeakerIdInput(e.target.value)}
                  readOnly={mode === 'retrain'}
                  placeholder="在火山引擎控制台获取 S_ 开头的音色 ID"
                  className="kid-input font-mono"
                />
              </div>
            </div>

            {/* 朗读采样文本卡片 */}
            <div className="p-3 rounded-xl bg-white border border-[#E9E7E0] space-y-1.5">
              <div className="text-[11px] text-[#77786F] font-semibold">
                请在安静环境下朗读以下文字（自动录制为 24kHz 单声道标准 WAV 格式，约 6~12 秒）：
              </div>
              <p className="text-sm font-bold text-[#B96043] leading-relaxed">
                “{DEFAULT_SAMPLE_SCRIPT}”
              </p>
            </div>

            {/* 录音与上传文件栏 */}
            <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
              <div className="text-xs text-[#55574F]">
                {isRecording ? (
                  <span className="text-[#EF4444] font-bold">
                    正在录制 WAV 样本 ({recordSec}s)… 读完请点击停止
                  </span>
                ) : recordedWavBase64 ? (
                  <span className="text-[#4C7866] font-bold inline-flex items-center gap-1">
                    <IconCheck className="w-3.5 h-3.5" />
                    已就绪 {audioFormat.toUpperCase()} 音频样本{recordSec > 0 ? `（${recordSec} 秒）` : ''}，可回放或上传复刻
                  </span>
                ) : (
                  <span>可录音或上传 WAV/MP3 文件，最大 3 MB</span>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {recordedWavUrl && !isRecording && (
                  <button
                    type="button"
                    onClick={() => playAudioOrFallback(recordedWavUrl)}
                    className="kid-btn kid-btn-ghost kid-btn-sm"
                  >
                    <IconVolume className="w-3.5 h-3.5" />
                    <span>回放原声</span>
                  </button>
                )}
                <label className="kid-btn kid-btn-ghost kid-btn-sm cursor-pointer">
                  <span>上传文件</span>
                  <input
                    type="file"
                    accept=".wav,.mp3,audio/wav,audio/mpeg"
                    onChange={handleUploadSampleFile}
                    className="hidden"
                  />
                </label>
                <button
                  type="button"
                  onClick={isRecording ? stopRecordSample : startRecordSample}
                  className={`kid-btn kid-btn-sm ${
                    isRecording ? 'kid-btn-secondary' : 'kid-btn-primary'
                  }`}
                >
                  <IconMic className="w-3.5 h-3.5" />
                  <span>{isRecording ? '停止录音' : recordedWavBase64 ? '重录' : '开始录音'}</span>
                </button>
              </div>
            </div>
          </div>}
        </div>

        {/* Footer */}
        {mode !== 'list' && <div className="p-4 bg-[#F9FAFB] border-t border-[#E5E7EB] shrink-0">
          <button
            type="button"
            disabled={isCloning || !recordedWavBase64 || !speakerIdInput.trim()}
            onClick={() => {
              if (mode === 'retrain') {
                void Dialog.confirm({ title: '重新复刻这个声音？', content: '将使用新录音更新该音色并消耗一次训练机会；已有定时音频不会自动更新。', confirmText: '确认复刻', cancelText: '取消', onConfirm: handleSubmitClone });
              } else {
                void handleSubmitClone();
              }
            }}
            className="w-full kid-btn kid-btn-primary kid-btn-lg"
          >
            {isCloning
              ? '正在上传音频至豆包 MegaTTS 训练…'
              : mode === 'retrain' ? '提交并更新声音' : '创建声音'}
          </button>
        </div>}
      </div>
    </Popup>
  );
};
