'use client';

import React, { useState, useEffect } from 'react';
import { Popup, Stepper, Toast } from 'antd-mobile';
import { VoiceSchedule } from '../../services/types';
import { useAppStore } from '../../stores/useAppStore';
import { IconMic, IconVolume, IconSparkle } from '../../components/Icons';
import {
  playAudioStrict,
  requestDoubaoTtsAudio,
} from '../../utils/voiceSynth';

export type ScheduleModalMode = 'create' | 'schedule' | 'voice';

interface Props {
  visible: boolean;
  onClose: () => void;
  initialSchedule?: VoiceSchedule | null;
  editMode?: ScheduleModalMode;
  onOpenCloneStudio?: () => void;
}

const WEEKDAY_OPTIONS = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 7 },
];

export const ScheduleFormModal: React.FC<Props> = ({
  visible,
  onClose,
  initialSchedule,
  editMode,
  onOpenCloneStudio,
}) => {
  const mode: ScheduleModalMode = initialSchedule
    ? editMode === 'voice'
      ? 'voice'
      : 'schedule'
    : 'create';
  const { addSchedule, updateSchedule, petConfig, voiceClones } = useAppStore();

  const [title, setTitle] = useState('晚上刷牙睡觉提醒');
  const [timeStr, setTimeStr] = useState('20:30');
  const [repeatDays, setRepeatDays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [sourceType, setSourceType] = useState<'tts' | 'parent_clone' | 'record'>('parent_clone');
  const [selectedCloneId, setSelectedCloneId] = useState<string>('');
  const [textContent, setTextContent] = useState('宝贝，八点半啦，快去刷牙洗脸准备睡觉吧！');
  const [repeatPlayCount, setRepeatPlayCount] = useState(2);
  const [requireAck, setRequireAck] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (initialSchedule) {
      setTitle(initialSchedule.title);
      setTimeStr(initialSchedule.timeStr);
      setRepeatDays(initialSchedule.repeatDays);
      setSourceType(initialSchedule.sourceType);
      setSelectedCloneId(initialSchedule.clonedVoiceId || voiceClones[0]?.id || '');
      setTextContent(initialSchedule.textContent);
      setRepeatPlayCount(initialSchedule.repeatPlayCount);
      setRequireAck(Boolean(initialSchedule.requireAck));
    } else {
      setTitle('');
      setTimeStr('07:30');
      setRepeatDays([1, 2, 3, 4, 5]);
      setSourceType(voiceClones.length > 0 ? 'parent_clone' : 'tts');
      setSelectedCloneId(voiceClones[0]?.id || '');
      setTextContent('宝贝快起床啦，太阳晒屁股喽！');
      setRepeatPlayCount(2);
      setRequireAck(false);
    }
  }, [initialSchedule, visible, voiceClones]);

  const toggleDay = (day: number) => {
    setRepeatDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort()
    );
  };

  const selectedCloneProfile = voiceClones.find(c => c.id === selectedCloneId) || voiceClones[0];

  const handlePreviewVoice = async () => {
    if (!textContent.trim() || previewing) {
      if (!textContent.trim()) Toast.show({ content: '请先输入要播报的内容' });
      return;
    }
    if (sourceType === 'parent_clone' && !selectedCloneProfile) {
      Toast.show({ content: '尚未录制或绑定爸妈克隆音色，请先录制' });
      return;
    }
    setPreviewing(true);
    try {
      const isCloned = sourceType === 'parent_clone';
      const voiceType = isCloned ? selectedCloneProfile?.providerVoiceId : undefined;
      const res = await requestDoubaoTtsAudio({
        text: textContent.trim(),
        voiceType,
        isClonedVoice: isCloned,
      });
      if (res.ok && res.audioDataUrl) {
        Toast.show({ icon: 'success', content: '豆包 TTS 合成成功，正在播放真实音频' });
        await playAudioStrict(res.audioDataUrl);
      } else {
        Toast.show({ icon: 'fail', content: res.error || '合成失败，请重试' });
      }
    } catch {
      Toast.show({ icon: 'fail', content: '播放失败，请重试' });
    } finally {
      setPreviewing(false);
    }
  };

  const handleSubmit = async () => {
    if (isSynthesizing) return;

    if (mode !== 'voice' && !title.trim()) {
      Toast.show({ icon: 'fail', content: '请填写提醒任务标题' });
      return;
    }
    if (mode !== 'schedule' && !textContent.trim()) {
      Toast.show({ icon: 'fail', content: '请填写要转成语音播报的文字内容' });
      return;
    }
    if (mode !== 'schedule' && sourceType === 'parent_clone' && !selectedCloneProfile) {
      Toast.show({ content: '尚未录制或绑定爸妈克隆音色，请先录制或选择萌音播报' });
      return;
    }

    setIsSynthesizing(true);
    try {
      if (mode === 'schedule' && initialSchedule) {
        const [hourStr, minStr] = timeStr.split(':');
        const cronDays = repeatDays.length > 0 ? repeatDays.join(',') : '*';
        const cronExpr = `${Number(minStr || 0)} ${Number(hourStr || 7)} * * ${cronDays}`;

        await updateSchedule(initialSchedule.id, {
          title: title.trim(),
          timeStr,
          repeatDays,
          cronExpr,
          enabled: true,
          lastAckStatus: 'idle',
          lastAckAt: null,
          repeatPlayCount,
          requireAck,
        });
        Toast.show({
          icon: 'success',
          content: '定时信息已更新（沿用原语音音频）',
        });
        onClose();
        return;
      }

      let audioUrl: string | null = initialSchedule?.audioUrl || null;
      let audioMd5: string | null = initialSchedule?.audioMd5 || null;

      if (sourceType === 'parent_clone' || sourceType === 'tts') {
        const isCloned = sourceType === 'parent_clone';
        const voiceType = isCloned ? selectedCloneProfile?.providerVoiceId : undefined;
        const ttsResult = await requestDoubaoTtsAudio({
          text: textContent.trim(),
          voiceType,
          isClonedVoice: isCloned,
          persist: true, // 定时语音任务开启持久化，生成 /api/v1/audio/{md5}.mp3 永久地址
        });
        if (ttsResult.ok && ttsResult.audioUrl && ttsResult.audioMd5) {
          // 优先保存标准 HTTP 播放/下载地址 `/api/v1/audio/{md5}.mp3`，避免在业务表存储庞大的 Base64
          audioUrl = ttsResult.audioUrl;
          audioMd5 = ttsResult.audioMd5 || null;
        } else {
          Toast.show({ icon: 'fail', content: ttsResult.error || '合成失败，请重试' });
          return;
        }
      }

      const cloneMeta =
        sourceType === 'parent_clone' && selectedCloneProfile
          ? {
              clonedVoiceId: selectedCloneProfile.id,
              clonedSpeakerRole: `${selectedCloneProfile.speakerRole}（豆包克隆）`,
            }
          : {
              clonedVoiceId: null,
              clonedSpeakerRole: null,
            };

      if (mode === 'voice' && initialSchedule) {
        await updateSchedule(initialSchedule.id, {
          sourceType,
          ...cloneMeta,
          textContent: textContent.trim(),
          audioUrl,
          audioMd5,
        });
        Toast.show({
          icon: 'success',
          content: audioUrl
            ? '声音与文字已重新合成并保存，等待设备同步'
            : '播报内容已更新',
        });
      } else {
        const [hourStr, minStr] = timeStr.split(':');
        const cronDays = repeatDays.length > 0 ? repeatDays.join(',') : '*';
        const cronExpr = `${Number(minStr || 0)} ${Number(hourStr || 7)} * * ${cronDays}`;

        await addSchedule({
          title: title.trim(),
          timeStr,
          repeatDays,
          cronExpr,
          enabled: true,
          sourceType,
          ...cloneMeta,
          textContent: textContent.trim(),
          audioUrl,
          audioMd5,
          repeatPlayCount,
          requireAck,
        });
        Toast.show({
          icon: 'success',
          content: audioUrl
            ? `豆包已合成「${selectedCloneProfile?.speakerRole || '专属'}」真实 MP3 音频（MD5: ${audioMd5?.slice(
                0,
                6
              )}），等待设备同步`
            : '定时语音已创建（配置豆包密钥后将自动生成真实 MP3）',
        });
      }
      onClose();
    } catch {
      Toast.show({ icon: 'fail', content: '保存失败，请检查网络后重试' });
    } finally {
      setIsSynthesizing(false);
    }
  };

  return (
    <Popup
      visible={visible}
      onMaskClick={onClose}
      position="bottom"
      bodyStyle={{
        height: mode === 'create' ? '86vh' : '74vh',
        borderTopLeftRadius: '22px',
        borderTopRightRadius: '22px',
        background: '#FFFFFF',
      }}
    >
      <div className="flex flex-col h-full text-[#1F2937]">
        {/* Header */}
        <div className="px-4 py-3 bg-[#F9FAFB] border-b border-[#E5E7EB] flex items-center justify-between">
          <h3 className="text-h2 text-[#1F2937]">
            {mode === 'create'
              ? '新建定时语音播报'
              : mode === 'schedule'
              ? '修改定时信息'
              : '修改声音与文字'}
          </h3>
          <button type="button" onClick={onClose} className="kid-btn kid-btn-ghost kid-btn-sm">
            关闭
          </button>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto flex-1 min-h-0 space-y-3.5">
          {mode === 'schedule' && initialSchedule && (
            <div className="px-3 py-2 rounded-xl bg-[#F5F4F0] text-[12px] text-[#55574F]">
              当前语音内容（不重新合成）：“{initialSchedule.textContent}”
            </div>
          )}
          {mode === 'voice' && initialSchedule && (
            <div className="px-3 py-2 rounded-xl bg-[#F5F4F0] text-[12px] text-[#55574F]">
              当前定时：<span className="font-mono font-bold text-[#242620]">{initialSchedule.timeStr}</span> · {initialSchedule.title}
            </div>
          )}

          {/* 1. 提醒时间与标题 */}
          {(mode === 'create' || mode === 'schedule') && (
          <div className="kid-card space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-caption text-[#1F2937] block mb-1.5">提醒名称 *</label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="如：起床唤醒 / 刷牙提醒"
                  className="kid-input"
                  maxLength={30}
                />
              </div>
              <div>
                <label className="text-caption text-[#1F2937] block mb-1.5">播报时间 (RTC) *</label>
                <input
                  type="time"
                  value={timeStr}
                  onChange={e => setTimeStr(e.target.value)}
                  className="kid-input font-mono font-bold"
                />
              </div>
            </div>

            <div>
              <div className="text-caption text-[#1F2937] mb-1.5">
                重复周期：
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {[
                  { label: '仅一次（不循环）', days: [] as number[] },
                  { label: '每天', days: [1, 2, 3, 4, 5, 6, 7] },
                  { label: '工作日', days: [1, 2, 3, 4, 5] },
                  { label: '周末', days: [6, 7] },
                ].map(preset => {
                  const isActive =
                    repeatDays.length === preset.days.length &&
                    preset.days.every(d => repeatDays.includes(d));
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setRepeatDays(preset.days)}
                      className={`kid-filter-chip !px-2.5 !text-[11px] ${
                        isActive ? 'kid-filter-chip-selected' : ''
                      }`}
                    >
                      <span>{preset.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_OPTIONS.map(day => {
                  const checked = repeatDays.includes(day.value);
                  return (
                    <button
                      key={day.value}
                      type="button"
                      onClick={() => toggleDay(day.value)}
                      className={`kid-filter-chip !px-3 ${
                        checked ? 'kid-filter-chip-selected' : ''
                      }`}
                    >
                      <span>{day.label}</span>
                    </button>
                  );
                })}
              </div>
              {repeatDays.length === 0 && (
                <p className="text-[11px] text-[#6B7280] mt-1.5">
                  仅在下次到达 <span className="font-mono font-bold text-[#1F2937]">{timeStr}</span> 时播报一次，播报后不再循环。
                </p>
              )}
            </div>
          </div>
          )}

          {/* 2. 音源类型选择（爸妈克隆声音 TTS / 小铭同学萌音 TTS / 家长直接录音） */}
          {(mode === 'create' || mode === 'voice') && (
          <div className="kid-card space-y-3">
            <div className="text-caption text-[#1F2937]">选择播报声音类型：</div>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { label: '我的声音', value: 'parent_clone' as const },
                { label: `${petConfig.petName}萌音`, value: 'tts' as const },
                { label: '直接录原声', value: 'record' as const },
              ].map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSourceType(opt.value)}
                  className={`kid-filter-chip !px-2 !text-[11px] ${
                    sourceType === opt.value ? 'kid-filter-chip-selected' : ''
                  }`}
                >
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>

            {/* 当选择“我的声音”时，展示已克隆的爸爸/妈妈音色选择器 */}
            {sourceType === 'parent_clone' && (
              <div className="p-2.5 rounded-xl bg-[#FAF8F5] border border-[#E8D9C8] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[#242620]">
                    选择「我的声音」音色：
                  </span>
                  {onOpenCloneStudio && (
                    <button
                      type="button"
                      onClick={onOpenCloneStudio}
                      className="text-[11px] font-bold text-[#FF7A59] inline-flex items-center gap-1"
                    >
                      <IconSparkle className="w-3 h-3" />
                      <span>去新增/管理声音 →</span>
                    </button>
                  )}
                </div>
                {voiceClones.length === 0 ? (
                  <div className="text-xs text-[#8B8A80] py-2">
                    「我的声音」中暂无可用音色，请点击右上角「去新增/管理声音」添加，或选择「萌音」播报。
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {voiceClones.map(vc => (
                      <button
                        key={vc.id}
                        type="button"
                        onClick={() => setSelectedCloneId(vc.id)}
                        className={`kid-filter-chip ${
                          (selectedCloneProfile?.id || '') === vc.id ? 'kid-filter-chip-selected' : ''
                        }`}
                      >
                        <span>{vc.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <label className="text-caption text-[#1F2937] block">
                {sourceType === 'parent_clone'
                  ? `输入文字（自动用${selectedCloneProfile?.speakerRole || '爸妈'}克隆声音合成播报）*`
                  : sourceType === 'tts'
                  ? `输入文字（用${petConfig.petName}声音播报）*`
                  : '录音内容备注 *'}
              </label>
              <textarea
                rows={3}
                value={textContent}
                onChange={e => setTextContent(e.target.value)}
                placeholder="输入任意文字，例如：堂堂正正，八点半啦，快去刷牙洗脸准备睡觉吧！"
                className="kid-input"
                maxLength={150}
              />
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#8B8A80]">
                  {textContent.length}/150 字
                </span>
                {sourceType !== 'record' && (
                  <button
                    type="button"
                    disabled={previewing}
                    onClick={handlePreviewVoice}
                    className="kid-btn kid-btn-ghost kid-btn-sm !h-7 !min-h-[28px] !px-2.5 !text-[11px]"
                  >
                    <IconVolume className="w-3.5 h-3.5" />
                    <span>{previewing ? '豆包合成中…' : '合成试听'}</span>
                  </button>
                )}
              </div>
            </div>

            {sourceType === 'record' && (
              <div className="pt-2 border-t border-[#F0EFEA] flex items-center justify-between">
                <span className="text-xs text-[#6B7280]">
                  {isRecording ? '正在录制家长原声…' : '点击右侧按钮直接录一段固定语音'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (isRecording) {
                      setIsRecording(false);
                      Toast.show({ icon: 'success', content: '家长原声录制完成' });
                    } else {
                      setIsRecording(true);
                    }
                  }}
                  className={`kid-btn kid-btn-sm ${
                    isRecording ? 'kid-btn-secondary' : 'kid-btn-primary'
                  }`}
                >
                  <IconMic className="w-3.5 h-3.5" />
                  <span>{isRecording ? '完成录制' : '开始录音'}</span>
                </button>
              </div>
            )}
          </div>
          )}

          {/* 3. 播报结束方式与次数设置 */}
          {(mode === 'create' || mode === 'schedule') && (
          <div className="kid-card space-y-3">
            <div>
              <div className="text-caption text-[#1F2937] mb-1.5">播报结束方式：</div>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  {
                    label: '固定次数 · 播完即止',
                    value: false,
                  },
                  {
                    label: '需点确认 · 最大次数',
                    value: true,
                  },
                ].map(opt => (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => {
                      setRequireAck(opt.value);
                      if (opt.value && repeatPlayCount < 3) setRepeatPlayCount(5);
                    }}
                    className={`kid-filter-chip !px-2.5 !text-[11px] ${
                      requireAck === opt.value ? 'kid-filter-chip-selected' : ''
                    }`}
                  >
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-[#F3F4F6]">
              <div>
                <div className="text-caption text-[#1F2937]">
                  {requireAck ? '最大播放次数' : '固定播放次数'}
                </div>
                <div className="text-[11px] text-[#6B7280] mt-0.5">
                  {requireAck
                    ? '一直播放至最大次数，直到点击设备确认按钮关闭弹窗才算结束'
                    : '只播放设定的固定次数，播完后自动关闭弹窗直接结束'}
                </div>
              </div>
              <Stepper
                value={repeatPlayCount}
                onChange={v => setRepeatPlayCount(v)}
                min={1}
                max={20}
              />
            </div>
            <p className="text-[11px] text-[#8B8A80] pt-2 border-t border-[#F3F4F6]">
              {mode === 'schedule'
                ? '保存定时信息后，设备将在下次同步时更新响铃时间，无需重新合成语音。'
                : '定时音频保存后，设备将在同步时获取任务。离线缓存与定时播放仍需设备端支持。'}
            </p>
          </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-[#F9FAFB] border-t border-[#E5E7EB] shrink-0">
          <button
            type="button"
            disabled={isSynthesizing}
            onClick={handleSubmit}
            className="w-full kid-btn kid-btn-primary kid-btn-lg"
          >
            {isSynthesizing
              ? mode === 'schedule'
                ? '正在保存定时信息…'
                : '正在调用豆包 TTS 合成音频…'
              : mode === 'schedule'
              ? '保存定时信息（不重新合成语音）'
              : mode === 'voice'
              ? '重新合成并保存语音'
              : '通过豆包合成音频并下发设备定时播报'}
          </button>
        </div>
      </div>
    </Popup>
  );
};
