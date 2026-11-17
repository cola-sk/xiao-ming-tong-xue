'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Switch, Toast } from 'antd-mobile';
import { useAppStore } from '../../stores/useAppStore';
import { ChatVoiceMessage } from '../../services/types';
import { IconMic, IconVolume, IconBattery, IconWifi } from '../../components/Icons';
import { playAudioOrFallback, requestDoubaoTtsAudio } from '../../utils/voiceSynth';
import { startWavRecorder, WavRecorderHandle } from '../../utils/wavRecorder';

export const WeChatVoicePage: React.FC = () => {
  const {
    messages,
    devices,
    selectedDeviceId,
    petConfig,
    sendParentVoiceMessage,
    markMessagePlayed,
    syncDevicesFromServer,
    syncMessagesFromServer,
  } = useAppStore();

  useEffect(() => {
    void syncDevicesFromServer();
    void syncMessagesFromServer();
    const timer = window.setInterval(() => {
      void syncDevicesFromServer();
      void syncMessagesFromServer();
    }, 10000);
    return () => clearInterval(timer);
  }, [syncDevicesFromServer, syncMessagesFromServer]);

  const currentDevice = devices.find(d => d.id === selectedDeviceId) || devices[0];
  const [autoPlayOnDevice, setAutoPlayOnDevice] = useState(false);
  const [playingId, setPlayingId] = useState<string>('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [textInput, setTextInput] = useState('');
  const [senderRole, setSenderRole] = useState<'妈妈' | '爸爸'>('妈妈');

  const timerRef = useRef<number | null>(null);
  const wavRecorderRef = useRef<WavRecorderHandle | null>(null);

  const handlePlayBubble = async (msg: ChatVoiceMessage) => {
    if (playingId) return;
    setPlayingId(msg.id);
    try {
      if (msg.audioUrl) {
        await playAudioOrFallback(msg.audioUrl, msg.asrText);
      } else if (msg.asrText) {
        // 纯文字消息或已阅后清理音频的消息，点击时按实时 TTS 试听
        const tts = await requestDoubaoTtsAudio({
          text: msg.asrText,
          voiceType: petConfig.voiceId,
          persist: false,
        });
        await playAudioOrFallback(tts.audioDataUrl, msg.asrText);
      }
      if (msg.status === 'unread') {
        markMessagePlayed(msg.id);
      }
    } finally {
      setPlayingId('');
    }
  };

  const startHoldRecord = async () => {
    if (isRecording) return;
    try {
      const handle = await startWavRecorder();
      wavRecorderRef.current = handle;
      setIsRecording(true);
      setRecordSeconds(1);

      timerRef.current = window.setInterval(() => {
        setRecordSeconds(prev => prev + 1);
      }, 1000);
    } catch {
      Toast.show({ icon: 'fail', content: '无法访问麦克风，请允许浏览器麦克风权限或直接输入文字发送' });
    }
  };

  const stopHoldRecordAndSend = async () => {
    if (!isRecording) return;
    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const duration = Math.max(1, recordSeconds);
    const recorder = wavRecorderRef.current;
    wavRecorderRef.current = null;
    if (!recorder) return;

    const { base64, url } = await recorder.stop();
    const content = textInput.trim() || `（${duration}秒原声语音）`;
    sendParentVoiceMessage({
      senderName: senderRole,
      asrText: content,
      durationSec: duration,
      autoPlay: autoPlayOnDevice,
      audioUrl: url,
      audioBase64: base64,
      audioMime: 'audio/wav',
    });
    setTextInput('');
    Toast.show({
      icon: 'success',
      content: autoPlayOnDevice
        ? 'WAV 原声已上传，设备端将直接外放播报'
        : 'WAV 原声已上传，设备端亮起未读红点等待宝贝点击',
    });
  };

  const handleQuickTextVoiceSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) {
      Toast.show({ content: '请输入要转成语音发给宝贝的话' });
      return;
    }
    const duration = Math.max(2, Math.min(15, Math.ceil(textInput.trim().length / 4)));
    sendParentVoiceMessage({
      senderName: senderRole,
      asrText: textInput.trim(),
      durationSec: duration,
      autoPlay: autoPlayOnDevice,
    });
    setTextInput('');
    Toast.show({
      icon: 'success',
      content: autoPlayOnDevice ? '已推送至设备并直接播报' : '已推送至设备微聊列表',
    });
  };

  return (
    <div className="px-3.5 pt-3 pb-28 space-y-3.5 text-[#1F2937]">
      {/* 顶部设备在线与电量卡片 */}
      <div className="family-overview-card">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="text-[15px] font-bold text-[#292B25] truncate">
                {currentDevice ? currentDevice.alias : '尚未绑定硬件设备'}
              </h2>
              <span className="family-pet-name">AI伴侣：{petConfig.petName}</span>
            </div>
            <div className="family-account-meta mt-1 flex items-center gap-2.5">
              {currentDevice ? (
                <>
                  <span
                    className={`inline-flex items-center gap-1 font-semibold ${
                      currentDevice.isOnline ? 'text-[#4C7866]' : 'text-[#9CA3AF]'
                    }`}
                  >
                    <IconWifi className="w-3.5 h-3.5" />
                    {currentDevice.isOnline ? 'Wi-Fi 在线' : '设备离线'}
                  </span>
                  <span className="text-[#D9D6CE]">·</span>
                  <span className="inline-flex items-center gap-1 text-[#77786F]">
                    <IconBattery className="w-3.5 h-3.5" />
                    {currentDevice.isOnline || currentDevice.batteryPercent > 0
                      ? `电量 ${currentDevice.batteryPercent}%`
                      : '电量未知'}
                  </span>
                </>
              ) : (
                <span className="text-xs text-[#9CA3AF]">
                  请前往「设备」页绑定微雪 ESP32-S3 硬件终端
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 家长发送模式设置 */}
        <div className="mt-3 pt-2.5 border-t border-[#F0EFEA] flex items-center justify-between gap-2">
          <div className="text-caption text-[#6B7280]">
            <span>设备收到语音后直接外放播报</span>
            <span className="block text-[10px] text-[#929187]">
              关闭时仅响“叮咚”提示音并显示红点，等孩子点击屏幕再播
            </span>
          </div>
          <Switch
            checked={autoPlayOnDevice}
            onChange={setAutoPlayOnDevice}
            style={{
              '--width': '38px',
              '--height': '22px',
              '--checked-color': '#4C7866',
            }}
          />
        </div>
      </div>

      {/* 微信式语音气泡流 */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between px-0.5">
          <h3 className="approval-section-title">亲子双向微聊</h3>
          <span className="text-[11px] text-[#929187]">点击气泡播放语音 · 自动附带 ASR 转文字</span>
        </div>

        <div className="space-y-3">
          {messages.length === 0 ? (
            <div className="kid-card text-center py-8 text-xs text-[#8B8A80]">
              暂无亲子微聊语音记录，按住下方说话给宝贝发第一条语音吧
            </div>
          ) : (
            messages.map(msg => {
            const isParent = msg.direction === 'parent_to_device';
            const isPlaying = playingId === msg.id;
            const isUnread = msg.status === 'unread';

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isParent ? 'items-end' : 'items-start'}`}
              >
                <div className="flex items-center gap-1.5 mb-1 px-1">
                  <span className="text-[11px] font-bold text-[#55574F]">{msg.senderName}</span>
                  <span className="text-[10px] text-[#A19F95]">
                    {new Date(msg.createdAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  {isParent && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#F3F1EB] text-[#77776D]">
                      {msg.autoPlay ? '直接播报' : msg.status === 'played' ? '宝贝已听' : '待宝贝点击'}
                    </span>
                  )}
                </div>

                {/* 语音条按钮 */}
                <div className="relative max-w-[85%]">
                  <button
                    type="button"
                    onClick={() => handlePlayBubble(msg)}
                    className={`w-full text-left rounded-2xl px-3.5 py-2.5 transition-all border ${
                      isParent
                        ? 'bg-[#B96043] text-white border-[#B96043] shadow-sm'
                        : 'bg-white text-[#242620] border-[#E8D9C8] shadow-sm'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="inline-flex items-center gap-2">
                        <IconVolume
                          className={`w-4 h-4 ${isPlaying ? 'animate-pulse' : ''}`}
                        />
                        <span className="font-bold text-xs">
                          {isPlaying ? '正在播放语音…' : `${msg.durationSec}" 语音消息`}
                        </span>
                      </div>
                      <span
                        className={`text-[10px] ${
                          isParent ? 'text-white/80' : 'text-[#8B8A80]'
                        }`}
                      >
                        点击收听
                      </span>
                    </div>

                    {msg.asrText && (
                      <p
                        className={`mt-1.5 pt-1.5 text-xs leading-relaxed border-t ${
                          isParent
                            ? 'border-white/20 text-white/95'
                            : 'border-[#F0EFEA] text-[#55574F]'
                        }`}
                      >
                        {msg.asrText}
                      </p>
                    )}
                  </button>

                  {/* 未读小红点 */}
                  {!isParent && isUnread && (
                    <span
                      className="
                        absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[#EF4444]
                        ring-2 ring-white
                      "
                      title="未读语音"
                    />
                  )}
                </div>
              </div>
            );
          })
          )}
        </div>
      </section>

      {/* 底部录音与快捷语音发送操作台 */}
      <section className="kid-card space-y-2.5 sticky bottom-[64px] z-30 shadow-md">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-caption text-[#6B7280]">发送身份：</span>
            {(['妈妈', '爸爸'] as const).map(role => (
              <button
                key={role}
                type="button"
                onClick={() => setSenderRole(role)}
                className={`kid-filter-chip !h-6 !min-h-[24px] !px-2.5 !text-[11px] ${
                  senderRole === role ? 'kid-filter-chip-selected' : ''
                }`}
              >
                {role}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-[#8B8A80]">
            {isRecording ? `正在录音 ${recordSeconds}s (松手即发送)...` : '支持按住说话或输入文字转语音'}
          </span>
        </div>

        <form onSubmit={handleQuickTextVoiceSend} className="flex items-center gap-2">
          <input
            type="text"
            value={textInput}
            onChange={e => setTextInput(e.target.value)}
            placeholder="输入内容或备注（可留空直接按住录音）"
            className="kid-input flex-1"
            maxLength={120}
          />
          {textInput.trim() ? (
            <button type="submit" className="kid-btn kid-btn-primary kid-btn-md shrink-0">
              发送语音
            </button>
          ) : (
            <button
              type="button"
              onMouseDown={startHoldRecord}
              onMouseUp={stopHoldRecordAndSend}
              onTouchStart={startHoldRecord}
              onTouchEnd={stopHoldRecordAndSend}
              className={`kid-btn kid-btn-md shrink-0 ${
                isRecording ? 'kid-btn-secondary scale-95' : 'kid-btn-primary'
              }`}
            >
              <IconMic className="w-4 h-4" />
              <span>{isRecording ? '松开 立即发送' : '按住 说话'}</span>
            </button>
          )}
        </form>
      </section>
    </div>
  );
};
