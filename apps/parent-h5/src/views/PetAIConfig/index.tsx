'use client';

import React, { useState } from 'react';
import { Toast } from 'antd-mobile';
import { useAppStore } from '../../stores/useAppStore';
import { PET_PERSONAS } from '../../services/types';
import { BrandLogoXiaoming, IconVolume } from '../../components/Icons';
import { playAudioOrFallback, requestDoubaoTtsAudio } from '../../utils/voiceSynth';

export const PetAIConfigPage: React.FC = () => {
  const { petConfig, aiLogs, updatePetConfig } = useAppStore();

  const [petName, setPetName] = useState(petConfig.petName);
  const [customPrompt, setCustomPrompt] = useState(petConfig.customPrompt);

  const handleSelectPersona = (persona: (typeof PET_PERSONAS)[number]) => {
    setCustomPrompt(persona.systemPrompt);
    updatePetConfig({
      personaId: persona.id,
      voiceId: persona.voiceId,
      customPrompt: persona.systemPrompt,
    });
    Toast.show({ content: `已切换为「${persona.name}」人设与音色` });
  };

  const handleSaveConfig = (e: React.FormEvent) => {
    e.preventDefault();
    if (!petName.trim()) {
      Toast.show({ content: '请填写宠物名字' });
      return;
    }
    updatePetConfig({
      petName: petName.trim(),
      customPrompt: customPrompt.trim(),
    });
    Toast.show({ icon: 'success', content: 'AI 宠物人设已保存，下次对话立即生效' });
  };

  return (
    <div className="px-3.5 pt-3 pb-24 space-y-4 text-[#1F2937]">
      {/* 1. AI 宠物名片与人设选择 */}
      <form onSubmit={handleSaveConfig} className="kid-card space-y-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BrandLogoXiaoming className="w-11 h-11 rounded-2xl shrink-0" />
            <div>
              <h2 className="text-h2 text-[#1F2937]">AI 语音伴聊人设 ({petConfig.petName})</h2>
              <p className="text-caption text-[#77786F]">
                孩子按住设备触摸屏说话，松手即由大模型 + 萌宠 TTS 回复
              </p>
            </div>
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
              const selected = petConfig.personaId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelectPersona(p)}
                  className={`p-3 rounded-xl border text-left transition-all flex items-center justify-between ${
                    selected
                      ? 'bg-[#FFFEFB] border-[#B96043] shadow-sm'
                      : 'bg-white border-[#E9E7E0]'
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-[#242620]">{p.name}</span>
                      <span className="kid-status-chip kid-status-new">{p.tag}</span>
                    </div>
                    <p className="text-xs text-[#77786F] mt-1 line-clamp-1">{p.systemPrompt}</p>
                  </div>
                  <span
                    className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                      selected ? 'border-[#B96043]' : 'border-[#D1D5DB]'
                    }`}
                  >
                    {selected && <span className="w-2 h-2 rounded-full bg-[#B96043]" />}
                  </span>
                </button>
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
      </form>

      {/* 2. 最近伴聊问答记录 */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between px-0.5">
          <h3 className="approval-section-title">最近 AI 伴聊记录</h3>
          <span className="text-[11px] text-[#929187]">共 {aiLogs.length} 轮问答</span>
        </div>

        <div className="space-y-2.5">
          {aiLogs.length === 0 ? (
            <div className="kid-card text-center py-6 text-xs text-[#8B8A80]">
              暂无 AI 伴聊记录，孩子在设备端按住屏幕与宠物对话后将同步显示在这里
            </div>
          ) : (
            aiLogs.map(log => (
            <div key={log.id} className="kid-card space-y-2">
              <div className="flex items-center justify-between text-[11px] text-[#929187]">
                <span className="font-bold text-[#55574F]">宝贝提问</span>
                <span>
                  {new Date(log.createdAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <p className="text-body-lg text-[#242620]">“{log.childText}”</p>
              <div className="pt-2 border-t border-[#F0EFEA] flex items-start justify-between gap-2">
                <p className="text-body text-[#4C7866] flex-1">
                  <strong className="font-bold">{petConfig.petName}：</strong>
                  {log.petReplyText}
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    const tts = await requestDoubaoTtsAudio({
                      text: log.petReplyText,
                      voiceType: petConfig.voiceId,
                      persist: false,
                    });
                    await playAudioOrFallback(tts.audioDataUrl, log.petReplyText);
                  }}
                  className="kid-btn kid-btn-ghost kid-btn-sm !h-6 !min-h-[24px] !px-2 !text-[11px] shrink-0"
                >
                  <IconVolume className="w-3 h-3" />
                  <span>实时试听</span>
                </button>
              </div>
            </div>
          ))
          )}
        </div>
      </section>
    </div>
  );
};
