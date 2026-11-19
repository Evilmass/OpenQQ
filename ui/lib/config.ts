import type { HttpPostConfig, OpenQQConfig, ReverseConfig } from './types';

// Client-side checks mirror validateConfig() in src/config.mjs; the server validates again on save.
export function portError(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? null : '请输入 1–65535 的端口';
}

export function reverseUrlError(value: string) {
  try {
    const url = new URL(value.trim());
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error();
    return null;
  } catch { return '请填写不含查询参数的 ws:// 或 wss:// 地址'; }
}

export function postUrlError(value: string) {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return null;
  } catch { return '请填写不含账号密码和 # 的 http:// 或 https:// 地址'; }
}

export const tokenError = (value: string) => /^[\x21-\x7e]{16,256}$/.test(value) ? null : '需要 16–256 位非空格 ASCII 字符';
export const secretError = (value: string) => /^[!-~]{0,256}$/.test(value) ? null : '密钥只能包含非空格 ASCII 字符';
export const reverseTokenError = (value: string) => /^[\x21-\x7e]{0,256}$/.test(value) ? null : '令牌只能包含非空格 ASCII 字符';

export interface ConfigIssues { [field: string]: string }

export function validateDraft(config: OpenQQConfig): ConfigIssues {
  const issues: ConfigIssues = {};
  if (!config.qqRoot.trim()) issues.qqRoot = '请填写 QQ 安装目录';
  const web = portError(config.webPort); if (web) issues.webPort = web;
  const token = tokenError(config.accessToken); if (token) issues.accessToken = token;
  if (config.ws.enabled) {
    const ws = portError(config.ws.port); if (ws) issues['ws.port'] = ws;
    else if (config.ws.port === config.webPort) issues['ws.port'] = 'WebSocket 与 WebUI 不能使用同一个端口';
  }
  config.reverseWs.forEach((item, index) => {
    const url = reverseUrlError(item.url); if (url) issues[`reverseWs.${index}.url`] = url;
    const secret = reverseTokenError(item.token); if (secret) issues[`reverseWs.${index}.token`] = secret;
  });
  if (config.http.enabled) {
    const http = portError(config.http.port); if (http) issues['http.port'] = http;
    else if (config.http.port === config.webPort) issues['http.port'] = 'HTTP 与 WebUI 不能使用同一个端口';
    else if (config.ws.enabled && config.http.port === config.ws.port) issues['http.port'] = 'HTTP 与 WebSocket 不能使用同一个端口';
  }
  config.httpPost.forEach((item, index) => {
    const url = postUrlError(item.url); if (url) issues[`httpPost.${index}.url`] = url;
    const secret = secretError(item.secret); if (secret) issues[`httpPost.${index}.secret`] = secret;
  });
  if (!config.ws.enabled && !config.reverseWs.some(item => item.enabled) && !config.http.enabled && !config.httpPost.some(item => item.enabled)) issues.connections = '请至少启用一种接入方式';
  return issues;
}

/** Normalizes a draft into the shape accepted by POST /api/config. */
export function cleanConfig(config: OpenQQConfig): OpenQQConfig {
  return { version: 1, qqRoot: config.qqRoot.trim(), webPort: Number(config.webPort), accessToken: config.accessToken,
    ws: { enabled: config.ws.enabled, host: config.ws.host, port: Number(config.ws.port) },
    reverseWs: config.reverseWs.filter(item => item.url.trim()).map((item): ReverseConfig => ({ enabled: item.enabled, url: item.url.trim(), token: item.token })),
    http: { enabled: config.http.enabled, host: config.http.host, port: Number(config.http.port) },
    httpPost: config.httpPost.filter(item => item.url.trim()).map((item): HttpPostConfig => ({ enabled: item.enabled, url: item.url.trim(), secret: item.secret })) };
}

export const httpAddress = (config: Pick<OpenQQConfig, 'http'>) => `http://${config.http.host === '0.0.0.0' ? '<局域网 IP>' : '127.0.0.1'}:${config.http.port}/`;
export const forwardAddress = (config: Pick<OpenQQConfig, 'ws'>) => `ws://${config.ws.host === '0.0.0.0' ? '<局域网 IP>' : '127.0.0.1'}:${config.ws.port}/`;
