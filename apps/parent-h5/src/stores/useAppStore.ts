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
import { saveLocalChatAudio } from '../utils/chatAudioDb';

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

const INITIAL_DEVICES: Device[] = [];

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
    id?: string;
    speakerRole: '妈妈' | '爸爸';
    title: string;
    sampleText: string;
    sampleAudioUrl?: string;
    providerVoiceId?: string;
  }) => VoiceCloneProfile;
  deleteVoiceCloneProfile: (id: string) => void;
  syncVoiceClonesFromServer: () => Promise<void>;

  // Actions - 功能三：亲子双向微聊
  sendParentVoiceMessage: (payload: {
    senderName: string;
    asrText: string;
    durationSec: number;
    autoPlay: boolean;
    audioUrl?: string;
    audioBlob?: Blob;
    audioBase64?: string;
    audioMime?: string;
  }) => string;
  markMessagePlayed: (msgId: string) => void;
  syncMessagesFromServer: () => Promise<void>;

  // Actions - 功能二：定时语音播报
  addSchedule: (draft: Omit<VoiceSchedule, 'id' | 'familyId' | 'deviceId' | 'createdAt' | 'lastAckStatus'>) => void;
  updateSchedule: (id: string, updates: Partial<VoiceSchedule>) => void;
  toggleSchedule: (id: string) => void;
  deleteSchedule: (id: string) => void;
  syncSchedulesFromServer: () => Promise<void>;

  // Actions - 功能一：AI 宠物对话与人设配置
  updatePetConfig: (updates: Partial<PetAiConfig>) => void;
  syncPetAiFromServer: () => Promise<void>;

  // Actions - 设备与家庭管理（真实联网状态同步）
  addDevice: (deviceId: string, alias: string, childNickname: string) => Promise<void>;
  syncDevicesFromServer: () => Promise<void>;
  removeDevice: (deviceId: string) => Promise<void>;
  selectDevice: (deviceId: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      family: INITIAL_FAMILY,
      children: INITIAL_CHILDREN,
      devices: INITIAL_DEVICES,
      selectedDeviceId: '',
      messages: INITIAL_MESSAGES,
      schedules: INITIAL_SCHEDULES,
      voiceClones: INITIAL_VOICE_CLONES,
      petConfig: INITIAL_PET_CONFIG,
      aiLogs: INITIAL_AI_LOGS,

      addVoiceCloneProfile: ({ id, speakerRole, title, sampleText, sampleAudioUrl, providerVoiceId }) => {
        const state = get();
        const profile: VoiceCloneProfile = {
          id: id || `clone_${Date.now()}`,
          familyId: state.family.id,
          speakerRole,
          title: title.trim() || `${speakerRole}的克隆声音`,
          sampleText,
          sampleAudioUrl,
          providerVoiceId: providerVoiceId || `S_${speakerRole === '爸爸' ? 'dad' : 'mom'}_${Date.now()}`,
          status: 'ready',
          createdAt: new Date().toISOString(),
        };
        set(s => ({
          voiceClones: [profile, ...s.voiceClones.filter(v => v.id !== profile.id)],
        }));
        return profile;
      },

      deleteVoiceCloneProfile: id => {
        set(s => ({ voiceClones: s.voiceClones.filter(v => v.id !== id) }));
        fetch(`/api/v1/voice-clone?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
          () => {}
        );
      },

      syncVoiceClonesFromServer: async () => {
        try {
          const res = await fetch('/api/v1/voice-clone', { cache: 'no-store' });
          if (!res.ok) return;
          const data = await res.json();
          if (Array.isArray(data.profiles)) {
            set(s => ({
              voiceClones: data.profiles.map((p: any) => ({
                id: p.id,
                familyId: s.family.id,
                speakerRole: p.speakerRole === '爸爸' ? '爸爸' : '妈妈',
                title: p.title,
                sampleText: p.sampleText || '',
                providerVoiceId: p.providerVoiceId,
                status: p.status || 'ready',
                createdAt: p.createdAt,
              })),
            }));
          }
        } catch {
          // ignore
        }
      },

      sendParentVoiceMessage: ({
        senderName,
        asrText,
        durationSec,
        autoPlay,
        audioUrl,
        audioBlob,
        audioBase64,
        audioMime,
      }) => {
        const state = get();
        const id = `msg_${Date.now()}`;
        const deviceId = state.selectedDeviceId || 'default';
        const cleanText = asrText.trim() || `（${durationSec}秒原声语音）`;
        const remoteAudioUrl = audioBase64 ? `/api/v1/chat/messages/${id}/audio` : '';
        const newMsg: ChatVoiceMessage = {
          id,
          familyId: state.family.id,
          deviceId,
          childId: state.children[0]?.id,
          direction: 'parent_to_device',
          senderName: senderName || '妈妈',
          audioUrl: audioUrl || remoteAudioUrl,
          durationSec: Math.max(1, durationSec),
          asrText: cleanText,
          autoPlay,
          status: 'unread',
          createdAt: new Date().toISOString(),
        };
        set(s => ({ messages: [...s.messages, newMsg] }));
        if (audioBlob) {
          void saveLocalChatAudio(id, audioBlob);
        }
        fetch('/api/v1/chat/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            deviceId,
            direction: 'parent_to_device',
            senderName: newMsg.senderName,
            durationSec: newMsg.durationSec,
            asrText: cleanText,
            autoPlay,
            audioBase64,
            audioMime,
          }),
        }).catch(() => {});
        return id;
      },

      markMessagePlayed: msgId => {
        set(s => ({
          messages: s.messages.map(m => (m.id === msgId ? { ...m, status: 'played' } : m)),
        }));
        fetch('/api/v1/chat/messages', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: msgId }),
        }).catch(() => {});
      },

      syncMessagesFromServer: async () => {
        try {
          const deviceId = get().selectedDeviceId || 'all';
          const res = await fetch(
            `/api/v1/chat/messages?deviceId=${encodeURIComponent(deviceId)}`,
            { cache: 'no-store' }
          );
          if (!res.ok) return;
          const data = await res.json();
          if (Array.isArray(data.messages)) {
            set(s => ({
              messages: data.messages.map((m: any) => {
                const existing = s.messages.find(local => local.id === m.id);
                return {
                  id: m.id,
                  familyId: s.family.id,
                  deviceId: m.deviceId,
                  childId: s.children[0]?.id,
                  direction: m.direction,
                  senderName: m.senderName,
                  audioUrl: existing?.audioUrl || m.audioUrl || '',
                  durationSec: m.durationSec,
                  asrText: m.asrText,
                  autoPlay: Boolean(m.autoPlay),
                  status: m.status,
                  createdAt: m.createdAt,
                };
              }),
            }));
          }
        } catch {
          // ignore
        }
      },

      addSchedule: draft => {
        const state = get();
        const id = `sched_${Date.now()}`;
        const deviceId = state.selectedDeviceId || 'default';
        const newSched: VoiceSchedule = {
          ...draft,
          id,
          familyId: state.family.id,
          deviceId,
          childId: state.children[0]?.id,
          lastAckStatus: 'idle',
          lastAckAt: null,
          createdAt: new Date().toISOString(),
        };
        set(s => ({ schedules: [newSched, ...s.schedules] }));
        fetch('/api/v1/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newSched),
        }).catch(() => {});
      },

      updateSchedule: (id, updates) => {
        let merged: VoiceSchedule | undefined;
        set(s => ({
          schedules: s.schedules.map(item => {
            if (item.id === id) {
              merged = { ...item, ...updates, updatedAt: new Date().toISOString() };
              return merged;
            }
            return item;
          }),
        }));
        if (merged) {
          fetch('/api/v1/schedules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(merged),
          }).catch(() => {});
        }
      },

      toggleSchedule: id => {
        let nextEnabled: boolean | undefined;
        set(s => ({
          schedules: s.schedules.map(item => {
            if (item.id === id) {
              nextEnabled = !item.enabled;
              return { ...item, enabled: nextEnabled };
            }
            return item;
          }),
        }));
        fetch('/api/v1/schedules', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, enabled: nextEnabled }),
        }).catch(() => {});
      },

      deleteSchedule: id => {
        set(s => ({
          schedules: s.schedules.filter(item => item.id !== id),
        }));
        fetch(`/api/v1/schedules?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
          () => {}
        );
      },

      syncSchedulesFromServer: async () => {
        try {
          const deviceId = get().selectedDeviceId || 'all';
          const res = await fetch(
            `/api/v1/schedules?deviceId=${encodeURIComponent(deviceId)}`,
            { cache: 'no-store' }
          );
          if (!res.ok) return;
          const data = await res.json();
          if (Array.isArray(data.schedules)) {
            set(s => ({
              schedules: data.schedules.map((rs: any) => ({
                ...rs,
                familyId: s.family.id,
                childId: s.children[0]?.id,
              })),
            }));
          }
        } catch {
          // ignore
        }
      },

      updatePetConfig: updates => {
        const state = get();
        const deviceId = state.selectedDeviceId || 'default';
        const nextConfig = {
          ...state.petConfig,
          ...updates,
          updatedAt: new Date().toISOString(),
        };
        set({ petConfig: nextConfig });
        fetch('/api/v1/pet-ai', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId,
            petName: nextConfig.petName,
            personaId: nextConfig.personaId,
            voiceId: nextConfig.voiceId,
            customPrompt: nextConfig.customPrompt,
            volumeLevel: nextConfig.volumeLevel,
          }),
        }).catch(() => {});
      },

      syncPetAiFromServer: async () => {
        try {
          const deviceId = get().selectedDeviceId || 'default';
          const res = await fetch(
            `/api/v1/pet-ai?deviceId=${encodeURIComponent(deviceId)}`,
            { cache: 'no-store' }
          );
          if (!res.ok) return;
          const data = await res.json();
          set(s => ({
            petConfig: data.config
              ? {
                  ...s.petConfig,
                  petName: data.config.petName || s.petConfig.petName,
                  personaId: data.config.personaId || s.petConfig.personaId,
                  voiceId: data.config.voiceId || s.petConfig.voiceId,
                  customPrompt: data.config.customPrompt || s.petConfig.customPrompt,
                  volumeLevel: data.config.volumeLevel ?? s.petConfig.volumeLevel,
                  updatedAt: data.config.updatedAt || s.petConfig.updatedAt,
                }
              : s.petConfig,
            aiLogs: Array.isArray(data.logs) ? data.logs : s.aiLogs,
          }));
        } catch {
          // ignore
        }
      },

      addDevice: async (deviceIdInput, alias, childNickname) => {
        const state = get();
        const deviceId = deviceIdInput.trim();
        if (!deviceId) throw new Error('请输入设备 ID');

        const res = await fetch('/api/v1/device/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'bind',
            deviceId,
            alias: alias.trim() || `${childNickname.trim() || '宝贝'}的小铭同学`,
            childNickname: childNickname.trim() || '宝贝',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || '设备绑定失败');
        }

        const remoteDev = data.device;
        const childId = `child-${Date.now()}`;
        const newChild: Child = {
          id: childId,
          familyId: state.family.id,
          nickname: remoteDev?.childNickname || childNickname.trim() || '宝贝',
        };
        const newDevice: Device = {
          id: remoteDev?.id || deviceId,
          familyId: state.family.id,
          childId,
          alias: remoteDev?.alias || alias.trim() || `${newChild.nickname}的小铭同学`,
          deviceModel: remoteDev?.deviceModel || 'Waveshare ESP32-S3-Touch-AMOLED-2.16',
          macAddress: remoteDev?.macAddress || '',
          status: 'paired',
          firmwareVersion: remoteDev?.firmwareVersion || '1.0.0',
          batteryPercent: Number(remoteDev?.batteryPercent ?? 0),
          isOnline: Boolean(remoteDev?.isOnline),
          lastSeenAt: remoteDev?.lastSeenAt || null,
        };
        set(s => ({
          children: [...s.children, newChild],
          devices: [
            ...s.devices.filter(d => d.id !== newDevice.id),
            newDevice,
          ],
          selectedDeviceId: newDevice.id,
        }));
      },

      syncDevicesFromServer: async () => {
        try {
          const res = await fetch('/api/v1/device/status', { cache: 'no-store' });
          if (!res.ok) return;
          const data = await res.json();
          if (!Array.isArray(data.devices)) return;

          set(s => {
            const mappedDevices: Device[] = data.devices.map((rd: any) => {
              const existing = s.devices.find(d => d.id === rd.id);
              return {
                id: rd.id,
                familyId: s.family.id,
                childId: existing?.childId || s.children[0]?.id || 'child-001',
                alias: rd.alias || existing?.alias || '小铭同学',
                deviceModel: rd.deviceModel || 'Waveshare ESP32-S3-Touch-AMOLED-2.16',
                macAddress: rd.macAddress || '',
                status: 'paired',
                firmwareVersion: rd.firmwareVersion || '1.0.0',
                batteryPercent: Number(rd.batteryPercent ?? 0),
                isOnline: Boolean(rd.isOnline),
                lastSeenAt: rd.lastSeenAt || null,
              };
            });
            const nextSelected =
              mappedDevices.some(d => d.id === s.selectedDeviceId)
                ? s.selectedDeviceId
                : mappedDevices[0]?.id || '';
            return {
              devices: mappedDevices,
              selectedDeviceId: nextSelected,
            };
          });
        } catch {
          // 忽略网络瞬断
        }
      },

      removeDevice: async deviceId => {
        await fetch(`/api/v1/device/status?deviceId=${encodeURIComponent(deviceId)}`, {
          method: 'DELETE',
        });
        set(s => {
          const remaining = s.devices.filter(d => d.id !== deviceId);
          return {
            devices: remaining,
            selectedDeviceId:
              s.selectedDeviceId === deviceId ? remaining[0]?.id || '' : s.selectedDeviceId,
          };
        });
      },

      selectDevice: deviceId => {
        set({ selectedDeviceId: deviceId });
      },
    }),
    {
      name: 'xiaoming_pet_parent_store_v2',
      version: 7,
      migrate: (persistedState: any) => {
        if (!persistedState) return persistedState;
        // 自动清理旧本地缓存中的测试/演示假数据
        if (Array.isArray(persistedState.devices)) {
          persistedState.devices = persistedState.devices.filter(
            (d: any) => d.id !== 'esp32_pet_001'
          );
          if (persistedState.selectedDeviceId === 'esp32_pet_001') {
            persistedState.selectedDeviceId = persistedState.devices[0]?.id || '';
          }
        }
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
