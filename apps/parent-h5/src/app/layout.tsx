import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '小铭同学 - 智能语音宠物家长端',
  description: '小铭同学：基于微雪 ESP32-S3-Touch-AMOLED-2.16 的智能语音宠物（AI 伴聊、定时语音播报与亲子双向微聊）',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icons/xiaoming-logo.svg?v=2', type: 'image/svg+xml' },
      { url: '/favicon.ico?v=4', sizes: 'any' },
    ],
    apple: '/icons/apple-touch-icon.png?v=4',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: '小铭同学',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#3E493F',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="icon" type="image/svg+xml" href="/icons/xiaoming-logo.svg?v=2" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600;700&family=Nunito:wght@400;600;700;800&family=Roboto+Mono:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
