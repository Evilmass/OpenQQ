import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageClient } from '../src/bot/image.mjs';
import { AIError, createAIClient } from '../src/bot/ai.mjs';
import { createBotStore, defaultImageSettings, imageDefaults, mergeImageSettings, publicImageSettings } from '../src/bot/store.mjs';
import { createBotApi } from '../src/bot/api.mjs';
import { createBotEngine } from '../src/bot/engine.mjs';
import { startWebUI } from '../src/webui.mjs';
import { mockAI, withUsablePort } from './bot-support.mjs';

const SECRET = 'sk-image-SECRET-1234567890abcdef';
const png = (w = 8, h = 4) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
  return b;
};
const settingsFor = (baseUrl, extra = {}) => ({ ...defaultImageSettings(), baseUrl, apiKey: SECRET, model: 'img-a', ...extra });
const answer = images => (request, response) => response.end(JSON.stringify({ data: images }));

test('the image settings default to api.zelix.asia and merge by the same rules as the AI settings', () => {
  const defaults = defaultImageSettings();
  assert.deepEqual([defaults.baseUrl, defaults.apiKey, defaults.model, defaults.size, defaults.count, defaults.timeoutSec],
    ['https://api.zelix.asia', '', imageDefaults.model, '1024x1024', 1, 120]);

  const saved = mergeImageSettings(defaults, { baseUrl: 'https://api.zelix.asia', apiKey: ' ' + SECRET + ' ', model: ' gpt-image-1 ', size: '1536x1024', count: '2', timeoutSec: 90 });
  assert.deepEqual([saved.baseUrl, saved.apiKey, saved.model, saved.size, saved.count, saved.timeoutSec], ['https://api.zelix.asia/v1', SECRET, 'gpt-image-1', '1536x1024', 2, 90]);
  assert.equal(mergeImageSettings(saved, { model: 'other' }).apiKey, SECRET, 'a missing key keeps the saved one');
  assert.equal(mergeImageSettings(saved, { apiKey: '' }).apiKey, SECRET);
  assert.equal(mergeImageSettings(saved, { clearApiKey: true }).apiKey, '');
  assert.equal(mergeImageSettings(saved, { baseUrl: '' }).baseUrl, 'https://api.zelix.asia', 'an empty address returns to the default');
  assert.equal(mergeImageSettings(saved, { baseUrl: 'https://api.zelix.asia/v1/images/generations' }).baseUrl, 'https://api.zelix.asia/v1', 'a pasted endpoint is cut back to the /v1 root');
  assert.throws(() => mergeImageSettings(saved, { baseUrl: 'https://other.example.com' }), /重新填写 API Key/);
  assert.equal(mergeImageSettings(saved, { baseUrl: 'https://other.example.com', apiKey: 'k-new-12345' }).apiKey, 'k-new-12345');
  assert.equal(mergeImageSettings(saved, { baseUrl: 'https://api.zelix.asia/v1/' }).apiKey, SECRET, 'the same server may be written differently');

  for (const bad of [{ size: '10x10' }, { size: '1024*1024' }, { size: 7 }, { count: 0 }, { count: 5 }, { count: 1.5 }, { timeoutSec: 5 }, { timeoutSec: 301 }, { model: 'a\nb' },
    { model: 'x'.repeat(201) }, { apiKey: 'has space' }, { baseUrl: 'http://api.example.com/v1' }, { baseUrl: 'https://u:p@api.example.com' }]) {
    assert.throws(() => mergeImageSettings(saved, bad), Error, JSON.stringify(bad));
  }
  assert.throws(() => mergeImageSettings(saved, []), /格式无效/);
  assert.equal(mergeImageSettings(saved, { size: 'auto' }).size, 'auto');

  const view = publicImageSettings(saved);
  assert.equal(JSON.stringify(view).includes(SECRET), false);
  assert.deepEqual([view.apiKeySet, view.apiKeyHint], [true, '••••' + SECRET.slice(-4)]);
  assert.deepEqual([publicImageSettings(defaults).apiKeySet, publicImageSettings(defaults).apiKeyHint], [false, '']);
});

test('generate posts the OpenAI images request with the bearer key and returns images as data URLs', async t => {
  const api = await mockAI(t, answer([{ b64_json: png(64, 32).toString('base64'), revised_prompt: '一只猫，细节更多' }]));
  const client = createImageClient({ settings: () => settingsFor(api.baseUrl, { size: '1536x1024', count: 2 }) });
  const result = await client.generate({ prompt: '  一只猫  ' });
  const [request] = api.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/images/generations');
  assert.equal(request.headers.authorization, 'Bearer ' + SECRET);
  assert.match(request.headers['content-type'], /application\/json/);
  assert.deepEqual(request.body, { model: 'img-a', prompt: '一只猫', n: 2, size: '1536x1024' });
  assert.equal(result.images.length, 1);
  const [image] = result.images;
  assert.deepEqual([image.mime, image.width, image.height, image.bytes], ['image/png', 64, 32, 33]);
  assert.equal(image.dataUrl, 'data:image/png;base64,' + png(64, 32).toString('base64'));
  assert.equal(image.revisedPrompt, '一只猫，细节更多');
  assert.deepEqual([result.model, result.size], ['img-a', '1536x1024']);
  assert.ok(result.elapsedMs >= 0);

  // Per-call overrides win over the saved settings, and a data: URL in `url` works like b64_json.
  api.set(answer([{ url: 'data:image/png;base64,' + png().toString('base64') }, { b64_json: 'data:image/png;base64,' + png().toString('base64') }, { nothing: true }]));
  const again = await client.generate({ prompt: 'x', model: 'img-b', size: 'auto', count: 3 });
  assert.deepEqual(api.requests.at(-1).body, { model: 'img-b', prompt: 'x', n: 3, size: 'auto' });
  assert.equal(again.images.length, 2, 'entries without a usable image are skipped');
});

test('a result that is an image URL is downloaded on the server, without the key, and only from a safe place', async t => {
  const api = await mockAI(t, (request, response) => {
    if (request.url === '/img/a.png') { response.setHeader('Content-Type', 'image/png'); response.end(png(10, 20)); return; }
    if (request.url === '/img/page.html') { response.setHeader('Content-Type', 'text/html'); response.end('<script>alert(1)</script>'); return; }
    response.end(JSON.stringify({ data: [{ url: api.origin + (request.body?.prompt === 'html' ? '/img/page.html' : '/img/a.png') }] }));
  });
  const client = createImageClient({ settings: () => settingsFor(api.baseUrl) });
  const result = await client.generate({ prompt: 'x' });
  assert.deepEqual([result.images[0].width, result.images[0].height], [10, 20]);
  const download = api.requests.find(item => item.url === '/img/a.png');
  assert.equal(download.headers.authorization, undefined, 'the key is never sent to the image address');
  await assert.rejects(client.generate({ prompt: 'html' }), /不是图片/);

  // A gateway on the internet must not be able to make us fetch local or private addresses.
  const calls = [];
  const resolved = { 'cdn.example.com': ['93.184.216.34'], 'metadata.example.com': ['10.0.0.5'], 'mixed.example.com': ['93.184.216.34', '127.0.0.1'] };
  const remote = urls => createImageClient({
    settings: () => settingsFor('https://api.example.com/v1'),
    resolve: async host => resolved[host] ?? [],
    fetchImpl: async (target, init) => {
      calls.push(String(target));
      if (String(target).endsWith('/images/generations')) return new Response(JSON.stringify({ data: urls.map(url => ({ url })) }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(png(), { headers: { 'Content-Type': 'image/png' } });
    },
  });
  assert.equal((await remote(['https://cdn.example.com/a.png']).generate({ prompt: 'x' })).images.length, 1);
  assert.equal((await remote(['https://api.example.com/files/a.png']).generate({ prompt: 'x' })).images.length, 1, 'the same server as the API is trusted');
  for (const [url, pattern] of [['https://metadata.example.com/a.png', /本机或内网/], ['https://mixed.example.com/a.png', /本机或内网/], ['https://unknown.example.com/a.png', /本机或内网/],
    ['https://169.254.169.254/latest', /本机或内网/], ['https://[::1]/a.png', /本机或内网/], ['http://cdn.example.com/a.png', /不是 https/], ['ftp://cdn.example.com/a.png', /不受支持/],
    ['https://user:pw@cdn.example.com/a.png', /不受支持/], ['not a url', /无效/]]) {
    const before = calls.length;
    await assert.rejects(remote([url]).generate({ prompt: 'x' }), pattern, url);
    assert.equal(calls.length, before + 1, 'only the API call was made for ' + url);
  }
});

test('failures are reported plainly and never contain the key', async t => {
  const api = await mockAI(t, (request, response) => {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${request.headers.authorization.slice(7)}. Bearer ${SECRET} sk-another-LEAKED-key-1234` } }));
  });
  const client = createImageClient({ settings: () => settingsFor(api.baseUrl) });
  const failure = await client.generate({ prompt: 'x' }).catch(error => error);
  assert.ok(failure instanceof AIError);
  assert.match(failure.message, /HTTP 401/);
  assert.equal(failure.message.includes(SECRET), false);
  assert.equal(/LEAKED/.test(failure.message), false);

  const fetching = answer => createImageClient({ settings: () => settingsFor('https://api.example.com/v1'), fetchImpl: async () => answer() });
  const ok = body => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(fetching(() => ok('<html>')).generate({ prompt: 'x' }), /不是 JSON/);
  await assert.rejects(fetching(() => ok({ data: [] })).generate({ prompt: 'x' }), /没有返回可用的图片/);
  await assert.rejects(fetching(() => ok({ data: [{ b64_json: Buffer.from('<html>not an image</html>').toString('base64') }] })).generate({ prompt: 'x' }), /不是图片/);
  await assert.rejects(fetching(() => ok({ data: [{ b64_json: '###' }] })).generate({ prompt: 'x' }), /base64 图片数据无效/);
  await assert.rejects(fetching(() => ok({ data: [{ b64_json: 'A'.repeat(23 * 1024 * 1024) }] })).generate({ prompt: 'x' }), /超过 16 MiB/);
  await assert.rejects(fetching(() => new Response('x', { status: 500 })).generate({ prompt: 'x' }), /HTTP 500/);
  await assert.rejects(createImageClient({ settings: () => settingsFor('https://api.example.com/v1'), fetchImpl: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } }).generate({ prompt: 'x' }), /没有响应/);
  await assert.rejects(createImageClient({ settings: () => settingsFor('https://api.example.com/v1'), fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } }).generate({ prompt: 'x' }), /ECONNREFUSED/);

  const empty = createImageClient({ settings: () => settingsFor('https://api.example.com/v1'), fetchImpl: async () => { throw new Error('must not be called'); } });
  for (const [options, pattern] of [[{ prompt: '' }, /提示词/], [{ prompt: '   ' }, /提示词/], [{ prompt: 5 }, /提示词/], [{ prompt: 'x'.repeat(4001) }, /最多 4000/], [{ prompt: 'x', model: ' ' , size: undefined }, null],
    [{ prompt: 'x', size: '10x10' }, /图片尺寸/], [{ prompt: 'x', count: 0 }, /最多生成/], [{ prompt: 'x', count: 5 }, /最多生成/]]) {
    if (pattern) await assert.rejects(empty.generate(options), pattern, JSON.stringify(options).slice(0, 60));
  }
  await assert.rejects(createImageClient({ settings: () => settingsFor('https://api.example.com/v1', { apiKey: '' }) }).generate({ prompt: 'x' }), /API Key/);
  await assert.rejects(createImageClient({ settings: () => settingsFor('https://api.example.com/v1', { model: '' }) }).generate({ prompt: 'x' }), /模型/);
  // A local server needs no key.
  const local = await mockAI(t, answer([{ b64_json: png().toString('base64') }]));
  assert.equal((await createImageClient({ settings: () => settingsFor(local.baseUrl, { apiKey: '' }) }).generate({ prompt: 'x' })).images.length, 1);
  assert.equal(local.requests[0].headers.authorization, undefined);
});

test('a redirect is refused so the key is never sent elsewhere, and only one generation runs at a time', async t => {
  const target = await mockAI(t, answer([{ b64_json: png().toString('base64') }]));
  const redirecting = await mockAI(t, (request, response) => { response.statusCode = 307; response.setHeader('Location', target.baseUrl + '/images/generations'); response.end(); });
  const failure = await createImageClient({ settings: () => settingsFor(redirecting.baseUrl) }).generate({ prompt: 'x' }).catch(error => error);
  assert.ok(failure instanceof AIError);
  assert.equal(target.requests.length, 0, 'the redirect target was never contacted');

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = createImageClient({ settings: () => settingsFor('https://api.example.com/v1'), fetchImpl: async () => {
    await gate;
    return new Response(JSON.stringify({ data: [{ b64_json: png().toString('base64') }] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const first = slow.generate({ prompt: 'one' });
  const second = await slow.generate({ prompt: 'two' }).catch(error => error);
  assert.ok(second instanceof AIError);
  assert.equal(second.status, 429);
  assert.match(second.message, /正在进行/);
  release();
  assert.equal((await first).images.length, 1);
  assert.equal((await slow.generate({ prompt: 'three' })).images.length, 1, 'the next one runs once the first has finished');
});

async function fixture(t, handler) {
  const dir = mkdtempSync(join(tmpdir(), 'openqq-image-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createBotStore({ dir });
  const api = await mockAI(t, handler);
  const engine = createBotEngine({ store, ai: createAIClient({ settings: () => store.readAi() }), dispatch: async () => ({ status: 'ok', retcode: 0, data: {} }), memoryOptions: { saveDelay: -1 } });
  t.after(() => engine.close());
  const web = await withUsablePort(async () => {
    const started = await startWebUI({ port: 0, bot: createBotApi({ store, engine, ai: createAIClient({ settings: () => store.readAi() }) }) });
    return Object.assign(started, { port: Number(new URL(started.origin).port), stop: () => started.close() });
  });
  t.after(() => web.close());
  const token = new URLSearchParams(new URL(web.url).hash.slice(1)).get('token');
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const call = async (method, path, body) => {
    const response = await fetch(web.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    return { status: response.status, raw, json: raw ? JSON.parse(raw) : undefined };
  };
  return { web, store, api, call, dir, token };
}

test('the image page API saves settings, keeps the key private and generates through the saved server', async t => {
  const { web, store, api, call, dir, token } = await fixture(t, (request, response) => {
    if (request.url.endsWith('/models')) { response.end(JSON.stringify({ data: [{ id: 'img-a' }, { id: 'img-b' }] })); return; }
    if (request.body?.prompt === 'bad') { response.statusCode = 400; response.end(JSON.stringify({ error: { message: `invalid key ${request.headers.authorization} (${SECRET})` } })); return; }
    response.end(JSON.stringify({ data: [{ b64_json: png(16, 16).toString('base64') }] }));
  });
  assert.equal((await fetch(web.origin + '/image')).headers.get('content-type'), 'text/html; charset=utf-8', 'the console serves the new page');
  assert.equal((await fetch(web.origin + '/api/bot/image')).status, 401);

  const initial = await call('GET', '/api/bot/image');
  assert.deepEqual([initial.json.baseUrl, initial.json.model, initial.json.apiKeySet, initial.json.limits.maxCount], ['https://api.zelix.asia', imageDefaults.model, false, 4]);

  const saved = await call('POST', '/api/bot/image', { baseUrl: api.origin, apiKey: SECRET, model: 'img-a', size: '1024x1536', count: 1, timeoutSec: 60 });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.json.baseUrl, saved.json.apiKeySet, saved.json.size], [api.baseUrl, true, '1024x1536']);
  assert.equal(JSON.parse(readFileSync(join(dir, 'image.json'), 'utf8')).apiKey, SECRET, 'the key lives only in image.json');
  assert.throws(() => readFileSync(join(dir, 'ai.json')), /ENOENT/, 'the AI settings file is not created by the image page');
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'image.json')).mode & 0o777, 0o600);
  assert.deepEqual([store.readImage().apiKey, store.readAi().apiKey], [SECRET, '']);

  const models = await call('POST', '/api/bot/image/models', {});
  assert.deepEqual(models.json.models, ['img-a', 'img-b']);
  const test = await call('POST', '/api/bot/image/test', {});
  assert.deepEqual([test.json.ok, test.json.models], [true, 2]);
  assert.equal(api.requests.at(-1).headers.authorization, 'Bearer ' + SECRET);

  const generated = await call('POST', '/api/bot/image/generate', { prompt: '一幅画', model: 'img-b', size: '512x512' });
  assert.equal(generated.status, 200);
  assert.equal(generated.json.images.length, 1);
  assert.match(generated.json.images[0].dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(api.requests.at(-1).body, { model: 'img-b', prompt: '一幅画', n: 1, size: '512x512' }, 'the form values win over the saved ones for this call');
  assert.equal(store.readImage().model, 'img-a', 'generating does not change the saved settings');

  const failed = await call('POST', '/api/bot/image/generate', { prompt: 'bad' });
  assert.equal(failed.status, 400);
  assert.match(failed.json.message, /HTTP 400/);
  for (const result of [saved, initial, models, test, generated, failed, await call('GET', '/api/bot/image')]) assert.equal(result.raw.includes(SECRET), false, 'no response contains the key');
  assert.equal((await call('POST', '/api/bot/image/generate', { prompt: '' })).status, 400);
  assert.equal((await call('POST', '/api/bot/image', { size: 'huge' })).status, 400);

  // The page's draft never sends the saved key to a different server.
  const other = await mockAI(t, answer([{ b64_json: png().toString('base64') }]));
  const moved = await call('POST', '/api/bot/image/test', { baseUrl: other.origin });
  assert.equal(moved.json.ok, true, 'a local server needs no key');
  assert.equal(other.requests.at(-1).headers.authorization, undefined, 'the saved key was not reused for another origin');
  const refused = await call('POST', '/api/bot/image', { baseUrl: other.origin });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /重新填写 API Key/);
  assert.ok(token.length > 20);
});
