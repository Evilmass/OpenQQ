import { useMemo, useState } from 'react';
import { Activity, ArrowRight, Braces, CircleAlert, CircleCheck, Clock, Cpu, Inbox, MessagesSquare, Radio, TriangleAlert, Zap } from 'lucide-react';
import { describeEntry } from '../format.mjs';
import { useMetrics, useNow } from '../lib/hooks';
import { navigate } from '../lib/router';
import { alertsOf, useStream } from '../lib/stream';
import { formatBytes, formatDuration, formatMs, formatNumber, formatTime } from '../lib/utils';
import type { Entry } from '../lib/types';
import { ActivityChart } from '../components/activity-chart';
import { EntryDetail, KindBadge } from '../components/entry';
import { MetricCard, Meter } from '../components/metric-card';
import { EmptyState, ErrorState, Page, PageHeader } from '../components/page';
import { StatusBadge, StatusDot, postMeta, reverseMeta, sessionStatus } from '../components/status';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/misc';
import { linkHandler } from '../components/shell/sidebar';

function SessionCard() {
  const state = useStream(store => store.state), connected = useStream(store => store.connected), loaded = useStream(store => store.loaded);
  const meta = sessionStatus(state, connected, loaded);
  const facts = [['QQ 版本', state.version ?? '—'], ['引导方式', state.bootstrap === 'cpp-native' ? 'C++ 原生' : state.bootstrap ?? '—'], ['QQ 进程', state.pid ? 'PID ' + state.pid : '—'], ['会话服务', state.services ? state.services.length + ' 个' : '—']];
  return <Card className="lg:col-span-2">
    <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <span className="relative grid size-12 shrink-0 place-items-center rounded-full border bg-muted text-sm font-semibold text-secondary-foreground">
          {state.self_id ? String(state.self_id).slice(-2) : 'QQ'}
          <StatusDot tone={meta.tone} className="absolute bottom-0 right-0 rounded-full ring-[3px] ring-card" />
        </span>
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tabular truncate font-mono text-lg font-semibold tracking-[-0.01em]">{state.self_id ?? '尚未登录'}</span>
            <StatusBadge meta={meta} />
          </div>
          <p className="truncate text-caption text-muted-foreground">{state.phase === 'hook_error' && state.error ? state.error : meta.description}</p>
        </div>
      </div>
      <dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-2 border-t pt-4 text-caption sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
        {facts.map(([term, value]) => <div key={term} className="grid gap-0.5"><dt className="text-xs text-muted-foreground">{term}</dt><dd className="tabular truncate font-medium">{value}</dd></div>)}
      </dl>
    </CardContent>
  </Card>;
}

function ConnectionHealth() {
  const network = useStream(store => store.state.network);
  return <Card className="flex flex-col">
    <CardHeader><CardTitle><Radio className="size-4 text-muted-foreground" aria-hidden />连接健康</CardTitle>
      <Button variant="ghost" size="xs" asChild><a href="/connections" onClick={linkHandler('/connections')}>管理<ArrowRight /></a></Button>
    </CardHeader>
    <CardContent className="flex-1">
      {!network ? <p className="text-caption text-muted-foreground">OneBot 服务将在 QQ 启动后开始。</p> : <ul className="grid gap-3">
        <li className="flex items-center justify-between gap-3">
          <span className="grid min-w-0"><span className="text-sm font-medium">正向 WebSocket</span><span className="truncate font-mono text-xs text-muted-foreground">{network.ws.enabled ? network.ws.address ?? '正在启动' : '未启用'}</span></span>
          {network.ws.enabled ? <StatusBadge meta={{ label: network.ws.clients + ' 个客户端', tone: network.ws.clients ? 'success' : 'neutral' }} icon={false} /> : <StatusBadge meta={{ label: '未启用', tone: 'neutral' }} icon={false} />}
        </li>
        {network.reverseWs.map(item => { const meta = reverseMeta[item.state] ?? { label: item.state, tone: 'neutral' as const }; return <li key={item.index} className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">反向连接 {item.index + 1}</span><StatusBadge meta={meta} icon={false} />
        </li>; })}
        {network.http?.enabled && <li className="flex items-center justify-between gap-3">
          <span className="grid min-w-0"><span className="text-sm font-medium">HTTP 服务</span><span className="truncate font-mono text-xs text-muted-foreground">{network.http.address ?? '正在启动'}</span></span>
          <StatusBadge meta={{ label: '已启用', tone: 'success' }} icon={false} />
        </li>}
        {network.httpPost?.map(item => { const meta = postMeta[item.state] ?? { label: item.state, tone: 'neutral' as const }; return <li key={'post' + item.index} className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">HTTP 上报 {item.index + 1}</span><StatusBadge meta={meta} icon={false} />
        </li>; })}
        {!network.ws.enabled && !network.reverseWs.length && !network.http?.enabled && !network.httpPost?.length && <li className="text-caption text-muted-foreground">没有启用的连接</li>}
      </ul>}
    </CardContent>
  </Card>;
}

function ProcessCard() {
  const { data, isLoading, isError } = useMetrics();
  return <Card>
    <CardHeader><div className="grid gap-0.5"><CardTitle><Cpu className="size-4 text-muted-foreground" aria-hidden />桥接进程</CardTitle><CardDescription>OpenQQ Node.js 进程，不含 QQ 客户端</CardDescription></div></CardHeader>
    <CardContent className="grid gap-4">
      {isLoading ? <><Skeleton className="h-9" /><Skeleton className="h-9" /></> : isError || !data ? <p className="text-caption text-muted-foreground">暂时无法读取进程指标。</p> : <>
        <div className="grid gap-1.5">
          <div className="flex justify-between text-caption"><span className="text-muted-foreground">CPU</span><span className="tabular font-medium">{data.process.cpu.toFixed(1)}%</span></div>
          <Meter value={data.process.cpu} label="CPU 占用" />
        </div>
        <div className="grid gap-1.5">
          <div className="flex justify-between text-caption"><span className="text-muted-foreground">堆内存</span><span className="tabular font-medium">{formatBytes(data.process.heapUsed)} / {formatBytes(data.process.heapTotal)}</span></div>
          <Meter value={data.process.heapUsed / data.process.heapTotal * 100} label="堆内存占用" />
        </div>
        <dl className="grid grid-cols-3 gap-3 border-t pt-3 text-caption">
          <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">常驻内存</dt><dd className="tabular font-medium">{formatBytes(data.process.rss)}</dd></div>
          <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">P95 耗时</dt><dd className="tabular font-medium">{formatMs(data.latency.p95)}</dd></div>
          <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">Node</dt><dd className="tabular truncate font-medium">{data.process.node}</dd></div>
        </dl>
      </>}
    </CardContent>
  </Card>;
}

function RecentEvents({ onOpen }: { onOpen(entry: Entry): void }) {
  const entries = useStream(store => store.entries), loaded = useStream(store => store.loaded);
  const recent = useMemo(() => entries.filter(entry => entry.kind !== 'diagnostic').slice(-8).reverse().map(entry => ({ entry, description: describeEntry(entry) })), [entries]);
  return <Card className="lg:col-span-2">
    <CardHeader><CardTitle><Activity className="size-4 text-muted-foreground" aria-hidden />最近事件</CardTitle>
      <Button variant="ghost" size="xs" asChild><a href="/events" onClick={linkHandler('/events')}>查看全部<ArrowRight /></a></Button>
    </CardHeader>
    {!loaded ? <div className="grid gap-2 p-4">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-10" />)}</div>
      : recent.length ? <ul className="divide-y">
        {recent.map(({ entry, description }) => <li key={entry.id}>
          <button type="button" onClick={() => onOpen(entry)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted sm:px-5">
            <KindBadge kind={description.kind} failed={description.failed} />
            <span className="grid min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline gap-2"><span className="truncate text-sm font-medium">{description.title}</span><span className="shrink-0 truncate text-xs text-muted-foreground">{description.source}</span></span>
              <span className="truncate text-caption text-muted-foreground">{description.text}</span>
            </span>
            <time className="tabular shrink-0 font-mono text-xs text-muted-foreground" dateTime={entry.time}>{formatTime(entry.time)}</time>
          </button>
        </li>)}
      </ul> : <EmptyState compact icon={Inbox} title="暂无事件" description="新的消息、通知和动作回执会实时出现在这里。" />}
  </Card>;
}

export default function Overview() {
  const counts = useStream(store => store.counts);
  const metrics = useMetrics();
  const now = useNow();
  const [detail, setDetail] = useState<Entry | null>(null);
  const uptime = metrics.data ? Math.max(0, (now - new Date(metrics.data.startedAt).getTime()) / 1000) : null;
  const hour = metrics.data?.timeline.reduce((sum, bucket) => ({ events: sum.events + bucket.events, actions: sum.actions + bucket.actions }), { events: 0, actions: 0 });
  return <Page>
    <PageHeader title="概览" description="QQ 会话、OneBot 连接与桥接进程的实时状态。"
      actions={<>
        <Button variant="outline" size="sm" onClick={() => navigate('/actions')}><Braces />API 调试</Button>
        <Button size="sm" onClick={() => navigate('/messages')}><MessagesSquare />发送消息</Button>
      </>} />
    <div className="grid gap-4 lg:grid-cols-3">
      <SessionCard />
      <ConnectionHealth />
    </div>
    <section aria-label="运行指标" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <MetricCard label="事件" icon={Activity} value={formatNumber(counts.events)} hint="本次启动以来" />
      <MetricCard label="动作" icon={Zap} value={formatNumber(counts.actions)} loading={metrics.isLoading}
        hint={metrics.data?.latency.average != null ? '平均耗时 ' + formatMs(metrics.data.latency.average) : '尚无动作耗时'} />
      <MetricCard label="异常" icon={TriangleAlert} value={formatNumber(counts.errors)} tone={counts.errors ? 'destructive' : 'default'} hint="失败动作与运行错误" />
      <MetricCard label="运行时长" icon={Clock} loading={metrics.isLoading} value={uptime != null ? formatDuration(uptime) : '—'}
        hint={metrics.data ? '启动于 ' + formatTime(metrics.data.startedAt) : metrics.isError ? '指标不可用' : undefined} />
    </section>
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div className="grid gap-0.5"><CardTitle>消息吞吐</CardTitle>
            <CardDescription>{hour ? `近 60 分钟 ${formatNumber(hour.events)} 个事件 · ${formatNumber(hour.actions)} 个动作` : '近 60 分钟'}</CardDescription></div>
        </CardHeader>
        <CardContent>
          {metrics.isLoading ? <Skeleton className="h-48" /> : metrics.isError || !metrics.data ? <ErrorState title="指标暂时不可用" description="无法读取 /api/metrics，请确认 OpenQQ 版本与终端运行状态。" onRetry={() => metrics.refetch()} className="py-8" />
            : <ActivityChart timeline={metrics.data.timeline} />}
        </CardContent>
      </Card>
      <ProcessCard />
    </div>
    <div className="grid gap-4 lg:grid-cols-3">
      <RecentEvents onOpen={setDetail} />
      <RecentAlerts />
    </div>
    <EntryDetail entry={detail} onClose={() => setDetail(null)} />
  </Page>;
}

function RecentAlerts() {
  const entries = useStream(store => store.entries);
  const alerts = useMemo(() => alertsOf(entries).slice(-5).reverse(), [entries]);
  return <Card className="flex flex-col">
    <CardHeader><CardTitle><TriangleAlert className="size-4 text-muted-foreground" aria-hidden />最近异常</CardTitle>
      <Button variant="ghost" size="xs" asChild><a href="/logs" onClick={linkHandler('/logs')}>运行日志<ArrowRight /></a></Button>
    </CardHeader>
    {alerts.length ? <ul className="divide-y">
      {alerts.map(alert => <li key={alert.id}>
        <a href={(alert.entry.kind === 'diagnostic' ? '/logs?e=' : '/events?e=') + alert.id} onClick={linkHandler((alert.entry.kind === 'diagnostic' ? '/logs?e=' : '/events?e=') + alert.id)}
          className="flex items-start gap-3 px-4 py-2.5 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted sm:px-5">
          {alert.level === 'error' ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="错误" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="警告" />}
          <span className="grid min-w-0 flex-1"><span className="truncate font-mono text-caption font-medium">{alert.title}</span><span className="line-clamp-2 text-xs text-muted-foreground">{alert.message}</span></span>
          <time className="tabular shrink-0 font-mono text-xs text-muted-foreground" dateTime={alert.time}>{formatTime(alert.time)}</time>
        </a>
      </li>)}
    </ul> : <EmptyState compact icon={CircleCheck} title="运行正常" description="失败的动作与挂接异常会显示在这里。" className="flex-1" />}
  </Card>;
}
