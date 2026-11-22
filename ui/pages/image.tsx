import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Download, ExternalLink, ImagePlus, KeyRound, List, Plug, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { request } from '../lib/api';
import { useImageSettings, type ImageResult, type ImageSettings, type ImageTestResult } from '../lib/bot';
import { formatBytes } from '../lib/utils';
import { ErrorState, Page, PageHeader } from '../components/page';
import { AdSlot } from '../components/bot/ad';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/dialog';
import { Field, Input, SecretInput, Textarea } from '../components/ui/form';
import { Skeleton } from '../components/ui/misc';
import { PickInput } from '../components/ui/pick-input';
import { toast } from '../components/ui/toast';

/** 点击「获取 KEY」跳转的中转站。 */
const KEY_URL = 'https://zelix.asia';
const sizePresets = ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', '512x512', 'auto'];
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

interface Draft { baseUrl: string; apiKey: string; model: string; size: string; count: string; timeoutSec: string }
const toDraft = (settings: ImageSettings): Draft => ({ baseUrl: settings.baseUrl, apiKey: '', model: settings.model, size: settings.size, count: String(settings.count), timeoutSec: String(settings.timeoutSec) });

function numberIssue(value: string, min: number, max: number) {
  const number = Number(value);
  return value.trim() !== '' && Number.isInteger(number) && number >= min && number <= max ? null : `请输入 ${min}–${max} 的整数`;
}

export default function ImagePage() {
  const query = useImageSettings();
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<'save' | 'test' | 'models' | null>(null);
  const [test, setTest] = useState<ImageTestResult | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<ImageResult | null>(null);
  const [failure, setFailure] = useState('');
  useEffect(() => { if (query.data && !draft) setDraft(toDraft(query.data)); }, [query.data, draft]);

  if (query.isError) return <Page><PageHeader title="AI 生图" /><Card><ErrorState description={(query.error as Error).message} onRetry={() => query.refetch()} /></Card></Page>;
  if (!query.data || !draft) return <Page><PageHeader title="AI 生图" /><Skeleton className="h-96 rounded-xl" /></Page>;
  const saved = query.data;
  const { limits } = saved;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const issues = {
    size: /^(?:auto|\d{3,4}x\d{3,4})$/.test(draft.size.trim()) ? null : '填写 auto 或「宽x高」，例如 1024x1024',
    count: numberIssue(draft.count, 1, limits.maxCount),
    timeoutSec: numberIssue(draft.timeoutSec, limits.minTimeout, limits.maxTimeout),
    model: draft.model.trim() ? null : '请填写模型名称',
  };
  const valid = !Object.values(issues).some(Boolean);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(saved));
  const configured = saved.apiKeySet && Boolean(saved.model);
  // 测试、拉取模型、生成都只带表单里真正填写的内容；没填的 Key 由服务端决定要不要沿用已保存的。
  const form = () => ({ baseUrl: draft.baseUrl.trim(), ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}), model: draft.model.trim(), size: draft.size.trim(), count: Number(draft.count), timeoutSec: Number(draft.timeoutSec) });

  async function save(extra: Record<string, unknown> = {}) {
    if (!draft) return;
    setBusy('save');
    try {
      const next = await request<ImageSettings>('/api/bot/image', { ...form(), ...extra });
      client.setQueryData(['bot-image'], next);
      setDraft(toDraft(next));
      toast.success('生图设置已保存');
    } catch (error) { toast.error('保存失败', (error as Error).message); }
    finally { setBusy(null); }
  }
  async function testConnection() {
    setBusy('test'); setTest(null);
    try { setTest(await request<ImageTestResult>('/api/bot/image/test', form(), { timeout: 40000 })); }
    catch (error) { setTest({ ok: false, message: (error as Error).message, latency: 0 }); }
    finally { setBusy(null); }
  }
  async function fetchModels() {
    setBusy('models');
    try {
      const { models: list } = await request<{ models: string[] }>('/api/bot/image/models', form(), { timeout: 40000 });
      setModels(list);
      toast.success(`获取到 ${list.length} 个模型`, list.length ? '在「模型」栏的下拉里选择，生图模型的名字里通常带 image、dall-e 或 flux。' : undefined);
    } catch (error) { toast.error('获取模型列表失败', (error as Error).message); }
    finally { setBusy(null); }
  }
  async function generate() {
    if (!draft) return;
    setGenerating(true); setFailure('');
    try {
      // 生成可能要一两分钟：界面的等待时间比服务端的超时多留一点。
      setResult(await request<ImageResult>('/api/bot/image/generate', { ...form(), prompt }, { timeout: (Number(draft.timeoutSec) + 20) * 1000 }));
    } catch (error) { setFailure((error as Error).message); }
    finally { setGenerating(false); }
  }

  const promptLength = [...prompt].length;
  const promptIssue = promptLength > limits.promptChars ? `提示词最多 ${limits.promptChars} 个字符` : null;
  const canGenerate = valid && prompt.trim() !== '' && !promptIssue && !generating;

  return <Page>
    <PageHeader title="AI 生图" description="调用 OpenAI 兼容的 /images/generations 接口生成图片。默认使用 api.zelix.asia 中转站，也可以换成任何兼容的服务。"
      meta={<Badge tone={configured ? 'success' : 'warning'}>{saved.apiKeySet ? (saved.model ? '已配置' : '未选模型') : '未填 Key'}</Badge>} />

    <AdSlot />

    <Card>
      <CardHeader><div className="grid gap-0.5"><CardTitle><Plug className="size-4 text-muted-foreground" aria-hidden />接口</CardTitle><CardDescription>和「AI 接入」各存各的设置：这里的 Base URL 和 Key 只用于生图。</CardDescription></div></CardHeader>
      <CardContent className="grid gap-4">
        <Field label="Base URL" htmlFor="img-base" description="默认是 https://api.zelix.asia。只填域名时会自动补上 /v1，也可以直接粘贴完整的 …/images/generations 地址。">
          <Input id="img-base" value={draft.baseUrl} placeholder="https://api.zelix.asia" spellCheck={false} className="font-mono text-caption" aria-describedby="img-base-hint"
            onChange={event => set({ baseUrl: event.target.value })} />
        </Field>
        <Field label="API Key" htmlFor="img-key"
          description={saved.apiKeySet ? `已保存（${saved.apiKeyHint}）。留空表示不修改；更换了服务器地址时需要重新填写。` : '只保存在本机，不会出现在日志、事件流或页面里。还没有 Key？点右边的按钮去中转站获取（中转站由 OpenQQ 维护者运营，你也可以改用别的服务）。'}
          action={saved.apiKeySet ? <Button variant="destructive-ghost" size="xs" onClick={() => setConfirmClear(true)}><Trash2 />清除已保存的 Key</Button> : undefined}>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <SecretInput id="img-key" value={draft.apiKey} placeholder={saved.apiKeySet ? '留空保持不变' : 'sk-…'} aria-describedby="img-key-hint" onChange={event => set({ apiKey: event.target.value })} />
            </div>
            <Button asChild className="ad-banner-cta">
              <a href={KEY_URL} target="_blank" rel="noopener noreferrer sponsored" aria-label="点击获取 KEY（在新标签页打开 zelix.asia）"><ExternalLink className="ad-banner-arrow" aria-hidden />点击获取 KEY</a>
            </Button>
          </div>
        </Field>
        <Field label="模型" htmlFor="img-model" error={issues.model} description="直接输入模型名，或点「获取模型列表」后从下拉里选择。"
          action={<Button variant="outline" size="xs" onClick={fetchModels} loading={busy === 'models'}>{busy !== 'models' && <List />}获取模型列表</Button>}>
          <PickInput id="img-model" value={draft.model} onValueChange={model => set({ model })} options={models} placeholder="例如 gpt-image-1"
            listLabel={models.length ? `从 ${models.length} 个模型中选择` : '选择模型'} invalid={Boolean(issues.model)} describedBy="img-model-hint" selectClassName="w-64" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="图片尺寸" htmlFor="img-size" error={issues.size} description="宽x高，或 auto；具体支持哪些尺寸取决于模型。">
            <PickInput id="img-size" value={draft.size} onValueChange={size => set({ size })} options={sizePresets} listLabel="常用尺寸" invalid={Boolean(issues.size)} describedBy="img-size-hint" selectClassName="w-32" showSelected={false} />
          </Field>
          <Field label="张数" htmlFor="img-count" error={issues.count} description={`一次最多 ${limits.maxCount} 张。`}>
            <Input id="img-count" inputMode="numeric" value={draft.count} aria-invalid={Boolean(issues.count)} aria-describedby="img-count-hint" onChange={event => set({ count: event.target.value })} />
          </Field>
          <Field label="超时（秒）" htmlFor="img-timeout" error={issues.timeoutSec} description="生图通常要几十秒，慢的模型可以调大。">
            <Input id="img-timeout" inputMode="numeric" value={draft.timeoutSec} aria-invalid={Boolean(issues.timeoutSec)} aria-describedby="img-timeout-hint" onChange={event => set({ timeoutSec: event.target.value })} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button onClick={() => save()} loading={busy === 'save'} disabled={!valid || !dirty}>保存</Button>
          <Button variant="outline" onClick={testConnection} loading={busy === 'test'} disabled={!draft.baseUrl.trim()}><KeyRound />测试连接</Button>
          <span className="text-caption text-muted-foreground">测试只读取一次模型列表，不会生成图片，也不收费。</span>
        </div>
        {test && <div role="status" className="flex items-start gap-2.5 rounded-lg border bg-muted/30 p-3.5">
          {test.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />}
          <div className="grid min-w-0 gap-0.5 text-sm">
            <span className="font-medium">{test.ok ? `连接成功 · ${test.latency} ms` : '连接失败'}</span>
            <span className="break-words text-caption text-muted-foreground">{test.message}</span>
          </div>
        </div>}
      </CardContent>
    </Card>

    <Card>
      <CardHeader><div className="grid gap-0.5"><CardTitle><Sparkles className="size-4 text-muted-foreground" aria-hidden />生成</CardTitle><CardDescription>用上面表单里的设置（不需要先保存）生成图片；每次生成都会向接口计费。</CardDescription></div></CardHeader>
      <CardContent className="grid gap-4">
        <Field label="提示词" htmlFor="img-prompt" error={promptIssue} description={`${promptLength} / ${limits.promptChars} 字符。描述你想要的画面、风格和构图。`}>
          <Textarea id="img-prompt" rows={4} value={prompt} placeholder="例如：一只戴着飞行员护目镜的橘猫，坐在复古飞机的驾驶舱里，柔和的晨光，细腻的插画风格" aria-invalid={Boolean(promptIssue)} aria-describedby="img-prompt-hint"
            onChange={event => setPrompt(event.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={generate} loading={generating} disabled={!canGenerate}>{!generating && <ImagePlus />}{generating ? '生成中…' : '生成图片'}</Button>
          {generating && <span className="text-caption text-muted-foreground">通常需要几十秒，最长等 {draft.timeoutSec} 秒。</span>}
        </div>
        {failure && <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3.5">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0 break-words text-sm">{failure}</span>
        </div>}
        {result && <div className="grid gap-3">
          <p className="text-caption text-muted-foreground">模型 <span className="font-mono">{result.model}</span> · 尺寸 {result.size} · 用时 {(result.elapsedMs / 1000).toFixed(1)} 秒 · {result.images.length} 张</p>
          <ul className="grid gap-4 sm:grid-cols-2">
            {result.images.map((image, index) => <li key={index} className="grid gap-2 rounded-xl border bg-muted/20 p-3">
              <img src={image.dataUrl} alt={`生成的图片 ${index + 1}：${prompt.slice(0, 40)}`} width={image.width} height={image.height} className="h-auto w-full rounded-lg border bg-card object-contain" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-caption text-muted-foreground">{image.width}×{image.height} · {formatBytes(image.bytes)}</span>
                <Button asChild variant="outline" size="xs"><a href={image.dataUrl} download={`openqq-image-${index + 1}.${extensions[image.mime] ?? 'png'}`}><Download />下载</a></Button>
              </div>
              {image.revisedPrompt && <p className="break-words text-caption text-muted-foreground">模型改写后的提示词：{image.revisedPrompt}</p>}
            </li>)}
          </ul>
        </div>}
      </CardContent>
    </Card>

    <Card>
      <CardHeader><div className="grid gap-0.5"><CardTitle><ShieldCheck className="size-4 text-muted-foreground" aria-hidden />Key 的保管方式</CardTitle></div></CardHeader>
      <CardContent className="grid gap-1.5 text-caption text-muted-foreground">
        <p>API Key 只写入本机的 <span className="font-mono">data/bot/image.json</span>（权限仅限当前用户，已被 .gitignore 忽略），页面和接口只会显示「已保存」和末 4 位，和「AI 接入」的 Key 互不相通。</p>
        <p>请求只发往你填写的 Base URL，不跟随重定向；非本机、非内网地址必须使用 https://。接口返回图片地址时由 OpenQQ 在本机下载，不带 Key，并拒绝指向本机或内网的地址。</p>
        <p>生成的图片只显示在这个页面里，不会保存到磁盘，也不会发到 QQ；需要的话点「下载」自己保存。</p>
      </CardContent>
    </Card>

    <ConfirmDialog open={confirmClear} onOpenChange={setConfirmClear} title="清除已保存的 API Key？" description="清除后生图页无法调用接口，直到重新填写。" confirmLabel="清除" destructive
      onConfirm={() => { void save({ clearApiKey: true }); }} />
  </Page>;
}
