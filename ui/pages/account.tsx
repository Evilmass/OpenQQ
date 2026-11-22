import { useEffect, useMemo, useState } from 'react';
import { Check, CircleAlert, Copy, History, Info, LoaderCircle, LogIn, Play, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { describeLog } from '../format.mjs';
import { request } from '../lib/api';
import { useConfig } from '../lib/hooks';
import { isReady, useStream } from '../lib/stream';
import { cn, formatTimeMs } from '../lib/utils';
import type { ActionResponse, SessionState } from '../lib/types';
import { levelMeta } from '../components/entry';
import { DescriptionList, EmptyState, Page, PageHeader } from '../components/page';
import { StatusBadge, StatusDot, sessionStatus } from '../components/status';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { copyText, toast } from '../components/ui/toast';

type StepState = 'done' | 'active' | 'error' | 'todo';
const steps = ['启动 QQ', '载入原生脚本', '登录账号', '同步数据', '会话就绪'];

function progress(state: SessionState): StepState[] {
  const failed = ['failed', 'hook_error', 'offline'].includes(state.phase);
  const reached = state.phase === 'session_ready' ? (state.syncing ? 3 : 5)
    : state.phase === 'hook_installed' ? 2 : state.phase === 'starting' ? 0
    : state.phase === 'offline' ? 2 : failed ? (state.pid ? 2 : 0) : -1;
  return steps.map((_, index) => index < reached ? 'done' : index === reached ? (failed ? 'error' : 'active') : 'todo');
}

function Lifecycle({ state }: { state: SessionState }) {
  const states = progress(state);
  return <ol className="grid gap-0 sm:grid-cols-5" aria-label="会话进度">
    {steps.map((step, index) => { const value = states[index]; return <li key={step} className="relative flex items-center gap-3 py-2 sm:flex-col sm:items-start sm:gap-2 sm:py-0" aria-current={value === 'active' ? 'step' : undefined}>
      <div className="flex w-full items-center gap-2">
        <span className={cn('grid size-6 shrink-0 place-items-center rounded-full border text-2xs font-semibold',
          value === 'done' && 'border-success/30 bg-success/10 text-success-text', value === 'active' && 'border-foreground/40 bg-muted text-foreground',
          value === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive-text', value === 'todo' && 'bg-muted text-muted-foreground')}>
          {value === 'done' ? <Check className="size-3.5" aria-hidden /> : value === 'active' ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : value === 'error' ? <CircleAlert className="size-3.5" aria-hidden /> : index + 1}
        </span>
        {index < steps.length - 1 && <span className={cn('hidden h-px flex-1 sm:block', value === 'done' ? 'bg-success/40' : 'bg-border')} aria-hidden />}
      </div>
      <span className={cn('text-caption', value === 'todo' ? 'text-muted-foreground' : 'font-medium text-foreground')}>{step}
        <span className="sr-only">{{ done: '，已完成', active: '，进行中', error: '，出错', todo: '，未开始' }[value]}</span></span>
    </li>; })}
  </ol>;
}

const lifecycleTypes = new Set(['wrapper_loaded', 'session_captured', 'session_ready', 'sync_state', 'offline', 'hook_error']);

export default function Account() {
  const state = useStream(store => store.state), connected = useStream(store => store.connected), loaded = useStream(store => store.loaded);
  const entries = useStream(store => store.entries);
  const config = useConfig();
  const client = useQueryClient();
  const [info, setInfo] = useState<ActionResponse | null>(null), [busy, setBusy] = useState(false), [starting, setStarting] = useState(false);
  const meta = sessionStatus(state, connected, loaded);
  const ready = isReady(state, connected);
  const history = useMemo(() => entries.filter(entry => entry.kind === 'diagnostic' && lifecycleTypes.has(String(entry.data.type))).reverse(), [entries]);
  const canStart = config.data && !config.data.running && config.data.initialized;

  async function loginInfo() {
    setBusy(true);
    try { const response = await request<ActionResponse>('/api/action', { action: 'get_login_info', echo: 'webui' }); setInfo(response); if (response.status !== 'ok') toast.error('获取失败', response.message); }
    catch (error) { toast.error('获取失败', (error as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!ready || !state.self_id) return;
    let active = true;
    request<ActionResponse>('/api/action', { action: 'get_login_info', echo: 'webui-auto' })
      .then(response => { if (active && response.status === 'ok') setInfo(response); })
      .catch(() => {});
    return () => { active = false; };
  }, [ready, state.self_id]);
  async function start() {
    setStarting(true);
    try { const result = await request<{ message: string }>('/api/start', {}); toast.success('正在启动', result.message); client.invalidateQueries({ queryKey: ['config'] }); }
    catch (error) { toast.error('无法启动', (error as Error).message); }
    finally { setStarting(false); }
  }

  const loginData = info?.status === 'ok' ? info.data as { user_id?: number; nickname?: string } : null;
  return <Page>
    <PageHeader title="账号" description="通过 OpenQQ 挂接的 QQ 会话。登录在 QQ 客户端窗口中完成，OpenQQ 不保存任何账号凭据。"
      actions={canStart && <Button size="sm" onClick={start} loading={starting}>{!starting && <Play />}启动 OpenQQ</Button>} />

    <Card>
      <CardContent className="grid gap-6">
        <div className="flex flex-wrap items-center gap-4">
          <span className="relative grid size-14 shrink-0 place-items-center rounded-full border bg-muted text-base font-semibold text-secondary-foreground">
            {state.self_id ? String(state.self_id).slice(-2) : 'QQ'}
            <StatusDot tone={meta.tone} className="absolute bottom-0.5 right-0.5 rounded-full ring-[3px] ring-card" />
          </span>
          <div className="grid min-w-0 flex-1 gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular font-mono text-xl font-semibold tracking-[-0.01em]">{state.self_id ?? '尚未登录'}</span>
              <StatusBadge meta={meta} />
            </div>
            <p className="text-caption text-muted-foreground">{state.phase === 'hook_error' && state.error ? `[${state.stage}] ${state.error}` : meta.description}</p>
          </div>
          <div className="flex gap-2">
            {state.self_id && <Button variant="outline" size="sm" onClick={() => copyText(String(state.self_id))}><Copy />复制 QQ 号</Button>}
            <Button variant="outline" size="sm" onClick={loginInfo} loading={busy} disabled={!ready}>{!busy && <RefreshCw />}获取登录信息</Button>
          </div>
        </div>
        <div className="border-t pt-5"><Lifecycle state={state} /></div>
        {state.phase === 'hook_installed' && <p className="flex items-start gap-2.5 rounded-lg border bg-muted/60 px-3.5 py-2.5 text-caption text-secondary-foreground">
          <LogIn className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />请切换到 QQ 窗口，使用扫码或账号密码正常登录。登录完成后这里会自动更新。
        </p>}
        {state.phase === 'offline' && <p className="flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/5 px-3.5 py-2.5 text-caption text-secondary-foreground">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />账号已掉线。请在 QQ 窗口中重新登录；如需重新挂接，在终端按 Ctrl+C 停止后再次运行 npm start。
        </p>}
      </CardContent>
    </Card>

    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader><CardTitle>会话详情</CardTitle></CardHeader>
        <CardContent>
          <DescriptionList items={[
            ['QQ 号', <span className="tabular font-mono">{state.self_id ?? '—'}</span>],
            ['昵称', loginData ? loginData.nickname || <span className="text-muted-foreground">（QQ 暂未提供）</span> : <span className="text-muted-foreground">点击「获取登录信息」读取</span>],
            ['QQ 版本', state.version ?? '—'],
            ['引导方式', state.bootstrap === 'cpp-native' ? 'C++ 原生引导（无 Inspector 端口）' : state.bootstrap ?? '—'],
            ['QQ 进程', state.pid ? <span className="tabular font-mono">PID {state.pid}</span> : '—'],
            ['同步状态', state.phase === 'session_ready' ? state.syncing ? <Badge tone="warning">同步中</Badge> : <Badge tone="success">已完成</Badge> : '—'],
            ['会话服务', state.services?.length ? <span className="flex flex-wrap gap-1">{state.services.map(service => <Badge key={service} tone="outline" className="font-mono">{service}</Badge>)}</span> : '—'],
          ]} />
        </CardContent>
      </Card>

      <Card className="flex flex-col">
        <CardHeader><div className="grid gap-0.5"><CardTitle><History className="size-4 text-muted-foreground" aria-hidden />会话历史</CardTitle><CardDescription>本次运行内的挂接与登录事件</CardDescription></div></CardHeader>
        {history.length ? <ol className="grid gap-0 px-4 py-4 sm:px-5">
          {history.map((entry, index) => { const log = describeLog(entry); return <li key={entry.id} className="relative flex gap-3 pb-4 last:pb-0">
            {index < history.length - 1 && <span className="absolute left-[5px] top-4 h-[calc(100%-8px)] w-px bg-border" aria-hidden />}
            <span className={cn('relative mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-card', log.level === 'error' ? 'bg-destructive' : log.level === 'warn' ? 'bg-warning' : log.level === 'success' ? 'bg-success' : 'bg-muted-foreground')} aria-hidden />
            <div className="grid min-w-0 gap-0.5">
              <span className="text-sm">{log.message}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground"><span className="tabular font-mono">{formatTimeMs(entry.time)}</span><span className={levelMeta[log.level].text}>{levelMeta[log.level].label}</span></span>
            </div>
          </li>; })}
        </ol> : <EmptyState compact icon={Info} title="暂无记录" description="启动 OpenQQ 并登录 QQ 后，挂接与会话事件会记录在这里。" className="flex-1" />}
      </Card>
    </div>
  </Page>;
}
