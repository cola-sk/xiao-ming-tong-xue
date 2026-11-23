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

let deviceGeneration = 0;

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
  configDeviceId: string;
  messagesDeviceId: string;
  schedulesDeviceId: string;
  unreadCounts: Record<string, number>;
  syncUnreadCounts: () => Promise<void>;
  setAutoPlayOnDevice: (enabled: boolean) => Promise<void>;
  parentRole: string;
  setParentRole: (role: string) => void;

  // Actions - 爸妈声音克隆
  addVoiceCloneProfile: (payload: {
    id?: string;
    speakerRole: string;
    title: string;
    sampleText: string;
    sampleAudioUrl?: string;
    providerVoiceId: string;
    status?: VoiceCloneProfile['status'];
  }) => VoiceCloneProfile;
  deleteVoiceCloneProfile: (id: string) => Promise<void>;
  syncVoiceClonesFromServer: () => Promise<void>;

  // Actions - 功能三：亲子双向微聊
  sendParentVoiceMessage: (payload: {
    deviceId: string;
    senderName: string;
    asrText: string;
    durationSec: number;
    autoPlay: boolean;
    audioUrl?: string;
    audioBlob?: Blob;
    audioBase64?: string;
    audioMime?: string;
  }) => Promise<string>;
  markMessagePlayed: (msgId: string) => Promise<void>;
  syncMessagesFromServer: () => Promise<void>;

  // Actions - 功能二：定时语音播报
  addSchedule: (draft: Omit<VoiceSchedule, 'id' | 'familyId' | 'deviceId' | 'createdAt' | 'lastAckStatus'>, deviceId: string) => Promise<void>;
  updateSchedule: (id: string, updates: Partial<VoiceSchedule>) => Promise<void>;
  toggleSchedule: (id: string) => void;
  deleteSchedule: (id: string) => void;
  syncSchedulesFromServer: () => Promise<void>;

  // Actions - 功能一：AI 宠物对话与人设配置
  updatePetConfig: (updates: Partial<PetAiConfig>) => void;
  syncPetAiFromServer: () => Promise<void>;

  // Actions - 设备与家庭管理（真实联网状态同步）
  addDevice: (pairingCode: string, alias: string, childNickname: string) => Promise<void>;
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
      configDeviceId: '', messagesDeviceId: '', schedulesDeviceId: '',
      unreadCounts: {},
      syncUnreadCounts: async () => {
        try {
          const res = await fetch('/api/v1/chat/messages?summary=unread', { cache: 'no-store' });
          if (res.ok) { const data = await res.json(); set({ unreadCounts: data.counts || {} }); }
        } catch { /* Retry on the next sync. */ }
      },
      setAutoPlayOnDevice: async enabled => {
        const deviceId = get().selectedDeviceId;
        if (!deviceId) throw new Error('请先选择设备');
        const res = await fetch('/api/v1/device/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'autoPlay', deviceId, enabled }) });
        if (!res.ok) throw new Error('保存失败，请重试');
        set(s => ({ devices: s.devices.map(d => d.id === deviceId ? { ...d, autoPlayOnDevice: enabled } : d) }));
      },
      parentRole: '',
      setParentRole: role => {
        if (typeof window !== 'undefined') {
          try {
            localStorage.setItem('parent_user_role', role);
          } catch {}
        }
        set({ parentRole: role });
      },

      addVoiceCloneProfile: ({ id, speakerRole, title, sampleText, sampleAudioUrl, providerVoiceId, status }) => {
        const state = get();
        const profile: VoiceCloneProfile = {
          id: id || `clone_${Date.now()}`,
          familyId: state.family.id,
          speakerRole,
          title: title.trim() || `${speakerRole}的克隆声音`,
          sampleText,
          sampleAudioUrl,
          providerVoiceId,
          status: status || 'training',
          createdAt: new Date().toISOString(),
        };
        set(s => ({
          voiceClones: [profile, ...s.voiceClones.filter(v => v.id !== profile.id)],
        }));
        return profile;
      },

      deleteVoiceCloneProfile: async id => {
        const response = await fetch(`/api/v1/voice-clone?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('删除失败，请重试');
        set(s => ({ voiceClones: s.voiceClones.filter(v => v.id !== id) }));
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
                speakerRole: p.speakerRole || '自定义',
                title: p.title,
                sampleText: p.sampleText || '',
                providerVoiceId: p.providerVoiceId,
                status: ['ready', 'training', 'failed', 'unknown'].includes(p.status) ? p.status : 'unknown',
                createdAt: p.createdAt,
              })),
            }));
          }
        } catch {
          // ignore
        }
      },

      sendParentVoiceMessage: async ({
        deviceId,
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
        const id = `msg_${crypto.randomUUID()}`;
        if (!deviceId || !state.devices.some(d => d.id === deviceId)) throw new Error('请先选择设备');
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
        const response = await fetch('/api/v1/chat/messages', {
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
        });
        if (!response.ok) throw new Error('发送失败，请重试');
        set(s => s.selectedDeviceId === deviceId ? { messages: [...s.messages.filter(m => m.id !== id), newMsg] } : {});
        if (audioBlob) void saveLocalChatAudio(id, audioBlob);
        return id;
      },

      markMessagePlayed: async msgId => {
        const response = await fetch('/api/v1/chat/messages', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: msgId }),
        });
        if (!response.ok) throw new Error('已读状态同步失败');
        set(s => ({ messages: s.messages.map(m => (m.id === msgId ? { ...m, status: 'played' } : m)) }));
        void get().syncUnreadCounts();
      },

      syncMessagesFromServer: async () => {
        try {
          const deviceId = get().selectedDeviceId;
          if (!deviceId) return;
          const generation = deviceGeneration;
          const res = await fetch(
            `/api/v1/chat/messages?deviceId=${encodeURIComponent(deviceId)}`,
            { cache: 'no-store' }
          );
          if (!res.ok) return;
          const data = await res.json();
          if (generation !== deviceGeneration || get().selectedDeviceId !== deviceId) return;
          if (Array.isArray(data.messages)) {
            set(s => ({
              messagesDeviceId: deviceId,
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

      addSchedule: async (draft, deviceId) => {
        const state = get();
        const id = `sched_${crypto.randomUUID()}`;
        if (!deviceId || !state.devices.some(d => d.id === deviceId)) throw new Error('设备不存在');
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
        const response = await fetch('/api/v1/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newSched),
        });
        if (!response.ok) throw new Error('保存定时任务失败');
        set(s => s.selectedDeviceId === deviceId ? { schedules: [newSched, ...s.schedules] } : {});
      },

      updateSchedule: async (id, updates) => {
        const existing = get().schedules.find(item => item.id === id);
        if (!existing) throw new Error('定时任务不存在');
        const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
        const response = await fetch('/api/v1/schedules', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(merged),
        });
        if (!response.ok) throw new Error('保存定时任务失败');
        const data = await response.json().catch(() => null);
        const saved = data?.schedule ? { ...merged, ...data.schedule } : merged;
        set(s => ({ schedules: s.schedules.map(item => item.id === id ? saved : item) }));
      },

      toggleSchedule: id => {
        let nextEnabled: boolean | undefined;
        set(s => ({
          schedules: s.schedules.map(item => {
            if (item.id === id) {
              nextEnabled = !item.enabled;
              return {
                ...item,
                enabled: nextEnabled,
                lastAckStatus: nextEnabled ? 'idle' : item.lastAckStatus,
                lastAckAt: nextEnabled ? null : item.lastAckAt,
              };
            }
            return item;
          }),
        }));
        fetch('/api/v1/schedules', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, enabled: nextEnabled }),
        })
          .then(r => (r.ok ? r.json() : null))
          .then(data => {
            if (data?.schedule) {
              set(s => ({
                schedules: s.schedules.map(item =>
                  item.id === id ? { ...item, ...data.schedule } : item
                ),
              }));
            }
          })
          .catch(() => {});
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
          const deviceId = get().selectedDeviceId;
          if (!deviceId) return;
          const generation = deviceGeneration;
          const res = await fetch(
            `/api/v1/schedules?deviceId=${encodeURIComponent(deviceId)}`,
            { cache: 'no-store' }
          );
          if (!res.ok) return;
          const data = await res.json();
          if (generation !== deviceGeneration || get().selectedDeviceId !== deviceId) return;
          if (Array.isArray(data.schedules)) {
            set(s => ({
              schedulesDeviceId: deviceId,
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
        const deviceId = state.selectedDeviceId;
        if (!deviceId || state.configDeviceId !== deviceId) return;
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
          const deviceId = get().selectedDeviceId;
          if (!deviceId) return;
          const generation = deviceGeneration;
          const res = await fetch(
            `/api/v1/pet-ai?deviceId=${encodeURIComponent(deviceId)}`,
            { cache: 'no-store' }
          );
          if (!res.ok) return;
          const data = await res.json();
          if (generation !== deviceGeneration || get().selectedDeviceId !== deviceId) return;
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
            configDeviceId: deviceId,
          }));
        } catch {
          // ignore
        }
      },

      addDevice: async (pairingCode, alias, childNickname) => {
        const state = get();
        const code = pairingCode.trim();
        if (!/^\d{8}$/.test(code)) throw new Error('请输入8位绑定码');

        const res = await fetch('/api/v1/device/pairing/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            alias: alias.trim() || `${childNickname.trim() || '宝贝'}的小铭同学`,
            childNickname: childNickname.trim() || '宝贝',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || '设备绑定失败');
        }

        const remoteDev = data.device;
        if (!remoteDev?.id) throw new Error('绑定结果无效，请重新查询设备');
        const childId = `child-${Date.now()}`;
        const newChild: Child = {
          id: childId,
          familyId: state.family.id,
          nickname: remoteDev?.childNickname || childNickname.trim() || '宝贝',
        };
        const newDevice: Device = {
          id: remoteDev.id,
          familyId: state.family.id,
          childId,
          alias: remoteDev?.alias || alias.trim() || `${newChild.nickname}的小铭同学`,
          deviceModel: remoteDev?.deviceModel || 'Waveshare ESP32-S3-Touch-AMOLED-2.16',
          macAddress: remoteDev?.macAddress || '',
          status: 'paired',
          firmwareVersion: remoteDev?.firmwareVersion || '1.0.0',
          batteryPercent: Number(remoteDev?.batteryPercent ?? 0),
          autoPlayOnDevice: Boolean(remoteDev?.autoPlayOnDevice),
          isOnline: Boolean(remoteDev?.isOnline),
          lastSeenAt: remoteDev?.lastSeenAt || null,
        };
        deviceGeneration++;
        set(s => ({
          messages: [], schedules: [], aiLogs: [], petConfig: INITIAL_PET_CONFIG, configDeviceId: '', messagesDeviceId: '', schedulesDeviceId: '',
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
                autoPlayOnDevice: Boolean(rd.autoPlayOnDevice),
                isOnline: Boolean(rd.isOnline),
                lastSeenAt: rd.lastSeenAt || null,
              };
            });
            const nextSelected =
              mappedDevices.some(d => d.id === s.selectedDeviceId)
                ? s.selectedDeviceId
                : mappedDevices[0]?.id || '';
            if (nextSelected !== s.selectedDeviceId) deviceGeneration++;
            return {
              ...(nextSelected !== s.selectedDeviceId ? { messages: [], schedules: [], aiLogs: [], petConfig: INITIAL_PET_CONFIG, configDeviceId: '', messagesDeviceId: '', schedulesDeviceId: '' } : {}),
              devices: mappedDevices,
              selectedDeviceId: nextSelected,
            };
          });
        } catch {
          // 忽略网络瞬断
        }
      },

      removeDevice: async deviceId => {
        const response = await fetch(`/api/v1/device/status?deviceId=${encodeURIComponent(deviceId)}`, {
          method: 'DELETE',
        });
        if (!response.ok) throw new Error('解绑失败，请重试');
        if (get().selectedDeviceId === deviceId) deviceGeneration++;
        set(s => {
          const remaining = s.devices.filter(d => d.id !== deviceId);
          return {
            devices: remaining,
            ...(s.selectedDeviceId === deviceId ? { messages: [], schedules: [], aiLogs: [], petConfig: INITIAL_PET_CONFIG, configDeviceId: '', messagesDeviceId: '', schedulesDeviceId: '' } : {}),
            selectedDeviceId:
              s.selectedDeviceId === deviceId ? remaining[0]?.id || '' : s.selectedDeviceId,
          };
        });
      },

      selectDevice: deviceId => {
        if (get().selectedDeviceId === deviceId || !get().devices.some(d => d.id === deviceId)) return;
        deviceGeneration++;
        set({ selectedDeviceId: deviceId, messages: [], schedules: [], aiLogs: [], petConfig: INITIAL_PET_CONFIG, configDeviceId: '', messagesDeviceId: '', schedulesDeviceId: '' });
      },
    }),
    {
      name: 'xiaoming_pet_parent_store_v2',
      version: 8,
      migrate: (persistedState: any) => {
        if (!persistedState) return persistedState;
        // Device-scoped snapshots are always reloaded after startup.
        persistedState.messages = []; persistedState.schedules = []; persistedState.aiLogs = [];
        persistedState.petConfig = INITIAL_PET_CONFIG; persistedState.configDeviceId = '';
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
        parentRole: s.parentRole,
        // 亲子微聊消息持久化时剔除临时音频 Blob/Base64，只保留文字与状态，不保存聊天音频文件
        voiceClones: s.voiceClones,
      }),
    }
  )
);
