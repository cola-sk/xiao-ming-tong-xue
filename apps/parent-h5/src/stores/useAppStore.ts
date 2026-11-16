import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  Family,
  Child,
  Device,
  VoiceSchedule,
  ChatVoiceMessage,
  PetAiConfig,
  AiChatLog,
  VoiceCloneProfile,
  PET_PERSONAS,
} from '../services/types';

const INITIAL_FAMILY: Family = {
  id: 'fam-001',
  name: '小铭同学成长空间',
  timezone: 'Asia/Shanghai',
  createdAt: '2026-11-16T08:00:00Z',
};

const INITIAL_CHILDREN: Child[] = [
  {
    id: 'child-001',
    familyId: 'fam-001',
    nickname: '堂堂',
  },
];

const INITIAL_DEVICES: Device[] = [
  {
    id: 'esp32_pet_001',
    familyId: 'fam-001',
    childId: 'child-001',
    alias: '堂堂的小铭同学',
    deviceModel: 'Waveshare ESP32-S3-Touch-AMOLED-2.16',
    macAddress: '34:85:18:A2:B9:01',
    status: 'paired',
    firmwareVersion: '1.0.0-box',
    batteryPercent: 88,
    isOnline: true,
    lastSeenAt: new Date().toISOString(),
  },
];

const INITIAL_MESSAGES: ChatVoiceMessage[] = [
  {
    id: 'msg-001',
    familyId: 'fam-001',
    deviceId: 'esp32_pet_001',
    childId: 'child-001',
    direction: 'parent_to_device',
    senderName: '妈妈',
    audioUrl: 'mock://parent-hello.mp3',
    durationSec: 4,
    asrText: '宝贝，放学回家先喝口温水，妈妈六点半到家哦！',
    autoPlay: false,
    status: 'played',
    createdAt: new Date(Date.now() - 3600 * 1000).toISOString(),
  },
  {
    id: 'msg-002',
    familyId: 'fam-001',
    deviceId: 'esp32_pet_001',
    childId: 'child-001',
    direction: 'device_to_parent',
    senderName: '堂堂',
    audioUrl: 'mock://child-reply.mp3',
    durationSec: 5,
    asrText: '妈妈我知道啦！我正在跟小铭同学聊恐龙的故事呢，等你回来！',
    autoPlay: false,
    status: 'unread',
    createdAt: new Date(Date.now() - 1200 * 1000).toISOString(),
  },
];

const INITIAL_VOICE_CLONES: VoiceCloneProfile[] = [
  {
    id: 'clone-mom-001',
    familyId: 'fam-001',
    speakerRole: '妈妈',
    title: '妈妈的温柔声音（豆包 2.0 小何）',
    sampleText: '堂堂、正正，我是妈妈，不管什么时候妈妈都最爱你们哦！',
    providerVoiceId: 'zh_female_xiaohe_uranus_bigtts',
    status: 'ready',
    createdAt: '2026-11-16T07:00:00Z',
  },
  {
    id: 'clone-dad-001',
    familyId: 'fam-001',
    speakerRole: '爸爸',
    title: '爸爸的鼓励声音（豆包 2.0 云舟）',
    sampleText: '堂堂、正正，我是爸爸，遇到不懂的问题勇敢探索哦！',
    providerVoiceId: 'zh_male_m191_uranus_bigtts',
    status: 'ready',
    createdAt: '2026-11-16T07:05:00Z',
  },
];

const INITIAL_SCHEDULES: VoiceSchedule[] = [
  {
    id: 'sched-001',
    familyId: 'fam-001',
    deviceId: 'esp32_pet_001',
    childId: 'child-001',
    title: '早上起床唤醒',
    cronExpr: '30 7 * * 1,2,3,4,5',
    timeStr: '07:30',
    repeatDays: [1, 2, 3, 4, 5],
    enabled: true,
    sourceType: 'parent_clone',
    clonedVoiceId: 'clone-mom-001',
    clonedSpeakerRole: '妈妈（克隆音色）',
    textContent: '太阳晒屁股啦！快起床穿衣服，妈妈给你准备了好吃的早餐哦！',
    repeatPlayCount: 2,
    lastAckStatus: 'confirmed',
    lastAckAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    createdAt: '2026-11-16T07:00:00Z',
  },
  {
    id: 'sched-002',
    familyId: 'fam-001',
    deviceId: 'esp32_pet_001',
    childId: 'child-001',
    title: '晚上刷牙睡觉提醒',
    cronExpr: '30 20 * * 1,2,3,4,5,6,7',
    timeStr: '20:30',
    repeatDays: [1, 2, 3, 4, 5, 6, 7],
    enabled: true,
    sourceType: 'tts',
    textContent: '宝贝，八点半啦，快去刷牙洗脸，小铭同学要在被窝里给你讲故事啦！',
    repeatPlayCount: 2,
    lastAckStatus: 'idle',
    lastAckAt: null,
    createdAt: '2026-11-16T08:00:00Z',
  },
];

const INITIAL_PET_CONFIG: PetAiConfig = {
  id: 'pet-cfg-001',
  familyId: 'fam-001',
  deviceId: 'esp32_pet_001',
  childId: 'child-001',
  petName: '小铭同学',
  personaId: PET_PERSONAS[0].id,
  voiceId: PET_PERSONAS[0].voiceId,
  customPrompt: PET_PERSONAS[0].systemPrompt,
  volumeLevel: 80,
  batteryPercent: 88,
  isOnline: true,
  lastSeenAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const INITIAL_AI_LOGS: AiChatLog[] = [
  {
    id: 'log-001',
    deviceId: 'esp32_pet_001',
    childText: '小铭同学，为什么霸王龙的手那么短呀？',
    petReplyText: '哈哈！因为霸王龙的大嘴巴咬合力超级强，不需要长手臂抓猎物，短小的前肢还能帮它减轻体重跑得更快呢！',
    createdAt: new Date(Date.now() - 1800 * 1000).toISOString(),
  },
  {
    id: 'log-002',
    deviceId: 'esp32_pet_001',
    childText: '我今天在学校得到了小红花！',
    petReplyText: '哇！你太棒啦！小铭同学为你骄傲，快摇摇我的小脑袋一起庆祝一下吧！',
    createdAt: new Date(Date.now() - 900 * 1000).toISOString(),
  },
];

interface AppState {
  family: Family;
  children: Child[];
  devices: Device[];
  selectedDeviceId: string;
  messages: ChatVoiceMessage[];
  schedules: VoiceSchedule[];
  voiceClones: VoiceCloneProfile[];
  petConfig: PetAiConfig;
  aiLogs: AiChatLog[];
  activeRingingScheduleId: string | null;

  // Actions - 爸妈声音克隆
  addVoiceCloneProfile: (payload: {
    speakerRole: '妈妈' | '爸爸';
    title: string;
    sampleText: string;
    sampleAudioUrl?: string;
    providerVoiceId?: string;
  }) => VoiceCloneProfile;
  deleteVoiceCloneProfile: (id: string) => void;

  // Actions - 功能三：亲子双向微聊
  sendParentVoiceMessage: (payload: {
    senderName: string;
    asrText: string;
    durationSec: number;
    autoPlay: boolean;
    audioUrl?: string;
  }) => void;
  sendDeviceVoiceMessage: (payload: {
    asrText: string;
    durationSec: number;
    audioUrl?: string;
  }) => void;
  markMessagePlayed: (msgId: string) => void;

  // Actions - 功能二：定时语音播报
  addSchedule: (draft: Omit<VoiceSchedule, 'id' | 'familyId' | 'deviceId' | 'createdAt' | 'lastAckStatus'>) => void;
  updateSchedule: (id: string, updates: Partial<VoiceSchedule>) => void;
  toggleSchedule: (id: string) => void;
  deleteSchedule: (id: string) => void;
  triggerScheduleRing: (id: string) => void;
  acknowledgeScheduleOnDevice: (id: string) => void;

  // Actions - 功能一：AI 宠物对话与人设配置
  updatePetConfig: (updates: Partial<PetAiConfig>) => void;
  simulateAiDialogue: (childQuestion: string) => Promise<{ log: AiChatLog; ephemeralAudioDataUrl?: string }>;

  // Actions - 设备与家庭管理
  addDevice: (alias: string, childNickname: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      family: INITIAL_FAMILY,
      children: INITIAL_CHILDREN,
      devices: INITIAL_DEVICES,
      selectedDeviceId: INITIAL_DEVICES[0].id,
      messages: INITIAL_MESSAGES,
      schedules: INITIAL_SCHEDULES,
      voiceClones: INITIAL_VOICE_CLONES,
      petConfig: INITIAL_PET_CONFIG,
      aiLogs: INITIAL_AI_LOGS,
      activeRingingScheduleId: null,

      addVoiceCloneProfile: ({ speakerRole, title, sampleText, sampleAudioUrl, providerVoiceId }) => {
        const state = get();
        const profile: VoiceCloneProfile = {
          id: `clone-${Date.now()}`,
          familyId: state.family.id,
          speakerRole,
          title: title.trim() || `${speakerRole}的克隆声音`,
          sampleText,
          sampleAudioUrl,
          providerVoiceId: providerVoiceId || `cosyvoice_clone_${speakerRole}_${Date.now()}`,
          status: 'ready',
          createdAt: new Date().toISOString(),
        };
        set(s => ({ voiceClones: [profile, ...s.voiceClones] }));
        return profile;
      },

      deleteVoiceCloneProfile: id => {
        set(s => ({ voiceClones: s.voiceClones.filter(v => v.id !== id) }));
      },

      sendParentVoiceMessage: ({ senderName, asrText, durationSec, autoPlay, audioUrl }) => {
        const state = get();
        const newMsg: ChatVoiceMessage = {
          id: `msg-${Date.now()}`,
          familyId: state.family.id,
          deviceId: state.selectedDeviceId,
          childId: state.children[0]?.id,
          direction: 'parent_to_device',
          senderName: senderName || '妈妈',
          audioUrl: audioUrl || 'mock://parent-voice.webm',
          durationSec: Math.max(1, durationSec),
          asrText: asrText.trim() || '（语音消息）',
          autoPlay,
          status: autoPlay ? 'played' : 'unread',
          createdAt: new Date().toISOString(),
        };
        set(s => ({ messages: [...s.messages, newMsg] }));
      },

      sendDeviceVoiceMessage: ({ asrText, durationSec, audioUrl }) => {
        const state = get();
        const childName = state.children[0]?.nickname || '宝贝';
        const newMsg: ChatVoiceMessage = {
          id: `msg-${Date.now()}`,
          familyId: state.family.id,
          deviceId: state.selectedDeviceId,
          childId: state.children[0]?.id,
          direction: 'device_to_parent',
          senderName: childName,
          audioUrl: audioUrl || 'mock://device-voice.webm',
          durationSec: Math.max(1, durationSec),
          asrText: asrText.trim() || '妈妈，我想你啦，你什么时候回来呀？',
          autoPlay: false,
          status: 'unread',
          createdAt: new Date().toISOString(),
        };
        set(s => ({ messages: [...s.messages, newMsg] }));
      },

      markMessagePlayed: msgId => {
        set(s => ({
          messages: s.messages.map(m => (m.id === msgId ? { ...m, status: 'played' } : m)),
        }));
      },

      addSchedule: draft => {
        const state = get();
        const newSched: VoiceSchedule = {
          ...draft,
          id: `sched-${Date.now()}`,
          familyId: state.family.id,
          deviceId: state.selectedDeviceId,
          childId: state.children[0]?.id,
          lastAckStatus: 'idle',
          lastAckAt: null,
          createdAt: new Date().toISOString(),
        };
        set(s => ({ schedules: [newSched, ...s.schedules] }));
      },

      updateSchedule: (id, updates) => {
        set(s => ({
          schedules: s.schedules.map(item =>
            item.id === id ? { ...item, ...updates, updatedAt: new Date().toISOString() } : item
          ),
        }));
      },

      toggleSchedule: id => {
        set(s => ({
          schedules: s.schedules.map(item =>
            item.id === id ? { ...item, enabled: !item.enabled } : item
          ),
        }));
      },

      deleteSchedule: id => {
        set(s => ({
          schedules: s.schedules.filter(item => item.id !== id),
          activeRingingScheduleId: s.activeRingingScheduleId === id ? null : s.activeRingingScheduleId,
        }));
      },

      triggerScheduleRing: id => {
        set(s => ({
          activeRingingScheduleId: id,
          schedules: s.schedules.map(item =>
            item.id === id ? { ...item, lastAckStatus: 'ringing' } : item
          ),
        }));
      },

      acknowledgeScheduleOnDevice: id => {
        const now = new Date().toISOString();
        set(s => ({
          activeRingingScheduleId: s.activeRingingScheduleId === id ? null : s.activeRingingScheduleId,
          schedules: s.schedules.map(item =>
            item.id === id ? { ...item, lastAckStatus: 'confirmed', lastAckAt: now } : item
          ),
        }));
      },

      updatePetConfig: updates => {
        set(s => ({
          petConfig: {
            ...s.petConfig,
            ...updates,
            updatedAt: new Date().toISOString(),
          },
        }));
      },

      simulateAiDialogue: async childQuestion => {
        const { petConfig, selectedDeviceId } = get();
        const q = childQuestion.trim() || '今天天气真好，我们玩什么呀？';
        let reply = '';
        let ephemeralAudioDataUrl: string | undefined;
        try {
          const res = await fetch('/api/v1/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question: q,
              petName: petConfig.petName,
              personaId: petConfig.personaId,
              voiceType: petConfig.voiceId,
              systemPrompt: petConfig.customPrompt,
            }),
          });
          const data = await res.json();
          if (data?.reply) reply = data.reply;
          if (data?.audioDataUrl) {
            ephemeralAudioDataUrl = data.audioDataUrl;
          }
        } catch {
          // Fallback when offline
        }
        if (!reply) {
          reply = `哈哈！我是${petConfig.petName}，听到你的声音太开心啦！我们一起加油出发吧！`;
        }
        // AI 问答仅保留文字记录，不持久化存储合成音频
        const newLog: AiChatLog = {
          id: `log-${Date.now()}`,
          deviceId: selectedDeviceId,
          childText: q,
          petReplyText: reply,
          createdAt: new Date().toISOString(),
        };
        set(s => ({ aiLogs: [newLog, ...s.aiLogs] }));
        return { log: newLog, ephemeralAudioDataUrl };
      },

      addDevice: (alias, childNickname) => {
        const state = get();
        const childId = `child-${Date.now()}`;
        const deviceId = `esp32_pet_${Date.now().toString().slice(-4)}`;
        const newChild: Child = {
          id: childId,
          familyId: state.family.id,
          nickname: childNickname.trim() || '宝贝',
        };
        const newDevice: Device = {
          id: deviceId,
          familyId: state.family.id,
          childId,
          alias: alias.trim() || `${newChild.nickname}的小铭同学`,
          deviceModel: 'Waveshare ESP32-S3-Touch-AMOLED-2.16',
          macAddress: '34:85:18:C4:E1:88',
          status: 'paired',
          firmwareVersion: '1.0.0-box',
          batteryPercent: 100,
          isOnline: true,
          lastSeenAt: new Date().toISOString(),
        };
        set(s => ({
          children: [...s.children, newChild],
          devices: [...s.devices, newDevice],
          selectedDeviceId: deviceId,
        }));
      },
    }),
    {
      name: 'xiaoming_pet_parent_store_v2',
      version: 4,
      partialize: s => ({
        family: s.family,
        children: s.children,
        devices: s.devices,
        selectedDeviceId: s.selectedDeviceId,
        // 亲子微聊消息持久化时剔除临时音频 Blob/Base64，只保留文字与状态，不保存聊天音频文件
        messages: s.messages.map(m => ({ ...m, audioUrl: '' })),
        schedules: s.schedules,
        voiceClones: s.voiceClones,
        petConfig: s.petConfig,
        aiLogs: s.aiLogs,
      }),
    }
  )
);
