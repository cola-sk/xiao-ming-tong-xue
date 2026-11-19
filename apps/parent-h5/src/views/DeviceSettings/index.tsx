'use client';

import React, { useState, useEffect } from 'react';
import { Popup, Switch, Toast } from 'antd-mobile';
import { DeleteOutline } from 'antd-mobile-icons';
import { useAppStore } from '../../stores/useAppStore';
import { IconDevice, IconPlus, IconBattery, IconWifi } from '../../components/Icons';

export const DeviceSettingsPage: React.FC = () => {
  const {
    devices,
    selectedDeviceId,
    addDevice,
    syncDevicesFromServer,
    removeDevice,
    selectDevice,
    petConfig,
    updatePetConfig,
    autoPlayOnDevice,
    setAutoPlayOnDevice,
  } = useAppStore();

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [alias, setAlias] = useState('');
  const [childNickname, setChildNickname] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void syncDevicesFromServer();
    const timer = window.setInterval(() => {
      void syncDevicesFromServer();
    }, 10000);
    return () => clearInterval(timer);
  }, [syncDevicesFromServer]);

  const handleAddDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{8}$/.test(pairingCode.trim())) {
      Toast.show({ content: '请输入设备屏幕上的8位绑定码' });
      return;
    }
    if (!childNickname.trim()) {
      Toast.show({ content: '请输入宝贝昵称' });
      return;
    }
    setSubmitting(true);
    try {
      await addDevice(pairingCode.trim(), alias, childNickname);
      setPairingCode('');
      setAlias('');
      setChildNickname('');
      setAddModalOpen(false);
      Toast.show({ icon: 'success', content: '绑定成功，设备将自动连接' });
    } catch (err) {
      Toast.show({
        icon: 'fail',
        content: err instanceof Error ? err.message : '设备绑定失败',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleVolumeChange = (val: number) => {
    updatePetConfig({ volumeLevel: val });
    if (selectedDeviceId) {
      fetch('/api/v1/device/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'volume',
          deviceId: selectedDeviceId,
          volumeLevel: val,
        }),
      }).catch(() => {});
    }
  };

  return (
    <div className="px-3.5 pt-3 pb-24 space-y-4 text-[#1F2937]">
      {/* 1. 已绑定设备列表 */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between px-0.5">
          <div>
            <h2 className="text-h2">微雪 2.16 寸语音设备 ({devices.length})</h2>
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

        {devices.length === 0 ? (
          <div className="kid-card text-center py-8 space-y-2">
            <p className="text-xs text-[#8B8A80]">
              尚未绑定任何 ESP32-S3 硬件设备
            </p>
            <p className="text-[11px] text-[#9CA3AF]">
              让设备联网后，点击「配对新设备」，输入设备屏幕上的8位绑定码即可完成关联。
            </p>
          </div>
        ) : (
          <div className="kid-list">
            {devices.map(dev => {
              const isCurrent = dev.id === selectedDeviceId;
              return (
                <div
                  key={dev.id}
                  onClick={() => selectDevice(dev.id)}
                  className="kid-list-row cursor-pointer"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="w-9 h-9 rounded-xl bg-[#F3F1EB] flex items-center justify-center text-[#3E493F] shrink-0">
                      <IconDevice className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-bold text-sm truncate">{dev.alias}</span>
                        {isCurrent && (
                          <span className="kid-status-chip kid-status-complete">当前选中</span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-[#9CA3AF] mt-0.5">
                        ID: {dev.id}
                      </div>
                      <div className="text-xs text-[#6B7280] mt-0.5 flex items-center gap-2 flex-wrap">
                        <span
                          className={`inline-flex items-center gap-1 font-semibold ${
                            dev.isOnline ? 'text-[#4C7866]' : 'text-[#9CA3AF]'
                          }`}
                        >
                          <IconWifi className="w-3 h-3" />
                          {dev.isOnline ? '在线' : '离线'}
                        </span>
                        <span>·</span>
                        <span className="inline-flex items-center gap-1">
                          <IconBattery className="w-3 h-3" />
                          {dev.isOnline || dev.batteryPercent > 0
                            ? `${dev.batteryPercent}%`
                            : '未上报'}
                        </span>
                        {dev.lastSeenAt && (
                          <>
                            <span>·</span>
                            <span className="text-[10px] text-[#9CA3AF]">
                              心跳{' '}
                              {new Date(dev.lastSeenAt).toLocaleTimeString('zh-CN', {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                              })}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-[10px] text-[#9CA3AF]">
                      v{dev.firmwareVersion}
                    </span>
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        void removeDevice(dev.id).catch(err => Toast.show({ content: err instanceof Error ? err.message : '解绑失败' }));
                      }}
                      className="kid-btn kid-btn-danger-ghost kid-btn-sm !h-6 !min-h-[24px] !px-1.5"
                      title="解绑设备"
                    >
                      <DeleteOutline />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 2. 设备喇叭音量与微聊播报方式设置 */}
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
          onChange={e => handleVolumeChange(Number(e.target.value))}
          className="w-full accent-[#B96043]"
        />

        <div className="pt-3 border-t border-[#F0EFEA] flex items-center justify-between gap-3">
          <div>
            <div className="text-caption text-[#1F2937] font-bold">
              亲子微聊语音直接外放
            </div>
            <p className="text-[11px] text-[#6B7280] mt-0.5 leading-relaxed">
              仅对家长发送的微聊语音生效（不影响 AI 对话和定时提醒）。开启后设备收到即直接播报；关闭时仅响提示音并亮红点，需孩子点击播放。
            </p>
          </div>
          <Switch
            checked={autoPlayOnDevice}
            onChange={checked => {
              setAutoPlayOnDevice(checked);
              Toast.show({
                content: checked
                  ? '已开启：家长微聊语音收到后直接外放'
                  : '已关闭：家长微聊语音需孩子点击收听',
              });
            }}
            style={{
              '--width': '38px',
              '--height': '22px',
              '--checked-color': '#4C7866',
            }}
          />
        </div>
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
            <label className="block text-caption mb-1">设备绑定码 *</label>
            <input
              type="text"
              required
              inputMode="numeric"
              pattern="[0-9]{8}"
              maxLength={8}
              autoComplete="off"
              value={pairingCode}
              onChange={e => setPairingCode(e.target.value.replace(/\D/g, ''))}
              placeholder="输入设备屏幕上的8位数字"
              className="kid-input font-mono"
            />
            <p className="text-caption text-[#9CA3AF] mt-2">设备联网后显示绑定码，10分钟内有效。请确认设备就在身边。</p>
          </div>
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
            <button type="submit" disabled={submitting} className="kid-btn kid-btn-primary flex-1">
              {submitting ? '绑定中…' : '确认绑定'}
            </button>
          </div>
        </form>
      </Popup>
    </div>
  );
};
