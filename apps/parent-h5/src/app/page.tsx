'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { BrandLogoXiaoming } from '../components/Icons';

const MainLayout = dynamic(() => import('../components/Layout').then(mod => mod.Layout), { ssr: false });

export default function HomePage() {
  const [status, setStatus] = useState<'loading' | 'login' | 'ready' | 'unconfigured' | 'error'>('loading');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/v1/auth', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('无法连接服务');
      const data = await response.json();
      setStatus(!data.configured ? 'unconfigured' : data.authenticated ? 'ready' : 'login');
    }).catch(() => setStatus('error'));
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/v1/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '登录失败');
      setPassword('');
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  if (status === 'ready') return <MainLayout />;
  return (
    <main className="min-h-screen bg-[#F5F4F0] flex items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-7 shadow-sm">
        <BrandLogoXiaoming className="w-14 h-14 rounded-xl mx-auto mb-4" />
        <h1 className="text-center text-xl font-bold text-[#242620]">小铭同学</h1>
        {status === 'loading' && <p className="text-center mt-4">正在连接…</p>}
        {status === 'error' && <p className="text-center mt-4">连接失败，请刷新页面重试。</p>}
        {status === 'unconfigured' && <p className="mt-4 text-sm text-center">服务尚未配置访问凭证，请联系管理员。</p>}
        {status === 'login' && <form onSubmit={login} className="mt-6 space-y-4">
          <label className="block text-sm" htmlFor="family-username">用户名</label>
          <input id="family-username" autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
          <label className="block text-sm" htmlFor="family-password">家庭访问密码</label>
          <input id="family-password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button disabled={busy} className="w-full rounded-lg bg-[#3E493F] text-white py-2 disabled:opacity-50">{busy ? '登录中…' : '进入家庭空间'}</button>
        </form>}
      </div>
    </main>
  );
}
