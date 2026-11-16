import {
  VoiceScheduleContract,
  ChatVoiceMessageContract,
  PetAiConfigContract,
  AiChatLogContract,
  VoiceCloneProfileContract,
  PET_PERSONAS,
} from '@ai-chat-pet/contracts';

export { PET_PERSONAS };
export type {
  VoiceScheduleContract as VoiceSchedule,
  ChatVoiceMessageContract as ChatVoiceMessage,
  PetAiConfigContract as PetAiConfig,
  AiChatLogContract as AiChatLog,
  VoiceCloneProfileContract as VoiceCloneProfile,
};

export interface Family {
  id: string;
  name: string;
  timezone: string;
  createdAt: string;
}

export interface Child {
  id: string;
  familyId: string;
  nickname: string;
  avatarUrl?: string;
}

export interface Device {
  id: string;
  familyId: string;
  childId: string;
  alias: string;
  deviceModel: string;
  macAddress: string;
  status: 'unpaired' | 'paired';
  firmwareVersion: string;
  batteryPercent: number;
  isOnline: boolean;
  lastSeenAt: string;
}
