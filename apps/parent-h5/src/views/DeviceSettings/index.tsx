'use client';

import React, { useState } from 'react';
import { Popup, Toast } from 'antd-mobile';
import { useAppStore } from '../../stores/useAppStore';
import { IconDevice, IconPlus, IconBattery, IconWifi } from '../../components/Icons';

export const DeviceSettingsPage: React.FC = () => {
  const { devices, children, selectedDeviceId, addDevice, petConfig, updatePetConfig } =
    useAppStore();

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [alias, setAlias] = useState('');
  const [childNickname, setChildNickname] = useState('');

  const handleAddDevice = (e: React.FormEvent) => {
    e.preventDefault();
    if (!childNickname.trim()) {
      Toast.show({ content: '请输入宝贝昵称' });
      return;
    }
    addDevice(alias, childNickname);
    setAlias('');
    setChildNickname('');
    setAddModalOpen(false);
    Toast.show({ icon: 'success', content: '已添加并绑定微雪 ESP32-S3 语音设备' });
  };

  return (
    <div className="px-3.5 pt-3 pb-24 space-y-4 text-[#1F2937]">
      {/* 1. 已绑定设备列表 */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between px-0.5">
          <div>
            <h2 className="text-h2">微雪 2.16 寸语音设备</h2>
            <p className="text-caption text-[#9CA3AF]">
              硬件型号：Waveshare ESP32-S3-Touch-AMOLED-2.16 (480×480)
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAddModalOpen(true)}
            className="kid-btn kid-btn-primary kid-btn-sm"
          >
            <IconPlus className="w-3 h-3" />
            <span>配对新设备</span>
          </button>
        </div>

        <div className="kid-list">
          {devices.map(dev => {
            const child = children.find(c => c.id === dev.childId);
            const isCurrent = dev.id === selectedDeviceId;
            return (
              <div key={dev.id} className="kid-list-row">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="w-9 h-9 rounded-xl bg-[#F3F1EB] flex items-center justify-center text-[#3E493F] shrink-0">
                    <IconDevice className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sm truncate">{dev.alias}</span>
                      {isCurrent && (
                        <span className="kid-status-chip kid-status-complete">当前活跃</span>
                      )}
                    </div>
                    <div className="text-xs text-[#6B7280] mt-0.5 flex items-center gap-2 flex-wrap">
                      <span>宝贝：{child?.nickname || '天天'}</span>
                      <span>·</span>
                      <span className="inline-flex items-center gap-1 text-[#4C7866]">
                        <IconWifi className="w-3 h-3" />
                        在线
                      </span>
                      <span>·</span>
                      <span className="inline-flex items-center gap-1">
                        <IconBattery className="w-3 h-3" />
                        {dev.batteryPercent}%
                      </span>
                    </div>
                  </div>
                </div>
                <span className="font-mono text-[10px] text-[#9CA3AF] shrink-0">
                  {dev.firmwareVersion}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* 2. 设备喇叭音量与盲操按键说明 */}
      <section className="kid-card space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-h3 text-[#1F2937]">ES8311 喇叭音量控制</h3>
            <p className="text-xs text-[#6B7280]">调节 AI 回复、微聊语音及定时闹钟的外放音量</p>
          </div>
          <span className="font-mono font-bold text-sm text-[#B96043]">
            {petConfig.volumeLevel}%
          </span>
        </div>
        <input
          type="range"
          min={10}
          max={100}
          step={5}
          value={petConfig.volumeLevel}
          onChange={e => updatePetConfig({ volumeLevel: Number(e.target.value) })}
          className="w-full accent-[#B96043]"
        />
      </section>

      {/* 3. 硬件按键与触控盲操指南卡片 */}
      <section className="kid-card space-y-2.5">
        <h3 className="text-h3 text-[#1F2937]">硬件交互与快捷盲操规范</h3>
        <div className="space-y-2 text-xs text-[#55574F]">
          <div className="p-2.5 rounded-xl bg-[#F5F4F0]">
            <strong className="text-[#242620]">1. 按住触摸屏 (CST9220)：</strong>
            在主页按住 480×480 方形屏幕直接与 <strong>AI 宠物 ({petConfig.petName})</strong> 对话聊天（自带双麦硬件 AEC 回声消除），松手即发送。
          </div>
          <div className="p-2.5 rounded-xl bg-[#F5F4F0]">
            <strong className="text-[#242620]">2. 按住机身侧面自定义按键 (GPIO18 / BOOT)：</strong>
            无论当前在哪个页面，按住侧面实体键即刻录音并发送 <strong>微信语音给爸爸妈妈</strong>！
          </div>
          <div className="p-2.5 rounded-xl bg-[#F5F4F0]">
            <strong className="text-[#242620]">3. 硬件 RTC 定时提醒 (PCF85063)：</strong>
            到点自动唤醒屏幕循环播报提醒语音，孩子点击触摸屏即可停止播报并回传已确认状态。
          </div>
        </div>
      </section>

      <Popup
        visible={addModalOpen}
        onMaskClick={() => setAddModalOpen(false)}
        bodyStyle={{ borderRadius: '20px 20px 0 0' }}
      >
        <form onSubmit={handleAddDevice} className="p-5 pb-8 space-y-4 max-w-xl mx-auto">
          <h3 className="text-h1">配对「小铭同学」语音设备</h3>
          <div>
            <label className="block text-caption mb-1">归属宝贝昵称 *</label>
            <input
              type="text"
              required
              value={childNickname}
              onChange={e => setChildNickname(e.target.value)}
              placeholder="例如：正正"
              className="kid-input"
            />
          </div>
          <div>
            <label className="block text-caption mb-1">设备名称（选填）</label>
            <input
              type="text"
              value={alias}
              onChange={e => setAlias(e.target.value)}
              placeholder="例如：正正书桌的小铭同学"
              className="kid-input"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setAddModalOpen(false)}
              className="kid-btn kid-btn-ghost flex-1"
            >
              取消
            </button>
            <button type="submit" className="kid-btn kid-btn-primary flex-1">
              确认绑定
            </button>
          </div>
        </form>
      </Popup>
    </div>
  );
};
