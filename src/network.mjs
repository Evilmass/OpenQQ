import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { imageInfo, safeName } from './media.mjs';
import { quickActions } from './quick.mjs';

const DEFAULT_MAX_PAYLOAD = 48 * 1024 * 1024;
const MAX_HTTP_ACTIONS = 16;
const POST_CONCURRENCY = 4;
const POST_QUEUE = 256;
const POST_RESPONSE_LIMIT = 1024 * 1024;
// Form and query values are strings; these parameters are booleans in OneBot.
const BOOLEAN_PARAMS = new Set([
  'auto_escape', 'approve', 'reject_add_request', 'enable', 'is_dismiss', 'no_cache',
  'set', 'is_add', 'reverseOrder', 'reverse_order', 'temp_block', 'temp_both_del', 'pinned',
]);
const ACTION_NAME = /^\.?[A-Za-z0-9_]{1,64}$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (retcode, message) => ({ status: 'failed', retcode, data: null, message });

// Query strings and forms only carry strings: restore booleans, and JSON arrays (message / messages / user_id).
function coerceParams(entries) {
  const params = {};
  for (const [key, value] of entries) {
    if (key === 'access_token') continue;
    if (BOOLEAN_PARAMS.has(key) && (value === 'true' || value === 'false')) params[key] = value === 'true';
    else if ((key === 'message' || key === 'messages' || key === 'user_id') && value.startsWith('[')) {
      try { const parsed = JSON.parse(value); params[key] = Array.isArray(parsed) ? parsed : value; } catch { params[key] = value; }
    } else params[key] = value;
  }
  return params;
}

async function readBody(request, limit) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readCapped(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel().catch(() => {}); return ''; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const MAX_MEDIA_ENTRIES = 1000;
const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

function parseMediaBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

async function sniffMime(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const info = imageInfo(buf.subarray(0, bytesRead));
    return info ? IMAGE_MIME[info.format] ?? 'application/octet-stream' : 'application/octet-stream';
  } catch {
    return 'application/octet-stream';
  } finally {
    await handle?.close().catch(() => {});
  }
}

function extractToken(request, url) {
  const header = request.headers.authorization;
  if (header !== undefined) {
    const match = header.match(/^(?:Bearer|Token)\s+(.+)$/i);
    return match ? match[1] : '';
  }
  return url.searchParams.get('access_token') ?? '';
}

export async function startOneBot({ config, dispatch, onStatus = () => {}, maxPayload = DEFAULT_MAX_PAYLOAD,
  mediaBaseUrl = process.env.OPENQQ_MEDIA_BASE_URL, postTimeoutMs = 5000 } = {}) {
  const peers = new Map();
  const reverse = config.reverseWs.filter(item => item.enabled).map(item => ({ ...item, state: 'waiting', socket: null, timer: null }));
  // Event receivers that get every message, notice and request as an HTTP POST (OneBot v11 "HTTP POST").
  const posters = (config.httpPost ?? []).filter(item => item.enabled).map(item => ({ ...item, state: 'waiting', queue: [], active: 0, dropped: 0 }));
  const httpEnabled = config.http?.enabled === true;
  const heartbeatInterval = Number.isInteger(config.heartbeatInterval) && config.heartbeatInterval >= 1000 ? config.heartbeatInterval : 15000;
  const reconnectInterval = Number.isInteger(config.reconnectInterval) && config.reconnectInterval >= 500 ? config.reconnectInterval : 3000;
  const authFailures = new Map();
  const mediaMap = new Map();
  const mediaByPath = new Map();
  let state = { phase: 'starting' };
  let closed = false;
  let server;
  let httpServer;
  let wss;
  let address = null;
  let httpAddress = null;
  let httpMediaOrigin = null;
  let activeHttp = 0;
  const ready = () => state.phase === 'session_ready' && state.syncing !== true && Number.isSafeInteger(Number(state.self_id)) && Number(state.self_id) > 0;
  const report = () => onStatus({ ws: { enabled: config.ws.enabled, address, clients: [...peers.values()].filter(p => !p.reverse).length },
    reverseWs: reverse.map((item, index) => ({ index, state: item.state })),
    http: { enabled: httpEnabled, address: httpAddress },
    httpPost: posters.map((item, index) => ({ index, state: item.state })) });
  const meta = extra => ({ time: Math.floor(Date.now() / 1000), self_id: Number(state.self_id), post_type: 'meta_event', ...extra });
  function send(socket, value) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 32 * 1024 * 1024) { socket.terminate(); return; }
    socket.send(JSON.stringify(value));
  }
  function mediaUrl(filePath, fileName) {
    if (!httpMediaOrigin || typeof filePath !== 'string' || !filePath) return null;
    let id = mediaByPath.get(filePath);
    if (id && mediaMap.has(id)) {
      const existing = mediaMap.get(id);
      mediaMap.delete(id);
      mediaMap.set(id, existing);
    } else {
      id = randomBytes(32).toString('hex');
      mediaMap.set(id, { path: filePath });
      mediaByPath.set(filePath, id);
      if (mediaMap.size > MAX_MEDIA_ENTRIES) {
        const [oldestId, oldest] = mediaMap.entries().next().value;
        mediaMap.delete(oldestId);
        if (mediaByPath.get(oldest.path) === oldestId) mediaByPath.delete(oldest.path);
      }
    }
    const name = safeName(fileName, basename(filePath) || 'media');
    return `${httpMediaOrigin}/openqq/media/${id}/${encodeURIComponent(name)}`;
  }
  // Shared by WebSocket and HTTP: the hidden quick-operation action is answered here, everything else goes to the dispatcher.
  async function execute(request) {
    if (request.action !== '.handle_quick_operation') return dispatch(request);
    const answer = value => Object.hasOwn(request, 'echo') ? { ...value, echo: request.echo } : value;
    try { return answer(await runQuick(request.params?.context, request.params?.operation)); }
    catch (error) { return answer(failure(error.retcode ?? 1500, error.message)); }
  }
  async function runQuick(context, operation) {
    for (const action of quickActions(context, operation)) {
      const response = await dispatch(action);
      if (response?.status !== 'ok') return failure(response?.retcode ?? 1500, response?.message ?? '快速操作执行失败');
    }
    return { status: 'ok', retcode: 0, data: null };
  }
  // 'ok', 'missing' (no token sent), 'wrong', or 'limited' (too many recent failures from this address).
  function authenticate(request, url) {
    const remote = request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const record = authFailures.get(remote);
    if (record && record.resetAt > now && record.count >= 20) return 'limited';
    const token = extractToken(request, url);
    const supplied = Buffer.from(token), expected = Buffer.from(config.accessToken);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) { authFailures.delete(remote); return 'ok'; }
    const entry = record && record.resetAt > now ? record : { count: 0, resetAt: now + 60000 };
    entry.count++;
    if (authFailures.size >= 1000) authFailures.delete(authFailures.keys().next().value);
    authFailures.set(remote, entry);
    return token ? 'wrong' : 'missing';
  }

  // OneBot v11 HTTP API: GET or POST /<action>, parameters from the query string, a JSON body or a form. The path may end in
  // _async (answered at once, run in the background) or _rate_limited (accepted and treated like a normal call).
  function answer(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
    res.end(text);
  }
  async function serveApi(req, res) {
    if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); res.end(); return; }
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
    if (url.pathname.startsWith('/openqq/media/')) { await serveMedia(req, res); return; }
    const auth = authenticate(req, url);
    if (auth === 'limited') { res.writeHead(429); res.end(); return; }
    if (auth !== 'ok') { res.writeHead(auth === 'missing' ? 401 : 403); res.end(); return; }
    let name;
    try { name = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, '')); } catch { name = ''; }
    if (!ACTION_NAME.test(name)) { answer(res, 404, failure(1404, '动作不存在')); return; }
    if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, POST' }); res.end(); return; }
    let params = coerceParams(url.searchParams);
    if (req.method === 'POST') {
      let body;
      try { body = await readBody(req, maxPayload); } catch (error) { answer(res, error.status ?? 400, failure(1400, error.message)); return; }
      if (body.length) {
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type === 'application/json') {
          let parsed;
          try { parsed = JSON.parse(body.toString('utf8')); } catch { answer(res, 400, failure(1400, '请求体不是合法的 JSON')); return; }
          if (!isObject(parsed)) { answer(res, 400, failure(1400, '请求体需要是 JSON 对象')); return; }
          params = { ...params, ...parsed };
        } else if (type === 'application/x-www-form-urlencoded') params = { ...params, ...coerceParams(new URLSearchParams(body.toString('utf8'))) };
        else { answer(res, 406, failure(1400, '不支持的 Content-Type，请使用 application/json 或 application/x-www-form-urlencoded')); return; }
      }
    }
    const suffix = /_(async|rate_limited)$/.exec(name);
    const action = suffix ? name.slice(0, -suffix[0].length) : name;
    if (!ready()) { answer(res, 200, failure(1502, 'QQ 尚未就绪')); return; }
    if (activeHttp >= MAX_HTTP_ACTIONS) { answer(res, 200, failure(1503, '并发动作过多')); return; }
    activeHttp++;
    const run = execute({ action, params }).catch(() => failure(1500, '动作执行异常')).finally(() => { activeHttp--; });
    if (suffix?.[1] === 'async') { answer(res, 200, { status: 'async', retcode: 1, data: null }); await run; return; }
    answer(res, 200, await run);
  }

  // HTTP POST reporting: every message, notice and request goes to each receiver, signed with X-Signature when a secret is set.
  // A 2xx response may carry a quick operation (see src/quick.mjs).
  function setPoster(poster, next) { if (poster.state !== next) { poster.state = next; report(); } }
  async function deliver(poster, event) {
    const body = JSON.stringify(event);
    const headers = { 'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': 'OpenQQ', 'X-Self-ID': String(event.self_id ?? state.self_id ?? ''),
      ...(poster.secret ? { 'X-Signature': 'sha1=' + createHmac('sha1', poster.secret).update(body).digest('hex') } : {}) };
    let text;
    try {
      const response = await fetch(poster.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(postTimeoutMs) });
      if (response.status < 200 || response.status >= 300) { response.body?.cancel().catch(() => {}); throw new Error('HTTP ' + response.status); }
      text = await readCapped(response, POST_RESPONSE_LIMIT);
    } catch { setPoster(poster, 'failed'); return; }
    setPoster(poster, 'ok');
    if (!text.trim() || !['message', 'request'].includes(event.post_type)) return;
    let operation;
    try { operation = JSON.parse(text); } catch { return; }
    if (isObject(operation) && Object.keys(operation).length && ready()) await runQuick(event, operation).catch(() => {});
  }
  function drain(poster) {
    while (!closed && poster.active < POST_CONCURRENCY && poster.queue.length) {
      const event = poster.queue.shift();
      poster.active++;
      deliver(poster, event).catch(() => {}).finally(() => { poster.active--; drain(poster); });
    }
  }
  function enqueue(poster, event) {
    if (poster.queue.length >= POST_QUEUE) { poster.queue.shift(); poster.dropped++; }
    poster.queue.push(event);
    drain(poster);
  }

  function attach(socket, role, isReverse = false) {
    const peer = { role, reverse: isReverse, active: 0, announced: false, alive: true };
    peers.set(socket, peer);
    socket.on('error', () => {});
    socket.on('pong', () => { peer.alive = true; });
    socket.on('close', () => { peers.delete(socket); report(); });
    socket.on('message', async (data, binary) => {
      if (role === 'event') return;
      let request;
      try {
        if (binary) throw new Error();
        request = JSON.parse(data.toString());
        if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string') throw new Error();
      } catch { send(socket, { status: 'failed', retcode: 1400, data: null, message: '需要 JSON 动作对象' }); return; }
      const fail = (retcode, message) => ({ status: 'failed', retcode, data: null, message, ...(Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) });
      if (peer.active >= 8) { send(socket, fail(1503, '并发动作过多')); return; }
      if (!ready()) { send(socket, fail(1502, 'QQ 尚未就绪')); return; }
      const suffix = /_(async|rate_limited)$/.exec(request.action);
      const effective = suffix ? { ...request, action: request.action.slice(0, -suffix[0].length) } : request;
      peer.active++;
      if (suffix?.[1] === 'async') {
        send(socket, { status: 'async', retcode: 1, data: null, ...(Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) });
        execute(effective).catch(() => {}).finally(() => { peer.active--; });
        return;
      }
      try { send(socket, await execute(effective)); }
      catch { send(socket, fail(1500, '动作执行异常')); }
      finally { peer.active--; }
    });
    announce(socket, peer);
    report();
  }
  function announce(socket, peer) {
    if (ready() && peer.role !== 'api' && !peer.announced) {
      send(socket, meta({ meta_event_type: 'lifecycle', sub_type: 'connect' })); peer.announced = true;
    }
  }
  function connect(item) {
    if (closed || !ready() || item.socket || item.timer) return;
    item.state = 'connecting'; report();
    const socket = new WebSocket(item.url, { headers: { 'X-Self-ID': String(state.self_id), 'X-Client-Role': 'Universal',
      ...(item.token ? { Authorization: 'Bearer ' + item.token } : {}) }, maxPayload, handshakeTimeout: 10000, followRedirects: false });
    item.socket = socket;
    socket.on('error', () => {});
    socket.once('open', () => { item.state = 'connected'; attach(socket, 'universal', true); });
    socket.once('close', () => {
      item.socket = null;
      if (closed || !ready()) { item.state = 'waiting'; report(); return; }
      item.state = 'reconnecting'; report();
      item.timer = setTimeout(() => { item.timer = null; connect(item); }, reconnectInterval);
    });
  }
  async function serveMedia(req, res) {
    if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); res.end(); return; }
    let parsed;
    try { parsed = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
    if (!parsed.pathname.startsWith('/openqq/media/')) { res.writeHead(426); res.end('OneBot v11: WebSocket required'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const match = parsed.pathname.match(/^\/openqq\/media\/([a-f0-9]{64})(?:\/[^/]*)?$/);
    if (!match) { res.writeHead(404); res.end(); return; }
    const entry = mediaMap.get(match[1]);
    if (!entry) { res.writeHead(404); res.end(); return; }
    let info;
    try { info = await stat(entry.path); } catch { info = null; }
    if (!info || !info.isFile()) { res.writeHead(404); res.end(); return; }
    const contentType = await sniffMime(entry.path);
    const headers = {
      'Content-Type': contentType,
      'Content-Length': String(info.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(contentType === 'application/octet-stream' ? { 'Content-Disposition': 'attachment' } : {}),
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(entry.path);
    stream.on('error', () => { if (!res.destroyed) res.destroy(); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
  if (config.ws.enabled) {
    server = createServer((req, res) => {
      serveMedia(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); if (!res.writableEnded) res.end(); });
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 30000;
    wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      socket.on('error', () => {});
      if (!request.url || !request.url.startsWith('/') || request.url.startsWith('//')) { socket.destroy(); return; }
      let url; try { url = new URL(request.url, 'http://127.0.0.1'); } catch { socket.destroy(); return; }
      const auth = authenticate(request, url);
      if (auth === 'limited') {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      let code = auth === 'ok' ? 0 : 401;
      const path = url.pathname.replace(/\/$/, '') || '/';
      if (!['/', '/api', '/event'].includes(path)) code = code || 404;
      if (closed || wss.clients.size >= 32) code = code || 503;
      if (code) { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
      wss.handleUpgrade(request, socket, head, ws => attach(ws, path === '/api' ? 'api' : path === '/event' ? 'event' : 'universal'));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.ws.port, config.ws.host, resolve); });
    address = `ws://${config.ws.host === '0.0.0.0' ? '127.0.0.1' : config.ws.host}:${server.address().port}`;
    httpMediaOrigin = parseMediaBase(mediaBaseUrl) ?? `http://${config.ws.host === '0.0.0.0' ? '127.0.0.1' : config.ws.host}:${server.address().port}`;
  }
  if (httpEnabled) {
    httpServer = createServer((req, res) => {
      serveApi(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); if (!res.writableEnded) res.end(); });
    });
    httpServer.headersTimeout = 10000;
    httpServer.requestTimeout = 30000;
    try { await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(config.http.port, config.http.host, resolve); }); }
    catch (error) {
      // Do not leave the WebSocket side listening when the HTTP port is taken.
      if (wss) wss.close();
      if (server) { server.close(); server.closeAllConnections(); }
      throw error;
    }
    httpAddress = `http://${config.http.host === '0.0.0.0' ? '127.0.0.1' : config.http.host}:${httpServer.address().port}`;
    // Without a WebSocket server the HTTP server hands out the media links.
    httpMediaOrigin ??= parseMediaBase(mediaBaseUrl) ?? httpAddress;
  }
  const heartbeat = setInterval(() => {
    for (const [socket, peer] of peers) {
      if (!peer.alive) { socket.terminate(); continue; }
      peer.alive = false; socket.ping();
      if (Number(state.self_id) > 0 && peer.role !== 'api') send(socket, meta({ meta_event_type: 'heartbeat', interval: heartbeatInterval, status: { online: ready(), good: ready() } }));
    }
  }, heartbeatInterval);
  heartbeat.unref();
  report();
  return {
    mediaUrl,
    setStatus(next) {
      const previous = state;
      state = { ...next };
      for (const [socket, peer] of peers) {
        if (previous.self_id && String(previous.self_id) !== String(state.self_id)) { socket.terminate(); continue; }
        announce(socket, peer);
      }
      for (const item of reverse) {
        if (!ready() || (previous.self_id && String(previous.self_id) !== String(state.self_id))) {
          clearTimeout(item.timer); item.timer = null; item.state = 'waiting'; item.socket?.terminate();
        } else connect(item);
      }
      report();
    },
    broadcast(event) {
      for (const [socket, peer] of peers) if (peer.role !== 'api') send(socket, event);
      if (event?.post_type !== 'meta_event') for (const poster of posters) enqueue(poster, event);
    },
    async close() {
      closed = true; clearInterval(heartbeat);
      mediaMap.clear(); mediaByPath.clear();
      for (const item of reverse) { clearTimeout(item.timer); item.socket?.terminate(); }
      for (const poster of posters) poster.queue.length = 0;
      for (const socket of peers.keys()) socket.terminate();
      if (wss) await new Promise(resolve => wss.close(resolve));
      for (const listener of [server, httpServer]) if (listener) { const stopped = new Promise(resolve => listener.close(resolve)); listener.closeAllConnections(); await stopped; }
    },
  };
}
