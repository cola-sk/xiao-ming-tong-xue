-- ==============================================================================
-- 智能语音宠物 (AI Chat Pet) - Supabase PostgreSQL 数据表设计
-- 对应微雪 ESP32-S3-Touch-AMOLED-2.16 (480x480) 三大核心功能：
-- 1. AI 宠物对话与人设配置 (pet_ai_configs, ai_chat_logs)
-- 2. 定时语音播报任务管理 (voice_schedules)
-- 3. 亲子双向微聊语音消息 (chat_voice_messages)
-- ==============================================================================

-- 1. 家庭表 (families)
CREATE TABLE IF NOT EXISTS public.families (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL DEFAULT '小铭同学成长空间',
    timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Shanghai',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. 家长表 (parents)
CREATE TABLE IF NOT EXISTS public.parents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID REFERENCES public.families(id) ON DELETE CASCADE,
    auth_user_id UUID UNIQUE,
    nickname VARCHAR(50) NOT NULL DEFAULT '妈妈',
    role VARCHAR(20) NOT NULL DEFAULT 'parent',
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. 孩子档案表 (children)
CREATE TABLE IF NOT EXISTS public.children (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    nickname VARCHAR(50) NOT NULL DEFAULT '堂堂',
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. 硬件设备表 (devices) - 微雪 ESP32-S3-Touch-AMOLED-2.16
CREATE TABLE IF NOT EXISTS public.devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID REFERENCES public.families(id) ON DELETE SET NULL,
    child_id UUID REFERENCES public.children(id) ON DELETE SET NULL,
    alias VARCHAR(50) NOT NULL DEFAULT '堂堂的小铭同学',
    device_model VARCHAR(100) NOT NULL DEFAULT 'Waveshare ESP32-S3-Touch-AMOLED-2.16',
    mac_address VARCHAR(50) UNIQUE,
    pair_code VARCHAR(10),
    pair_code_expires_at TIMESTAMPTZ,
    api_token_hash VARCHAR(64),
    status VARCHAR(20) NOT NULL DEFAULT 'paired', -- 'unpaired' | 'paired'
    firmware_version VARCHAR(30) DEFAULT '1.0.0',
    battery_percent INT NOT NULL DEFAULT 88 CHECK (battery_percent BETWEEN 0 AND 100),
    is_online BOOLEAN NOT NULL DEFAULT TRUE,
    last_seen_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. 功能一：AI 宠物人设与音色配置表 (pet_ai_configs)
CREATE TABLE IF NOT EXISTS public.pet_ai_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    child_id UUID REFERENCES public.children(id) ON DELETE SET NULL,
    pet_name VARCHAR(50) NOT NULL DEFAULT '小铭同学',
    persona_id VARCHAR(40) NOT NULL DEFAULT 'lively_puppy',
    voice_id VARCHAR(40) NOT NULL DEFAULT 'cute_puppy_v1',
    custom_prompt TEXT NOT NULL DEFAULT '你是5岁的智能语音萌宠“小铭同学”，性格活泼，回答简短易懂，每次不超过50字。',
    volume_level INT NOT NULL DEFAULT 80 CHECK (volume_level BETWEEN 0 AND 100),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_pet_ai_device UNIQUE (device_id)
);

-- 6. 功能一：AI 宠物伴聊对话历史表 (ai_chat_logs) - 仅记录问答文本，不保存音频文件
CREATE TABLE IF NOT EXISTS public.ai_chat_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    child_id UUID REFERENCES public.children(id) ON DELETE SET NULL,
    child_text TEXT NOT NULL,
    pet_reply_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.5 定时语音播报专用音频持久化表 (tts_audio_files)
-- 【仅用于功能二：定时语音播报】因为定时闹钟每天固定重复播放且需供 ESP32 预下载，将合成好的 MP3 按 MD5 去重存入数据库，
-- 并通过 Vercel 路由 `/api/v1/audio/[md5].mp3` 对外提供永久 HTTP 地址。
-- （功能一 AI 伴聊与功能三 亲子微聊的音频均走实时流，不写入此表，节省数据库空间）
CREATE TABLE IF NOT EXISTS public.tts_audio_files (
    md5 VARCHAR(64) PRIMARY KEY,
    voice_type VARCHAR(80) NOT NULL,
    text_content TEXT NOT NULL,
    mime_type VARCHAR(40) NOT NULL DEFAULT 'audio/mpeg',
    audio_base64 TEXT NOT NULL,
    size_bytes INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. 爸妈声音克隆档案表 (voice_clone_profiles) - 支持输入文字用爸妈克隆声音定时播报
CREATE TABLE IF NOT EXISTS public.voice_clone_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    speaker_role VARCHAR(30) NOT NULL DEFAULT '妈妈', -- '妈妈' | '爸爸'
    title VARCHAR(80) NOT NULL DEFAULT '妈妈的克隆声音',
    sample_text TEXT NOT NULL,
    sample_audio_url TEXT,
    provider_voice_id VARCHAR(120) NOT NULL,          -- CosyVoice / 火山引擎 / FishAudio 返回的克隆音色 ID
    status VARCHAR(20) NOT NULL DEFAULT 'ready',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. 功能二：定时语音播报任务表 (voice_schedules)
CREATE TABLE IF NOT EXISTS public.voice_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    child_id UUID REFERENCES public.children(id) ON DELETE SET NULL,
    title VARCHAR(100) NOT NULL,
    cron_expr VARCHAR(60) NOT NULL,
    time_str VARCHAR(10) NOT NULL,                -- 如 '07:30', '20:30'
    repeat_days JSONB NOT NULL DEFAULT '[1,2,3,4,5,6,7]'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    source_type VARCHAR(20) NOT NULL DEFAULT 'tts', -- 'tts' | 'parent_clone' | 'record'
    cloned_voice_id UUID REFERENCES public.voice_clone_profiles(id) ON DELETE SET NULL,
    cloned_speaker_role VARCHAR(40),
    text_content TEXT NOT NULL,
    audio_url TEXT,
    audio_md5 VARCHAR(64),
    repeat_play_count INT NOT NULL DEFAULT 2 CHECK (repeat_play_count BETWEEN 1 AND 5),
    last_ack_status VARCHAR(20) NOT NULL DEFAULT 'idle', -- 'idle' | 'ringing' | 'confirmed'
    last_ack_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. 功能三：亲子双向微聊语音消息表 (chat_voice_messages)
CREATE TABLE IF NOT EXISTS public.chat_voice_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    child_id UUID REFERENCES public.children(id) ON DELETE SET NULL,
    direction VARCHAR(30) NOT NULL,               -- 'parent_to_device' | 'device_to_parent'
    sender_name VARCHAR(50) NOT NULL DEFAULT '妈妈',
    audio_url TEXT NOT NULL,
    duration_sec INT NOT NULL DEFAULT 3 CHECK (duration_sec >= 1),
    asr_text TEXT,
    auto_play BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(20) NOT NULL DEFAULT 'unread', -- 'unread' | 'played'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 权限授予
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- Runtime device pairing: no shared firmware secret.
CREATE TABLE IF NOT EXISTS device_credentials (
  device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS device_pairing_sessions (
  device_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, setup_hash TEXT NOT NULL,
  token_nonce TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, claimed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS device_pairing_limits (
  bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
