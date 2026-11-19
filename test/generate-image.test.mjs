import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchAction, redactResponse } from '../src/actions.mjs';
import { createEventConverter } from '../src/onebot.mjs';
import { createMediaPreparer } from '../src/media.mjs';
import { createImageClient } from '../src/bot/image.mjs';
import { AIError } from '../src/bot/ai.mjs';
import { defaultImageSettings } from '../src/bot/store.mjs';
import { defaultConfig } from '../src/config.mjs';
import { startOneBot } from '../src/network.mjs';
import { mockAI } from './bot-support.mjs';

const SECRET = 'sk-genimg-SECRET-1234567890abcdef';
const png = (w = 16, h = 8) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
  return b;
};
const settingsFor = (baseUrl, extra = {}) => ({ ...defaultImageSettings(), baseUrl, apiKey: SECRET, model: 'img-a', ...extra });
const images = count => (request, response) => response.end(JSON.stringify({ data: Array.from({ length: count ?? request.body.n }, (_, i) => ({ b64_json: png(16 + i, 8).toString('base64'), revised_prompt: i === 0 ? '改写后的提示词' : undefined })) }));
const noChannel = { request: () => { throw new Error('QQ must not be called'); } };
const run = (request, options) => dispatchAction(noChannel, createEventConverter(), request, options);

test('generate_image returns the pictures as base64:// files that can go straight into an image segment', async t => {
  const api = await mockAI(t, images());
  const image = createImageClient({ settings: () => settingsFor(api.baseUrl, { size: '1024x1536', count: 2 }) });
  const response = await run({ action: 'generate_image', params: { prompt: '一只猫' }, echo: 'g1' }, { image });
  assert.equal(response.status, 'ok');
  assert.equal(response.echo, 'g1');
  assert.deepEqual(api.requests[0].body, { model: 'img-a', prompt: '一只猫', n: 2, size: '1024x1536' }, 'the saved settings are used');
  const { data } = response;
  assert.deepEqual([data.model, data.size, data.images.length], ['img-a', '1024x1536', 2]);
  assert.ok(data.elapsed_ms >= 0);
  assert.deepEqual([data.images[0].mime, data.images[0].width, data.images[0].height, data.images[0].bytes], ['image/png', 16, 8, 33]);
  assert.equal(data.images[0].revised_prompt, '改写后的提示词');
  assert.equal('revised_prompt' in data.images[1], false);
  assert.deepEqual(Buffer.from(data.images[0].file.slice('base64://'.length), 'base64'), png(16, 8), 'file is the picture itself');
  assert.equal(data.message_id, undefined);

  // Parameters override the saved settings for one call.
  await run({ action: 'generate_image', params: { prompt: 'x', model: 'img-b', size: 'auto', n: '1' } }, { image });
  assert.deepEqual(api.requests.at(-1).body, { model: 'img-b', prompt: 'x', n: 1, size: 'auto' });
});

test('with a target the pictures are sent through the normal send pipeline and only their details come back', async t => {
  const api = await mockAI(t, images());
  const image = createImageClient({ settings: () => settingsFor(api.baseUrl, { count: 2 }) });
  const root = await mkdtemp(join(tmpdir(), 'openqq-genimg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const media = createMediaPreparer({ dir: root });
  const sent = [];
  const channel = { request: async request => { sent.push(request); return { status: 'ok', retcode: 0, data: { self: { uin: '123456' }, message: { chatType: request.action === 'send_group_msg' ? 2 : 1, peerUid: '987654', msgId: '9007199254740993' } } }; } };
  const converter = createEventConverter();

  const group = await dispatchAction(channel, converter, { action: 'generate_image', params: { prompt: '风景', group_id: 987654 } }, { image, media });
  assert.equal(group.status, 'ok', group.message);
  assert.equal(sent[0].action, 'send_group_msg');
  assert.equal(String(sent[0].params.group_id), '987654');
  assert.deepEqual(sent[0].params.message.map(segment => segment.type), ['image', 'image']);
  assert.ok(sent[0].params.message.every(segment => segment.data.openqq_media?.kind === 'image' && !('file' in segment.data)), 'the pictures arrive prepared, without their base64 source');
  assert.ok(Number.isInteger(group.data.message_id));
  assert.equal(group.data.images.length, 2);
  assert.equal(group.data.images.some(item => 'file' in item), false, 'the picture data is not returned again');
  assert.deepEqual(await readdir(root), [], 'the temporary files are released');

  const friend = await dispatchAction(channel, converter, { action: 'generate_image', params: { prompt: '风景', user_id: '654321' } }, { image, media });
  assert.equal(friend.status, 'ok', friend.message);
  assert.equal(sent[1].action, 'send_private_msg');
  assert.equal(String(sent[1].params.user_id), '654321');
});

test('a failed send is reported as such, because the picture was already generated', async t => {
  const api = await mockAI(t, images(1));
  const image = createImageClient({ settings: () => settingsFor(api.baseUrl) });
  const root = await mkdtemp(join(tmpdir(), 'openqq-genimg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const channel = { request: async () => ({ status: 'failed', retcode: 1500, data: null, message: 'QQ 拒绝发送' }) };
  const response = await dispatchAction(channel, createEventConverter(), { action: 'generate_image', params: { prompt: 'x', group_id: 1 } }, { image, media: createMediaPreparer({ dir: root }) });
  assert.equal(response.status, 'failed');
  assert.equal(response.retcode, 1500);
  assert.match(response.message, /图片已生成，但发送失败：QQ 拒绝发送/);
  assert.equal(api.requests.length, 1, 'the picture is not generated twice');
});

test('generate_image refuses bad parameters and reports each kind of failure with its own return code', async t => {
  let calls = 0;
  const generated = { images: [{ dataUrl: 'data:image/png;base64,' + png().toString('base64'), mime: 'image/png', width: 16, height: 8, bytes: 33 }], model: 'm', size: 's', elapsedMs: 1 };
  const image = { generate: async options => { calls++; if (options.fail) throw options.fail; return generated; } };
  const code = async (params, options = { image }) => (await run({ action: 'generate_image', params }, options));
  for (const [params, pattern] of [[null, /prompt/], [{}, /prompt/], [{ prompt: '  ' }, /prompt/], [{ prompt: 5 }, /prompt/], [[], /params/], ['x', /params/], [{ prompt: 'x', group_id: 1, user_id: 2 }, /只能给一个/], [{ prompt: 'x', group_id: 'abc' }, /group_id/],
    [{ prompt: 'x', group_id: 0 }, /group_id/], [{ prompt: 'x', user_id: -5 }, /user_id/], [{ prompt: 'x', user_id: 1.5 }, /user_id/], [{ prompt: 'x', model: 5 }, /model/], [{ prompt: 'x', size: 1024 }, /size/]]) {
    const response = await code(params);
    assert.equal(response.retcode, 1400, JSON.stringify(params));
    assert.match(response.message, pattern);
  }
  assert.equal(calls, 0, 'nothing is generated for a request that is refused up front');
  assert.equal((await code({ prompt: 'x' }, {})).retcode, 1500, 'without a generator the action says so');

  // The client's own errors: settings and parameters → 1400, a task already running → 1503, anything else → 1500.
  const throwing = error => ({ generate: async () => { throw error; } });
  assert.equal((await code({ prompt: 'x' }, { image: throwing(Object.assign(new AIError('请先填写 API Key'), { retcode: 1400 })) })).retcode, 1400);
  const busy = await code({ prompt: 'x' }, { image: throwing(Object.assign(new AIError('已有一个生图任务正在进行'), { status: 429, retcode: 1503 })) });
  assert.deepEqual([busy.retcode, busy.message], [1503, '已有一个生图任务正在进行']);
  const upstream = await code({ prompt: 'x' }, { image: throwing(new AIError('生图接口返回 HTTP 500')) });
  assert.deepEqual([upstream.status, upstream.retcode, upstream.data], ['failed', 1500, null]);

  // The real client: missing prompt and out-of-range values are parameter errors, and the key never shows up.
  const api = await mockAI(t, (request, response) => { response.statusCode = 401; response.end(JSON.stringify({ error: { message: `bad key ${request.headers.authorization}` } })); });
  const real = createImageClient({ settings: () => settingsFor(api.baseUrl) });
  for (const params of [{}, { prompt: '   ' }, { prompt: 'x', n: 5 }, { prompt: 'x', size: 'huge' }, { prompt: 'x'.repeat(4001) }]) assert.equal((await code(params, { image: real })).retcode, 1400, JSON.stringify(params).slice(0, 40));
  assert.equal(api.requests.length, 0, 'invalid parameters never reach the gateway');
  const rejected = await code({ prompt: 'x' }, { image: real });
  assert.equal(rejected.retcode, 1500);
  assert.match(rejected.message, /HTTP 401/);
  assert.equal(JSON.stringify(rejected).includes(SECRET), false);
  const noKey = await code({ prompt: 'x' }, { image: createImageClient({ settings: () => settingsFor('https://api.example.com/v1', { apiKey: '' }) }) });
  assert.deepEqual([noKey.retcode, noKey.message], [1400, '请先填写 API Key']);
  const noModel = await code({ prompt: 'x' }, { image: createImageClient({ settings: () => settingsFor(api.baseUrl, { model: '' }) }) });
  assert.equal(noModel.retcode, 1400);
});

test('only one generation runs at a time, whether it comes from OneBot or the WebUI page', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const image = createImageClient({ settings: () => settingsFor('https://api.example.com/v1'), fetchImpl: async () => {
    await gate;
    return new Response(JSON.stringify({ data: [{ b64_json: png().toString('base64') }] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const first = run({ action: 'generate_image', params: { prompt: 'one' } }, { image });
  const second = await run({ action: 'generate_image', params: { prompt: 'two' } }, { image });
  assert.deepEqual([second.status, second.retcode], ['failed', 1503]);
  assert.match(second.message, /正在进行/);
  const page = await image.generate({ prompt: 'from the page' }).catch(error => error);
  assert.equal(page.status, 429, 'the WebUI page shares the same limit');
  release();
  assert.equal((await first).status, 'ok');
  assert.equal((await run({ action: 'generate_image', params: { prompt: 'three' } }, { image })).status, 'ok');
});

test('the copy shown in the WebUI replaces the generated pictures with their size', () => {
  const payload = Buffer.alloc(3000).toString('base64');
  const response = { status: 'ok', retcode: 0, data: { images: [{ file: 'base64://' + payload, mime: 'image/png', width: 1, height: 1, bytes: 3000 }, { mime: 'image/png', width: 2, height: 2, bytes: 5 }], model: 'm' } };
  const shown = redactResponse(response);
  assert.equal(shown.data.images[0].file, `base64://[已省略 ${payload.length} 字符]`);
  assert.deepEqual(shown.data.images[1], response.data.images[1]);
  assert.equal(shown.data.model, 'm');
  assert.equal(response.data.images[0].file, 'base64://' + payload, 'the real answer is not modified');
  const sameWhenNothingToShrink = { status: 'ok', retcode: 0, data: { message_id: 5, images: [] } };
  assert.deepEqual(redactResponse(sameWhenNothingToShrink), sameWhenNothingToShrink);
  assert.equal(redactResponse({ status: 'failed', retcode: 1500, data: null }).data, null);
});

test('generate_image works over the HTTP API with the access token, including the _async form', async t => {
  const api = await mockAI(t, images());
  const image = createImageClient({ settings: () => settingsFor(api.baseUrl) });
  const config = defaultConfig();
  config.ws = { ...config.ws, enabled: false, port: 0 };
  config.http = { enabled: true, host: '127.0.0.1', port: 0 };
  let state;
  const converter = createEventConverter();
  const network = await startOneBot({ config, onStatus: value => { state = value; }, dispatch: request => dispatchAction(noChannel, converter, request, { image }) });
  t.after(() => network.close());
  network.setStatus({ phase: 'session_ready', self_id: 12345 });
  const call = (path, body) => fetch(state.http.address + path, { method: 'POST', headers: { Authorization: 'Bearer ' + config.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await fetch(state.http.address + '/generate_image', { method: 'POST', body: '{}' })).status, 401);
  const done = await (await call('/generate_image', { prompt: '一只猫', n: 1 })).json();
  assert.equal(done.status, 'ok');
  assert.equal(done.data.images.length, 1);
  assert.match(done.data.images[0].file, /^base64:\/\//);
  assert.equal((await (await call('/generate_image', { prompt: '' })).json()).retcode, 1400);

  const before = api.requests.length;
  const early = await (await call('/generate_image_async', { prompt: '后台生成', n: 1 })).json();
  assert.deepEqual(early, { status: 'async', retcode: 1, data: null });
  for (let attempt = 0; attempt < 100 && api.requests.length === before; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(api.requests.length, before + 1, 'the generation still runs in the background');
});
