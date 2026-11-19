'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Toast } from 'antd-mobile';
import { useAppStore } from '../../stores/useAppStore';
import { ChatVoiceMessage } from '../../services/types';
import { IconMic, IconVolume, IconBattery, IconWifi } from '../../components/Icons';
import { playAudioOrFallback, requestDoubaoTtsAudio } from '../../utils/voiceSynth';
import { startWavRecorder, WavRecorderHandle } from '../../utils/wavRecorder';
import {
  saveLocalChatAudio,
  getLocalChatAudioUrl,
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

  const currentDevice = devices.find(d => d.id === selectedDeviceId) || devices[0];
  const visibleMessages = messages;

  const [playingId, setPlayingId] = useState<string>('');
  const [recordState, setRecordState] = useState<'idle' | 'starting' | 'recording' | 'sending'>('idle');
  const isRecording = recordState === 'recording';
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [textInput, setTextInput] = useState('');
  const currentRole = parentRole || (typeof window !== 'undefined' ? localStorage.getItem('parent_user_role') : '') || '妈妈';

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
    <div className="h-full flex-1 min-h-0 flex flex-col px-3.5 pt-2.5 pb-2.5 text-[#1F2937]">
      {/* 顶部设备在线与电量卡片（去边框轻量化） */}
      <div className="shrink-0 mb-2.5 rounded-2xl bg-white/90 px-3.5 py-2.5 shadow-[0_1px_4px_rgba(36,38,32,0.04)]">
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
      <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[#EAE8E1]/75 shrink-0 mb-2">
        <button
          type="button"
          onClick={() => setActiveSubTab('chat')}
          className={`h-8 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
            activeSubTab === 'chat'
              ? 'bg-white text-[#242620] shadow-[0_1px_3px_rgba(36,38,32,0.06)]'
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
              ? 'bg-white text-[#242620] shadow-[0_1px_3px_rgba(36,38,32,0.06)]'
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
        <div className="flex-1 min-h-0 flex flex-col">
          {/* 双向聊天消息区：微信风格纯白画布，自动撑高，支持向上滚动查看历史消息 */}
          <div className="flex-1 min-h-0 relative flex flex-col">
            <div
              ref={chatListRef}
              onScroll={handleChatScroll}
              className="flex-1 min-h-0 overflow-y-auto px-3.5 py-3 rounded-2xl bg-white space-y-3.5 overscroll-contain"
            >
              {visibleMessages.length === 0 ? (
                <div className="h-full min-h-[160px] flex items-center justify-center text-center p-6 text-xs text-[#929187]">
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
                      <div className="flex items-center gap-1.5 mb-1 px-1.5">
                        <span className="text-[11px] font-medium text-[#888888]">{msg.senderName}</span>
                        <span className="text-[10px] text-[#B2B2B2]">
                          {new Date(msg.createdAt).toLocaleTimeString('zh-CN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        {isParent && (
                          <span className="text-[10px] text-[#B2B2B2]">
                            · {msg.autoPlay ? '直接播报' : msg.status === 'played' ? '已听' : '待听'}
                          </span>
                        )}
                      </div>

                      {/* 微信风格语音气泡：对方浅灰 #EDEDED、自己微信绿 #95EC69、6px圆角与侧边小尖角 */}
                      <div className={`relative max-w-[80%] ${isParent ? 'mr-1.5' : 'ml-1.5'}`}>
                        <span
                          aria-hidden="true"
                          className={`pointer-events-none absolute top-[13px] w-2.5 h-2.5 rotate-45 rounded-[1px] ${
                            isParent
                              ? '-right-[4px] bg-[#95EC69]'
                              : '-left-[4px] bg-[#EDEDED]'
                          }`}
                        />
                        <button
                          type="button"
                          onClick={() => handlePlayBubble(msg)}
                          className={`relative z-10 w-full text-left rounded-[6px] px-3 py-2 transition-opacity active:opacity-85 ${
                            isParent
                              ? 'bg-[#95EC69] text-[#191919]'
                              : 'bg-[#EDEDED] text-[#191919]'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-4">
                            <div className="inline-flex items-center gap-2">
                              <IconVolume
                                className={`w-4 h-4 ${isPlaying ? 'animate-pulse' : ''}`}
                              />
                              <span className="font-medium text-xs">
                                {isPlaying ? '正在播放…' : `${msg.durationSec}" 语音消息`}
                              </span>
                            </div>
                          </div>

                          {msg.asrText && (
                            <p className="mt-1 text-xs leading-relaxed text-[#191919]/75">
                              {msg.asrText}
                            </p>
                          )}
                        </button>

                        {/* 未读小红点 */}
                        {!isParent && isUnread && (
                          <span
                            className="
                              absolute -top-1 -right-1 z-20 w-2.5 h-2.5 rounded-full bg-[#FA5151]
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
                className="absolute bottom-3 right-3 z-20 px-3 py-1 rounded-full bg-white/95 text-[#55574F] text-[11px] font-semibold shadow-[0_2px_10px_rgba(36,38,32,0.12)] flex items-center gap-1 hover:bg-white active:scale-95 transition-all backdrop-blur-sm"
                title="回到底部最新消息"
              >
                <span>回到底部</span>
                <span className="text-[10px]">↓</span>
              </button>
            )}
          </div>

          {/* 底部录音与快捷语音发送操作台：去外层卡片边框，胶囊化吸底 */}
          <div className="shrink-0 pt-2">
            {isRecording ? (
              <div className="flex items-center gap-2 rounded-full bg-white p-1.5 pl-3 shadow-[0_2px_8px_rgba(36,38,32,0.06)]">
                <div className="flex items-center gap-1.5 text-[#B96043] font-bold text-xs shrink-0 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-[#B96043]" />
                  <span>录音中 {recordSeconds}s</span>
                </div>
                <button
                  type="button"
                  onClick={() => void finishRecord(false)}
                  className="h-9 px-3.5 rounded-full bg-[#F3F1EB] text-[#55574F] font-semibold text-xs flex-1"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void finishRecord(true)}
                  className="h-9 px-4 rounded-full bg-[#B96043] text-white font-bold text-xs flex-1"
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
                  className="flex-1 min-w-0 h-10 px-4 rounded-full bg-white text-xs text-[#242620] placeholder:text-[#A19F95] shadow-[0_1px_4px_rgba(36,38,32,0.06)] focus:outline-none focus:ring-2 focus:ring-[#B96043]/25 transition-all"
                  maxLength={120}
                  disabled={recordState !== 'idle'}
                />
                {textInput.trim() ? (
                  <button
                    type="submit"
                    disabled={recordState !== 'idle'}
                    className="h-10 px-4 rounded-full bg-[#B96043] text-white shrink-0 font-bold text-xs shadow-[0_2px_8px_rgba(185,96,67,0.22)] active:scale-95 transition-all"
                  >
                    发送
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={recordState !== 'idle'}
                    onClick={() => void startRecord()}
                    className="h-10 px-4 rounded-full bg-[#B96043] text-white shrink-0 flex items-center gap-1.5 font-bold text-xs shadow-[0_2px_8px_rgba(185,96,67,0.22)] active:scale-95 transition-all"
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
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col gap-2">
          <div className="shrink-0 flex items-center justify-end px-1 text-[11px] text-[#929187]">
            <span>共 {aiLogs.length} 轮问答</span>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto space-y-2.5 pr-0.5">
            {aiLogs.length === 0 ? (
              <div className="rounded-2xl bg-white/90 text-center py-8 text-xs text-[#8B8A80] shadow-[0_1px_4px_rgba(36,38,32,0.04)]">
                暂无 AI 聊天记录，孩子在设备端按住屏幕与宠物对话后将同步显示在这里
              </div>
            ) : (
              aiLogs.map(log => (
                <div key={log.id} className="rounded-2xl bg-white p-3.5 space-y-2 shadow-[0_1px_4px_rgba(36,38,32,0.04)]">
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
                  <div className="rounded-xl bg-[#F5F7F5] px-3 py-2 flex items-start justify-between gap-2">
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
                      className="h-6 px-2 rounded-full bg-white text-[#4C7866] text-[11px] font-semibold shrink-0 inline-flex items-center gap-1 shadow-sm"
                    >
                      <IconVolume className="w-3 h-3" />
                      <span>试听</span>
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
