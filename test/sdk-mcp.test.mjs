import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { defaultConfig } from '../src/config.mjs';
import { startOneBot } from '../src/network.mjs';
import { OpenQQClient, OpenQQError, MessageBuilder, msg, OPENQQ_ACTIONS, isOpenQQAction } from '../src/sdk.mjs';
import { createMcpHandler, startMcpStdio } from '../src/mcp.mjs';

test('MessageBuilder builds standard and extended OneBot segments cleanly', () => {
  const built = msg()
    .reply(10)
    .at(654321, '小明')
    .text('你好 ')
    .face(76)
    .image('base64://QUJD', { summary: '[图]', sub_type: 1 })
    .dice()
    .rps()
    .mface('e1', 100, { summary: '[表情]' })
    .markdown('# hi')
    .contact('group', 987654)
    .build();
  assert.equal(built.length, 10);
  assert.deepEqual(built[0], { type: 'reply', data: { id: '10' } });
  assert.deepEqual(built[1], { type: 'at', data: { qq: '654321', name: '小明' } });
  assert.deepEqual(built[4], { type: 'image', data: { file: 'base64://QUJD', summary: '[图]', sub_type: 1 } });
  assert.deepEqual(built[9], { type: 'contact', data: { type: 'group', id: '987654' } });

  const forward = new MessageBuilder()
    .nodeRef(12, '甲')
    .node(msg().text('自定义节点'), { name: 'OpenQQ', uin: '10000' })
    .build();
  assert.equal(forward[0].data.id, '12');
  assert.deepEqual(forward[1].data.content, [{ type: 'text', data: { text: '自定义节点' } }]);
  assert.equal(isOpenQQAction('send_group_forward_msg'), true);
  assert.equal(isOpenQQAction('nonexistent_action'), false);
  assert.ok(OPENQQ_ACTIONS.includes('get_group_msg_history'));
});

test('OpenQQClient works end-to-end over both HTTP and WebSocket transports', async t => {
  const base = defaultConfig();
  let wsAddr = '';
  let httpAddr = '';
  const received = [];
  const server = await startOneBot({
    config: {
      ...base,
      ws: { enabled: true, host: '127.0.0.1', port: 0 },
      http: { enabled: true, host: '127.0.0.1', port: 0 },
    },
    onStatus: status => {
      if (status.ws?.address) wsAddr = status.ws.address;
      if (status.http?.address) httpAddr = status.http.address;
    },
    dispatch: async req => {
      received.push(req);
      if (req.action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123456, nickname: '测试号' }, ...(req.echo !== undefined ? { echo: req.echo } : {}) };
      if (req.action === 'send_group_msg') return { status: 'ok', retcode: 0, data: { message_id: 99 }, ...(req.echo !== undefined ? { echo: req.echo } : {}) };
      return { status: 'failed', retcode: 1404, data: null, message: '未知动作', ...(req.echo !== undefined ? { echo: req.echo } : {}) };
    },
  });
  t.after(() => server.close());
  server.setStatus({ phase: 'session_ready', self_id: '123456', syncing: false });

  // HTTP client
  const httpClient = new OpenQQClient({ url: httpAddr, token: base.accessToken });
  assert.equal(httpClient.transport, 'http');
  const login = await httpClient.getLoginInfo();
  assert.deepEqual(login, { user_id: 123456, nickname: '测试号' });
  const sent = await httpClient.sendGroupMsg(987654, msg().text('hello sdk'));
  assert.deepEqual(sent, { message_id: 99 });
  assert.deepEqual(received.at(-1).params.message, [{ type: 'text', data: { text: 'hello sdk' } }]);
  await assert.rejects(() => httpClient.call('unknown_xyz'), err => err instanceof OpenQQError && err.retcode === 1404);

  // WebSocket client + live event delivery
  const wsClient = new OpenQQClient({ url: wsAddr, token: base.accessToken, reconnect: false });
  t.after(() => wsClient.close());
  assert.equal(wsClient.transport, 'ws');
  await wsClient.connect();
  assert.equal(wsClient.connected, true);

  const gotGroupMsg = new Promise(resolve => wsClient.once('message.group', resolve));
  server.broadcast({ post_type: 'message', message_type: 'group', group_id: 987654, user_id: 654321, raw_message: 'ping', message: [{ type: 'text', data: { text: 'ping' } }] });
  const evt = await gotGroupMsg;
  assert.equal(evt.group_id, 987654);

  const wsLogin = await wsClient.getLoginInfo();
  assert.equal(wsLogin.nickname, '测试号');
  await wsClient.close();
  assert.equal(wsClient.connected, false);
});

test('MCP handler implements JSON-RPC 2.0 protocol, resources, tools, and strict security guardrails', async () => {
  const invoked = [];
  const invoke = async (action, params) => {
    invoked.push([action, params]);
    return { status: 'ok', retcode: 0, data: { action, ok: true } };
  };

  // Default policy: read/send/admin allowed, sensitive blocked by default
  const handler = createMcpHandler({ invoke, version: '0.4.0' });
  const init = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(init.result.serverInfo.name, 'openqq-mcp');
  assert.equal(await handler({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await handler({ jsonrpc: '2.0', id: 2, method: 'ping' })).result, {});

  const resources = await handler({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  assert.equal(resources.result.resources[0].uri, 'openqq://onebot/actions');
  const readRes = await handler({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'openqq://onebot/actions' } });
  const parsedCatalog = JSON.parse(readRes.result.contents[0].text);
  assert.equal(parsedCatalog.length, OPENQQ_ACTIONS.length);

  const tools = await handler({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  assert.deepEqual(tools.result.tools.map(t => t.name), ['list_actions', 'query_action', 'invoke_action']);

  const listed = await handler({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_actions', arguments: { group: '账号', safety: 'sensitive' } } });
  const listedBody = JSON.parse(listed.result.content[0].text);
  assert.ok(listedBody.actions.length >= 4);
  assert.ok(listedBody.actions.every(a => a.allowed === false), 'sensitive actions are marked blocked by default');

  const sensitiveBlocked = await handler({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'invoke_action', arguments: { action: 'get_cookies', params: {} } } });
  assert.equal(sensitiveBlocked.result.isError, true);
  assert.match(sensitiveBlocked.result.content[0].text, /敏感凭据/);
  assert.equal(invoked.length, 0);

  const okCall = await handler({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'invoke_action', arguments: { action: 'get_login_info', params: {} } } });
  assert.equal(okCall.result.isError, undefined);
  assert.deepEqual(invoked, [['get_login_info', {}]]);

  // Read-only mode blocks send & admin
  const readonlyHandler = createMcpHandler({ invoke, readonly: true });
  const blockedSend = await readonlyHandler({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'invoke_action', arguments: { action: 'send_group_msg', params: { group_id: 1, message: 'x' } } } });
  assert.equal(blockedSend.result.isError, true);
  assert.match(blockedSend.result.content[0].text, /只读模式/);

  // Explicit allowSensitive allows credentials
  const privileged = createMcpHandler({ invoke, allowSensitive: true, denyActions: ['delete_friend'] });
  const okCookie = await privileged({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'invoke_action', arguments: { action: 'get_cookies', params: { domain: 'qun.qq.com' } } } });
  assert.equal(okCookie.result.isError, undefined);
  const denied = await privileged({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'invoke_action', arguments: { action: 'delete_friend', params: { user_id: 1 } } } });
  assert.equal(denied.result.isError, true);
});

test('startMcpStdio processes JSON-RPC lines over stdio streams cleanly', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.setEncoding('utf8');
  output.on('data', chunk => {
    for (const line of chunk.split('\n')) if (line.trim()) lines.push(JSON.parse(line));
  });
  const mcp = startMcpStdio({
    input,
    output,
    env: { OPENQQ_MCP_READONLY: '1' },
    client: {
      call: async (action, params) => ({ status: 'ok', retcode: 0, data: { action, params } }),
      close: async () => {},
    },
  });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'query_action', arguments: { action: 'get_group_msg_history' } } }) + '\n');
  input.write('not json\n');
  input.end();
  await mcp.done;
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(JSON.parse(lines[1].result.content[0].text).allowed, true);
  assert.equal(lines[2].error.code, -32700);
});
