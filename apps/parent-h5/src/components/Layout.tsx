'use client';

import React, { useState, useEffect } from 'react';
import { SafeArea } from 'antd-mobile';
import { useAppStore } from '../stores/useAppStore';
import { BrandLogoXiaoming, IconMic, IconChatBubble, IconClock, IconDevice } from './Icons';

import { WeChatVoicePage } from '../views/WeChatVoice';
import { VoiceSchedulesPage } from '../views/VoiceSchedules';
import { PetAIConfigPage } from '../views/PetAIConfig';
import { DeviceSettingsPage } from '../views/DeviceSettings';

export const Layout: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>('wechat');
  const { messages, schedules, parentRole, setParentRole } = useAppStore();
  const [roleModalOpen, setRoleModalOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('parent_user_role');
      if (saved) {
        if (!parentRole) setParentRole(saved);
      } else if (!parentRole) {
        setRoleModalOpen(true);
      }
    } catch {
      if (!parentRole) setRoleModalOpen(true);
    }
  }, [parentRole, setParentRole]);

  const unreadChildVoiceCount = messages.filter(
    m => m.direction === 'device_to_parent' && m.status === 'unread'
  ).length;

  const activeSchedulesCount = schedules.filter(s => s.enabled).length;

  const tabs = [
    {
      key: 'wechat',
      title: '亲子聊',
      icon: <IconChatBubble className="w-[18px] h-[18px]" />,
      badge: unreadChildVoiceCount > 0 ? unreadChildVoiceCount : undefined,
    },
    {
      key: 'schedules',
      title: '定时播报',
      icon: <IconClock className="w-[18px] h-[18px]" />,
      badge: activeSchedulesCount > 0 ? activeSchedulesCount : undefined,
    },
    {
      key: 'pet-ai',
      title: '我的声音',
      icon: <IconMic className="w-[18px] h-[18px]" />,
    },
    {
      key: 'devices',
      title: '家庭设备',
      icon: <IconDevice className="w-[18px] h-[18px]" />,
    },
  ];

  return (
    <div className="parent-app-shell flex flex-col h-[100dvh] overflow-hidden antialiased">
      <SafeArea position="top" />

      <header className="parent-app-header shrink-0 select-none">
        <div className="parent-app-header-inner w-full max-w-xl mx-auto px-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BrandLogoXiaoming className="w-9 h-9 shrink-0 rounded-xl shadow-sm" />
            <div>
              <h1 className="parent-app-title leading-none">小铭同学</h1>
              <div className="parent-app-subtitle">智能语音萌宠 · 亲子聊空间</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button type="button" className="family-summary-chip" onClick={async () => {
              await fetch('/api/v1/auth', { method: 'DELETE' });
              window.location.reload();
            }}>退出</button>
          </div>
        </div>
      </header>

      {/* 主视图内容区 */}
      <main className="flex-1 min-h-0 w-full max-w-xl mx-auto flex flex-col overflow-hidden">
        {activeTab === 'wechat' && <WeChatVoicePage />}
        {activeTab === 'schedules' && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <VoiceSchedulesPage />
          </div>
        )}
        {activeTab === 'pet-ai' && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <PetAIConfigPage />
          </div>
        )}
        {activeTab === 'devices' && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <DeviceSettingsPage />
          </div>
        )}
      </main>

      {/* 简洁底部导航栏 */}
      <nav className="parent-bottom-nav shrink-0 z-40 select-none">
        <div className="max-w-xl mx-auto px-2 py-1 grid grid-cols-4">
          {tabs.map(item => {
            const isActive = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className={`parent-nav-item relative h-[50px] flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  isActive ? 'is-active' : 'hover:text-[#4C5148]'
                }`}
              >
                <div className="parent-nav-item-icon relative">
                  {item.icon}
                  {item.badge !== undefined && (
                    <span className="parent-nav-badge absolute -top-1 -right-3 text-white text-[10px] font-bold min-w-[14px] h-[14px] px-1 rounded-full flex items-center justify-center">
                      {item.badge}
                    </span>
                  )}
                </div>
                <span className="leading-none">{item.title}</span>
              </button>
            );
          })}
        </div>
        <SafeArea position="bottom" />
      </nav>

      {/* 首次进入弹窗：设置本地身份 */}
      {roleModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 select-none">
          <div className="w-full max-w-xs rounded-3xl bg-white p-6 shadow-2xl border border-[#E9E7E0] space-y-4 text-center animate-fade-in">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-[#F7EBE5] text-[#B96043] flex items-center justify-center text-3xl shadow-sm">
              👨‍👩‍👧
            </div>
            <div>
              <h3 className="text-base font-bold text-[#242620]">请选择您的身份</h3>
              <p className="text-xs text-[#77786F] mt-1.5 leading-relaxed">
                用于和孩子亲子聊时的身份标识，仅保存在当前手机本地，后续可在「家庭设备」随时修改。
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  setParentRole('妈妈');
                  setRoleModalOpen(false);
                }}
                className="kid-btn kid-btn-primary !h-11 flex items-center justify-center gap-1.5 rounded-xl text-xs font-bold"
              >
                <span>👩</span>
                <span>我是妈妈</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setParentRole('爸爸');
                  setRoleModalOpen(false);
                }}
                className="kid-btn !h-11 flex items-center justify-center gap-1.5 rounded-xl text-xs font-bold bg-[#4C7866] text-white hover:bg-[#3D6353]"
              >
                <span>👨</span>
                <span>我是爸爸</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
