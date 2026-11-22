import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACTION_SPECS, getActionSpec, isOpenQQAction } from './action-catalog.mjs';
import { OpenQQClient } from './sdk.mjs';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

function readVersion() {
  try { return JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

function parseList(value) {
  if (!value) return new Set();
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return new Set(value.map(item => String(item).trim()).filter(Boolean));
  return new Set(String(value).split(',').map(item => item.trim()).filter(Boolean));
}

export function resolveMcpEndpoint(env = process.env) {
  if (env.OPENQQ_URL) return { url: env.OPENQQ_URL, token: env.OPENQQ_TOKEN ?? '' };
  const configPath = env.OPENQQ_CONFIG ? resolve(env.OPENQQ_CONFIG) : join(projectDir, 'config', 'openqq.json');
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    const token = env.OPENQQ_TOKEN ?? cfg.accessToken ?? '';
    if (cfg.http?.enabled) {
      const host = cfg.http.host === '0.0.0.0' ? '127.0.0.1' : cfg.http.host || '127.0.0.1';
      return { url: `http://${host}:${cfg.http.port}`, token };
    }
    if (cfg.ws?.enabled) {
      const host = cfg.ws.host === '0.0.0.0' ? '127.0.0.1' : cfg.ws.host || '127.0.0.1';
      return { url: `ws://${host}:${cfg.ws.port}`, token };
    }
  } catch { /* fallback to default */ }
  return { url: 'http://127.0.0.1:5700', token: env.OPENQQ_TOKEN ?? '' };
}

export function createMcpHandler({
  invoke,
  readonly = false,
  allowSensitive = false,
  allowActions = [],
  denyActions = [],
  version = readVersion(),
} = {}) {
  if (typeof invoke !== 'function') throw new TypeError('invoke 必须为函数');
  const allowSet = parseList(allowActions);
  const denySet = parseList(denyActions);

  function checkPolicy(action) {
    const spec = getActionSpec(action);
    if (!spec) return { allowed: false, reason: `未知的 OpenQQ 动作：${action}` };
    if (denySet.has(action)) return { allowed: false, reason: `动作 ${action} 已被 OPENQQ_MCP_DENY_ACTIONS 禁用` };
    if (allowSet.size > 0 && !allowSet.has(action)) return { allowed: false, reason: `动作 ${action} 不在 OPENQQ_MCP_ALLOW_ACTIONS 白名单中` };
    if (readonly && spec.safety !== 'read') return { allowed: false, reason: `当前 MCP 运行在只读模式（OPENQQ_MCP_READONLY=1），拒绝执行 ${spec.safety} 类动作 ${action}` };
    if (spec.safety === 'sensitive' && !allowSensitive && !allowSet.has(action)) {
      return { allowed: false, reason: `敏感凭据动作 ${action} 默认被 MCP 策略阻止（如需启用请设置 OPENQQ_MCP_ALLOW_SENSITIVE=1 或加入白名单）` };
    }
    return { allowed: true, spec };
  }

  const tools = [
    {
      name: 'list_actions',
      description: 'List supported OpenQQ OneBot v11 actions, optionally filtered by group or safety level.',
      inputSchema: {
        type: 'object',
        properties: {
          group: { type: 'string', enum: ['消息', '群管理', '账号', '扩展'], description: 'Filter by action group.' },
          safety: { type: 'string', enum: ['read', 'send', 'admin', 'sensitive'], description: 'Filter by safety tier.' },
          include_aliases: { type: 'boolean', description: 'Include alias action names (default false).' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'query_action',
      description: 'Inspect the schema, group, safety tier, and policy status of a specific OpenQQ OneBot v11 action.',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', description: 'OneBot v11 action name (e.g. send_group_msg, get_group_msg_history).' } },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'invoke_action',
      description: 'Invoke an allowed OpenQQ OneBot v11 action against the running QQ session.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'OneBot v11 action name.' },
          params: { type: 'object', description: 'Action parameters object.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  ];

  const resources = [
    {
      uri: 'openqq://onebot/actions',
      name: 'OpenQQ OneBot v11 Actions',
      description: 'Complete catalog of OpenQQ supported OneBot v11 actions, groups, safety levels, and parameters.',
      mimeType: 'application/json',
    },
  ];

  const textResult = (payload, isError = false) => ({
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  });

  async function handleToolCall(name, args = {}) {
    if (name === 'list_actions') {
      const list = ACTION_SPECS
        .filter(item => (!args.group || item.group === args.group)
          && (!args.safety || item.safety === args.safety)
          && (args.include_aliases || !item.aliasOf))
        .map(item => ({ ...item, allowed: checkPolicy(item.action).allowed }));
      return textResult({ total: list.length, readonly, actions: list });
    }
    if (name === 'query_action') {
      const action = String(args.action ?? '');
      const spec = getActionSpec(action);
      if (!spec) return textResult({ error: `未找到动作：${action}` }, true);
      const policy = checkPolicy(action);
      return textResult({ ...spec, allowed: policy.allowed, ...(policy.reason ? { blocked_reason: policy.reason } : {}) });
    }
    if (name === 'invoke_action') {
      const action = String(args.action ?? '');
      if (!isOpenQQAction(action)) return textResult({ error: `不支持的动作：${action}` }, true);
      const policy = checkPolicy(action);
      if (!policy.allowed) return textResult({ error: policy.reason }, true);
      const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : {};
      try {
        const res = await invoke(action, params);
        const failed = res && typeof res === 'object' && 'status' in res && res.status !== 'ok' && res.status !== 'async';
        return textResult(res, failed);
      } catch (error) {
        return textResult({ error: error.message, retcode: error.retcode ?? 1500 }, true);
      }
    }
    throw Object.assign(new Error(`未知工具：${name}`), { code: -32601 });
  }

  return async function handleMessage(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' } };
    }
    const isNotification = !Object.hasOwn(message, 'id');
    const ok = result => isNotification ? null : { jsonrpc: '2.0', id: message.id, result };
    const err = (code, msg) => isNotification ? null : { jsonrpc: '2.0', id: message.id, error: { code, message: msg } };
    try {
      switch (message.method) {
        case 'initialize':
          return ok({
            protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2024-11-05',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'openqq-mcp', version },
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools });
        case 'tools/call':
          if (!message.params || typeof message.params.name !== 'string') return err(-32602, 'tools/call requires params.name');
          return ok(await handleToolCall(message.params.name, message.params.arguments ?? {}));
        case 'resources/list':
          return ok({ resources });
        case 'resources/read': {
          const uri = message.params?.uri;
          if (uri !== 'openqq://onebot/actions') return err(-32602, `Unknown resource URI: ${uri}`);
          return ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(ACTION_SPECS, null, 2) }] });
        }
        default:
          return err(-32601, `Method not found: ${message.method}`);
      }
    } catch (error) {
      return err(error.code ?? -32603, error.message || 'Internal error');
    }
  };
}

export function startMcpStdio({ input = process.stdin, output = process.stdout, env = process.env, client: customClient } = {}) {
  const endpoint = resolveMcpEndpoint(env);
  const client = customClient ?? new OpenQQClient({ url: endpoint.url, token: endpoint.token, reconnect: true });
  const handle = createMcpHandler({
    invoke: (action, params) => client.call(action, params, { raw: true }),
    readonly: env.OPENQQ_MCP_READONLY === '1' || env.OPENQQ_MCP_READONLY === 'true',
    allowSensitive: env.OPENQQ_MCP_ALLOW_SENSITIVE === '1' || env.OPENQQ_MCP_ALLOW_SENSITIVE === 'true',
    allowActions: env.OPENQQ_MCP_ALLOW_ACTIONS,
    denyActions: env.OPENQQ_MCP_DENY_ACTIONS,
  });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = obj => { if (obj) output.write(JSON.stringify(obj) + '\n'); };
  let queue = Promise.resolve();
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    queue = queue.then(async () => {
      let parsed;
      try { parsed = JSON.parse(trimmed); }
      catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
      try { write(await handle(parsed)); }
      catch (error) { write({ jsonrpc: '2.0', id: parsed?.id ?? null, error: { code: -32603, message: error.message } }); }
    });
  });
  const done = new Promise(resolveDone => rl.once('close', () => {
    queue.finally(() => client.close?.().catch(() => {}).finally(resolveDone));
  }));
  return { rl, client, done };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startMcpStdio();
}
