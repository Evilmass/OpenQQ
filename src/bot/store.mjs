// Bot 配置和 AI 设置的落盘。目录结构（dir 默认 data/bot，可用 OPENQQ_DATA_DIR 指向别处）：
//   ai.json                  Base URL、API Key、模型……（权限 0600）。Key 只存在这里，不会写进别的文件。
//   image.json               生图接口的设置（Base URL、API Key、模型、尺寸……，权限 0600），和 ai.json 各存各的
//   ads.json                 WebUI 里推广位（广告）的文案、链接和开关；只用于界面显示，和 Bot、QQ 消息无关
//   bots/<id>/bot.json       一个 Bot：积木程序、人设、记忆设置、适用范围、频率限制
//   bots/<id>/memory.json    这个 Bot 的记忆（由 memory.mjs 管理）
// 所有写入都是「写临时文件再改名」，中途断电不会留下半个文件。
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { compileProgram } from './compile.mjs';
import { templates } from './templates.mjs';
import { defaultPersona, defaultMemorySettings, normalizePersona, normalizeMemorySettings } from './persona.mjs';
import { defaultAds, normalizeAds } from './ads.mjs';
import { normalizeBaseUrl, originOf } from './ai.mjs';

export const MAX_BOTS = 20;
const idPattern = /^b_[0-9a-f]{8}$/;
const fail = message => { throw new Error(message); };

function writeJson(path, value, mode = 0o600) {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode, flag: 'wx' }); renameSync(temp, path); }
  finally { try { rmSync(temp, { force: true }); } catch { /* ignore */ } }
}
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function integer(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(`${label}需要在 ${min}–${max} 之间`);
  return number;
}

// ---- AI 设置 ---------------------------------------------------------------------------------------------------
export const defaultAiSettings = () => ({ baseUrl: '', apiKey: '', model: '', temperature: 0.7, maxTokens: 512, timeoutSec: 30 });

/** 返回给 WebUI 的版本：永远不含 Key，只告诉前端「有没有填」和末 4 位。 */
export function publicAiSettings(settings) {
  const key = settings.apiKey;
  return {
    baseUrl: settings.baseUrl, model: settings.model, temperature: settings.temperature, maxTokens: settings.maxTokens, timeoutSec: settings.timeoutSec,
    apiKeySet: Boolean(key), apiKeyHint: key ? (key.length >= 12 ? '••••' + key.slice(-4) : '••••') : '',
  };
}

/**
 * 把前端提交的修改合并进当前设置。
 * apiKey 为空或不提供 = 保持原值；clearApiKey = 清除。
 * 换了 Base URL 的服务器地址（origin）时，必须同时重新填写 Key——绝不把旧 Key 发给新的服务器。
 */
export function mergeAiSettings(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('AI 设置格式无效');
  const next = { ...current };
  if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl === '' ? '' : normalizeBaseUrl(patch.baseUrl);
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string' || patch.model.length > 200 || /[\r\n]/.test(patch.model)) fail('模型名称无效');
    next.model = patch.model.trim();
  }
  if (patch.temperature !== undefined) {
    const value = Number(patch.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2) fail('温度需要在 0–2 之间');
    next.temperature = value;
  }
  if (patch.maxTokens !== undefined) next.maxTokens = integer(patch.maxTokens, 16, 8192, '最大回复长度（tokens）');
  if (patch.timeoutSec !== undefined) next.timeoutSec = integer(patch.timeoutSec, 5, 120, '超时秒数');
  const typed = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
  if (typed) {
    if (!/^[\x21-\x7e]{1,512}$/.test(typed)) fail('API Key 只能包含不含空格的可见 ASCII 字符（最多 512 位）');
    next.apiKey = typed;
  } else if (patch.clearApiKey === true) next.apiKey = '';
  else if (current.apiKey && originOf(next.baseUrl) !== originOf(current.baseUrl)) {
    fail('更换了 Base URL 的服务器地址，请同时重新填写 API Key（旧 Key 不会发给新的服务器）');
  }
  return next;
}

// ---- 生图设置 -------------------------------------------------------------------------------------------------
export const imageDefaults = { baseUrl: 'https://api.zelix.asia', model: 'gpt-image-1', size: '1024x1024', count: 1, timeoutSec: 120 };
export const imageLimits = { promptChars: 4000, maxCount: 4, minTimeout: 10, maxTimeout: 300 };
export const imageSizePattern = /^(?:auto|\d{3,4}x\d{3,4})$/;
export const defaultImageSettings = () => ({ baseUrl: imageDefaults.baseUrl, apiKey: '', model: imageDefaults.model, size: imageDefaults.size, count: imageDefaults.count, timeoutSec: imageDefaults.timeoutSec });

/** 返回给 WebUI 的版本：永远不含 Key，只告诉前端「有没有填」和末 4 位。 */
export function publicImageSettings(settings) {
  const key = settings.apiKey;
  return {
    baseUrl: settings.baseUrl, model: settings.model, size: settings.size, count: settings.count, timeoutSec: settings.timeoutSec,
    apiKeySet: Boolean(key), apiKeyHint: key ? (key.length >= 12 ? '••••' + key.slice(-4) : '••••') : '',
  };
}

/** 规则和 mergeAiSettings 一样：apiKey 为空 = 不改；clearApiKey = 清除；换了服务器地址必须同时重填 Key。 */
export function mergeImageSettings(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('生图设置格式无效');
  const next = { ...current };
  if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl === '' ? imageDefaults.baseUrl : normalizeBaseUrl(patch.baseUrl);
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string' || patch.model.length > 200 || /[\r\n]/.test(patch.model)) fail('模型名称无效');
    next.model = patch.model.trim();
  }
  if (patch.size !== undefined) {
    if (typeof patch.size !== 'string' || !imageSizePattern.test(patch.size.trim())) fail('图片尺寸需要是 auto 或「宽x高」，例如 1024x1024');
    next.size = patch.size.trim();
  }
  if (patch.count !== undefined) next.count = integer(patch.count, 1, imageLimits.maxCount, '一次生成的张数');
  if (patch.timeoutSec !== undefined) next.timeoutSec = integer(patch.timeoutSec, imageLimits.minTimeout, imageLimits.maxTimeout, '超时秒数');
  const typed = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
  if (typed) {
    if (!/^[\x21-\x7e]{1,512}$/.test(typed)) fail('API Key 只能包含不含空格的可见 ASCII 字符（最多 512 位）');
    next.apiKey = typed;
  } else if (patch.clearApiKey === true) next.apiKey = '';
  else if (current.apiKey && originOf(next.baseUrl) !== originOf(current.baseUrl)) {
    fail('更换了 Base URL 的服务器地址，请同时重新填写 API Key（旧 Key 不会发给新的服务器）');
  }
  return next;
}

// ---- Bot -------------------------------------------------------------------------------------------------------
const modes = ['all', 'allow', 'deny'];
export const defaultScope = () => ({ private: { mode: 'all', ids: [] }, group: { mode: 'all', ids: [] } });
export const defaultLimits = () => ({ sendsPerMinute: 20, aiPerMinute: 10, cooldownSeconds: 2 });

function normalizeScope(input, current = defaultScope()) {
  if (input === undefined) return current;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('适用范围格式无效');
  const result = {};
  for (const [key, label] of [['private', '私聊'], ['group', '群聊']]) {
    const value = { ...current[key], ...input[key] };
    if (!modes.includes(value.mode)) fail(`${label}范围无效`);
    if (!Array.isArray(value.ids) || value.ids.length > 200) fail(`${label}名单最多 200 个`);
    const ids = [...new Set(value.ids.map(Number))];
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) fail(`${label}名单里有无效的号码`);
    result[key] = { mode: value.mode, ids };
  }
  return result;
}
function normalizeLimits(input, current = defaultLimits()) {
  if (input === undefined) return current;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('频率限制格式无效');
  const merged = { ...current, ...input };
  return {
    sendsPerMinute: integer(merged.sendsPerMinute, 1, 120, '每分钟最多发送条数'),
    aiPerMinute: integer(merged.aiPerMinute, 1, 60, '每分钟最多调用 AI 次数'),
    cooldownSeconds: integer(merged.cooldownSeconds, 0, 60, '同一个人的触发间隔秒数'),
  };
}
function normalizeName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40) fail('Bot 名称需要 1–40 个字符');
  return value.trim();
}

/** 校验并合并一次修改。program 必须能通过 compileProgram，所以保存下来的程序一定能被引擎安全加载。 */
export function applyBotPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('Bot 数据格式无效');
  const next = { ...current };
  let warnings = [];
  if (patch.name !== undefined) next.name = normalizeName(patch.name);
  if (patch.enabled !== undefined) { if (typeof patch.enabled !== 'boolean') fail('启用开关必须是布尔值'); next.enabled = patch.enabled; }
  if (patch.program !== undefined) {
    warnings = compileProgram(patch.program).warnings;
    next.program = patch.program === null ? null : JSON.parse(JSON.stringify(patch.program));
  }
  next.persona = normalizePersona(patch.persona, current.persona);
  next.memory = normalizeMemorySettings(patch.memory, current.memory);
  next.scope = normalizeScope(patch.scope, current.scope);
  next.limits = normalizeLimits(patch.limits, current.limits);
  return { bot: next, warnings };
}

export function createBotStore({ dir, now = () => new Date() } = {}) {
  const bots = new Map();
  const skipped = [];
  const botDir = id => join(dir, 'bots', id);
  const checkId = id => { if (typeof id !== 'string' || !idPattern.test(id)) fail('Bot 不存在'); return id; };

  try {
    for (const entry of readdirSync(join(dir, 'bots'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
      try {
        const bot = readJson(join(botDir(entry.name), 'bot.json'));
        if (!bot || bot.version !== 1 || bot.id !== entry.name) throw new Error('文件内容无效');
        // 从默认值出发再套用文件里的内容：缺字段的旧文件也能打开，内容不合规的文件会被跳过而不是让整个服务起不来。
        const base = { ...bot, name: normalizeName(bot.name), enabled: bot.enabled === true, persona: defaultPersona(), memory: defaultMemorySettings(),
          scope: defaultScope(), limits: defaultLimits() };
        delete base.ads; // 早期草稿里广告是每个 Bot 一份，现在是全局的界面推广位，旧字段直接丢弃
        const loaded = applyBotPatch(base, { program: bot.program ?? null, persona: bot.persona, memory: bot.memory, scope: bot.scope, limits: bot.limits });
        bots.set(entry.name, loaded.bot);
      } catch (error) { skipped.push({ id: entry.name, error: error.message }); }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const save = bot => writeJson(join(botDir(bot.id), 'bot.json'), bot);
  const copy = bot => structuredClone(bot);
  let aiCache;
  let imageCache;
  let adsCache;

  return {
    dir, skipped,
    memoryFile: id => join(botDir(checkId(id)), 'memory.json'),
    // 每次收到消息都会读设置，所以缓存在内存里；只有 writeAi 会改它。
    readAi() { aiCache ??= { ...defaultAiSettings(), ...readJson(join(dir, 'ai.json')) }; return { ...aiCache }; },
    writeAi(settings) { writeJson(join(dir, 'ai.json'), settings, 0o600); aiCache = { ...settings }; },
    // 生图设置：和 AI 设置分开保存，只有 WebUI 的生图页会读写它。
    readImage() { imageCache ??= { ...defaultImageSettings(), ...readJson(join(dir, 'image.json')) }; return { ...imageCache }; },
    writeImage(settings) { writeJson(join(dir, 'image.json'), settings, 0o600); imageCache = { ...settings }; },
    // 界面推广位设置。文件损坏或字段不合规时退回默认值，不影响其他功能。
    readAds() {
      if (!adsCache) {
        try { adsCache = normalizeAds(readJson(join(dir, 'ads.json')), defaultAds()); } catch { adsCache = defaultAds(); }
      }
      return { ...adsCache };
    },
    writeAds(patch) { const next = normalizeAds(patch, this.readAds()); writeJson(join(dir, 'ads.json'), next, 0o644); adsCache = next; return { ...next }; },
    list() { return [...bots.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(copy); },
    /** 引擎每收到一条消息都要遍历 Bot，所以这里不拷贝；调用方只读，update 总是换成新对象，不会改动已返回的旧对象。 */
    live() { return [...bots.values()]; },
    get(id) { const bot = bots.get(id); return bot ? copy(bot) : undefined; },
    create({ name, template } = {}) {
      if (bots.size >= MAX_BOTS) fail(`最多创建 ${MAX_BOTS} 个 Bot`);
      const chosen = template === undefined ? undefined : templates.find(item => item.id === template);
      if (template !== undefined && !chosen) fail('模板不存在');
      let id;
      do id = 'b_' + randomBytes(4).toString('hex'); while (bots.has(id));
      const stamp = now().toISOString();
      const bot = { version: 1, id, name: normalizeName(name ?? chosen?.name ?? '新 Bot'), enabled: false, program: (chosen ?? templates[0]).program(),
        persona: defaultPersona(), memory: defaultMemorySettings(), scope: defaultScope(), limits: defaultLimits(), createdAt: stamp, updatedAt: stamp };
      bots.set(id, bot);
      save(bot);
      return copy(bot);
    },
    update(id, patch) {
      const current = bots.get(checkId(id));
      if (!current) fail('Bot 不存在');
      const { bot, warnings } = applyBotPatch(current, patch);
      bot.updatedAt = now().toISOString();
      bot.revision = (current.revision ?? 0) + 1; // 引擎按它判断要不要重新编译，比时间戳可靠
      save(bot);
      bots.set(id, bot);
      return { bot: copy(bot), warnings };
    },
    remove(id) {
      checkId(id);
      if (!bots.delete(id)) fail('Bot 不存在');
      rmSync(botDir(id), { recursive: true, force: true });
    },
  };
}
