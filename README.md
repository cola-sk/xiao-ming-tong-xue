# 小铭同学（AI Chat Pet）：基于 ESP32-S3 的智能语音宠物全栈系统

**「小铭同学」** 是基于 **微雪（Waveshare）`ESP32-S3-Touch-AMOLED-2.16`**（2.16 寸 480×480 高清方形 AMOLED 屏、CO5300 + CST9220 触控、ES7210 双麦阵列带硬件 AEC、ES8311 音频解码、PCF85063 硬件 RTC）打造的儿童智能陪伴与亲子微聊系统。详细方案见 [产品与技术方案](docs/esp32-ai-pet-solution.md)。

## Monorepo 目录结构

- `packages/contracts`：跨端（家长端 H5、服务端 API、ESP32 固件）共享协议契约与 TypeScript 数据模型（`VoiceSchedule`、`ChatVoiceMessage`、`PetAiConfig`、`VoiceCloneProfile`）。
- `apps/parent-h5`：家长端 H5 应用（基于 Next.js 14 App Router + React 18 + Tailwind CSS + Ant Design Mobile + Zustand），支持直接部署至 Vercel。
- `apps/pet-device`：适配微雪 `ESP32-S3-Touch-AMOLED-2.16` 的固件工程骨架（`ui_state_machine`、`audio_engine`、`rtc_scheduler`）及硬件未到货前的 `480×480` 方形屏幕交互模拟器（`apps/pet-device/preview/index.html`）。
- `supabase/schema.sql`：PostgreSQL 数据库表结构（家庭、设备、爸妈声音克隆档案、AI 宠物配置、定时语音表、亲子微聊语音表）。

## 快速启动（设备未到货前全流程联调）

```bash
pnpm install
pnpm dev:h5
```

- 家长端 H5：[http://localhost:5189](http://localhost:5189)
- 生产构建验证：`pnpm build:h5`
- 设备端 `480×480` 方形屏幕与侧面物理按键模拟器：直接在浏览器打开 `apps/pet-device/preview/index.html`。
