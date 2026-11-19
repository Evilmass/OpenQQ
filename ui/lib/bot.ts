import { useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api';
import type { Segment } from './types';

export interface AiSettings { baseUrl: string; model: string; temperature: number; maxTokens: number; timeoutSec: number; apiKeySet: boolean; apiKeyHint: string }
export interface AiTestResult { ok: boolean; message: string; latency: number; model?: string; reply?: string }

/** 生图页的设置：和 AI 接入各存各的，Key 同样永远不会返回。 */
export interface ImageSettings {
  baseUrl: string; model: string; size: string; count: number; timeoutSec: number; apiKeySet: boolean; apiKeyHint: string;
  limits: { promptChars: number; maxCount: number; minTimeout: number; maxTimeout: number };
}
export interface ImageTestResult { ok: boolean; message: string; latency: number; models?: number }
export interface GeneratedImage { dataUrl: string; mime: string; width: number; height: number; bytes: number; revisedPrompt?: string }
export interface ImageResult { images: GeneratedImage[]; model: string; size: string; elapsedMs: number }

export interface Persona { name: string; systemPrompt: string; personality: string; traits: string; style: string; temperature: number | null }
export interface MemorySettings { enabled: boolean; contextTurns: number; summary: 'rule' | 'ai' }
/** WebUI 里的推广位：只在界面显示，和 Bot、QQ 消息无关。 */
export interface AdSettings { enabled: boolean; text: string; url: string }
export interface ScopeRule { mode: 'all' | 'allow' | 'deny'; ids: number[] }
export interface Scope { private: ScopeRule; group: ScopeRule }
export interface Limits { sendsPerMinute: number; aiPerMinute: number; cooldownSeconds: number }

export interface Bot {
  id: string; name: string; enabled: boolean; program: unknown;
  persona: Persona; memory: MemorySettings; scope: Scope; limits: Limits;
  createdAt: string; updatedAt: string;
}
export interface BotSummary { id: string; name: string; enabled: boolean; hats: number; createdAt: string; updatedAt: string }
export interface Preset { id: string; label: string; text: string }
export interface BotList {
  bots: BotSummary[]; max: number;
  status: { active: number; events: number; runs: number; errors: number; limited: number; dropped: number };
  templates: { id: string; name: string; description: string }[];
  presets: { personality: Preset[]; style: Preset[] };
}

export interface RunRecord { time: string; trigger: string; chat: string; user: number; status: 'ok' | 'error' | 'limited'; steps: number; messages: number; elapsed: number; error?: string; simulated?: boolean }
export interface SimulateResult { matched: string[]; outputs: { target: { type: string; id: number }; segments: Segment[]; text: string }[]; runs: RunRecord[] }

export interface MemoryOverview {
  stats: { chats: number; turns: number; notes: number; bytes: number; maxBytes: number };
  chats: { key: string; turns: number; summaryChars: number; notes: number; updatedAt: number }[];
  notes: [string, string][];
  limits: { notes: number; chats: number; summaryChars: number; softTurns: number };
}
export interface ChatMemory { key: string; summary: string; turns: { role: 'user' | 'assistant'; name: string; text: string; time: number }[]; notes: [string, string][] }

export const triggerNames: Record<string, string> = {
  oq_on_message: '收到消息', oq_on_mention: '被 @', oq_on_keyword: '关键词', oq_on_command: '命令',
};

export const useAiSettings = () => useQuery({ queryKey: ['bot-ai'], queryFn: () => request<AiSettings>('/api/bot/ai') });
export const useImageSettings = () => useQuery({ queryKey: ['bot-image'], queryFn: () => request<ImageSettings>('/api/bot/image') });
export const useAds = () => useQuery({ queryKey: ['bot-ads'], queryFn: () => request<AdSettings>('/api/bot/ads'), staleTime: 60_000 });
export const useBotList = () => useQuery({ queryKey: ['bot-list'], queryFn: () => request<BotList>('/api/bot/bots'), refetchInterval: 15_000 });
export const useBot = (id: string | null) => useQuery({ queryKey: ['bot', id], enabled: Boolean(id), queryFn: async () => (await request<{ bot: Bot }>(`/api/bot/bots/${id}`)).bot });
export const useRuns = (id: string | null) => useQuery({ queryKey: ['bot-runs', id], enabled: Boolean(id), refetchInterval: 4000, queryFn: async () => (await request<{ runs: RunRecord[] }>(`/api/bot/bots/${id}/runs`)).runs });
export const useMemoryOverview = (id: string | null) => useQuery({ queryKey: ['bot-memory', id], enabled: Boolean(id), queryFn: () => request<MemoryOverview>(`/api/bot/bots/${id}/memory`) });

/** 保存对 Bot 的修改（只提交改动的部分），并刷新缓存。 */
export function useBotActions() {
  const client = useQueryClient();
  return {
    async update(id: string, patch: Partial<Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>>) {
      const result = await request<{ bot: Bot; warnings: string[] }>(`/api/bot/bots/${id}`, patch);
      client.setQueryData(['bot', id], result.bot);
      await client.invalidateQueries({ queryKey: ['bot-list'] });
      return result;
    },
    async create(name: string, template: string) {
      const { bot } = await request<{ bot: Bot }>('/api/bot/bots', { name, template });
      client.setQueryData(['bot', bot.id], bot);
      await client.invalidateQueries({ queryKey: ['bot-list'] });
      return bot;
    },
    async remove(id: string) {
      await request(`/api/bot/bots/${id}/delete`, {});
      client.removeQueries({ queryKey: ['bot', id] });
      await client.invalidateQueries({ queryKey: ['bot-list'] });
    },
  };
}
