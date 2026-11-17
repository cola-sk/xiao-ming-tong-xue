'use client';

import React, { useState } from 'react';
import { SafeArea } from 'antd-mobile';
import { useAppStore } from '../stores/useAppStore';
import { BrandLogoXiaoming, IconPaw, IconChatBubble, IconClock, IconDevice } from './Icons';

import { WeChatVoicePage } from '../views/WeChatVoice';
import { VoiceSchedulesPage } from '../views/VoiceSchedules';
import { PetAIConfigPage } from '../views/PetAIConfig';
import { DeviceSettingsPage } from '../views/DeviceSettings';

export const Layout: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>('wechat');
  const { messages, schedules } = useAppStore();

  const unreadChildVoiceCount = messages.filter(
    m => m.direction === 'device_to_parent' && m.status === 'unread'
  ).length;

  const activeSchedulesCount = schedules.filter(s => s.enabled).length;

  const tabs = [
    {
      key: 'wechat',
      title: '亲子微聊',
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
      title: 'AI小宠',
      icon: <IconPaw className="w-[18px] h-[18px]" />,
    },
    {
      key: 'devices',
      title: '家庭设备',
      icon: <IconDevice className="w-[18px] h-[18px]" />,
    },
  ];

  return (
    <div className="parent-app-shell flex flex-col min-h-screen antialiased">
      <SafeArea position="top" />

      <header className="parent-app-header sticky top-0 z-40 select-none">
        <div className="parent-app-header-inner w-full max-w-xl mx-auto px-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BrandLogoXiaoming className="w-9 h-9 shrink-0 rounded-xl shadow-sm" />
            <div>
              <h1 className="parent-app-title leading-none">小铭同学</h1>
              <div className="parent-app-subtitle">智能语音萌宠 · 亲子微聊空间</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="family-summary-chip">AMOLED-2.16</span>
          </div>
        </div>
      </header>

      {/* 主视图内容区 */}
      <main className="flex-1 overflow-x-hidden w-full max-w-xl mx-auto">
        {activeTab === 'wechat' && <WeChatVoicePage />}
        {activeTab === 'schedules' && <VoiceSchedulesPage />}
        {activeTab === 'pet-ai' && <PetAIConfigPage />}
        {activeTab === 'devices' && <DeviceSettingsPage />}
      </main>

      {/* 简洁底部导航栏 */}
      <nav className="parent-bottom-nav fixed bottom-0 left-0 right-0 z-50 select-none">
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
    </div>
  );
};
