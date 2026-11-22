import { useEffect, useState, type CSSProperties, type PointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Megaphone, Sparkles } from 'lucide-react';
import { request } from '../../lib/api';
import { useAds, type AdSettings } from '../../lib/bot';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Field, Input, Switch, Textarea } from '../ui/form';
import { toast } from '../ui/toast';

/**
 * 控制台里的推广位。它只是界面上的一条横幅：不会发到 QQ，也不会进入 AI 的提示词。
 * 「广告」标记写死在这里，不受设置影响，让人一眼看出这是推广内容而不是 OpenQQ 自己的提示。
 */
export function AdBanner({ ad }: { ad: Pick<AdSettings, 'text' | 'url'> }) {
  const [spot, setSpot] = useState({ x: '50%', y: '50%' });
  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setSpot({ x: `${Math.round(event.clientX - rect.left)}px`, y: `${Math.round(event.clientY - rect.top)}px` });
  }
  const style = { '--ad-x': spot.x, '--ad-y': spot.y } as CSSProperties;
  return <aside aria-label="广告" className="ad-banner group" onPointerMove={onPointerMove} style={style}>
    <div className="ad-banner-inner flex flex-wrap items-center gap-x-3.5 gap-y-2.5 px-4 py-3">
      <span className="ad-banner-aurora" aria-hidden />
      <span className="ad-banner-spotlight" aria-hidden />
      <span className="ad-banner-sheen" aria-hidden />
      <Badge tone="warning" className="relative z-10 shadow-sm ring-1 ring-warning/30">
        <span className="size-1.5 rounded-full bg-warning animate-[pulse-dot_1.6s_ease-in-out_infinite]" aria-hidden />
        <Megaphone aria-hidden />
        广告
      </Badge>
      <p className="relative z-10 flex min-w-0 flex-1 items-start gap-2 break-words text-caption font-medium text-foreground">
        <Sparkles className="ad-banner-sparkle mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        <span className="min-w-0 flex-1">{ad.text}</span>
      </p>
      {ad.url && <Button asChild size="sm" className="ad-banner-cta relative z-10">
        <a href={ad.url} target="_blank" rel="noopener noreferrer sponsored">
          了解更多
          <ExternalLink className="ad-banner-arrow" aria-hidden />
        </a>
      </Button>}
    </div>
  </aside>;
}

/** 「AI 接入」「AI 生图」页顶部：开启且有文案时才显示。读取失败时静默不显示，不影响页面其他功能。 */
export function AdSlot() {
  const ads = useAds();
  if (!ads.data?.enabled || !ads.data.text) return null;
  return <AdBanner ad={ads.data} />;
}

/** 修改推广位的文案、链接和开关。 */
export function AdSettingsCard() {
  const query = useAds();
  const client = useQueryClient();
  const [draft, setDraft] = useState<AdSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (query.data && !draft) setDraft(query.data); }, [query.data, draft]);
  if (!draft || !query.data) return null;
  const saved = query.data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const issues = {
    text: draft.text.trim().length > 300 ? '最多 300 个字符' : draft.enabled && !draft.text.trim() ? '开启时文案不能为空' : null,
    url: draft.url.trim() && !/^https?:\/\/[^\s/@]+(?:[/?#]\S*)?$/i.test(draft.url.trim()) ? '请填写 http:// 或 https:// 开头的网址' : null,
  };
  const valid = !issues.text && !issues.url;

  async function run(path: string, body: unknown, message: string) {
    setSaving(true);
    try {
      const next = await request<AdSettings>(path, body);
      client.setQueryData(['bot-ads'], next);
      setDraft(next);
      toast.success(message);
    } catch (error) { toast.error('保存失败', (error as Error).message); }
    finally { setSaving(false); }
  }

  return <Card>
    <CardHeader>
      <div className="grid gap-0.5"><CardTitle><Megaphone className="size-4 text-muted-foreground" aria-hidden />推广位</CardTitle>
        <CardDescription>页面顶部的那条广告。它只显示在这个控制台里，不会发到 QQ，也不会发给 AI。</CardDescription></div>
      <Badge tone={saved.enabled ? 'warning' : 'neutral'}>{saved.enabled ? '显示中' : '已关闭'}</Badge>
    </CardHeader>
    <CardContent className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3.5">
        <div className="grid gap-0.5"><span className="text-sm font-medium">显示推广位</span><span className="text-caption text-muted-foreground">关闭后「AI 接入」与「AI 生图」页不再显示广告。</span></div>
        <Switch checked={draft.enabled} onCheckedChange={enabled => setDraft({ ...draft, enabled })} aria-label="显示推广位" />
      </div>
      <Field label="文案" htmlFor="ad-text" error={issues.text} description={`${draft.text.trim().length} / 300。默认介绍 zelix.asia（API 中转站），可以改成任何你想说的话。`}>
        <Textarea id="ad-text" rows={3} value={draft.text} aria-invalid={Boolean(issues.text)} aria-describedby="ad-text-hint" onChange={event => setDraft({ ...draft, text: event.target.value })} />
      </Field>
      <Field label="链接" htmlFor="ad-url" error={issues.url} description="可选。显示为「了解更多」按钮，在新标签页打开；留空则不显示按钮。">
        <Input id="ad-url" value={draft.url} placeholder="https://zelix.asia" spellCheck={false} className="font-mono text-caption" aria-invalid={Boolean(issues.url)} aria-describedby="ad-url-hint"
          onChange={event => setDraft({ ...draft, url: event.target.value })} />
      </Field>
      <div className="grid gap-1.5"><span className="text-caption font-medium">预览</span>{draft.text.trim() ? <AdBanner ad={draft} /> : <p className="text-caption text-muted-foreground">文案为空，不会显示。</p>}</div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button onClick={() => { if (valid) void run('/api/bot/ads', draft, '推广位已保存'); else toast.error('请先修正标红的字段'); }} loading={saving} disabled={!dirty}>保存</Button>
        <Button variant="ghost" onClick={() => setDraft(saved)} disabled={!dirty || saving}>放弃修改</Button>
        <Button variant="ghost" className="ml-auto" onClick={() => void run('/api/bot/ads/reset', {}, '已恢复默认')} disabled={saving}>恢复默认</Button>
      </div>
    </CardContent>
  </Card>;
}
