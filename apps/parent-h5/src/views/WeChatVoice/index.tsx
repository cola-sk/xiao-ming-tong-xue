'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Toast, Dialog } from 'antd-mobile';
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
    aiLogs,
    devices,
    selectedDeviceId,
    petConfig,
    autoPlayOnDevice,
    parentRole,
    sendParentVoiceMessage,
    markMessagePlayed,
    syncDevicesFromServer,
    syncMessagesFromServer,
    syncPetAiFromServer,
  } = useAppStore();

  const [activeSubTab, setActiveSubTab] = useState<'chat' | 'ai-logs'>('chat');

  useEffect(() => {
    void syncDevicesFromServer();
    void syncMessagesFromServer();
    void syncPetAiFromServer();
    const syncWhenVisible = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      void syncDevicesFromServer();
      void syncMessagesFromServer();
      void syncPetAiFromServer();
    };
    const timer = window.setInterval(syncWhenVisible, 10000);
    document.addEventListener('visibilitychange', syncWhenVisible);
    window.addEventListener('online', syncWhenVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', syncWhenVisible);
      window.removeEventListener('online', syncWhenVisible);
    };
  }, [syncDevicesFromServer, syncMessagesFromServer, syncPetAiFromServer]);

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

  const [playingId, setPlayingId] = useState<string>('');
  const [recordState, setRecordState] = useState<'idle' | 'starting' | 'recording' | 'sending'>('idle');
  const isRecording = recordState === 'recording';
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [textInput, setTextInput] = useState('');
  const currentRole = parentRole || (typeof window !== 'undefined' ? localStorage.getItem('parent_user_role') : '') || '妈妈';
  const [localCacheStats, setLocalCacheStats] = useState<{ count: number; totalBytes: number }>({
    count: 0,
    totalBytes: 0,
  });

  const chatListRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const scrollToBottom = (smooth = false) => {
    const el = chatListRef.current;
    if (!el) return;
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    isNearBottomRef.current = true;
    setShowScrollBottom(false);
  };

  const handleChatScroll = () => {
    const el = chatListRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isAtBottom = distanceToBottom <= 40;
    isNearBottomRef.current = isAtBottom;
    setShowScrollBottom(!isAtBottom && visibleMessages.length > 2);
  };

  // 当切换到亲子聊子标签页或初次加载时，自动滚动到底部显示最新消息
  useEffect(() => {
    if (activeSubTab === 'chat') {
      const timer = window.setTimeout(() => {
        scrollToBottom(false);
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [activeSubTab]);

  // 当消息列表增加时，若位于底部则保持在底部，用户向上滚动查看历史消息时不打断
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom(false);
    }
  }, [visibleMessages.length]);

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
      const recorder = await startWavRecorder({
        outputFormat: 'mp3',
        targetSampleRate: 16000,
        mp3BitrateKbps: 32,
      });
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
        senderName: currentRole,
        asrText: textInput.trim() || `（${duration}秒原声语音）`,
        durationSec: duration,
        autoPlay: autoPlayOnDevice,
        audioBlob: recording.blob,
        audioBase64: recording.base64,
        audioMime: recording.mime,
      });
      if (mountedRef.current) {
        refreshLocalStats();
        setTextInput('');
        Toast.show({ icon: 'success', content: '语音已发送，等待设备同步' });
        isNearBottomRef.current = true;
        scrollToBottom(true);
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
      senderName: currentRole,
      asrText: textInput.trim(),
      durationSec: duration,
      autoPlay: autoPlayOnDevice,
    });
    setTextInput('');
    Toast.show({
      icon: 'success',
      content: '已发送，等待设备同步',
    });
    isNearBottomRef.current = true;
    scrollToBottom(true);
    } catch {
      Toast.show({ content: '发送失败，请重试' });
    }
  };

  return (
    <div className="h-full flex-1 min-h-0 flex flex-col px-3.5 pt-2.5 pb-2 text-[#1F2937]">
      {/* 顶部设备在线与电量卡片 */}
      <div className="family-overview-card shrink-0 mb-2">
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

      </div>

      {/* 子标签页切换：亲子聊 / AI聊天记录 */}
      <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-[#EAE8E1] shrink-0 mb-2">
        <button
          type="button"
          onClick={() => setActiveSubTab('chat')}
          className={`h-8 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
            activeSubTab === 'chat'
              ? 'bg-white text-[#242620] shadow-sm'
              : 'text-[#77786F]'
          }`}
        >
          <span>亲子聊</span>
          {visibleMessages.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[#F3F1EB] text-[#55574F]">
              {visibleMessages.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('ai-logs')}
          className={`h-8 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
            activeSubTab === 'ai-logs'
              ? 'bg-white text-[#242620] shadow-sm'
              : 'text-[#77786F]'
          }`}
        >
          <span>AI聊天记录</span>
          {aiLogs.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[#F3F1EB] text-[#55574F]">
              {aiLogs.length}
            </span>
          )}
        </button>
      </div>

      {activeSubTab === 'chat' ? (
        <div className="flex-1 min-h-0 flex flex-col gap-2">
          {/* 清空本机记录与本地语音缓存统计 */}
          <div className="shrink-0 flex items-center justify-between px-1 text-[10px] text-[#929187]">
            {(visibleMessages.length > 0 || localCacheStats.count > 0) ? (
              <button
                type="button"
                onClick={clearLocalHistory}
                className="text-[#B96043] underline"
              >
                清空本机记录
              </button>
            ) : (
              <span />
            )}
            <span>
              本地语音缓存 {localCacheStats.count} 条 (
              {(localCacheStats.totalBytes / 1024).toFixed(0)} KB)
            </span>
          </div>

          {/* 双向聊天消息固定高度滚动区：自动撑高，支持向上滚动查看历史消息 */}
          <div className="flex-1 min-h-0 relative flex flex-col">
            <div
              ref={chatListRef}
              onScroll={handleChatScroll}
              className="flex-1 min-h-0 overflow-y-auto p-3 rounded-2xl bg-[#F6F5F1] border border-[#E7E5DE] space-y-3 overscroll-contain shadow-inner"
            >
              {visibleMessages.length === 0 ? (
                <div className="h-full min-h-[160px] flex items-center justify-center text-center p-6 text-xs text-[#8B8A80]">
                  暂无亲子聊记录，点击下方录音给宝贝发送语音
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

            {/* 向上滚动查看历史消息时，提供快速回到底部的悬浮按钮 */}
            {showScrollBottom && (
              <button
                type="button"
                onClick={() => scrollToBottom(true)}
                className="absolute bottom-3 right-3 z-20 px-2.5 py-1 rounded-full bg-white/95 text-[#55574F] text-[11px] font-semibold shadow-md border border-[#E5E3DC] flex items-center gap-1 hover:bg-white active:scale-95 transition-all backdrop-blur-sm"
                title="回到底部最新消息"
              >
                <span>回到底部</span>
                <span className="text-[10px]">↓</span>
              </button>
            )}
          </div>

          {/* 底部录音与快捷语音发送操作台：自动吸底 */}
          <section className="shrink-0 kid-card !p-2 bg-white/98 backdrop-blur-sm border border-[#E8E6DF] shadow-sm">
            {isRecording ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 px-2 text-[#B96043] font-bold text-xs shrink-0 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-[#B96043]" />
                  <span>录音中 {recordSeconds}s</span>
                </div>
                <button
                  type="button"
                  onClick={() => void finishRecord(false)}
                  className="kid-btn kid-btn-ghost !h-10 flex-1 justify-center text-xs"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void finishRecord(true)}
                  className="kid-btn kid-btn-primary !h-10 flex-1 justify-center text-xs"
                >
                  结束并发送
                </button>
              </div>
            ) : (
              <form onSubmit={handleQuickTextVoiceSend} className="flex items-center gap-2">
                <input
                  type="text"
                  value={textInput}
                  onChange={e => setTextInput(e.target.value)}
                  placeholder={`以「${currentRole}」身份发语音…`}
                  className="kid-input flex-1 min-w-0 !h-10 !text-xs"
                  maxLength={120}
                  disabled={recordState !== 'idle'}
                />
                {textInput.trim() ? (
                  <button
                    type="submit"
                    disabled={recordState !== 'idle'}
                    className="kid-btn kid-btn-primary !h-10 !px-4 shrink-0 font-bold text-xs"
                  >
                    发送语音
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={recordState !== 'idle'}
                    onClick={() => void startRecord()}
                    className="kid-btn kid-btn-primary !h-10 !px-3.5 shrink-0 flex items-center gap-1.5 font-bold text-xs"
                  >
                    <IconMic className="w-4 h-4" />
                    <span>
                      {recordState === 'starting'
                        ? '开启中…'
                        : recordState === 'sending'
                        ? '发送中…'
                        : '点击录音'}
                    </span>
                  </button>
                )}
              </form>
            )}
          </section>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col gap-2">
          <div className="shrink-0 flex items-center justify-end px-1 text-[11px] text-[#929187]">
            <span>共 {aiLogs.length} 轮问答</span>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto space-y-2.5 pr-0.5">
            {aiLogs.length === 0 ? (
              <div className="kid-card text-center py-8 text-xs text-[#8B8A80]">
                暂无 AI 聊天记录，孩子在设备端按住屏幕与宠物对话后将同步显示在这里
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
        </div>
      )}
    </div>
  );
};
