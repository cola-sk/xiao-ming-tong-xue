'use client';

import React, { useState, useEffect } from 'react';
import { Toast, Dialog } from 'antd-mobile';
import { EditSOutline, DeleteOutline } from 'antd-mobile-icons';
import { useAppStore } from '../../stores/useAppStore';
import { PET_PERSONAS, VoiceCloneProfile } from '../../services/types';
import { IconPlus, IconSparkle, IconVolume } from '../../components/Icons';
import { playAudioOrFallback, requestDoubaoTtsAudio } from '../../utils/voiceSynth';
import { VoiceCloneModal } from '../VoiceSchedules/VoiceCloneModal';

export const PetAIConfigPage: React.FC = () => {
  const {
    petConfig,
    devices, selectedDeviceId, configDeviceId,
    voiceClones,
    updatePetConfig,
    deleteVoiceCloneProfile,
    syncPetAiFromServer,
    syncVoiceClonesFromServer,
  } = useAppStore();

  const [petName, setPetName] = useState(petConfig.petName);
  const [selectedPersonaId, setSelectedPersonaId] = useState(petConfig.personaId);
  const [selectedVoiceId, setSelectedVoiceId] = useState(petConfig.voiceId);
  const [customPrompt, setCustomPrompt] = useState(petConfig.customPrompt);
  const [previewingId, setPreviewingId] = useState<string>('');
  const [cloneModalVisible, setCloneModalVisible] = useState(false);
  const [cloneModalMode, setCloneModalMode] = useState<'create' | 'retrain'>('create');
  const [editingVoice, setEditingVoice] = useState<VoiceCloneProfile | null>(null);

  const handleAddVoice = () => {
    setEditingVoice(null);
    setCloneModalMode('create');
    setCloneModalVisible(true);
  };

  const handleEditVoice = (vc: VoiceCloneProfile) => {
    setEditingVoice(vc);
    setCloneModalMode('retrain');
    setCloneModalVisible(true);
  };

  const handleDeleteVoice = (vc: VoiceCloneProfile) => {
    Dialog.confirm({
      title: '删除该声音？',
      content: `删除后「${vc.title}」将从我的声音列表移除，已绑定该音色的定时任务需重新选择声音。`,
      confirmText: '确认删除',
      cancelText: '取消',
      onConfirm: async () => {
        try {
          await deleteVoiceCloneProfile(vc.id);
          Toast.show({ content: '已删除该声音' });
        } catch {
          Toast.show({ icon: 'fail', content: '删除失败，请重试' });
        }
      },
    });
  };

  useEffect(() => {
    void syncPetAiFromServer();
    void syncVoiceClonesFromServer();
  }, [syncPetAiFromServer, syncVoiceClonesFromServer]);

  useEffect(() => {
    setPetName(petConfig.petName);
    setSelectedPersonaId(petConfig.personaId);
    setSelectedVoiceId(petConfig.voiceId);
    setCustomPrompt(petConfig.customPrompt);
  }, [petConfig.petName, petConfig.personaId, petConfig.voiceId, petConfig.customPrompt]);

  const handleSelectPersona = (persona: (typeof PET_PERSONAS)[number]) => {
    setSelectedPersonaId(persona.id);
    setSelectedVoiceId(persona.voiceId);
    setCustomPrompt(persona.systemPrompt);
  };

  const handlePreviewVoice = async (
    previewKey: string,
    voiceType: string,
    sampleText: string,
    isClonedVoice = false
  ) => {
    if (previewingId) return;
    setPreviewingId(previewKey);
    try {
      const tts = await requestDoubaoTtsAudio({
        text: sampleText,
        voiceType,
        isClonedVoice,
        persist: false,
      });
      if (!tts.ok && !tts.audioDataUrl) {
        Toast.show({ icon: 'fail', content: tts.error || '试听合成失败' });
        return;
      }
      await playAudioOrFallback(tts.audioDataUrl, sampleText);
    } catch {
      Toast.show({ icon: 'fail', content: '试听播放失败，请重试' });
    } finally {
      setPreviewingId('');
    }
  };

  const handleSaveConfig = (e: React.FormEvent) => {
    e.preventDefault();
    if (!petName.trim()) {
      Toast.show({ content: '请填写宠物名字' });
      return;
    }
    if (!selectedDeviceId || configDeviceId !== selectedDeviceId) { Toast.show({ content: '请先选择设备并等待设置加载' }); return; }
    updatePetConfig({
      petName: petName.trim(),
      personaId: selectedPersonaId,
      voiceId: selectedVoiceId,
      customPrompt: customPrompt.trim(),
    });
    Toast.show({ icon: 'success', content: 'AI 宠物人设已保存，下次对话立即生效' });
  };

  return (
    <div className="px-3.5 pt-3 pb-24 space-y-4 text-[#1F2937]">
      {/* 1. 我的声音管理（爸妈克隆音色） */}
      <div className="kid-card-highlight space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <IconSparkle className="w-4 h-4 text-[#E85835] shrink-0" />
              <h2 className="text-h2 text-[#242620]">家庭声音库（所有设备共享）</h2>
              <span className="kid-status-chip kid-status-new">已克隆 {voiceClones.length} 个音色</span>
            </div>
            <p className="text-caption text-[#77786F] mt-1">
              录制爸爸/妈妈声音样本，用于定时语音播报与专属声音合成。
            </p>
          </div>
          <button
            type="button"
            onClick={handleAddVoice}
            className="kid-btn kid-btn-primary kid-btn-sm shrink-0"
          >
            <IconPlus className="w-3.5 h-3.5" />
            <span>新增声音</span>
          </button>
        </div>

        {voiceClones.length === 0 ? (
          <div className="text-center py-5 text-xs text-[#8B8A80] bg-white/70 rounded-xl border border-dashed border-[#E8D9C8]">
            暂无录制的声音，点击右上角「新增声音」开始录制或复刻
          </div>
        ) : (
          <div className="space-y-2 pt-1">
            {voiceClones.map(vc => (
              <div
                key={vc.id}
                className="p-2.5 rounded-xl bg-white border border-[#E8D9C8] flex items-center justify-between gap-2 flex-wrap"
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
                  {vc.status === 'ready' && (
                    <button
                      type="button"
                      disabled={previewingId === vc.id}
                      onClick={() =>
                        void handlePreviewVoice(
                          vc.id,
                          vc.providerVoiceId,
                          `你好呀，我是${vc.title}，记得按时喝水休息哦！`,
                          true
                        )
                      }
                      className="kid-btn kid-btn-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px]"
                    >
                      <IconVolume className="w-3 h-3" />
                      <span>{previewingId === vc.id ? '合成中…' : '试听'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={vc.status === 'training'}
                    onClick={() => handleEditVoice(vc)}
                    className="kid-btn kid-btn-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px]"
                  >
                    <EditSOutline />
                    <span>编辑</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteVoice(vc)}
                    className="kid-btn kid-btn-danger-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px]"
                  >
                    <DeleteOutline />
                    <span>删除</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. 小宠物声音与人设配置 */}
      {selectedDeviceId && configDeviceId === selectedDeviceId ? <form onSubmit={handleSaveConfig} className="kid-card space-y-3.5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-h2 text-[#1F2937]">{devices.find(d => d.id === selectedDeviceId)?.alias || '未选择设备'} · AI 伙伴设置</h2>
            <p className="text-caption text-[#77786F]">
              孩子按住设备触摸屏说话，松手即由大模型 + 萌宠 TTS 回复
            </p>
          </div>
        </div>

        <div>
          <label className="text-caption text-[#1F2937] block mb-1.5">宠物专属昵称</label>
          <input
            type="text"
            value={petName}
            onChange={e => setPetName(e.target.value)}
            className="kid-input"
            maxLength={20}
            placeholder="例如：麦麦、闪电"
          />
        </div>

        {/* 预设性格与音色卡片 */}
        <div className="space-y-2">
          <div className="text-caption text-[#1F2937]">选择性格模板与萌宠音色：</div>
          <div className="grid grid-cols-1 gap-2">
            {PET_PERSONAS.map(p => {
              const selected = selectedPersonaId === p.id;
              const isPreviewing = previewingId === p.id;
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSelectPersona(p)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleSelectPersona(p);
                    }
                  }}
                  className={`p-3 rounded-xl border text-left transition-all flex items-center justify-between gap-2 cursor-pointer ${
                    selected
                      ? 'bg-[#FFFEFB] border-[#E85835] shadow-sm'
                      : 'bg-white border-[#E9E7E0]'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm text-[#242620]">{p.name}</span>
                      <span className="kid-status-chip kid-status-new">{p.tag}</span>
                    </div>
                    <p className="text-xs text-[#77786F] mt-1 line-clamp-1">{p.systemPrompt}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={isPreviewing}
                      onClick={e => {
                        e.stopPropagation();
                        void handlePreviewVoice(
                          p.id,
                          p.voiceId,
                          `你好呀，我是${petName.trim() || '小铭同学'}，很高兴陪你一起探索奇妙世界！`
                        );
                      }}
                      className="kid-btn kid-btn-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px]"
                    >
                      <IconVolume className="w-3 h-3" />
                      <span>{isPreviewing ? '合成中…' : '试听'}</span>
                    </button>
                    <span
                      className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                        selected ? 'border-[#E85835]' : 'border-[#D1D5DB]'
                      }`}
                    >
                      {selected && <span className="w-2 h-2 rounded-full bg-[#E85835]" />}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 自定义 System Prompt */}
        <div>
          <label className="text-caption text-[#1F2937] block mb-1.5">
            大模型人设指令 (System Prompt)
          </label>
          <textarea
            rows={3}
            value={customPrompt}
            onChange={e => setCustomPrompt(e.target.value)}
            className="kid-input"
            maxLength={300}
          />
        </div>

        <button type="submit" className="w-full kid-btn kid-btn-primary kid-btn-md">
          保存 AI 宠物配置
        </button>
      </form> : <div className="kid-card text-sm text-[#77786F]">{selectedDeviceId ? '正在加载当前设备的 AI 伙伴设置…' : '请先配对设备，再设置 AI 伙伴'}</div>}

      <VoiceCloneModal
        visible={cloneModalVisible}
        onClose={() => setCloneModalVisible(false)}
        initialMode={cloneModalMode}
        initialProfile={editingVoice}
      />
    </div>
  );
};
