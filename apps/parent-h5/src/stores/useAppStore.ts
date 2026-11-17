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

const INITIAL_MESSAGES: ChatVoiceMessage[] = [];

const INITIAL_VOICE_CLONES: VoiceCloneProfile[] = [];

const INITIAL_SCHEDULES: VoiceSchedule[] = [];

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

const INITIAL_AI_LOGS: AiChatLog[] = [];

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

  // Actions - 功能一：AI 宠物对话与人设配置
  updatePetConfig: (updates: Partial<PetAiConfig>) => void;

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
      version: 6,
      migrate: (persistedState: any) => {
        if (!persistedState) return persistedState;
        // 自动清理旧本地缓存中的测试/演示假数据
        if (Array.isArray(persistedState.voiceClones)) {
          persistedState.voiceClones = persistedState.voiceClones.filter(
            (vc: any) =>
              vc.providerVoiceId !== 'zh_female_xiaohe_uranus_bigtts' &&
              vc.providerVoiceId !== 'zh_male_m191_uranus_bigtts'
          );
        }
        if (Array.isArray(persistedState.messages)) {
          persistedState.messages = persistedState.messages.filter(
            (m: any) => m.id !== 'msg-001' && m.id !== 'msg-002'
          );
        }
        if (Array.isArray(persistedState.aiLogs)) {
          persistedState.aiLogs = persistedState.aiLogs.filter(
            (l: any) => l.id !== 'log-001' && l.id !== 'log-002'
          );
        }
        if (Array.isArray(persistedState.schedules)) {
          persistedState.schedules = persistedState.schedules.filter(
            (s: any) => s.id !== 'sched-001' && s.id !== 'sched-002'
          );
        }
        return persistedState;
      },
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
