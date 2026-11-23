/**
 * 智能语音宠物系统 (AI Chat Pet) - 统一通信协议与数据契约规范
 * 供家长端 H5 (TypeScript)、服务端 (Vercel/Supabase)、ESP32-S3 固件 (C/C++) 共同参照
 * 硬件底座：Waveshare ESP32-S3-Touch-AMOLED-2.16 (480x480, CO5300, CST9220, ES7210+AEC, ES8311, PCF85063)
 */

// 1. 亲子微聊语音方向
export const CHAT_DIRECTION = {
  PARENT_TO_DEVICE: 'parent_to_device', // 家长发给宠物设备
  DEVICE_TO_PARENT: 'device_to_parent', // 孩子从设备发给家长
} as const;

export type ChatDirection = (typeof CHAT_DIRECTION)[keyof typeof CHAT_DIRECTION];

// 2. 语音消息已读状态
export const VOICE_MSG_STATUS = {
  UNREAD: 'unread', // 未收听
  PLAYED: 'played', // 已播报/已收听
} as const;

export type VoiceMsgStatus = (typeof VOICE_MSG_STATUS)[keyof typeof VOICE_MSG_STATUS];

// 3. 定时语音播报音源类型
export const SCHEDULE_SOURCE_TYPE = {
  TTS: 'tts',                   // 文字转宠物萌音 (TTS)
  PARENT_CLONE: 'parent_clone', // 文字转爸妈克隆音色 (Zero-shot Voice Clone TTS)
  RECORD: 'record',             // 家长亲自直接录音
} as const;

export type ScheduleSourceType = (typeof SCHEDULE_SOURCE_TYPE)[keyof typeof SCHEDULE_SOURCE_TYPE];

// 3.5 家长声音克隆档案契约 (`voice_clone_profiles`)
export interface VoiceCloneProfileContract {
  id: string;
  familyId: string;
  speakerRole: '妈妈' | '爸爸' | string;
  title: string;                 // 如 "妈妈的温柔声音"、"爸爸的鼓励声音"
  sampleText: string;            // 克隆采样朗读标准文本
  sampleAudioUrl?: string;       // 家长录制的 5~15 秒声音样本 URL
  providerVoiceId: string;       // 云端克隆引擎返回的专属 Voice ID (如 CosyVoice / 火山引擎 / FishAudio)
  status: 'ready' | 'training' | 'failed' | 'unknown';
  createdAt: string;
}

// 4. 定时提醒孩子确认状态
export const SCHEDULE_ACK_STATUS = {
  IDLE: 'idle',         // 未触发
  RINGING: 'ringing',   // 正在响铃播报
  CONFIRMED: 'confirmed', // 孩子已点击屏幕确认
} as const;

export type ScheduleAckStatus = (typeof SCHEDULE_ACK_STATUS)[keyof typeof SCHEDULE_ACK_STATUS];

// 5. AI 宠物性格与音色预设（对应豆包语音 2.0 真实音色编码）
export const PET_PERSONAS = [
  {
    id: 'lively_puppy',
    name: '元气小铭同学',
    voiceId: 'zh_female_vv_uranus_bigtts',
    tag: '豆包 2.0 Vivi · 活泼陪伴',
    systemPrompt: '你是5岁的智能语音萌宠“小铭同学”，性格活泼热情，喜欢鼓励小朋友，回答简短易懂，每次不超过50字。',
  },
  {
    id: 'wise_owl',
    name: '阳光博学学长',
    voiceId: 'zh_male_taocheng_uranus_bigtts',
    tag: '豆包 2.0 小天 · 百科故事',
    systemPrompt: '你是温和博学的科学小博士“小铭同学”，擅长用生动有趣的比喻解答小朋友的十万个为什么，每次回答不超过60字。',
  },
  {
    id: 'gentle_bunny',
    name: '甜美桃子姐姐',
    voiceId: 'zh_female_tianmeitaozi_uranus_bigtts',
    tag: '豆包 2.0 桃子 · 情绪安抚',
    systemPrompt: '你是温柔体贴的知心伙伴“小铭同学”，说话软萌亲切，擅长倾听小朋友的心事并给予温暖的回应，每次不超过50字。',
  },
] as const;

// 6. 核心数据模型契约

/** 定时语音任务 (`voice_schedules`) */
export interface VoiceScheduleContract {
  id: string;
  groupId?: string;
  familyId: string;
  deviceId: string;
  childId?: string | null;
  title: string;
  cronExpr: string;
  timeStr: string;               // "07:30" | "20:30"
  repeatDays: number[];          // [1,2,3,4,5,6,7] 周一到周日，空数组表示单次
  enabled: boolean;
  sourceType: ScheduleSourceType;
  clonedVoiceId?: string | null; // 当 sourceType === 'parent_clone' 时选用的爸妈克隆音色 ID
  clonedSpeakerRole?: string | null; // 如 "妈妈（克隆音色）"
  textContent: string;           // TTS 文本或录音备注
  audioUrl?: string | null;
  audioMd5?: string | null;
  repeatPlayCount: number;       // 到点连续播报次数 (1~20)
  loudnessRate?: number;         // 合成音量 (-50~100, 0为默认)
  requireAck?: boolean;          // true: 需点击确认按钮关闭弹窗才算结束（最多播 repeatPlayCount 次）; false: 播放固定次数直接结束
  lastAckStatus?: ScheduleAckStatus;
  lastAckAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

/** 亲子双向微聊语音消息 (`chat_voice_messages`) */
export interface ChatVoiceMessageContract {
  id: string;
  familyId: string;
  deviceId: string;
  childId?: string | null;
  direction: ChatDirection;
  senderName: string;            // "妈妈" | "爸爸" | "宝贝"
  audioUrl: string;
  durationSec: number;
  asrText?: string;              // 自动语音转文字内容
  autoPlay: boolean;             // true: 设备收到立即外放; false: 响提示音等孩子点击收听
  status: VoiceMsgStatus;
  createdAt: string;
}

/** AI 宠物配置与对话记录摘要 (`pet_ai_configs` & `ai_chat_logs`) */
export interface PetAiConfigContract {
  id: string;
  familyId: string;
  deviceId: string;
  childId?: string | null;
  petName: string;
  personaId: string;
  voiceId: string;
  customPrompt: string;
  volumeLevel: number;           // 0 ~ 100
  batteryPercent: number;        // AXP2101 上报电量 0 ~ 100
  isOnline: boolean;
  lastSeenAt?: string | null;
  updatedAt: string;
}

export interface AiChatLogContract {
  id: string;
  deviceId: string;
  childText: string;             // ASR 识别的孩子提问
  petReplyText: string;          // 豆包大模型生成的宠物回答（仅存文本，音频实时流式播放不落库）
  createdAt: string;
}

// 7. RESTful 核心接口契约路径定义
export const API_ENDPOINTS = {
  // 家庭与初始化
  FAMILY_BOOTSTRAP: '/api/v1/family/bootstrap',
  // 亲子双向微聊 (功能三)
  VOICE_MESSAGES: '/api/v1/chat/messages',
  VOICE_MESSAGE_READ: '/api/v1/chat/messages/:id/read',
  // 定时语音播报 (功能二) & 爸妈声音克隆
  VOICE_SCHEDULES: '/api/v1/schedules',
  VOICE_SCHEDULE_ITEM: '/api/v1/schedules/:id',
  VOICE_SCHEDULE_ACK: '/api/v1/schedules/:id/ack',
  VOICE_CLONES: '/api/v1/voice-clone',
  // AI 宠物人设与伴聊状态 (功能一)
  PET_AI_CONFIG: '/api/v1/pet-ai',
  AI_CHAT_COMPLETION: '/api/v1/ai/chat',
  // 硬件设备管理与模拟器同步
  DEVICES: '/api/v1/devices',
  DEVICE_PAIR: '/api/v1/device/pair',
  DEVICE_SYNC: '/api/v1/device/sync',
} as const;
