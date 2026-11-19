// WebUI 的 /api/bot/* 接口。鉴权、同源检查和请求体大小限制由 webui.mjs 统一完成，这里只做业务。
// 约定：任何响应都不含 API Key（见 publicAiSettings）；AI 设置的修改、测试都走这里。
import { createAIClient, normalizeBaseUrl, originOf } from './ai.mjs';
import { createImageClient } from './image.mjs';
import { mergeAiSettings, mergeImageSettings, publicAiSettings, publicImageSettings, imageLimits, MAX_BOTS } from './store.mjs';
import { compileProgram } from './compile.mjs';
import { templates } from './templates.mjs';
import { personalityPresets, replyStyles } from './persona.mjs';
import { defaultAds } from './ads.mjs';

export class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createBotApi({ store, engine, ai, image = createImageClient({ settings: () => store.readImage() }) }) {
  function summary(bot) {
    let hats = 0;
    try { hats = compileProgram(bot.program).hats.length; } catch { /* 摘要里不显示错误 */ }
    return { id: bot.id, name: bot.name, enabled: bot.enabled, hats, createdAt: bot.createdAt, updatedAt: bot.updatedAt };
  }
  const need = id => { const bot = store.get(id); if (!bot) throw new ApiError('Bot 不存在', 404); return bot; };

  // 测试连接 / 拉取模型列表用的“草稿”设置：表单里填的优先，没填的用已保存的。
  // 服务器地址变了而没有重新输入 Key 时，不会拿已保存的 Key 去请求新地址。
  function draftSettings(body) {
    const saved = store.readAi();
    const draft = { ...saved };
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) draft.baseUrl = normalizeBaseUrl(body.baseUrl);
    if (typeof body.model === 'string' && body.model.trim()) draft.model = body.model.trim();
    const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (key) draft.apiKey = mergeAiSettings({ ...saved, apiKey: '' }, { apiKey: key, baseUrl: draft.baseUrl }).apiKey;
    else if (originOf(draft.baseUrl) !== originOf(saved.baseUrl)) draft.apiKey = '';
    return draft;
  }

  // 生图页的草稿设置，规则同上：表单里填的优先，换了服务器地址又没重新输入 Key 时不会沿用已保存的 Key。
  function draftImageSettings(body) {
    const saved = store.readImage();
    const draft = { ...saved };
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) draft.baseUrl = normalizeBaseUrl(body.baseUrl);
    const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (key) draft.apiKey = mergeImageSettings({ ...saved, apiKey: '' }, { apiKey: key, baseUrl: draft.baseUrl }).apiKey;
    else if (originOf(draft.baseUrl) !== originOf(saved.baseUrl)) draft.apiKey = '';
    const patch = {};
    for (const field of ['model', 'size', 'count', 'timeoutSec']) if (body[field] !== undefined && body[field] !== '') patch[field] = body[field];
    return mergeImageSettings(draft, patch);
  }

  const routes = {
    'GET /api/bot/image': () => ({ ...publicImageSettings(store.readImage()), limits: imageLimits }),
    'POST /api/bot/image': ({ body }) => {
      store.writeImage(mergeImageSettings(store.readImage(), body));
      return { ...publicImageSettings(store.readImage()), limits: imageLimits };
    },
    'POST /api/bot/image/models': async ({ body }) => {
      try { return { models: await ai.listModels(draftImageSettings(body)) }; }
      catch (error) { throw new ApiError(error.message); }
    },
    // 测试连接只读一次模型列表：免费，也不会生成图片。
    'POST /api/bot/image/test': async ({ body }) => {
      const started = performance.now();
      try {
        const models = await ai.listModels(draftImageSettings(body));
        return { ok: true, latency: Math.round(performance.now() - started), message: `连接成功，接口返回 ${models.length} 个模型`, models: models.length };
      } catch (error) { return { ok: false, latency: Math.round(performance.now() - started), message: error.message }; }
    },
    'POST /api/bot/image/generate': async ({ body }) => {
      try { return await image.generate({ config: draftImageSettings(body), prompt: body.prompt }); }
      catch (error) { throw new ApiError(error.message, Number.isInteger(error.status) ? error.status : 400); }
    },
    'GET /api/bot/ai': () => publicAiSettings(store.readAi()),
    'POST /api/bot/ai': ({ body }) => {
      store.writeAi(mergeAiSettings(store.readAi(), body));
      return publicAiSettings(store.readAi());
    },
    'POST /api/bot/ai/test': async ({ body }) => {
      let draft;
      try { draft = draftSettings(body); } catch (error) { return { ok: false, message: error.message, latency: 0 }; }
      return ai.test(draft);
    },
    'POST /api/bot/ai/models': async ({ body }) => {
      try { return { models: await ai.listModels(draftSettings(body)) }; }
      catch (error) { throw new ApiError(error.message); }
    },
    // 界面推广位：只给 WebUI 显示和修改，不参与 Bot 的运行。
    'GET /api/bot/ads': () => store.readAds(),
    'POST /api/bot/ads': ({ body }) => store.writeAds(body),
    'POST /api/bot/ads/reset': () => store.writeAds(defaultAds()),
    'GET /api/bot/bots': () => ({
      bots: store.list().map(summary), max: MAX_BOTS, status: engine.status(),
      templates: templates.map(({ id, name, description }) => ({ id, name, description })),
      presets: { personality: Object.entries(personalityPresets).map(([id, item]) => ({ id, label: item.label, text: item.text })),
        style: Object.entries(replyStyles).map(([id, item]) => ({ id, label: item.label, text: item.text })) },
    }),
    'POST /api/bot/bots': ({ body }) => ({ bot: store.create({ name: body.name, template: body.template }) }),
  };

  // /api/bot/bots/<id>[/动作]
  const perBot = {
    'GET ': ({ bot }) => ({ bot, status: engine.status() }),
    'POST ': ({ bot, body }) => {
      const result = store.update(bot.id, body);
      return result;
    },
    'POST delete': ({ bot }) => { engine.forget(bot.id); store.remove(bot.id); return { ok: true }; },
    'POST simulate': ({ bot, body }) => engine.simulate(bot.id, body),
    'GET runs': ({ bot }) => ({ runs: engine.runsOf(bot.id) }),
    'GET memory': ({ bot }) => {
      const memory = engine.memoryOf(bot.id);
      return { stats: memory.stats(), chats: memory.listChats(), notes: memory.notesFor(''), limits: memory.limits };
    },
    'GET memory/chat': ({ bot, query }) => {
      const key = query.get('key') ?? '';
      const memory = engine.memoryOf(bot.id);
      const known = memory.listChats().find(chat => chat.key === key);
      if (!known) throw new ApiError('没有这个会话的记忆', 404);
      return { key, summary: memory.summary(key), turns: memory.recent(key, memory.limits.hardTurns), notes: memory.notesFor(key).slice(memory.notesFor('').length) };
    },
    'GET memory/export': ({ bot }) => engine.memoryOf(bot.id).exportData({ bot: { id: bot.id, name: bot.name } }),
    'POST memory/clear': ({ bot, body }) => {
      const memory = engine.memoryOf(bot.id);
      if (body.scope === 'chat') {
        if (typeof body.chatKey !== 'string' || !/^(?:[gp]:\d+|sim:[gp])$/.test(body.chatKey)) throw new ApiError('会话标识无效');
        memory.clearChat(body.chatKey);
      } else if (['all', 'chats', 'notes'].includes(body.scope)) memory.clear(body.scope);
      else throw new ApiError('scope 需要是 all、chats、notes 或 chat');
      memory.flush();
      return { stats: memory.stats() };
    },
  };

  /** 返回 undefined 表示不是 /api/bot 的路径。出错时抛 ApiError。 */
  async function handle({ method, path, query = new URLSearchParams(), body }) {
    if (!path.startsWith('/api/bot/')) return undefined;
    if (method === 'POST' && !object(body)) throw new ApiError('需要 JSON 对象');
    const direct = routes[`${method} ${path}`];
    if (direct) return direct({ body: body ?? {}, query });
    const match = path.match(/^\/api\/bot\/bots\/([^/]+)(?:\/(.+))?$/);
    const action = perBot[`${method} ${match?.[2] ?? ''}`];
    if (!match || !action) throw new ApiError('未找到入口', 404);
    try { return await action({ bot: need(match[1]), body: body ?? {}, query }); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error.message);
    }
  }

  return { handle };
}
