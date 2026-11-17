'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Popup, Toast } from 'antd-mobile';
import { DeleteOutline } from 'antd-mobile-icons';
import { useAppStore } from '../../stores/useAppStore';
import { VoiceCloneProfile } from '../../services/types';
import { IconMic, IconVolume, IconSparkle, IconCheck } from '../../components/Icons';
import {
  playAudioOrFallback,
  requestDoubaoTtsAudio,
  speakBySourceType,
} from '../../utils/voiceSynth';
import { startWavRecorder, WavRecorderHandle } from '../../utils/wavRecorder';

interface Props {
  visible: boolean;
  onClose: () => void;
}

const SAMPLE_SCRIPTS: Record<'妈妈' | '爸爸', string> = {
  妈妈: '堂堂、正正，我是妈妈！今天在学校开心吗？记得按时喝水，早点刷牙睡觉哦，妈妈最爱你们啦！',
  爸爸: '堂堂、正正，我是爸爸！遇到不懂的问题可以问小铭同学，勇敢探索，爸爸等你们回家一起玩！',
};

export const VoiceCloneModal: React.FC<Props> = ({ visible, onClose }) => {
  const { voiceClones, addVoiceCloneProfile, deleteVoiceCloneProfile } = useAppStore();

  const [speakerRole, setSpeakerRole] = useState<'妈妈' | '爸爸'>('妈妈');
  const [title, setTitle] = useState('妈妈的温柔声音');
  const [speakerIdInput, setSpeakerIdInput] = useState('');
  const [doubaoConfigured, setDoubaoConfigured] = useState<boolean | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [recordedWavUrl, setRecordedWavUrl] = useState<string>('');
  const [recordedWavBase64, setRecordedWavBase64] = useState<string>('');
  const [isCloning, setIsCloning] = useState(false);
  const [synthesizingId, setSynthesizingId] = useState<string>('');
  const [checkingId, setCheckingId] = useState<string>('');
  const [testText, setTestText] = useState('宝贝，八点半啦，快去刷牙洗脸准备睡觉吧！');

  const timerRef = useRef<number | null>(null);
  const wavRecorderRef = useRef<WavRecorderHandle | null>(null);

  useEffect(() => {
    if (!visible) return;
    fetch('/api/v1/voice-clone')
      .then(r => r.json())
      .then(data => {
        setDoubaoConfigured(Boolean(data.configured));
      })
      .catch(() => setDoubaoConfigured(false));
  }, [visible]);

  const handleSelectRole = (role: '妈妈' | '爸爸') => {
    setSpeakerRole(role);
    setTitle(role === '妈妈' ? '妈妈的温柔声音' : '爸爸的鼓励声音');
    setSpeakerIdInput('');
    setRecordedWavUrl('');
    setRecordedWavBase64('');
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
    }
  };

  const handleUploadSampleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
      if (base64) {
        setRecordedWavUrl(URL.createObjectURL(file));
        setRecordedWavBase64(base64);
        setRecordSec(8);
        Toast.show({ icon: 'success', content: `已载入音频文件：${file.name}` });
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSubmitClone = async () => {
    if (!recordedWavBase64) {
      Toast.show({ content: '请先录制或上传 5~15 秒的 WAV/MP3 声音样本' });
      return;
    }

    const resolvedSpeakerId =
      speakerIdInput.trim() ||
      `S_${speakerRole === '爸爸' ? 'dad' : 'mom'}_${Date.now().toString(36)}`;

    setIsCloning(true);
    try {
      const res = await fetch('/api/v1/voice-clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          speakerRole,
          title,
          speakerId: resolvedSpeakerId,
          audioBase64: recordedWavBase64,
          audioFormat: 'wav',
          sampleText: SAMPLE_SCRIPTS[speakerRole],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        Toast.show({ icon: 'fail', content: data.error || '豆包声音复刻上传失败' });
        return;
      }

      const finalVoiceId = data.providerVoiceId || resolvedSpeakerId;
      addVoiceCloneProfile({
        speakerRole,
        title,
        sampleText: SAMPLE_SCRIPTS[speakerRole],
        sampleAudioUrl: recordedWavUrl,
        providerVoiceId: finalVoiceId,
      });
      setRecordedWavUrl('');
      setRecordedWavBase64('');
      setSpeakerIdInput('');
      Toast.show({
        icon: 'success',
        content: `已上传至火山引擎豆包声音复刻（音色 ID: ${finalVoiceId}）！`,
      });
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
      Toast.show({
        icon: data.status === 2 || data.status === 4 ? 'success' : undefined,
        content: `豆包音色 ${vc.providerVoiceId} 状态：${statusMap[data.status] || data.status}`,
      });
    } finally {
      setCheckingId('');
    }
  };

  const handleTestSynthesize = async (vc: VoiceCloneProfile) => {
    if (!testText.trim() || synthesizingId) return;
    setSynthesizingId(vc.id);
    try {
      const res = await requestDoubaoTtsAudio({
        text: testText.trim(),
        voiceType: vc.providerVoiceId,
        isClonedVoice: true,
      });
      if (res.ok && res.audioDataUrl) {
        Toast.show({ icon: 'success', content: '豆包克隆语音合成成功，正在播放真实音频' });
        await playAudioOrFallback(res.audioDataUrl, testText.trim(), 'parent_clone', vc.speakerRole);
      } else {
        Toast.show({
          content: res.error
            ? `${res.error}（已回退浏览器模拟试听）`
            : '正在用浏览器模拟试听',
        });
        speakBySourceType(testText.trim(), 'parent_clone', vc.speakerRole);
      }
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
            <h3 className="text-h2 text-[#1F2937]">火山引擎豆包 · 爸妈声音复刻工坊</h3>
            <p className="text-[11px] text-[#6B7280]">
              真实对接字节跳动 MegaTTS (`/api/v1/mega_tts/audio/upload` & `/api/v1/tts`)
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
                请在 `apps/parent-h5/.env.local` 中填入 `DOUBAO_SPEECH_API_KEY`（只需这一个 Key）及复刻音色 ID `S_xxxxxx`，即可直接调用豆包语音 V3 接口合成真实 MP3。
              </p>
            </div>
          )}

          {/* 1. 已复刻的爸妈音色库 */}
          <div className="kid-card space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-caption font-bold text-[#1F2937]">
                已绑定的爸妈克隆音色 ({voiceClones.length})
              </span>
              <span className="text-[10px] text-[#8B8A80]">Cluster: volcano_icl</span>
            </div>

            <div className="space-y-2">
              {voiceClones.length === 0 ? (
                <div className="text-center py-5 text-xs text-[#8B8A80] bg-[#FAF8F5] rounded-xl border border-dashed border-[#E8D9C8]">
                  暂无绑定的爸妈音色，请在下方录制或上传原声音频进行豆包声音复刻
                </div>
              ) : (
                voiceClones.map(vc => (
                  <div
                    key={vc.id}
                    className="p-2.5 rounded-xl bg-[#FAF8F5] border border-[#E8D9C8] flex items-center justify-between gap-2 flex-wrap"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="kid-status-chip kid-status-complete">{vc.speakerRole}</span>
                        <span className="font-bold text-xs text-[#242620] truncate">{vc.title}</span>
                      </div>
                      <div className="text-[10px] text-[#77786F] mt-1 font-mono truncate">
                        speaker_id: {vc.providerVoiceId}
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
                      <button
                        type="button"
                        onClick={() => deleteVoiceCloneProfile(vc.id)}
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
          </div>

          {/* 2. 录制并上传新声音复刻 */}
          <div className="kid-card-highlight space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-h3 text-[#242620] inline-flex items-center gap-1.5">
                <IconSparkle className="w-4 h-4 text-[#B96043]" />
                <span>上传原声训练豆包复刻音色</span>
              </span>
              <div className="flex gap-1.5">
                {(['妈妈', '爸爸'] as const).map(role => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => handleSelectRole(role)}
                    className={`kid-filter-chip !h-6 !min-h-[24px] !px-2.5 !text-[11px] ${
                      speakerRole === role ? 'kid-filter-chip-selected' : ''
                    }`}
                  >
                    我是{role}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="text-caption text-[#1F2937] block mb-1">音色显示名称 *</label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  className="kid-input"
                  maxLength={30}
                />
              </div>
              <div>
                <label className="text-caption text-[#1F2937] block mb-1">
                  火山引擎 Speaker ID（自定义 S_xxx，留空自动生成）
                </label>
                <input
                  type="text"
                  value={speakerIdInput}
                  onChange={e => setSpeakerIdInput(e.target.value)}
                  placeholder="如：S_mom_01（留空将自动生成）"
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
                “{SAMPLE_SCRIPTS[speakerRole]}”
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
                    已就绪 WAV 音频样本 ({recordSec}s)，可回放或上传复刻
                  </span>
                ) : (
                  <span>可直接麦克风录音，或上传现成的 WAV/MP3 录音文件</span>
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
                    accept="audio/wav,audio/mp3,audio/mpeg"
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
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-[#F9FAFB] border-t border-[#E5E7EB] shrink-0">
          <button
            type="button"
            disabled={isCloning || !recordedWavBase64}
            onClick={handleSubmitClone}
            className="w-full kid-btn kid-btn-primary kid-btn-lg"
          >
            {isCloning
              ? '正在上传音频至豆包 MegaTTS 训练…'
              : '上传音频至火山引擎豆包进行声音复刻'}
          </button>
        </div>
      </div>
    </Popup>
  );
};
