import './lib/nonce';
import { useEffect, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from './lib/api';
import { connectStream, useStream } from './lib/stream';
import { navigate, useLocation } from './lib/router';
import './lib/preferences';
import { Sidebar } from './components/shell/sidebar';
import { Header } from './components/shell/header';
import { CommandMenu } from './components/shell/command-menu';
import { TooltipProvider } from './components/ui/overlay';
import { Toaster } from './components/ui/toast';
import { EmptyState, Page } from './components/page';
import { Button } from './components/ui/button';
import { FileQuestion } from 'lucide-react';
import Login from './pages/login';
import Overview from './pages/overview';
import Messages from './pages/messages';
import Events from './pages/events';
import ApiExplorer from './pages/actions';
import Logs from './pages/logs';
import Account from './pages/account';
import Connections from './pages/connections';
import Settings from './pages/settings';
import BotPage from './pages/bot';
import AiPage from './pages/ai';
import ImagePage from './pages/image';
import Setup from './pages/setup';

const pages: Record<string, ComponentType> = {
  '/': Overview, '/messages': Messages, '/events': Events, '/actions': ApiExplorer, '/logs': Logs,
  '/account': Account, '/connections': Connections, '/bot': BotPage, '/ai': AiPage, '/image': ImagePage, '/settings': Settings,
};

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function NotFound() {
  return <Page><EmptyState icon={FileQuestion} title="页面不存在" description="这个地址没有对应的页面。" action={<Button variant="outline" size="sm" onClick={() => navigate('/')}>返回概览</Button>} /></Page>;
}

function Shell() {
  const { pathname } = useLocation();
  const phase = useStream(state => state.state.phase);
  useEffect(() => connectStream(), []);
  useEffect(() => { if (phase === 'setup' && pathname !== '/setup') navigate('/setup', { replace: true }); }, [phase, pathname]);
  useEffect(() => {
    const title = { '/': '概览', '/messages': '消息', '/events': '事件', '/actions': 'API 调试', '/logs': '运行日志', '/account': '账号', '/connections': '连接', '/bot': 'Bot 编程', '/ai': 'AI 接入', '/image': 'AI 生图','/settings': '设置', '/setup': '接入向导' }[pathname];
    document.title = (title ? title + ' · ' : '') + 'OpenQQ';
  }, [pathname]);
  if (pathname === '/setup') return <Setup />;
  const Current = pages[pathname] ?? NotFound;
  return <div className="flex min-h-dvh">
    <a href="#main" className="sr-only z-50 rounded-md bg-card px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:shadow-md">跳到主要内容</a>
    <Sidebar />
    <div className="flex min-w-0 flex-1 flex-col">
      <Header />
      <main id="main" className="min-w-0 flex-1" tabIndex={-1}><Current /></main>
    </div>
    <CommandMenu />
  </div>;
}

function App() {
  const token = useAuth(state => state.token);
  return <QueryClientProvider client={queryClient}>
    <TooltipProvider delayDuration={350} skipDelayDuration={150}>
      {token ? <Shell key={token} /> : <Login />}
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>;
}

// Opening a fresh "#token=…" link in an existing tab swaps the access key in place.
window.addEventListener('hashchange', () => { if (new URLSearchParams(location.hash.slice(1)).has('token')) location.reload(); });
createRoot(document.getElementById('root')!).render(<App />);
