import { readFile, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import nativeActions from '../native/actions.cjs';
import { generateImage } from './image-action.mjs';

const fail = (message, retcode = 1400) => Object.assign(new Error(message), { retcode });
const sendActions = ['send_private_msg', 'send_group_msg', 'send_msg'];
const forwardSendActions = ['send_group_forward_msg', 'send_private_forward_msg', 'send_forward_msg'];
const messageRefRequired = new Set([
  'delete_msg', 'get_msg', 'set_msg_emoji_like', 'set_group_reaction',
  'fetch_emoji_like', 'get_emoji_likes', 'get_msg_emoji_likes',
  'fetch_ptt_text', 'get_ptt_text', 'get_record_text',
  'set_essence_msg', 'delete_essence_msg',
  'forward_group_single_msg', 'forward_friend_single_msg',
]);
const singleMediaActions = {
  upload_group_file: { kind: 'file', field: 'file', required: true },
  upload_private_file: { kind: 'file', field: 'file', required: true },
  set_group_portrait: { kind: 'image', field: 'file', required: true },
  set_qq_avatar: { kind: 'image', field: 'file', required: true },
  _send_group_notice: { kind: 'image', field: 'image', required: false },
};
const MAX_MEDIA_BASE64_BYTES = 16 * 1024 * 1024;

async function formatMediaResult(data, mediaUrl, label = '图片') {
  const file = String(data?.file ?? '');
  const remoteUrl = typeof data?.url === 'string' && /^https?:\/\//.test(data.url) ? data.url : '';
  let size = Number(data?.file_size ?? 0) || 0;
  let exists = false;
  if (file) {
    try {
      const info = await stat(file);
      if (info.isFile()) { exists = true; size = info.size; }
    } catch { /* fallback below */ }
  }
  if (!exists && !remoteUrl) throw fail(`${label}文件不存在或尚未下载`, 1404);
  const fileName = String(data?.file_name || (file ? basename(file) : '') || 'file');
  const url = remoteUrl || (exists && typeof mediaUrl === 'function' ? (mediaUrl(file, fileName) ?? '') : '');
  let base64;
  if (exists && size > 0 && size <= MAX_MEDIA_BASE64_BYTES) {
    try { base64 = (await readFile(file)).toString('base64'); } catch { /* best effort */ }
  }
  return { file, filename: fileName, file_name: fileName, size, file_size: size, url, ...(base64 ? { base64 } : {}) };
}

// Inline media (base64:// or a data: URI) can be megabytes. The WebUI keeps every action in a 2 MiB history and drops any entry larger
// than that, and the terminal prints the request, so both get a copy where the payload is replaced by its size.
const INLINE_MEDIA = /(base64:\/\/|data:[^;,\s]{1,100};base64,)[A-Za-z0-9+/=_\-\s]{512,}/g;
export function redactRequest(value, depth = 0) {
  if (typeof value === 'string') return value.length > 512 ? value.replace(INLINE_MEDIA, (match, head) => `${head}[已省略 ${match.length - head.length} 字符]`) : value;
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => redactRequest(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === 'base64' && typeof item === 'string' && item.length > 512 ? `[已省略 ${item.length} 字符]` : redactRequest(item, depth + 1),
  ]));
}

// get_image / get_record / get_file answer with plain base64, generate_image with base64:// files.
export function redactResponse(response) {
  const data = response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return response;
  const plain = typeof data.base64 === 'string' && data.base64.length > 512;
  if (!plain && !Array.isArray(data.images)) return response;
  return { ...response, data: { ...data, ...(plain ? { base64: `[已省略 ${data.base64.length} 字符]` } : {}), ...(Array.isArray(data.images) ? { images: redactRequest(data.images) } : {}) } };
}

function resolveReplySegments(converter, segments) {
  return segments.map(segment => {
    if (segment?.type !== 'reply') return segment;
    const data = segment.data && typeof segment.data === 'object' && !Array.isArray(segment.data) ? segment.data : {};
    if (data.id === undefined && data.seq !== undefined) {
      return { type: 'reply', data: { seq: String(data.seq) } };
    }
    const ref = converter.resolve(data.id);
    if (ref?.kind !== 'message') throw fail('引用的消息不存在或已过期（仅支持本次运行期间收发过的消息）', 1404);
    return { type: 'reply', data: { id: String(data.id), openqq_ref: { chatType: ref.chatType, peerUid: ref.peerUid, msgId: ref.msgId } } };
  });
}

// OneBot ids are local to this process; translate them into the native references QQ needs before validation.
function resolveReferences(converter, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  const rawParams = request.params;
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) return request;
  // Always discard client-supplied internal fields; only the main process may set them.
  const { openqq_ref: _ignoredRef, openqq_media: _ignoredMedia, ...params } = rawParams;
  if (request.action === 'get_forward_msg') {
    const ref = converter.resolve(params.id ?? params.message_id);
    if (!ref) throw fail('合并转发 id 不存在或已过期（仅支持本次运行期间收到的消息）', 1404);
    // A message id also works: QQ keys a top-level forward by the message that carries it.
    const forward = ref.kind === 'forward' ? ref : { chatType: ref.chatType, peerUid: ref.peerUid, root: ref.msgId, parent: ref.msgId };
    return { ...request, params: { ...params, openqq_ref: { chatType: forward.chatType, peerUid: forward.peerUid, root: forward.root, parent: forward.parent } } };
  }
  if (messageRefRequired.has(request.action)) {
    const ref = converter.resolve(params.message_id);
    if (ref?.kind !== 'message') throw fail('message_id 不存在或已过期（仅支持本次运行期间收发过或被引用的消息）', 1404);
    return { ...request, params: { ...params, openqq_ref: { chatType: ref.chatType, peerUid: ref.peerUid, msgId: ref.msgId } } };
  }
  if (request.action === 'mark_msg_as_read') {
    if (params.message_id !== undefined && params.message_id !== null && String(params.message_id) !== '') {
      const ref = converter.resolve(params.message_id);
      if (ref?.kind !== 'message') throw fail('message_id 不存在或已过期（仅支持本次运行期间收发过的消息）', 1404);
      return { ...request, params: { ...params, openqq_ref: { chatType: ref.chatType, peerUid: ref.peerUid, msgId: ref.msgId } } };
    }
    return { ...request, params };
  }
  if (request.action === 'get_group_msg_history' || request.action === 'get_friend_msg_history') {
    if (params.message_id !== undefined && params.message_id !== null && String(params.message_id) !== '' && String(params.message_id) !== '0') {
      const ref = converter.resolve(params.message_id);
      if (ref?.kind !== 'message') throw fail('message_id 不存在或已过期（仅支持本次运行期间收发过的消息）', 1404);
      return { ...request, params: { ...params, openqq_ref: { chatType: ref.chatType, peerUid: ref.peerUid, msgId: ref.msgId } } };
    }
    if (params.message_seq !== undefined && params.message_seq !== null && String(params.message_seq) !== '' && String(params.message_seq) !== '0') {
      const ref = converter.resolve(params.message_seq);
      if (ref?.kind === 'message') {
        return { ...request, params: { ...params, openqq_ref: { chatType: ref.chatType, peerUid: ref.peerUid, msgId: ref.msgId } } };
      }
    }
    return { ...request, params };
  }
  if (sendActions.includes(request.action) && Array.isArray(params.message)) {
    return { ...request, params: { ...params, message: resolveReplySegments(converter, params.message) } };
  }
  if (forwardSendActions.includes(request.action) && Array.isArray(params.messages)) {
    const messages = params.messages.map(node => {
      if (!node || typeof node !== 'object' || node.type !== 'node' || !node.data || typeof node.data !== 'object' || Array.isArray(node.data)) return node;
      const { openqq_ref: _dropRef, ...data } = node.data;
      if (data.id !== undefined) {
        const ref = converter.resolve(data.id);
        if (ref?.kind !== 'message') throw fail('合并转发节点引用的消息 id 不存在或已过期', 1404);
        return { ...node, data: { ...data, openqq_ref: { chatType: ref.chatType, peerUid: ref.peerUid, msgId: ref.msgId } } };
      }
      if (Array.isArray(data.content)) return { ...node, data: { ...data, content: resolveReplySegments(converter, data.content) } };
      if (data.content === undefined && Array.isArray(data.message)) return { ...node, data: { ...data, content: resolveReplySegments(converter, data.message) } };
      return { ...node, data };
    });
    return { ...request, params: { ...params, messages } };
  }
  return { ...request, params };
}

// Answers that need no QQ session. `can_send_*` is always yes because sending media is implemented here.
function localAnswer(request, options) {
  if (request?.action === 'get_version_info') {
    return { app_name: 'OpenQQ', app_version: options.version ?? '', protocol_version: 'v11' };
  }
  if (request?.action === 'can_send_image' || request?.action === 'can_send_record') return { yes: true };
  if (request?.action === 'nc_get_packet_status') return { ok: false, mode: 'native-wrapper' };
  if (request?.action === 'check_url_safely') {
    const raw = request.params?.url;
    if (typeof raw !== 'string' || !raw.trim()) throw fail('url 不能为空');
    let parsed;
    try { parsed = new URL(raw.trim()); } catch { throw fail('url 格式无效'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw fail('url 必须是 http(s) 链接');
    return { level: 2 };
  }
  return undefined;
}

// `options.media` (see src/media.mjs) turns image / record / video / file segments into prepared local files.
export async function dispatchAction(channel, converter, request, options = {}) {
  let response;
  let release = async () => {};
  try {
    const local = localAnswer(request, options);
    if (local !== undefined) {
      response = { status: 'ok', retcode: 0, data: local };
    } else if (request?.action === 'generate_image') {
      // 发送走同一个 dispatchAction，所以图片照常经过媒体处理（落盘、大小限制）和 QQ 的发送回执。
      const data = await generateImage(request.params ?? {}, { image: options.image, send: next => dispatchAction(channel, converter, next, options) });
      response = { status: 'ok', retcode: 0, data };
    } else if (request?.action === 'download_file') {
      if (typeof options.media?.downloadToFile !== 'function') throw fail('当前未启用媒体下载服务', 1500);
      const data = await options.media.downloadToFile(request.params ?? {});
      response = { status: 'ok', retcode: 0, data };
    } else if (request?.action === 'clean_cache') {
      // Only OpenQQ's own temporary media is cleaned, and only what an earlier run left behind (the same rule as at startup).
      await options.media?.sweep();
      response = { status: 'ok', retcode: 0, data: null };
    } else {
      let prepared = resolveReferences(converter, nativeActions.normalizeParams(request));
      if (options.media && prepared?.params && typeof prepared.params === 'object') {
        if (sendActions.includes(prepared.action)) {
          const media = await options.media.prepare(prepared.params);
          prepared = { ...prepared, params: media.params };
          release = media.release;
        } else if (forwardSendActions.includes(prepared.action) && typeof options.media.prepareForward === 'function') {
          const media = await options.media.prepareForward(prepared.params);
          prepared = { ...prepared, params: media.params };
          release = media.release;
        } else if (Object.hasOwn(singleMediaActions, prepared.action) && typeof options.media.prepareSingle === 'function') {
          const spec = singleMediaActions[prepared.action];
          const source = prepared.params[spec.field] ?? (spec.field === 'file' ? prepared.params.url ?? prepared.params.path : undefined);
          if (spec.required || (typeof source === 'string' && source.trim())) {
            const single = await options.media.prepareSingle(spec.kind, { file: source, name: prepared.params.name });
            const nextParams = { ...prepared.params, openqq_media: single.media };
            delete nextParams[spec.field];
            if (spec.field === 'file') { delete nextParams.url; delete nextParams.path; }
            prepared = { ...prepared, params: nextParams };
            release = single.release;
          }
        }
      }
      const action = nativeActions.validateAction(prepared);
      response = await channel.request(prepared, (action.timeout ?? 15000) + 5000);
      if (!response || !['ok', 'failed'].includes(response.status) || !Number.isSafeInteger(response.retcode)) throw new Error('原生动作回执无效');
      if (response.status === 'ok' && response.retcode !== 0) throw new Error('原生动作回执状态不一致');
      if (response.status === 'ok' && (action.kind === 'send' || action.kind === 'forward_single' || action.kind === 'send_forward')) {
        response = { status: 'ok', retcode: 0, data: { message_id: converter.messageId(response.data.self, response.data.message) } };
      }
      if (response.status === 'ok' && action.kind === 'forward') {
        response = { status: 'ok', retcode: 0, data: converter.forwardResult(response.data.self, response.data.forward) };
      }
      if (response.status === 'ok' && action.kind === 'get_msg') {
        response = { status: 'ok', retcode: 0, data: converter.messageResult(response.data.self, response.data.message) };
      }
      if (response.status === 'ok' && action.kind === 'msg_history') {
        response = { status: 'ok', retcode: 0, data: converter.historyResult(response.data.self, response.data.messages) };
      }
      if (response.status === 'ok' && action.kind === 'get_image') {
        response = { status: 'ok', retcode: 0, data: await formatMediaResult(response.data, options.mediaUrl, '图片') };
      }
      if (response.status === 'ok' && action.kind === 'get_record') {
        let resultData = response.data;
        if (action.outFormat && resultData?.file && typeof options.media?.decodeRecord === 'function') {
          const tempFiles = [];
          try {
            const decoded = await options.media.decodeRecord(resultData.file, action.outFormat, p => tempFiles.push(p));
            // Keep the final converted file for the caller; remove any intermediate files (e.g. temp WAV before MP3).
            await Promise.all(tempFiles.filter(p => p !== decoded.path).map(p => rm(p, { force: true }).catch(() => {})));
            resultData = { ...resultData, file: decoded.path, file_name: basename(decoded.path) };
          } catch (error) {
            await Promise.all(tempFiles.map(p => rm(p, { force: true }).catch(() => {})));
            throw error;
          }
        }
        response = { status: 'ok', retcode: 0, data: await formatMediaResult(resultData, options.mediaUrl, '语音') };
      }
      if (response.status === 'ok' && action.kind === 'get_file') {
        response = { status: 'ok', retcode: 0, data: await formatMediaResult(response.data, options.mediaUrl, '文件') };
      }
    }
  } catch (error) {
    response = { status: 'failed', retcode: error.retcode ?? 1500, data: null, message: error.message };
  } finally {
    await release();
  }
  return { ...response, ...(request && Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) };
}
