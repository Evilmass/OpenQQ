import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, KeyRound, List, Plug, ShieldCheck, Trash2 } from 'lucide-react';
import { request } from '../lib/api';
import { useAiSettings, type AiSettings, type AiTestResult } from '../lib/bot';
import { AdSettingsCard, AdSlot } from '../components/bot/ad';
import { ErrorState, Page, PageHeader } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/dialog';
import { Field, Input, SecretInput } from '../components/ui/form';
import { Skeleton } from '../components/ui/misc';
import { PickInput } from '../components/ui/pick-input';
import { toast } from '../components/ui/toast';

interface Draft { baseUrl: string; apiKey: string; model: string; temperature: string; maxTokens: string; timeoutSec: string }
const toDraft = (settings: AiSettings): Draft => ({ baseUrl: settings.baseUrl, apiKey: '', model: settings.model, temperature: String(settings.temperature), maxTokens: String(settings.maxTokens), timeoutSec: String(settings.timeoutSec) });

function numberIssue(value: string, min: number, max: number, integer = false) {
  const number = Number(value);
  return value.trim() !== '' && Number.isFinite(number) && number >= min && number <= max && (!integer || Number.isInteger(number)) ? null : `请输入 ${min}–${max}${integer ? ' 的整数' : ''}`;
}

export default function AiPage() {
  const query = useAiSettings();
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<'save' | 'test' | 'models' | null>(null);
  const [result, setResult] = useState<AiTestResult | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => { if (query.data && !draft) setDraft(toDraft(query.data)); }, [query.data, draft]);

  if (query.isError) return <Page><PageHeader title="AI 接入" /><Card><ErrorState description={(query.error as Error).message} onRetry={() => query.refetch()} /></Card></Page>;
  if (!query.data || !draft) return <Page><PageHeader title="AI 接入" /><Skeleton className="h-96 rounded-xl" /></Page>;
  const saved = query.data;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const issues = {
    temperature: numberIssue(draft.temperature, 0, 2), maxTokens: numberIssue(draft.maxTokens, 16, 8192, true), timeoutSec: numberIssue(draft.timeoutSec, 5, 120, true),
  };
  const valid = !Object.values(issues).some(Boolean);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(saved));
  // 测试/拉取模型时只带用户在表单里真正填写的内容；没填的 Key 由服务端决定要不要沿用已保存的。
  const form = () => ({ baseUrl: draft.baseUrl.trim(), ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}), model: draft.model.trim() });

  async function save(extra: Record<string, unknown> = {}) {
    if (!draft) return;
    setBusy('save');
    try {
      const next = await request<AiSettings>('/api/bot/ai', { ...form(), temperature: Number(draft.temperature), maxTokens: Number(draft.maxTokens), timeoutSec: Number(draft.timeoutSec), ...extra });
      client.setQueryData(['bot-ai'], next);
      setDraft(toDraft(next));
      toast.success('AI 设置已保存');
    } catch (error) { toast.error('保存失败', (error as Error).message); }
    finally { setBusy(null); }
  }
  async function test() {
    setBusy('test'); setResult(null);
    try { setResult(await request<AiTestResult>('/api/bot/ai/test', form(), { timeout: 40000 })); }
    catch (error) { setResult({ ok: false, message: (error as Error).message, latency: 0 }); }
    finally { setBusy(null); }
  }
  async function fetchModels() {
    setBusy('models');
    try {
      const { models: list } = await request<{ models: string[] }>('/api/bot/ai/models', form(), { timeout: 40000 });
      setModels(list);
      toast.success(`获取到 ${list.length} 个模型`, list.length ? '在「模型」栏的下拉里选择。' : undefined);
    } catch (error) { toast.error('获取模型列表失败', (error as Error).message); }
    finally { setBusy(null); }
  }

  return <Page>
    <PageHeader title="AI 接入" description="填写 OpenAI 兼容接口的 Base URL 和 API Key，所有 Bot 共用。" meta={<Badge tone={saved.apiKeySet && saved.model ? 'success' : 'warning'}>{saved.apiKeySet ? (saved.model ? '已配置' : '未选模型') : '未填 Key'}</Badge>} />
    <AdSlot />

    <Card>
      <CardHeader><div className="grid gap-0.5"><CardTitle><Plug className="size-4 text-muted-foreground" aria-hidden />接口</CardTitle><CardDescription>支持任何兼容 <span className="font-mono">/chat/completions</span> 的服务，包括中转站和本机模型（如 Ollama）。</CardDescription></div></CardHeader>
      <CardContent className="grid gap-4">
        <Field label="Base URL" htmlFor="ai-base" description="例如 https://api.example.com/v1。只填域名时会自动补上 /v1，也可以直接粘贴完整的 …/chat/completions 地址。">
          <Input id="ai-base" value={draft.baseUrl} placeholder="https://api.example.com/v1" spellCheck={false} className="font-mono text-caption" aria-describedby="ai-base-hint"
            onChange={event => set({ baseUrl: event.target.value })} />
        </Field>
        <Field label="API Key" htmlFor="ai-key" description={saved.apiKeySet ? `已保存（${saved.apiKeyHint}）。留空表示不修改；更换了服务器地址时需要重新填写。` : '只保存在本机，不会出现在日志、事件流和接口响应里。'}
          action={saved.apiKeySet ? <Button variant="destructive-ghost" size="xs" onClick={() => setConfirmClear(true)}><Trash2 />清除已保存的 Key</Button> : undefined}>
          <SecretInput id="ai-key" value={draft.apiKey} placeholder={saved.apiKeySet ? '留空保持不变' : 'sk-…'} aria-describedby="ai-key-hint" onChange={event => set({ apiKey: event.target.value })} />
        </Field>
        <Field label="模型" htmlFor="ai-model" description="直接输入模型名，或点「获取模型列表」后从下拉里选择。"
          action={<Button variant="outline" size="xs" onClick={fetchModels} loading={busy === 'models'}>{busy !== 'models' && <List />}获取模型列表</Button>}>
          <PickInput id="ai-model" value={draft.model} onValueChange={model => set({ model })} options={models} placeholder="例如 gpt-4o-mini"
            listLabel={models.length ? `从 ${models.length} 个模型中选择` : '选择模型'} describedBy="ai-model-hint" selectClassName="w-64" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="温度" htmlFor="ai-temp" error={issues.temperature} description="越高越随机，0–2。每个 Bot 可以在人设里单独设置。">
            <Input id="ai-temp" inputMode="decimal" value={draft.temperature} aria-invalid={Boolean(issues.temperature)} aria-describedby="ai-temp-hint" onChange={event => set({ temperature: event.target.value })} />
          </Field>
          <Field label="最大回复长度" htmlFor="ai-tokens" error={issues.maxTokens} description="单次回答最多多少 tokens。">
            <Input id="ai-tokens" inputMode="numeric" value={draft.maxTokens} aria-invalid={Boolean(issues.maxTokens)} aria-describedby="ai-tokens-hint" onChange={event => set({ maxTokens: event.target.value })} />
          </Field>
          <Field label="超时（秒）" htmlFor="ai-timeout" error={issues.timeoutSec} description="等待接口响应的最长时间。">
            <Input id="ai-timeout" inputMode="numeric" value={draft.timeoutSec} aria-invalid={Boolean(issues.timeoutSec)} aria-describedby="ai-timeout-hint" onChange={event => set({ timeoutSec: event.target.value })} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button onClick={() => save()} loading={busy === 'save'} disabled={!valid || !dirty}>保存</Button>
          <Button variant="outline" onClick={test} loading={busy === 'test'} disabled={!draft.baseUrl.trim()}><KeyRound />测试连接</Button>
          <span className="text-caption text-muted-foreground">测试会用表单里的内容发一条很小的真实请求（不需要先保存）。</span>
        </div>
        {result && <div role="status" className="flex items-start gap-2.5 rounded-lg border bg-muted/30 p-3.5">
          {result.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />}
          <div className="grid min-w-0 gap-0.5 text-sm">
            <span className="font-medium">{result.ok ? `连接成功 · ${result.latency} ms` : '连接失败'}</span>
            <span className="break-words text-caption text-muted-foreground">{result.ok ? `模型 ${result.model} 回复：${result.reply}` : result.message}</span>
          </div>
        </div>}
      </CardContent>
    </Card>

    <Card>
      <CardHeader><div className="grid gap-0.5"><CardTitle><ShieldCheck className="size-4 text-muted-foreground" aria-hidden />Key 的保管方式</CardTitle></div></CardHeader>
      <CardContent className="grid gap-1.5 text-caption text-muted-foreground">
        <p>API Key 只写入本机的 <span className="font-mono">data/bot/ai.json</span>（权限仅限当前用户，已被 .gitignore 忽略），页面和接口只会显示「已保存」和末 4 位。</p>
        <p>请求只发往你填写的 Base URL，不跟随重定向；非本机、非内网地址必须使用 https://。更换服务器地址时需要重新填写 Key，旧 Key 不会被发给新地址。</p>
        <p>接口返回的错误信息会先擦除 Key 再显示。控制台访问仍然需要启动时生成的访问密钥。</p>
      </CardContent>
    </Card>

    <AdSettingsCard />

    <ConfirmDialog open={confirmClear} onOpenChange={setConfirmClear} title="清除已保存的 API Key？" description="清除后所有 Bot 都无法调用 AI，直到重新填写。" confirmLabel="清除" destructive
      onConfirm={() => { void save({ clearApiKey: true }); }} />
  </Page>;
}
