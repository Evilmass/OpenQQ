// 每个 Bot 一份独立的记忆，落盘成一个 JSON 文件（memory.json）：
//   notes   整个 Bot 共用的笔记（积木「记住 … 范围：整个 Bot」）
//   chats   按会话分区（g:群号 / p:QQ号）：最近的对话原文 turns、更早对话的摘要 summary、本会话笔记 notes
// 体积靠上限控制：每轮文字、每个会话的原文条数、摘要长度、笔记条数、会话个数、整个文件的字节数。
// 对话原文超过 softTurns 时，把最旧的一批折进摘要（默认按规则压缩成一行一句，也可以传入 AI 摘要函数，失败自动回退）。
// 内部全部用 Map，避免笔记名叫 "__proto__" 之类时污染原型。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const memoryLimits = {
  softTurns: 40, keepTurns: 24, hardTurns: 100, turnChars: 2000, summaryChars: 1500,
  notes: 100, keyChars: 40, valueChars: 500, chats: 200, bytes: 2 * 1024 * 1024,
};

const oneLine = (value, max) => {
  const flat = String(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
};
const text = (value, max) => (typeof value === 'string' ? value : '').slice(0, max);

export function createMemory({ file, limits: overrides = {}, now = Date.now, saveDelay = 400 } = {}) {
  const limits = { ...memoryLimits, ...overrides };
  const notes = new Map();
  const chats = new Map();
  let timer = null;
  let dirty = false;

  function tail(value, max) {
    if (value.length <= max) return value;
    const cut = value.slice(value.length - max);
    const newline = cut.indexOf('\n');
    return '…' + (newline >= 0 && newline < 120 ? cut.slice(newline + 1) : cut);
  }
  const readNotes = (source, into) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    for (const [key, value] of Object.entries(source)) {
      if (into.size >= limits.notes) break;
      if (key && key.length <= limits.keyChars && typeof value === 'string') into.set(key, value.slice(0, limits.valueChars));
    }
  };

  function load() {
    let raw;
    try { raw = readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let data;
    try {
      data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || data.version !== 1) throw new Error('记忆文件版本无效');
    } catch {
      // 文件损坏时保留原文件供人工查看，从空记忆重新开始，而不是让 Bot 起不来。
      try { renameSync(file, `${file}.bad-${Date.now()}`); } catch { /* 忽略 */ }
      return;
    }
    readNotes(data.notes, notes);
    for (const [key, value] of Object.entries(data.chats ?? {})) {
      if (chats.size >= limits.chats || !/^[gp]:\d+$|^sim:[gp]$/.test(key) || !value || typeof value !== 'object') continue;
      const chat = { summary: text(value.summary, limits.summaryChars), turns: [], notes: new Map(), updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0 };
      for (const turn of Array.isArray(value.turns) ? value.turns.slice(-limits.hardTurns) : []) {
        if (turn && (turn.r === 'u' || turn.r === 'a') && typeof turn.t === 'string') {
          chat.turns.push({ r: turn.r, n: text(turn.n, 40), t: turn.t.slice(0, limits.turnChars), ts: Number.isFinite(turn.ts) ? turn.ts : 0 });
        }
      }
      readNotes(value.notes, chat.notes);
      chats.set(key, chat);
    }
  }
  load();

  const serialize = () => ({
    version: 1,
    notes: Object.fromEntries(notes),
    chats: Object.fromEntries([...chats].map(([key, chat]) => [key, { updatedAt: chat.updatedAt, summary: chat.summary, notes: Object.fromEntries(chat.notes), turns: chat.turns }])),
  });

  function write() {
    timer = null;
    if (!dirty) return;
    // 超过整体字节上限就淘汰最久没有更新的会话，直到放得下为止。
    let body = JSON.stringify(serialize());
    while (Buffer.byteLength(body) > limits.bytes && chats.size) {
      const oldest = [...chats].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0][0];
      chats.delete(oldest);
      body = JSON.stringify(serialize());
    }
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try { writeFileSync(temp, body, { mode: 0o600, flag: 'wx' }); renameSync(temp, file); }
    finally { try { rmSync(temp, { force: true }); } catch { /* ignore */ } }
    dirty = false;
  }
  function touch() {
    dirty = true;
    if (!timer && saveDelay >= 0) { timer = setTimeout(() => { try { write(); } catch { /* 下次保存重试 */ } }, saveDelay); timer.unref?.(); }
  }

  function chatFor(key) {
    let chat = chats.get(key);
    if (!chat) {
      chat = { summary: '', turns: [], notes: new Map(), updatedAt: now() };
      chats.set(key, chat);
      if (chats.size > limits.chats) {
        const oldest = [...chats].filter(([name]) => name !== key).sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
        if (oldest) chats.delete(oldest[0]);
      }
    }
    return chat;
  }
  const publicTurn = turn => ({ role: turn.r === 'u' ? 'user' : 'assistant', name: turn.n, text: turn.t, time: turn.ts });

  function foldRule(chat, count) {
    const removed = chat.turns.splice(0, count);
    const lines = removed.map(turn => `${turn.r === 'u' ? turn.n || '用户' : '我'}：${oneLine(turn.t, 60)}`);
    chat.summary = tail((chat.summary ? chat.summary + '\n' : '') + lines.join('\n'), limits.summaryChars);
  }
  const noteMap = (scope, chatKey, create) => scope === 'bot' ? notes : create ? chatFor(chatKey).notes : chats.get(chatKey)?.notes;
  const checkKey = key => {
    if (typeof key !== 'string' || !key.trim() || key.length > limits.keyChars) throw new Error(`记忆的名称需要 1–${limits.keyChars} 个字符`);
    return key.trim();
  };

  return {
    limits,
    /** 最近 count 条对话（旧→新）。 */
    recent(chatKey, count) { const chat = chats.get(chatKey); return chat ? chat.turns.slice(-count).map(publicTurn) : []; },
    summary(chatKey) { return chats.get(chatKey)?.summary ?? ''; },
    /** 追加对话；turn 形如 { role: 'user' | 'assistant', name?, text }。 */
    appendTurns(chatKey, turns) {
      const chat = chatFor(chatKey);
      for (const turn of turns) {
        const body = text(turn.text, limits.turnChars).trim();
        if (body) chat.turns.push({ r: turn.role === 'user' ? 'u' : 'a', n: turn.role === 'user' ? text(turn.name, 40) : '', t: body, ts: now() });
      }
      // 兜底：就算没人调用 compact，原文也不会无限增长。
      if (chat.turns.length > limits.hardTurns) foldRule(chat, chat.turns.length - limits.keepTurns);
      chat.updatedAt = now();
      touch();
    },
    needsCompaction(chatKey) { return (chats.get(chatKey)?.turns.length ?? 0) > limits.softTurns; },
    /** 原文超过 softTurns 时，把最旧的折进摘要，只留 keepTurns 条。summarizer 可选，失败时回退到规则摘要。 */
    async compact(chatKey, summarizer) {
      const chat = chats.get(chatKey);
      if (!chat || chat.turns.length <= limits.softTurns) return false;
      const count = chat.turns.length - limits.keepTurns;
      const removed = chat.turns.slice(0, count);
      let summary;
      if (summarizer) {
        try { summary = text(await summarizer({ summary: chat.summary, turns: removed.map(publicTurn) }), limits.summaryChars).trim(); } catch { /* 回退 */ }
      }
      // await 期间会话可能被清空或重建；只有最旧的那批原文原样还在时才折叠。
      if (chats.get(chatKey) !== chat || chat.turns[0] !== removed[0]) return false;
      if (summary) { chat.turns.splice(0, count); chat.summary = summary; }
      else foldRule(chat, count);
      touch();
      return true;
    },
    getNote(scope, chatKey, key) { return noteMap(scope, chatKey, false)?.get(checkKey(key)) ?? ''; },
    setNote(scope, chatKey, key, value) {
      const name = checkKey(key);
      const map = noteMap(scope, chatKey, true);
      if (!map.has(name) && map.size >= limits.notes) throw new Error(`笔记已满（最多 ${limits.notes} 条），请先忘记一些`);
      map.set(name, text(String(value), limits.valueChars));
      if (scope !== 'bot') chatFor(chatKey).updatedAt = now();
      touch();
    },
    deleteNote(scope, chatKey, key) { if (noteMap(scope, chatKey, false)?.delete(checkKey(key))) touch(); },
    /** 要拼进提示词的笔记：[[名称, 内容], ...]，先整个 Bot 的，再本会话的。 */
    notesFor(chatKey) { return [...notes, ...(chats.get(chatKey)?.notes ?? [])]; },
    clearChat(chatKey) { if (chats.delete(chatKey)) touch(); },
    /** scope：all（全部）、chats（所有会话）、notes（Bot 笔记）。 */
    clear(scope = 'all') {
      if (scope === 'all' || scope === 'chats') chats.clear();
      if (scope === 'all' || scope === 'notes') notes.clear();
      touch();
    },
    listChats() {
      return [...chats].map(([key, chat]) => ({ key, turns: chat.turns.length, summaryChars: chat.summary.length, notes: chat.notes.size, updatedAt: chat.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    stats() {
      let turns = 0;
      for (const chat of chats.values()) turns += chat.turns.length;
      return { chats: chats.size, turns, notes: notes.size, bytes: Buffer.byteLength(JSON.stringify(serialize())), maxBytes: limits.bytes };
    },
    /** 导出为普通对象（不含计数器），可直接序列化成下载文件。 */
    exportData(meta = {}) {
      const data = serialize();
      return { ...meta, version: 1, exportedAt: new Date(now()).toISOString(), notes: data.notes, chats: data.chats };
    },
    flush() { if (timer) { clearTimeout(timer); timer = null; } write(); },
    close() { this.flush(); },
  };
}
