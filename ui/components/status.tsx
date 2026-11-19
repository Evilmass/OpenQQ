import { CircleAlert, CircleCheck, CircleDot, LoaderCircle, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';
import type { SessionState } from '../lib/types';
import { Badge, type Tone } from './ui/badge';

export interface StatusMeta { label: string; tone: Tone; description: string }

export const phaseMeta: Record<string, StatusMeta> = {
  setup: { label: '待配置', tone: 'neutral', description: '尚未保存接入配置，请完成接入向导' },
  detached: { label: '未接入', tone: 'neutral', description: 'OpenQQ 尚未挂接 QQ' },
  starting: { label: '正在启动', tone: 'warning', description: '正在启动 QQ 并载入原生脚本' },
  hook_installed: { label: '等待登录', tone: 'warning', description: '原生脚本已载入，请在 QQ 窗口中登录' },
  session_ready: { label: '在线', tone: 'success', description: 'QQ 会话就绪，可以收发消息' },
  offline: { label: '已掉线', tone: 'destructive', description: '账号已掉线，需要在 QQ 中重新登录' },
  failed: { label: '启动失败', tone: 'destructive', description: '启动过程出错，请查看终端与运行日志' },
  hook_error: { label: '接入异常', tone: 'destructive', description: '原生挂接出错，请查看运行日志' },
};

/** Combines the bridge phase with the WebUI stream connection into one status. */
export function sessionStatus(state: SessionState, connected: boolean, loaded = true): StatusMeta {
  if (!loaded) return { label: '连接中', tone: 'neutral', description: '正在连接 OpenQQ' };
  if (!connected) return { label: '连接中断', tone: 'destructive', description: '与 OpenQQ 的实时连接已断开，正在重连' };
  if (state.phase === 'session_ready' && state.syncing) return { label: '同步中', tone: 'warning', description: 'QQ 正在同步消息与好友列表，完成后即可执行动作' };
  return phaseMeta[state.phase] ?? { label: String(state.phase), tone: 'neutral', description: '' };
}

export const reverseMeta: Record<string, StatusMeta> = {
  waiting: { label: '等待 QQ', tone: 'neutral', description: 'QQ 会话就绪后发起连接' },
  connecting: { label: '连接中', tone: 'warning', description: '正在连接机器人地址' },
  connected: { label: '已连接', tone: 'success', description: '反向连接已建立' },
  reconnecting: { label: '重连中', tone: 'warning', description: '连接断开，正在重试' },
};

export const postMeta: Record<string, StatusMeta> = {
  waiting: { label: '等待事件', tone: 'neutral', description: '收到第一个事件后开始上报' },
  ok: { label: '上报正常', tone: 'success', description: '最近一次上报被接收' },
  failed: { label: '上报失败', tone: 'destructive', description: '最近一次上报没有成功（连接失败、超时或非 2xx 响应）' },
};

const dotColor: Record<Tone, string> = {
  success: 'bg-success', warning: 'bg-warning', destructive: 'bg-destructive', neutral: 'bg-muted-foreground/60', primary: 'bg-foreground', outline: 'bg-muted-foreground/60',
};
const toneIcon: Record<Tone, LucideIcon> = {
  success: CircleCheck, warning: LoaderCircle, destructive: CircleAlert, neutral: CircleDot, primary: CircleDot, outline: CircleDot,
};

export function StatusDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
    {pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-50', dotColor[tone])} />}
    <span className={cn('relative inline-flex size-2 rounded-full', dotColor[tone])} />
  </span>;
}

/** Status pill: tone is always paired with a label and an icon, never color alone. */
export function StatusBadge({ meta, icon = true, className }: { meta: Pick<StatusMeta, 'label' | 'tone'>; icon?: boolean; className?: string }) {
  const Icon = toneIcon[meta.tone];
  return <Badge tone={meta.tone} className={className}>
    {icon ? <Icon className={cn(meta.tone === 'warning' && 'animate-spin [animation-duration:2.4s]')} aria-hidden /> : <StatusDot tone={meta.tone} />}
    {meta.label}
  </Badge>;
}
