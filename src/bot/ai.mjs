// OpenAI 兼容接口（/chat/completions、/models）的客户端。
// API Key 只在这里被读取、放进 Authorization 头；错误信息会擦掉 Key，所以不会进入日志、事件流或 /api 响应。
import net from 'node:net';

export class AIError extends Error {
  constructor(message) { super(message); this.name = 'AIError'; }
}

const MAX_RESPONSE = 1024 * 1024;

/** 本机、局域网和容器内部的主机名/地址：这些地址允许明文 http://（例如本地 Ollama）。 */
export function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'host.docker.internal') return true;
  if (/\.(?:local|lan|internal)$/.test(host) || (!host.includes('.') && !host.includes(':'))) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  return net.isIPv6(host) && (host === '::1' || /^f[cd]/.test(host) || host.startsWith('fe80'));
}

/**
 * 规范化用户填写的 Base URL：
 *   https://host            → https://host/v1
 *   https://host/v1/        → https://host/v1
 *   https://host/v1/chat/completions → https://host/v1（/models、/images/generations 同理）
 * 不接受账号密码、查询参数；非本机地址必须 https，避免把 Key 明文发到公网。
 */
export function normalizeBaseUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw new AIError('请填写 Base URL，例如 https://api.example.com/v1');
  let url;
  try { url = new URL(input.trim()); } catch { throw new AIError('Base URL 格式无效，例如 https://api.example.com/v1'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new AIError('Base URL 只支持 http:// 或 https://');
  if (url.username || url.password) throw new AIError('Base URL 里不要带账号密码，Key 请填到 API Key 栏');
  if (url.search || url.hash) throw new AIError('Base URL 里不要带 ? 或 # 参数');
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) throw new AIError('非本机地址必须使用 https://，否则 Key 会被明文发送');
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models|images\/generations)$/i, '');
  if (!path) path = '/v1';
  return url.origin + path;
}

export const originOf = baseUrl => { try { return new URL(baseUrl).origin; } catch { return ''; } };

/** 擦掉文字里的 API Key 和常见 Key/令牌样式，用于错误信息。 */
export function scrub(message, apiKey = '') {
  let result = String(message);
  if (apiKey.length >= 4) result = result.split(apiKey).join('***');
  return result.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***').replace(/\b(?:sk|key|tok|ak)[-_][A-Za-z0-9_-]{6,}/gi, '***');
}

async function readBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE) { await reader.cancel().catch(() => {}); throw new AIError('AI 接口响应过大，已中止'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  // 少数网关返回 [{type:'text', text:'...'}] 形式的分段内容。
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('');
  return '';
}

/**
 * @param {object} options
 * @param {() => { baseUrl: string, apiKey: string, model: string, temperature: number, maxTokens: number, timeoutSec: number }} options.settings 读取已保存的设置
 * @param {typeof fetch} [options.fetchImpl] 测试里可以替换
 */
export function createAIClient({ settings, fetchImpl = fetch } = {}) {
  async function call(config, path, { method = 'GET', body, timeout } = {}) {
    const base = normalizeBaseUrl(config.baseUrl);
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';
    if (!apiKey && !isLocalHost(new URL(base).hostname)) throw new AIError('请先填写 API Key');
    const limit = Math.max(1000, Math.min(timeout ?? config.timeoutSec * 1000, 120_000));
    let response;
    let text;
    try {
      response = await fetchImpl(base + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(limit),
        headers: { Accept: 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await readBody(response);
    } catch (error) {
      if (error instanceof AIError) throw new AIError(scrub(error.message, apiKey));
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new AIError(`AI 接口 ${Math.round(limit / 1000)} 秒内没有响应`);
      const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? '';
      throw new AIError(scrub(`无法连接 AI 接口（${String(cause).slice(0, 120) || '网络错误'}）；请检查 Base URL 和网络`, apiKey));
    }
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (!response.ok) {
      const detail = json?.error?.message ?? json?.message ?? (typeof json?.error === 'string' ? json.error : text);
      throw new AIError(scrub(`AI 接口返回 HTTP ${response.status}${detail ? '：' + String(detail).replace(/\s+/g, ' ').slice(0, 200) : ''}`, apiKey));
    }
    if (json === undefined) throw new AIError('AI 接口返回的不是 JSON，请确认 Base URL 指向 OpenAI 兼容接口（通常以 /v1 结尾）');
    return json;
  }

  async function chat({ messages, model, temperature, maxTokens, timeout, config = settings() }) {
    const chosen = model || config.model;
    if (!chosen) throw new AIError('请先选择模型');
    const json = await call(config, '/chat/completions', { method: 'POST', timeout, body: {
      model: chosen, messages, stream: false,
      temperature: temperature ?? config.temperature, max_tokens: maxTokens ?? config.maxTokens,
    } });
    const raw = contentText(json?.choices?.[0]?.message?.content);
    // 推理模型有时把思考过程放在 <think> 里，不应该发给用户。
    const answer = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!answer) throw new AIError('AI 没有返回文字内容');
    return answer;
  }

  async function listModels(config = settings()) {
    const json = await call(config, '/models');
    const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : Array.isArray(json?.models) ? json.models : [];
    const ids = rows.map(row => typeof row === 'string' ? row : row?.id ?? row?.name).filter(id => typeof id === 'string' && id && id.length <= 200);
    return [...new Set(ids)].sort().slice(0, 500);
  }

  /** 发一条很小的真实请求验证 Base URL、Key 和模型；不抛异常，失败信息放在 message 里。 */
  async function test(config = settings()) {
    const started = performance.now();
    try {
      const reply = await chat({ config, messages: [{ role: 'user', content: '请只回复 ok' }], maxTokens: 16, temperature: 0, timeout: 20_000 });
      return { ok: true, latency: Math.round(performance.now() - started), model: config.model, message: '连接成功', reply: reply.slice(0, 80) };
    } catch (error) {
      return { ok: false, latency: Math.round(performance.now() - started), model: config.model, message: error instanceof AIError ? error.message : '连接失败' };
    }
  }

  return { chat, listModels, test };
}
