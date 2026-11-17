'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Switch, Toast, Dialog } from 'antd-mobile';
import { useAppStore } from '../../stores/useAppStore';
import { ChatVoiceMessage } from '../../services/types';
import { IconMic, IconVolume, IconBattery, IconWifi } from '../../components/Icons';
import { playAudioOrFallback, requestDoubaoTtsAudio } from '../../utils/voiceSynth';
import { startWavRecorder, WavRecorderHandle } from '../../utils/wavRecorder';
import {
  saveLocalChatAudio,
  getLocalChatAudioUrl,
  getLocalChatAudioStats,
  clearLocalChatAudio,
} from '../../utils/chatAudioDb';

function playRecordedAudio(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error('音频播放失败'));
    audio.play().catch(reject);
  });
}

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
    const syncWhenVisible = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      void syncDevicesFromServer();
      void syncMessagesFromServer();
    };
    const timer = window.setInterval(syncWhenVisible, 10000);
    document.addEventListener('visibilitychange', syncWhenVisible);
    window.addEventListener('online', syncWhenVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', syncWhenVisible);
      window.removeEventListener('online', syncWhenVisible);
    };
  }, [syncDevicesFromServer, syncMessagesFromServer]);

  const [hiddenMessageIds, setHiddenMessageIds] = useState<string[]>([]);
  const currentDevice = devices.find(d => d.id === selectedDeviceId) || devices[0];
  const historyKey = `pet_chat_hidden_${selectedDeviceId || 'all'}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(historyKey) || '[]');
      setHiddenMessageIds(Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : []);
    } catch {
      setHiddenMessageIds([]);
    }
  }, [historyKey]);
  const hiddenIds = new Set(hiddenMessageIds);
  const visibleMessages = messages.filter(message => !hiddenIds.has(message.id));

  const clearLocalHistory = () => {
    void Dialog.confirm({
      title: '清空本机记录？',
      content: '将隐藏当前聊天记录并清除本浏览器所有聊天语音缓存，服务器消息和未读语音仍会保留；清除浏览器数据后记录可能重新显示。',
      confirmText: '清空本机记录',
      cancelText: '取消',
      onConfirm: async () => {
        try {
          await clearLocalChatAudio();
          refreshLocalStats();
          const ids = Array.from(new Set([...hiddenMessageIds, ...messages.map(message => message.id)]));
          localStorage.setItem(historyKey, JSON.stringify(ids));
          setHiddenMessageIds(ids);
          Toast.show({ content: '已清空本机记录和语音缓存' });
        } catch {
          Toast.show({ icon: 'fail', content: '清空未完成，请检查浏览器存储权限后重试' });
        }
      },
    });
  };

  const [autoPlayOnDevice, setAutoPlayOnDevice] = useState(false);
  const [playingId, setPlayingId] = useState<string>('');
  const [recordState, setRecordState] = useState<'idle' | 'starting' | 'recording' | 'sending'>('idle');
  const isRecording = recordState === 'recording';
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [textInput, setTextInput] = useState('');
  const [senderRole, setSenderRole] = useState<'妈妈' | '爸爸'>('妈妈');
  const [localCacheStats, setLocalCacheStats] = useState<{ count: number; totalBytes: number }>({
    count: 0,
    totalBytes: 0,
  });

  const refreshLocalStats = () => {
    void getLocalChatAudioStats().then(setLocalCacheStats);
  };

  useEffect(() => {
    refreshLocalStats();
  }, [messages.length]);

  const timerRef = useRef<number | null>(null);
  const wavRecorderRef = useRef<WavRecorderHandle | null>(null);
  const mountedRef = useRef(false);
  const startRef = useRef(false);
  const recordStartedAt = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const stopOnBackground = () => {
      if (document.visibilityState !== 'hidden') return;
      const recorder = wavRecorderRef.current;
      wavRecorderRef.current = null;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      if (recorder) {
        void recorder.cancel();
        setRecordState('idle');
      }
    };
    document.addEventListener('visibilitychange', stopOnBackground);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', stopOnBackground);
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      const recorder = wavRecorderRef.current;
      wavRecorderRef.current = null;
      if (recorder) void recorder.cancel();
    };
  }, []);

  const handlePlayBubble = async (msg: ChatVoiceMessage) => {
    if (playingId) return;
    setPlayingId(msg.id);
    try {
      // 1) 优先从家长端本地 IndexedDB 读取已缓存的双向原声录音
      const localUrl = await getLocalChatAudioUrl(msg.id);
      if (localUrl) {
        try {
          await playRecordedAudio(localUrl);
        } finally {
          URL.revokeObjectURL(localUrl);
        }
      } else if (msg.audioUrl) {
        // 2) 若在云端中转队列中：先拉取 WAV 存入本地 IndexedDB，再播放并标记已读以释放云端中转
        try {
          const resp = await fetch(msg.audioUrl);
          if (resp.ok) {
            const blob = await resp.blob();
            await saveLocalChatAudio(msg.id, blob, true);
            refreshLocalStats();
            const objUrl = URL.createObjectURL(blob);
            try {
              await playRecordedAudio(objUrl);
            } finally {
              URL.revokeObjectURL(objUrl);
            }
          } else {
            throw new Error('音频下载失败');
          }
        } catch (err) {
          throw err;
        }
      } else if (msg.asrText) {
        // 3) 纯文字微聊消息：实时调用豆包 TTS 合成播放（不存音频）
        const tts = await requestDoubaoTtsAudio({
          text: msg.asrText,
          voiceType: petConfig.voiceId,
          persist: false,
        });
        await playAudioOrFallback(tts.audioDataUrl, msg.asrText);
      }

      if (msg.status === 'unread' && msg.direction === 'device_to_parent') {
        await markMessagePlayed(msg.id);
      }
    } catch {
      Toast.show({ content: '播放或同步失败，请重试' });
    } finally {
      setPlayingId('');
    }
  };

  const startRecord = async () => {
    if (startRef.current || recordState !== 'idle') return;
    startRef.current = true;
    setRecordState('starting');
    try {
      const recorder = await startWavRecorder();
      if (!mountedRef.current || document.visibilityState !== 'visible') {
        await recorder.cancel();
        if (mountedRef.current) setRecordState('idle');
        return;
      }
      wavRecorderRef.current = recorder;
      recordStartedAt.current = Date.now();
      setRecordSeconds(0);
      setRecordState('recording');
      timerRef.current = window.setInterval(() => {
        setRecordSeconds(Math.floor((Date.now() - recordStartedAt.current) / 1000));
      }, 250);
    } catch {
      if (mountedRef.current) {
        setRecordState('idle');
        Toast.show({ icon: 'fail', content: '无法访问麦克风，请允许浏览器麦克风权限后重试' });
      }
    } finally {
      startRef.current = false;
    }
  };

  const finishRecord = async (send: boolean) => {
    const recorder = wavRecorderRef.current;
    if (!recorder) return;
    wavRecorderRef.current = null;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    const durationMs = Date.now() - recordStartedAt.current;
    if (!send || durationMs < 1000) {
      setRecordState('idle');
      await recorder.cancel();
      if (send && mountedRef.current) Toast.show({ content: '录音太短，请说话至少 1 秒' });
      return;
    }
    setRecordState('sending');
    let url = '';
    try {
      const recording = await recorder.stop();
      url = recording.url;
      const duration = Math.max(1, Math.ceil(durationMs / 1000));
      await sendParentVoiceMessage({
        senderName: senderRole,
        asrText: textInput.trim() || `（${duration}秒原声语音）`,
        durationSec: duration,
        autoPlay: autoPlayOnDevice,
        audioBlob: recording.blob,
        audioBase64: recording.base64,
        audioMime: 'audio/wav',
      });
      if (mountedRef.current) {
        refreshLocalStats();
        setTextInput('');
        Toast.show({ icon: 'success', content: '语音已发送，等待设备同步' });
      }
    } catch {
      if (mountedRef.current) Toast.show({ content: '发送失败，请重新录音' });
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (mountedRef.current) setRecordState('idle');
    }
  };

  const handleQuickTextVoiceSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) {
      Toast.show({ content: '请输入要转成语音发给宝贝的话' });
      return;
    }
    const duration = Math.max(2, Math.min(15, Math.ceil(textInput.trim().length / 4)));
    try {
    await sendParentVoiceMessage({
      senderName: senderRole,
      asrText: textInput.trim(),
      durationSec: duration,
      autoPlay: autoPlayOnDevice,
    });
    setTextInput('');
    Toast.show({
      icon: 'success',
      content: '已发送，等待设备同步',
    });
    } catch {
      Toast.show({ content: '发送失败，请重试' });
    }
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
        <div className="flex items-center justify-between px-0.5 gap-2">
          <div className="flex items-center gap-2">
            <h3 className="approval-section-title">亲子双向微聊</h3>
            {(visibleMessages.length > 0 || localCacheStats.count > 0) && <button type="button" onClick={clearLocalHistory} className="text-[10px] text-[#B96043] underline">清空本机记录</button>}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-[#929187]">
            <span>
              本地语音缓存 {localCacheStats.count} 条 (
              {(localCacheStats.totalBytes / 1024).toFixed(0)} KB)
            </span>

          </div>
        </div>

        <div className="space-y-3">
          {visibleMessages.length === 0 ? (
            <div className="kid-card text-center py-8 text-xs text-[#8B8A80]">
              暂无亲子微聊语音记录，点击下方录音给宝贝发送语音
            </div>
          ) : (
            visibleMessages.map(msg => {
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
          <span className="text-[11px] text-[#8B8A80]" aria-live="polite">
            {isRecording ? `正在录音 ${recordSeconds}s` : recordState === 'starting' ? '正在开启麦克风…' : recordState === 'sending' ? '正在发送…' : '支持录音或输入文字转语音'}
          </span>
        </div>

        {isRecording ? (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void finishRecord(false)} className="kid-btn kid-btn-ghost kid-btn-md flex-1">取消录音</button>
            <button type="button" onClick={() => void finishRecord(true)} className="kid-btn kid-btn-primary kid-btn-md flex-1">结束并发送</button>
          </div>
        ) : (
          <form onSubmit={handleQuickTextVoiceSend} className="flex items-center gap-2">
            <input
              type="text"
              value={textInput}
              onChange={e => setTextInput(e.target.value)}
              placeholder="输入内容或点击录音"
              className="kid-input flex-1 min-w-0"
              maxLength={120}
              disabled={recordState !== 'idle'}
            />
            {textInput.trim() ? (
              <button type="submit" disabled={recordState !== 'idle'} className="kid-btn kid-btn-primary kid-btn-md shrink-0">发送语音</button>
            ) : (
              <button type="button" disabled={recordState !== 'idle'} onClick={() => void startRecord()} className="kid-btn kid-btn-primary kid-btn-md shrink-0">
                <IconMic className="w-4 h-4" />
                <span>{recordState === 'starting' ? '开启中…' : recordState === 'sending' ? '发送中…' : '点击录音'}</span>
              </button>
            )}
          </form>
        )}
      </section>
    </div>
  );
};
