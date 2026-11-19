// OpenAI 兼容的生图接口（POST {Base URL}/images/generations）的客户端。
// 和 ai.mjs 一样：API Key 只在这里被放进 Authorization 头，错误信息会先擦掉 Key；请求不跟随重定向。
// 接口可能直接返回 base64（b64_json），也可能返回图片地址（url）。地址只在服务端下载：不带 Key、有大小上限，
// 并且拒绝指向本机和内网的地址（接口本身就在本机/内网时除外）。
import dns from 'node:dns/promises';
import net from 'node:net';
import { AIError, isLocalHost, normalizeBaseUrl, scrub } from './ai.mjs';
import { imageInfo, isBlockedAddress } from '../media.mjs';
import { imageDefaults, imageLimits, imageSizePattern } from './store.mjs';

// 一次最多 4 张、每张最多 16 MiB 的 base64（约 21 MiB 文字）；再留一点余量给 JSON 外壳。
const MAX_IMAGE = 16 * 1024 * 1024;
const MAX_RESPONSE = 96 * 1024 * 1024;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

// retcode 是 OneBot 动作 generate_image 用的返回码：参数或设置有问题 1400，已有任务在跑 1503，其他（接口、网络）按 1500。
const paramError = message => Object.assign(new AIError(message), { retcode: 1400 });
function busyError() {
  return Object.assign(new AIError('已有一个生图任务正在进行，请等它结束后再试'), { status: 429, retcode: 1503 });
}

async function readCapped(response, limit, what) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new AIError(`${what}过大，已中止`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** 把接口给的一条结果（b64_json 或 data: 文字）解成图片字节；校验文件头，不是图片就拒绝。 */
function decodeBase64(text) {
  const body = text.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) throw new AIError('接口返回的 base64 图片数据无效');
  if (body.length / 4 * 3 > MAX_IMAGE + 3) throw new AIError(`接口返回的图片超过 ${MAX_IMAGE / 1048576} MiB`);
  return Buffer.from(body, 'base64');
}

function describe(buffer) {
  const info = imageInfo(buffer.subarray(0, 1048576));
  if (!info || !MIME[info.format]) throw new AIError('接口返回的内容不是图片（支持 png、jpeg、gif、webp、bmp）');
  return { mime: MIME[info.format], width: info.width, height: info.height };
}

/**
 * @param {object} options
 * @param {() => { baseUrl: string, apiKey: string, model: string, size: string, count: number, timeoutSec: number }} options.settings 读取已保存的设置
 * @param {typeof fetch} [options.fetchImpl] 测试里可以替换
 * @param {(hostname: string) => Promise<string[]>} [options.resolve] 测试里可以替换域名解析
 */
export function createImageClient({ settings, fetchImpl = fetch, resolve = async host => (await dns.lookup(host, { all: true })).map(item => item.address) } = {}) {
  let busy = false;

  async function post(apiKey, base, body, limitMs) {
    let response;
    let text;
    try {
      response = await fetchImpl(base + '/images/generations', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(limitMs),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
        body: JSON.stringify(body),
      });
      text = (await readCapped(response, MAX_RESPONSE, '生图接口的响应')).toString('utf8');
    } catch (error) {
      if (error instanceof AIError) throw new AIError(scrub(error.message, apiKey));
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new AIError(`生图接口 ${Math.round(limitMs / 1000)} 秒内没有响应；可以在设置里调大超时`);
      const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? '';
      throw new AIError(scrub(`无法连接生图接口（${String(cause).slice(0, 120) || '网络错误'}）；请检查 Base URL 和网络`, apiKey));
    }
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (!response.ok) {
      const detail = json?.error?.message ?? json?.message ?? (typeof json?.error === 'string' ? json.error : text);
      throw new AIError(scrub(`生图接口返回 HTTP ${response.status}${detail ? '：' + String(detail).replace(/\s+/g, ' ').slice(0, 300) : ''}`, apiKey));
    }
    if (json === undefined) throw new AIError('生图接口返回的不是 JSON，请确认 Base URL 指向 OpenAI 兼容接口（通常以 /v1 结尾）');
    return json;
  }

  // 接口返回的是图片地址时在这里下载。不带 Key；地址和接口同源，或者解析出的地址都不在本机/内网才会请求。
  async function download(rawUrl, base, limitMs) {
    let url;
    try { url = new URL(rawUrl); } catch { throw new AIError('接口返回的图片地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AIError('接口返回的图片地址不受支持（只接受不带账号密码的 http(s) 地址）');
    const apiHost = new URL(base).hostname;
    const trusted = url.origin === new URL(base).origin || isLocalHost(apiHost);
    if (url.protocol === 'http:' && !isLocalHost(url.hostname) && !trusted) throw new AIError('接口返回的图片地址不是 https，已拒绝');
    if (!trusted) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = net.isIP(host) ? [host] : await resolve(host).catch(() => []);
      if (!addresses.length || addresses.some(isBlockedAddress)) throw new AIError('接口返回的图片地址指向本机或内网，已拒绝下载');
    }
    let response;
    try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(limitMs), headers: { Accept: 'image/*' } }); }
    catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new AIError('下载生成的图片超时');
      throw new AIError('下载生成的图片失败：' + String(error?.cause?.code ?? error?.message ?? '网络错误').slice(0, 120));
    }
    if (!response.ok) { response.body?.cancel().catch(() => {}); throw new AIError(`下载生成的图片失败：HTTP ${response.status}`); }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE) { response.body?.cancel().catch(() => {}); throw new AIError(`生成的图片超过 ${MAX_IMAGE / 1048576} MiB`); }
    return readCapped(response, MAX_IMAGE, '生成的图片');
  }

  /** 生成图片。返回 { images: [{ dataUrl, mime, width, height, bytes, revisedPrompt? }], model, size, elapsedMs }。 */
  async function generate({ config = settings(), prompt, model, size, count } = {}) {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (!text) throw paramError('请先写下想生成的画面（提示词）');
    if ([...text].length > imageLimits.promptChars) throw paramError(`提示词最多 ${imageLimits.promptChars} 个字符`);
    const chosen = (model || config.model || '').trim();
    if (!chosen) throw paramError('请先填写模型名称');
    const dimensions = String(size ?? config.size ?? imageDefaults.size).trim();
    if (!imageSizePattern.test(dimensions)) throw paramError('图片尺寸需要是 auto 或「宽x高」，例如 1024x1024');
    const amount = Number(count ?? config.count ?? 1);
    if (!Number.isInteger(amount) || amount < 1 || amount > imageLimits.maxCount) throw paramError(`一次最多生成 ${imageLimits.maxCount} 张`);
    let base;
    try { base = normalizeBaseUrl(config.baseUrl); } catch (error) { throw Object.assign(error, { retcode: 1400 }); }
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';
    if (!apiKey && !isLocalHost(new URL(base).hostname)) throw paramError('请先填写 API Key');
    const limitMs = Math.max(imageLimits.minTimeout, Math.min(Number(config.timeoutSec) || imageDefaults.timeoutSec, imageLimits.maxTimeout)) * 1000;
    if (busy) throw busyError();
    busy = true;
    const started = performance.now();
    try {
      const json = await post(apiKey, base, { model: chosen, prompt: text, n: amount, size: dimensions }, limitMs);
      const items = Array.isArray(json?.data) ? json.data.slice(0, amount) : [];
      const images = [];
      for (const item of items) {
        let buffer;
        if (typeof item?.b64_json === 'string' && item.b64_json) buffer = decodeBase64(item.b64_json);
        else if (typeof item?.url === 'string' && item.url) buffer = item.url.startsWith('data:') ? decodeBase64(item.url) : await download(item.url, base, limitMs);
        else continue;
        const info = describe(buffer);
        images.push({ dataUrl: `data:${info.mime};base64,${buffer.toString('base64')}`, mime: info.mime, width: info.width, height: info.height, bytes: buffer.length,
          ...(typeof item.revised_prompt === 'string' && item.revised_prompt ? { revisedPrompt: item.revised_prompt.slice(0, 1000) } : {}) });
      }
      if (!images.length) throw new AIError('接口没有返回可用的图片；请确认模型名称支持生图');
      return { images, model: chosen, size: dimensions, elapsedMs: Math.round(performance.now() - started) };
    } finally { busy = false; }
  }

  return { generate };
}
