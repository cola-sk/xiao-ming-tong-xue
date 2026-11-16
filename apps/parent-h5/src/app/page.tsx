'use client';

import dynamic from 'next/dynamic';
import { BrandLogoXiaoming } from '../components/Icons';

const MainLayout = dynamic(
  () => import('../components/Layout').then(mod => mod.Layout),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-[#F5F4F0] flex flex-col items-center justify-center space-y-3">
        <BrandLogoXiaoming className="w-14 h-14 rounded-2xl shadow-md" />
        <div className="text-body font-bold text-[#242620]">
          正在连接小铭同学语音空间…
        </div>
      </div>
    ),
  }
);

export default function HomePage() {
  return <MainLayout />;
}
