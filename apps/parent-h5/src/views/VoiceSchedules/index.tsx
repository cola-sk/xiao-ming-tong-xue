'use client';

import React, { useState, useEffect } from 'react';
import { Switch, Empty, Dialog, Toast } from 'antd-mobile';
import { EditSOutline, DeleteOutline } from 'antd-mobile-icons';
import { useAppStore } from '../../stores/useAppStore';
import { VoiceSchedule } from '../../services/types';
import { ScheduleFormModal, ScheduleModalMode } from './ScheduleFormModal';
import { VoiceCloneModal } from './VoiceCloneModal';
import { IconPlus, IconVolume, IconClock } from '../../components/Icons';
import { playAudioStrict, requestDoubaoTtsAudio } from '../../utils/voiceSynth';

export const VoiceSchedulesPage: React.FC = () => {
  const {
    schedules, devices, schedulesDeviceId,
    voiceClones,
    updateSchedule,
    toggleSchedule,
    deleteSchedule,
    syncSchedulesFromServer,
    syncVoiceClonesFromServer,
  } = useAppStore();

  useEffect(() => {
    void syncSchedulesFromServer();
    void syncVoiceClonesFromServer();
    const refresh = () => { if (document.visibilityState === 'visible' && navigator.onLine) void syncSchedulesFromServer(); };
    const timer = window.setInterval(refresh, 10000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('online', refresh); };
  }, [syncSchedulesFromServer, syncVoiceClonesFromServer]);

  const [modalVisible, setModalVisible] = useState(false);
  const [cloneModalVisible, setCloneModalVisible] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<VoiceSchedule | null>(null);
  const [editMode, setEditMode] = useState<ScheduleModalMode>('create');

  const handleCreate = () => {
    if (!devices.length) { Toast.show({ content: '请先配对设备' }); return; }
    setEditingSchedule(null);
    setEditMode('create');
    setModalVisible(true);
  };

  const handleEditSchedule = (sched: VoiceSchedule) => {
    setEditingSchedule(sched);
    setEditMode('schedule');
    setModalVisible(true);
  };

  const handleEditVoice = (sched: VoiceSchedule) => {
    setEditingSchedule(sched);
    setEditMode('voice');
    setModalVisible(true);
  };

  const handleDelete = (sched: VoiceSchedule) => {
    Dialog.confirm({
      title: '删除定时语音？',
      content: `确定删除「${sched.title} (${sched.timeStr})」吗？关联设备联网同步后将不再播报。`,
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: async () => {
        try { await deleteSchedule(sched.id); Toast.show({ content: '已删除定时提醒' }); }
        catch (error) { Toast.show({ content: error instanceof Error ? error.message : '删除失败' }); }
      },
    });
  };

  const renderRepeatDays = (days: number[]) => {
    if (!days || days.length === 0) return '仅一次（不循环）';
    if (days.length === 7) return '每天';
    if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return '周一至周五';
    if (days.length === 2 && [6, 7].every(d => days.includes(d))) return '周末';
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

  const handlePlayScheduleAudio = async (sched: VoiceSchedule) => {
    if (sched.audioUrl) {
      Toast.show({
        content: `正在播放定时播报音频 (MD5: ${sched.audioMd5?.slice(0, 6) || 'local'})`,
      });
      try {
        await playAudioStrict(sched.audioUrl);
      } catch {
        Toast.show({ icon: 'fail', content: '播放失败，请重试' });
      }
      return;
    }

    // 若该定时任务尚未保存音频地址，首次试播时合成并保存 audioUrl 到任务记录
    const cloneProfile = sched.clonedVoiceId
      ? voiceClones.find(c => c.id === sched.clonedVoiceId)
      : undefined;
    if (sched.sourceType === 'parent_clone' && !cloneProfile?.providerVoiceId) {
      Toast.show({ icon: 'fail', content: '音色档案不存在，无法合成' });
      return;
    }
    const isCloned = Boolean(sched.sourceType === 'parent_clone' && cloneProfile?.providerVoiceId);
    const ttsRes = await requestDoubaoTtsAudio({
      text: sched.textContent,
      voiceType: isCloned ? cloneProfile?.providerVoiceId : undefined,
      isClonedVoice: isCloned,
      persist: true,
    });
    const savedUrl = ttsRes.audioUrl;
    if (ttsRes.ok && savedUrl) {
      try {
        await updateSchedule(sched.id, {
          audioUrl: savedUrl,
          audioMd5: ttsRes.audioMd5 || null,
        });
      } catch {
        Toast.show({ icon: 'fail', content: '保存音频失败，请重试' });
        return;
      }
      Toast.show({
        content: `已生成并保存永久音频地址 (${savedUrl})，正在试播`,
      });
      try {
        await playAudioStrict(savedUrl);
      } catch {
        Toast.show({ icon: 'fail', content: '播放失败，请重试' });
      }
      return;
    }

    Toast.show({ icon: 'fail', content: ttsRes.error || '音频合成失败，请重试' });
  };

  const groups = Array.from(schedules.reduce((map, item) => {
    const key = item.groupId || item.id;
    map.set(key, [...(map.get(key) || []), item]);
    return map;
  }, new Map<string, VoiceSchedule[]>()).values());

  return (
    <div className="px-3.5 pt-3 pb-24 space-y-3.5 text-[#1F2937]">
      {/* 1. 顶部标题与新建按钮 */}
      <div className="flex items-center justify-between gap-2 px-0.5">
        <div>
          <h2 className="text-h2 text-[#1F2937]">定时语音播报 ({groups.length})</h2>
          <p className="text-caption text-[#9CA3AF]">
            显示全部设备的提醒；设备联网同步后生效
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

      {/* 定时任务列表 */}
      {schedules.length === 0 ? (
        <div className="kid-card text-center py-6">
          <Empty description={schedulesDeviceId !== 'all' ? '正在加载定时任务…' : '暂无定时语音任务，点击右上角新建'} />
        </div>
      ) : (
        <div className="space-y-2.5">
          {groups.map(members => { const sched = members[0]; const anyEnabled = members.some(item => item.enabled); const allEnabled = members.every(item => item.enabled); return (
            <div
              key={sched.id}
              className={`kid-card transition-opacity ${!anyEnabled ? 'opacity-60' : ''}`}
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
                  checked={allEnabled}
                  onChange={() => { void toggleSchedule(sched.id).catch(error => Toast.show({ content: error instanceof Error ? error.message : '操作失败' })); }}
                  style={{
                    '--width': '38px',
                    '--height': '22px',
                    '--checked-color': '#4C7866',
                  }}
                />
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                <span className="text-[#77786F]">应用设备：</span>
                {members.map(member => <span key={member.id} className="rounded-full bg-[#F3F1EB] px-2 py-1 text-[#4C5148]">
                  {devices.find(device => device.id === member.deviceId)?.alias || (member.deviceId === 'default' ? '旧版默认设备' : `${member.deviceId}（未绑定）`)} · {member.enabled ? '已启用' : '已停用'}{member.lastAckStatus === 'confirmed' ? ' · 已确认' : ''}
                </span>)}
              </div>
              {!allEnabled && anyEnabled && <p className="text-xs text-[#B45F32] mt-1">部分设备已停用，开启开关可对全部设备启用。</p>}
              {members.some(item => item.title !== sched.title || item.timeStr !== sched.timeStr || item.textContent !== sched.textContent || JSON.stringify(item.repeatDays) !== JSON.stringify(sched.repeatDays) || item.audioMd5 !== sched.audioMd5 || item.requireAck !== sched.requireAck || item.repeatPlayCount !== sched.repeatPlayCount) && <p className="text-xs text-[#B45F32] mt-1">部分设备的提醒内容不同，请重新编辑以统一设置。</p>}
              {/* 底部状态与操作栏 */}
              <div className="mt-2.5 pt-2.5 border-t border-[#F3F4F6] flex items-center justify-between gap-2 flex-wrap">
                <div className="text-caption text-[#6B7280] flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-[#3E493F]">
                    {renderRepeatDays(sched.repeatDays)}
                  </span>
                  <span>·</span>
                  <span>
                    {sched.requireAck
                      ? `最多播 ${sched.repeatPlayCount} 次(需确认)`
                      : `固定播 ${sched.repeatPlayCount} 次`}
                  </span>

                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => handlePlayScheduleAudio(sched)}
                    className="kid-btn kid-btn-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px]"
                  >
                    <IconVolume className="w-3 h-3" />
                    <span>试播</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEditSchedule(sched)}
                    className="kid-btn kid-btn-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px]"
                  >
                    <IconClock className="w-3 h-3" />
                    <span>改定时</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEditVoice(sched)}
                    className="kid-btn kid-btn-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px]"
                  >
                    <EditSOutline />
                    <span>改声音</span>
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
          ); })}
        </div>
      )}

      <ScheduleFormModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        initialSchedule={editingSchedule}
        editMode={editMode}
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
