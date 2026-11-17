'use client';

import React, { useState } from 'react';
import { Switch, Empty, Dialog, Toast } from 'antd-mobile';
import { EditSOutline, DeleteOutline } from 'antd-mobile-icons';
import { useAppStore } from '../../stores/useAppStore';
import { VoiceSchedule } from '../../services/types';
import { ScheduleFormModal } from './ScheduleFormModal';
import { VoiceCloneModal } from './VoiceCloneModal';
import { IconPlus, IconBell, IconVolume, IconCheck, IconMic, IconSparkle } from '../../components/Icons';
import { playAudioOrFallback, requestDoubaoTtsAudio } from '../../utils/voiceSynth';

export const VoiceSchedulesPage: React.FC = () => {
  const {
    schedules,
    voiceClones,
    updateSchedule,
    toggleSchedule,
    deleteSchedule,
    triggerScheduleRing,
    acknowledgeScheduleOnDevice,
    activeRingingScheduleId,
  } = useAppStore();

  const [modalVisible, setModalVisible] = useState(false);
  const [cloneModalVisible, setCloneModalVisible] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<VoiceSchedule | null>(null);

  const handleCreate = () => {
    setEditingSchedule(null);
    setModalVisible(true);
  };

  const handleEdit = (sched: VoiceSchedule) => {
    setEditingSchedule(sched);
    setModalVisible(true);
  };

  const handleDelete = (sched: VoiceSchedule) => {
    Dialog.confirm({
      title: '删除定时语音？',
      content: `确定要删除「${sched.title} (${sched.timeStr})」吗？设备本地缓存音频也将同步移除。`,
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: () => {
        deleteSchedule(sched.id);
        Toast.show({ content: '已删除定时提醒' });
      },
    });
  };

  const renderRepeatDays = (days: number[]) => {
    if (!days || days.length === 0) return '单次提醒';
    if (days.length === 7) return '每天';
    if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return '周一至周五';
    const dayMap: Record<number, string> = {
      1: '一',
      2: '二',
      3: '三',
      4: '四',
      5: '五',
      6: '六',
      7: '日',
    };
    return `每周${days.map(d => dayMap[d]).join('、')}`;
  };

  const renderSourceBadge = (sched: VoiceSchedule) => {
    if (sched.sourceType === 'parent_clone') {
      return sched.clonedSpeakerRole || '爸妈克隆声音';
    }
    if (sched.sourceType === 'record') {
      return '家长原声录音';
    }
    return '小铭同学萌音';
  };

  const handleSimulateAlarmTrigger = async (sched: VoiceSchedule) => {
    triggerScheduleRing(sched.id);
    if (sched.audioUrl) {
      Toast.show({
        content: `模拟设备 RTC 准点唤醒：正在播放豆包合成缓存音频 (MD5: ${sched.audioMd5?.slice(0, 6) || 'local'})`,
      });
      await playAudioOrFallback(
        sched.audioUrl,
        sched.textContent,
        sched.sourceType,
        sched.clonedSpeakerRole
      );
      return;
    }

    // 若该定时任务尚未保存音频地址（如初始演示数据），首次触发时合成并永久保存 audioUrl 到任务记录，后续每次播放直接读已存地址！
    const cloneProfile = sched.clonedVoiceId
      ? voiceClones.find(c => c.id === sched.clonedVoiceId)
      : undefined;
    const isCloned = Boolean(sched.sourceType === 'parent_clone' && cloneProfile?.providerVoiceId);
    const ttsRes = await requestDoubaoTtsAudio({
      text: sched.textContent,
      voiceType: isCloned ? cloneProfile?.providerVoiceId : undefined,
      isClonedVoice: isCloned,
      persist: true,
    });
    const savedUrl = ttsRes.audioUrl || ttsRes.audioDataUrl;
    if (ttsRes.ok && savedUrl) {
      updateSchedule(sched.id, {
        audioUrl: savedUrl,
        audioMd5: ttsRes.audioMd5 || null,
      });
      Toast.show({
        content: `已生成并保存永久音频地址 (${savedUrl})，正在播报`,
      });
      await playAudioOrFallback(
        savedUrl,
        sched.textContent,
        sched.sourceType,
        sched.clonedSpeakerRole
      );
      return;
    }

    Toast.show({
      content: `模拟设备 PCF85063 RTC 到点唤醒：正在用「${renderSourceBadge(sched)}」播报`,
    });
    await playAudioOrFallback(
      null,
      sched.textContent,
      sched.sourceType,
      sched.clonedSpeakerRole
    );
  };

  const activeRingingSchedule = schedules.find(s => s.id === activeRingingScheduleId);

  return (
    <div className="px-3.5 pt-3 pb-24 space-y-3.5 text-[#1F2937]">
      {/* 1. 爸妈声音克隆入口横幅卡片 */}
      <div className="kid-card-highlight flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <IconSparkle className="w-4 h-4 text-[#B96043] shrink-0" />
            <h3 className="text-h3 text-[#242620]">爸妈声音克隆工坊</h3>
            <span className="kid-status-chip kid-status-new">已克隆 {voiceClones.length} 个音色</span>
          </div>
          <p className="text-xs text-[#77786F] mt-1">
            爸爸妈妈录一段 6 秒声音即可完成克隆；输入任意文字都能转成爸妈的声音在设备端准点播报！
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCloneModalVisible(true)}
          className="kid-btn kid-btn-secondary kid-btn-sm shrink-0"
        >
          <IconMic className="w-3.5 h-3.5" />
          <span>去录克隆音</span>
        </button>
      </div>

      {/* 2. 顶部标题与新建按钮 */}
      <div className="flex items-center justify-between gap-2 px-0.5">
        <div>
          <h2 className="text-h2 text-[#1F2937]">定时语音播报 ({schedules.length})</h2>
          <p className="text-caption text-[#9CA3AF]">
            支持爸妈克隆声音合成 · 硬件 RTC 断网准点唤醒
          </p>
        </div>
        <button
          type="button"
          onClick={handleCreate}
          className="kid-btn kid-btn-primary kid-btn-sm shrink-0"
        >
          <IconPlus className="w-3 h-3" />
          <span>新建定时</span>
        </button>
      </div>

      {/* 当模拟闹钟正在响铃时展示设备弹窗状态与“孩子点击屏幕确认”模拟操作 */}
      {activeRingingSchedule && (
        <div className="approval-card border-[#B96043] bg-[#FFF8F5] space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="approval-count-pill inline-flex items-center gap-1">
              <IconBell className="w-3.5 h-3.5" />
              设备正在响铃播报 ({renderSourceBadge(activeRingingSchedule)})
            </span>
            <span className="font-mono text-xs font-bold text-[#A85339]">
              {activeRingingSchedule.timeStr}
            </span>
          </div>
          <div className="text-body-lg text-[#292B25]">{activeRingingSchedule.title}</div>
          <p className="text-body text-[#77786F]">“{activeRingingSchedule.textContent}”</p>
          <div className="pt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() =>
                void playAudioOrFallback(
                  activeRingingSchedule.audioUrl,
                  activeRingingSchedule.textContent,
                  activeRingingSchedule.sourceType,
                  activeRingingSchedule.clonedSpeakerRole
                )
              }
              className="approval-action approval-action-secondary inline-flex items-center gap-1"
            >
              <IconVolume className="w-3.5 h-3.5" />
              <span>重播声音</span>
            </button>
            <button
              type="button"
              onClick={() => {
                acknowledgeScheduleOnDevice(activeRingingSchedule.id);
                Toast.show({
                  icon: 'success',
                  content: '孩子已在设备触摸屏点击确认！已上报家长端',
                });
              }}
              className="approval-action approval-action-primary inline-flex items-center gap-1.5"
            >
              <IconCheck className="w-3.5 h-3.5" />
              <span>模拟孩子点击屏幕确认 (alarm_ack)</span>
            </button>
          </div>
        </div>
      )}

      {/* 定时任务列表 */}
      {schedules.length === 0 ? (
        <div className="kid-card text-center py-6">
          <Empty description="暂无定时语音任务，点击右上角新建" />
        </div>
      ) : (
        <div className="space-y-2.5">
          {schedules.map(sched => (
            <div
              key={sched.id}
              className={`kid-card transition-opacity ${!sched.enabled ? 'opacity-60' : ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-mono text-xl font-extrabold text-[#242620]">
                      {sched.timeStr}
                    </span>
                    <h3 className="text-h3 text-[#1F2937] truncate">{sched.title}</h3>
                    <span
                      className={`kid-status-chip shrink-0 ${
                        sched.sourceType === 'parent_clone'
                          ? 'kid-status-new'
                          : 'kid-status-active'
                      }`}
                    >
                      {renderSourceBadge(sched)}
                    </span>
                  </div>
                  <p className="text-body text-[#55574F] mt-1 line-clamp-2">
                    “{sched.textContent}”
                  </p>
                </div>

                <Switch
                  checked={sched.enabled}
                  onChange={() => toggleSchedule(sched.id)}
                  style={{
                    '--width': '38px',
                    '--height': '22px',
                    '--checked-color': '#4C7866',
                  }}
                />
              </div>

              {/* 底部状态与操作栏 */}
              <div className="mt-2.5 pt-2.5 border-t border-[#F3F4F6] flex items-center justify-between gap-2 flex-wrap">
                <div className="text-caption text-[#6B7280] flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-[#3E493F]">
                    {renderRepeatDays(sched.repeatDays)}
                  </span>
                  <span>·</span>
                  <span>连播 {sched.repeatPlayCount} 次</span>
                  <span>·</span>
                  {sched.lastAckStatus === 'confirmed' && sched.lastAckAt ? (
                    <span className="text-[#4C7866] font-bold">
                      孩子已确认 (
                      {new Date(sched.lastAckAt).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      )
                    </span>
                  ) : sched.lastAckStatus === 'ringing' ? (
                    <span className="text-[#B96043] font-bold">正在响铃待确认…</span>
                  ) : (
                    <span>等待准点触发</span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleSimulateAlarmTrigger(sched)}
                    className="kid-btn kid-btn-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px]"
                  >
                    <IconVolume className="w-3 h-3" />
                    <span>立即试播</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEdit(sched)}
                    className="kid-btn kid-btn-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px]"
                  >
                    <EditSOutline />
                    <span>编辑</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(sched)}
                    className="kid-btn kid-btn-danger-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px]"
                  >
                    <DeleteOutline />
                    <span>删除</span>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ScheduleFormModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        initialSchedule={editingSchedule}
        onOpenCloneStudio={() => {
          setModalVisible(false);
          setCloneModalVisible(true);
        }}
      />

      <VoiceCloneModal
        visible={cloneModalVisible}
        onClose={() => setCloneModalVisible(false)}
      />
    </div>
  );
};
