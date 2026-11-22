'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./common.cjs');
const { readSystemEvent } = require('./system.cjs');
const validUin = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const now = () => Math.floor(Date.now() / 1000);
// Merged-forward expansion limits: nesting depth, messages per root and serialized size (IPC frames cap at 1 MiB).
const FORWARD_DEPTH = 3;
const FORWARD_LIMIT = 200;
const FORWARD_BYTES = 512 * 1024;
// A member who just joined or left is often unknown to every UID store until QQ pushes the refreshed member list.
const MEMBER_RETRY_MS = 1500;
const MEDIA_TIMEOUT_MS = 12000;

async function existingFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) return undefined;
  try {
    const info = await fs.promises.stat(filePath);
    return info.isFile() && info.size > 0 ? filePath : undefined;
  } catch { return undefined; }
}

async function pickThumbPath(thumbPath) {
  const entries = thumbPath instanceof Map ? [...thumbPath.entries()]
    : thumbPath && typeof thumbPath === 'object' ? Object.entries(thumbPath) : [];
  entries.sort(([a], [b]) => (Number(a) === 0 ? -1 : Number(b) === 0 ? 1 : Number(b) - Number(a)));
  for (const [, candidate] of entries) {
    const ready = await existingFile(candidate);
    if (ready) return ready;
  }
  return undefined;
}

function createEventReceiver(session, self, report, current, { memberRetryMs = MEMBER_RETRY_MS, mediaTimeoutMs = MEDIA_TIMEOUT_MS } = {}) {
  const cache = new Map();
  const seenShapes = new Set();
  const members = new Map();
  const started = now();
  let friends;
  // Names of the friends in the last full list QQ pushed, for get_friend_list.
  let friendDetails;
  let friendCategories;
  let syncing = true;
  // Async push-reply waiters for NTQQ APIs whose responses arrive on a kernel listener.
  const eventWaiters = new Map();
  function waitFor(channel, match, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let set = eventWaiters.get(channel);
      if (!set) { set = new Set(); eventWaiters.set(channel, set); }
      const entry = {
        match,
        resolve(value) { clearTimeout(timer); set.delete(entry); if (!set.size) eventWaiters.delete(channel); resolve(value); },
        reject(error) { clearTimeout(timer); set.delete(entry); if (!set.size) eventWaiters.delete(channel); reject(error); },
      };
      const timer = setTimeout(() => entry.reject(fail(`等待 QQ ${channel} 回调超时`, 1501)), timeoutMs);
      set.add(entry);
    });
  }
  function notifyWaiters(channel, payload) {
    const set = eventWaiters.get(channel);
    if (!set || !set.size) return;
    for (const entry of [...set]) {
      try { if (entry.match(payload)) entry.resolve(payload); } catch { /* ignore matcher error */ }
    }
  }
  // Groups QQ has told us about, for get_group_list / get_group_info. QQ answers a refresh through the group listener.
  const groups = { map: new Map(), version: 0 };
  const groupWaiters = new Set();
  groups.waitForUpdate = (since, ms) => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); groupWaiters.delete(finish); resolve(); };
    const timer = setTimeout(finish, ms);
    groupWaiters.add(finish);
    if (groups.version !== since) finish();
  });
  function updateGroups(type, list) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || !/^\d+$/.test(String(item.groupCode))) continue;
      if (type === 3) groups.map.delete(String(item.groupCode));
      else groups.map.set(String(item.groupCode), item);
    }
    groups.version++;
    for (const finish of [...groupWaiters]) finish();
  }
  const remember = (uid, uin) => {
    if (uid && validUin(uin)) cache.set(uid, String(uin));
    if (cache.size > 10000) cache.delete(cache.keys().next().value);
  };
  remember(self.uid, self.uin);

  const inflight = new Map();
  async function uin(uid, hint) {
    if (!current()) throw new Error('会话已失效');
    if (validUin(hint)) { remember(uid, hint); return String(hint); }
    if (validUin(uid)) return String(uid);
    if (typeof uid !== 'string' || !uid) throw new Error('事件缺少用户 UID');
    if (cache.has(uid)) return cache.get(uid);
    // NT UIDs are always "u_"-prefixed; anything else (e.g. the "0" placeholder) can never convert,
    // so fail fast instead of spending the 5-second lookup budget.
    if (!/^u_[\w-]+$/.test(uid)) throw new Error(`UID 格式无效：${uid.slice(0, 40)}`);
    // Bursts (a message with several @, a member leaving several groups) share one native lookup.
    if (inflight.has(uid)) return inflight.get(uid);
    const pending = lookup(uid).finally(() => inflight.delete(uid));
    inflight.set(uid, pending);
    return pending;
  }
  // Optional identities (operators, @ targets) degrade instead of discarding the whole event.
  async function optionalUin(uid, stage, hint) {
    try { return await uin(uid, hint); }
    catch (error) {
      if (!current()) throw error;
      emit({ type: 'event_error', stage, error: error.message + '，已按未知处理并继续上报' });
      return undefined;
    }
  }
  // The subject of a membership notice gets one delayed retry (member list pushes fill the cache meanwhile),
  // then degrades to unknown like an operator, so the join/leave itself is still reported.
  async function memberUin(uid, stage) {
    try { return await uin(uid); }
    catch (error) {
      if (!current()) throw error;
      await new Promise(resolve => setTimeout(resolve, memberRetryMs));
      return optionalUin(uid, stage);
    }
  }

  async function lookup(uid) {
    let timer;
    let finished = false;
    // Same fallback order as mature NTQQ bridges: strangers and members who just left a group
    // are often missing from the friend/profile store but still known to the group service.
    const lookups = [
      async () => (await session.getUixConvertService().getUin([uid]))?.uinInfo?.get(uid),
      async () => (await session.getProfileService().getUinByUid('FriendsServiceImpl', [uid]))?.get(uid),
      async () => (await session.getGroupService().getUinByUids([uid]))?.uins?.get(uid),
    ];
    const timeout = Symbol('timeout');
    let result;
    try {
      result = await Promise.race([
        (async () => {
          for (const lookup of lookups) {
            if (!current() || finished) return undefined;
            let value;
            try { value = await lookup(); } catch {}
            if (validUin(value)) return value;
          }
          return undefined;
        })(),
        new Promise(resolve => { timer = setTimeout(() => resolve(timeout), 5000); }),
      ]);
    } finally { finished = true; clearTimeout(timer); }
    if (result === timeout) throw new Error(`UID ${uid} 转 QQ 号超时（5 秒）`);
    if (!validUin(result)) throw new Error(`UID ${uid} 未能转换为 QQ 号（UixConvert/Profile/Group 均无映射）`);
    remember(uid, result);
    return String(result);
  }

  function emit(event) { if (current()) report(event); }
  function notice(event, key, time = now(), message) {
    emit({ type: 'notice', self, event, key, time, message });
  }
  async function batch(values, action, stage) {
    if (!Array.isArray(values)) throw new Error('事件列表必须为数组');
    await Promise.all(values.map(value => Promise.resolve().then(() => current() ? action(value) : undefined).catch(error => {
      emit({ type: 'event_error', stage, error: error.message });
    })));
  }
  function native(source, name, args) {
    // Unknown callbacks report structure once, never opaque network buffers or credentials.
    const key = `${source}/${name}`;
    if (seenShapes.has(key)) return;
    if (seenShapes.size >= 500) seenShapes.delete(seenShapes.values().next().value);
    seenShapes.add(key);
    const shape = value => value === null ? 'null' : Array.isArray(value) ? `array(${value.length})`
      : value instanceof Map ? `map(${value.size})` : typeof value === 'object' ? Object.keys(value).slice(0, 50) : typeof value;
    emit({ type: 'native_callback', source, event: name, argument_shapes: args.map(shape) });
  }

  // Reply sends and essence actions need msgSeq/clientSeq/msgRandom of the message; keep them for recently seen messages.
  const recent = new Map();
  function record(input, senderUin = input.senderUin) {
    if (!/^\d+$/.test(String(input?.msgId ?? ''))) return;
    recent.set(`${input.chatType}:${input.peerUid}:${input.msgId}`, { msgId: String(input.msgId), msgSeq: String(input.msgSeq ?? ''),
      clientSeq: String(input.clientSeq ?? ''), msgRandom: String(input.msgRandom ?? ''), senderUin: String(senderUin ?? ''), senderUid: String(input.senderUid ?? '') });
    if (recent.size > 5000) recent.delete(recent.keys().next().value);
  }
  const lookupRecent = ref => recent.get(`${ref.chatType}:${ref.peerUid}:${ref.msgId}`);

  // Received rich-media index (for get_image) and download completion waiters (onRichMediaDownloadComplete).
  const mediaCache = new Map();
  const downloadWaiters = new Map();
  const inflightMedia = new Map();
  function cacheMediaKey(key, entry) {
    if (typeof key !== 'string' || !key) return;
    mediaCache.delete(key);
    mediaCache.set(key, entry);
    if (mediaCache.size > 5000) mediaCache.delete(mediaCache.keys().next().value);
  }
  function rememberMedia(element, ctx, msgId, resolvedPath) {
    const map = { 2: 'picElement', 3: 'fileElement', 4: 'pttElement', 5: 'videoElement' };
    const field = map[element?.elementType];
    const value = field ? element[field] : null;
    if (!value || typeof value !== 'object') return;
    const entry = {
      elementType: element.elementType,
      chatType: ctx.peer.chatType,
      peerUid: String(ctx.peer.peerUid),
      msgId: String(msgId ?? ''),
      elementId: String(element.elementId ?? ''),
      fileName: String(value.fileName ?? ''),
      md5: String(value.md5HexStr ?? value.fileMd5 ?? ''),
      fileUuid: String(value.fileUuid ?? ''),
      fileSize: Number(value.fileSize ?? 0) || 0,
      path: typeof resolvedPath === 'string' && resolvedPath ? resolvedPath : (typeof value.sourcePath === 'string' && value.sourcePath ? value.sourcePath : (typeof value.filePath === 'string' ? value.filePath : '')),
      url: typeof value.originImageUrl === 'string' && /^https?:\/\//.test(value.originImageUrl) ? value.originImageUrl : '',
      thumbPath: value.thumbPath,
    };
    cacheMediaKey(entry.fileName, entry);
    cacheMediaKey(entry.md5, entry);
    cacheMediaKey(entry.fileUuid, entry);
    cacheMediaKey(entry.path, entry);
    if (entry.msgId && entry.elementId) cacheMediaKey(`${entry.msgId}:${entry.elementId}`, entry);
  }
  // The fields of a download receipt that say how it went (numbers and short codes only, never a path or content), for error messages.
  const describeNotify = notify => ['trasferStatus', 'fileErrCode', 'fileErrMsg', 'fileDownType', 'thumbSize', 'curSize', 'totalSize']
    .filter(name => notify[name] !== undefined).map(name => `${name}=${String(notify[name]).slice(0, 60)}`).join(', ') + (typeof notify.filePath === 'string' && notify.filePath ? ', 有 filePath' : ', 无 filePath');
  const lastNotice = new Map();
  function resolveDownloadNotify(notify) {
    if (!notify || typeof notify !== 'object') return;
    const key = `${notify.msgId ?? ''}:${notify.msgElementId ?? ''}`;
    const waiters = downloadWaiters.get(key);
    if (!waiters || !waiters.size) return;
    // Field names, once: enough to see what a receipt carries if QQ changes it.
    native('msg', 'richmedia_receipt', [notify]);
    lastNotice.set(key, describeNotify(notify));
    if (lastNotice.size > 200) lastNotice.delete(lastNotice.keys().next().value);
    // Ignore thumbnail progress/completion while waiting for an original (thumbSize=0) download.
    if (notify.thumbSize !== undefined && Number(notify.thumbSize) !== 0) return;
    // QQ 9.9.37 reports a finished download as trasferStatus=4 with fileErrCode=0, an empty fileErrMsg and the file's path, so the status number
    // says nothing about failure: an error is an error code (or, without a code, an error message). Anything else resolves once the file is there.
    const code = notify.fileErrCode === undefined || notify.fileErrCode === null ? '' : String(notify.fileErrCode);
    const message = typeof notify.fileErrMsg === 'string' ? notify.fileErrMsg.trim() : '';
    const failed = (code !== '' && code !== '0') || (code === '' && message !== '');
    if (failed) {
      for (const waiter of [...waiters]) waiter.reject(new Error(`${message || 'QQ 富媒体下载失败'}（${describeNotify(notify)}）`));
      return;
    }
    // A receipt without the file yet (progress) is ignored; the later receipt, or the timeout, decides.
    existingFile(notify.filePath).then(ready => { if (ready) for (const waiter of [...(downloadWaiters.get(key) ?? [])]) waiter.resolve(ready); });
  }
  async function downloadMedia(entry) {
    const ready = await existingFile(entry.path);
    if (ready) return ready;
    const service = session.getMsgService?.();
    if (typeof service?.downloadRichMedia !== 'function' || !/^\d+$/.test(entry.msgId) || !entry.elementId) {
      return entry.elementType === 2 ? pickThumbPath(entry.thumbPath) : undefined;
    }
    const inflightKey = `${entry.chatType}:${entry.peerUid}:${entry.msgId}:${entry.elementId}`;
    if (inflightMedia.has(inflightKey)) return inflightMedia.get(inflightKey);
    const label = { 2: '图片', 3: '文件', 4: '语音', 5: '视频' }[entry.elementType] ?? '媒体';
    const task = (async () => {
      const waitKey = `${entry.msgId}:${entry.elementId}`;
      let timer;
      let waiter;
      const completed = new Promise((resolve, reject) => {
        waiter = {
          resolve: value => { clearTimeout(timer); waiters.delete(waiter); if (!waiters.size) downloadWaiters.delete(waitKey); resolve(value); },
          reject: error => { clearTimeout(timer); waiters.delete(waiter); if (!waiters.size) downloadWaiters.delete(waitKey); reject(error); },
        };
        let waiters = downloadWaiters.get(waitKey);
        if (!waiters) { waiters = new Set(); downloadWaiters.set(waitKey, waiters); }
        waiters.add(waiter);
        timer = setTimeout(() => waiter.reject(new Error(`${label}下载超时` + (lastNotice.has(waitKey) ? `（最后一次回执：${lastNotice.get(waitKey)}）` : '（没有收到下载回执）'))), mediaTimeoutMs);
      });
      completed.catch(() => {});
      try {
        const result = await service.downloadRichMedia({
          fileModelId: '0',
          downSourceType: 0,
          triggerType: 1,
          msgId: entry.msgId,
          chatType: entry.chatType,
          peerUid: entry.peerUid,
          elementId: entry.elementId,
          thumbSize: 0,
          filePath: '',
          downloadType: entry.elementType === 2 ? 1 : 2,
        });
        if (!current()) throw new Error('会话已失效');
        if (result?.result !== undefined && result.result !== 0) {
          throw new Error(result.errMsg || `QQ 拒绝下载${label} (${result.result})`);
        }
        const already = await existingFile(entry.path);
        if (already) {
          waiter.resolve(already);
          return already;
        }
        const notifiedPath = await completed;
        const verified = await existingFile(notifiedPath) || await existingFile(entry.path);
        if (verified) { entry.path = verified; return verified; }
        throw new Error(`QQ 下载完成但未生成${label}文件`);
      } catch (error) {
        waiter?.reject(error);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => inflightMedia.delete(inflightKey));
    inflightMedia.set(inflightKey, task);
    return task;
  }
  const downloadPicture = downloadMedia;
  async function resolveMedia(key, kind = 'any') {
    const label = kind === 'image' ? '图片' : kind === 'record' ? '语音' : '文件';
    if (typeof key !== 'string' || !key.trim()) throw fail(`缺少${label}标识 file`, 1400);
    const trimmed = key.trim();
    const entry = mediaCache.get(trimmed) ?? mediaCache.get(path.basename(trimmed));
    if (!entry) throw fail(`找不到对应的${label}记录（仅支持本次运行期间收到的${label}）`, 1404);
    if (kind === 'image' && entry.elementType !== 2) throw fail('该标识不是图片', 1400);
    if (kind === 'record' && entry.elementType !== 4) throw fail('该标识不是语音', 1400);
    let localPath = await existingFile(entry.path);
    if (!localPath) {
      try { localPath = await downloadMedia(entry); }
      catch (error) {
        localPath = entry.elementType === 2 ? await pickThumbPath(entry.thumbPath) : undefined;
        if (!localPath) throw fail(error.message, 1500);
      }
    }
    if (!localPath) throw fail(`${label}文件不存在或尚未下载`, 1404);
    entry.path = localPath;
    cacheMediaKey(localPath, entry);
    const stat = await fs.promises.stat(localPath);
    return {
      file: localPath,
      file_name: entry.fileName || path.basename(localPath),
      file_size: stat.size || entry.fileSize,
      url: entry.url,
    };
  }

  // Merged forwards: QQ fetches the content with getMultiMsg(peer, rootMsgId, parentMsgId), where root is the
  // message in the chat and parent is the message that directly carries the (possibly nested) forward.
  async function multiMsg(peer, root, parent) {
    let timer;
    try {
      const result = await Promise.race([
        session.getMsgService().getMultiMsg({ chatType: peer.chatType, peerUid: peer.peerUid, guildId: '' }, root, parent),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('合并转发内容获取超时（8 秒）')), 8000); }),
      ]);
      if (result?.result !== undefined && result.result !== 0) throw new Error(`QQ 拒绝获取合并转发：${result.errMsg || result.result}`);
      if (!Array.isArray(result?.msgList)) throw new Error('合并转发内容结构未适配');
      return result.msgList;
    } finally { clearTimeout(timer); }
  }
  async function forwardMessages(ctx, parent) {
    const list = await multiMsg(ctx.peer, ctx.root, parent);
    const messages = [];
    for (const item of list) {
      if (!current()) throw new Error('会话已失效');
      if (ctx.budget.left-- <= 0) break;
      remember(item.senderUid, item.senderUin);
      let senderUin = '0';
      // Forwarded authors are often strangers; the nickname still identifies them, so a missing QQ number is not an error.
      try { senderUin = await uin(item.senderUid, item.senderUin); } catch (error) { if (!current()) throw error; }
      messages.push({ msgId: String(item.msgId ?? ''), msgTime: item.msgTime, senderUin, senderUid: item.senderUid,
        sendNickName: item.sendNickName, sendMemberName: item.sendMemberName,
        elements: await prepare(Array.isArray(item.elements) ? item.elements : [], { ...ctx, depth: ctx.depth + 1 }, String(item.msgId ?? '')) });
    }
    return messages;
  }
  async function expandForward(ref) {
    return forwardMessages({ peer: { chatType: ref.chatType, peerUid: ref.peerUid }, root: ref.root, depth: 0, budget: { left: FORWARD_LIMIT } }, ref.parent);
  }
  const forwardSize = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item).length;

  // The id a reply segment should carry. The ids QQ writes into a reply element do not always name the quoted message in the local records
  // (seen for a message the account sent itself), so the quote is looked up by its sequence number first, then by the ids in the element.
  async function quotedMessageId(peer, reply) {
    const service = session.getMsgService?.();
    if (!service) return undefined;
    const target = { chatType: peer.chatType, peerUid: peer.peerUid, guildId: '' };
    const attempt = async call => {
      let timer;
      try { return await Promise.race([call(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 3000); })]); }
      catch { return undefined; }
      finally { clearTimeout(timer); }
    };
    const seq = String(reply.replayMsgSeq ?? '');
    if (/^[1-9]\d*$/.test(seq) && typeof service.getMsgsBySeqAndCount === 'function') {
      const found = (await attempt(() => service.getMsgsBySeqAndCount(target, seq, 1, true, true)))?.msgList?.find(item => String(item?.msgSeq) === seq);
      if (found && /^[1-9]\d*$/.test(String(found.msgId))) return String(found.msgId);
    }
    if (!current()) throw new Error('会话已失效');
    if (typeof service.getMsgsByMsgId === 'function') for (const id of [reply.sourceMsgIdInRecords, reply.replayMsgId].map(value => String(value ?? ''))) {
      if (!/^[1-9]\d*$/.test(id)) continue;
      const found = (await attempt(() => service.getMsgsByMsgId(target, [id])))?.msgList?.find(item => String(item?.msgId) === id);
      if (found) return id;
    }
    if (!current()) throw new Error('会话已失效');
    // Private-chat replies frequently leave replayMsgSeq=0; fall back to clientSeq + replyMsgTime.
    const clientSeq = String(reply.replyMsgClientSeq ?? '');
    const replyTime = String(reply.replyMsgTime ?? '');
    if (/^[1-9]\d*$/.test(clientSeq) && /^\d+$/.test(replyTime) && typeof service.getMsgByClientSeqAndTime === 'function') {
      const found = (await attempt(() => service.getMsgByClientSeqAndTime(target, clientSeq, replyTime)))?.msgList?.find(item => /^[1-9]\d*$/.test(String(item?.msgId ?? '')));
      if (found) return String(found.msgId);
    }
    // Field names only, once: enough to see what the element carries when a quote cannot be matched.
    native('msg', 'reply_unresolved', [reply]);
    return undefined;
  }

  // get_group_msg_history / get_friend_msg_history: read chat history from QQ without eagerly downloading media.
  async function fetchHistory(peer, { msgId, msgSeq, count = 20, reverseOrder = false } = {}) {
    const service = session.getMsgService?.();
    if (!service) throw fail('当前会话不支持获取历史消息', 1500);
    const target = { chatType: peer.chatType, peerUid: String(peer.peerUid), guildId: '' };
    let timer;
    let result;
    const call = async () => {
      if (msgId && /^\d+$/.test(String(msgId)) && typeof service.getMsgsIncludeSelf === 'function') {
        return service.getMsgsIncludeSelf(target, String(msgId), count, true);
      }
      if (msgSeq && /^[1-9]\d*$/.test(String(msgSeq)) && typeof service.getMsgsBySeqAndCount === 'function') {
        return service.getMsgsBySeqAndCount(target, String(msgSeq), count, true, true);
      }
      if (typeof service.getAioFirstViewLatestMsgs === 'function') {
        return service.getAioFirstViewLatestMsgs(target, count);
      }
      if (typeof service.getMsgsIncludeSelf === 'function') {
        return service.getMsgsIncludeSelf(target, '0', count, true);
      }
      throw fail('当前 QQ 版本不支持获取历史消息', 1500);
    };
    try {
      result = await Promise.race([
        call(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fail('获取历史消息超时（10 秒）', 1501)), 10000); }),
      ]);
    } finally { clearTimeout(timer); }
    if (!current()) throw new Error('会话已失效');
    if (result?.result !== undefined && result.result !== 0) throw fail(`QQ 拒绝获取历史消息：${result.errMsg || result.result}`, 1500);
    const list = Array.isArray(result?.msgList) ? result.msgList : [];
    const prepared = [];
    for (const item of list) {
      if (!current()) throw new Error('会话已失效');
      if (!item || !Array.isArray(item.elements) || !item.elements.length) continue;
      if (item.elements.some(element => element.elementType === 8)) continue;
      remember(item.senderUid, item.senderUin);
      let senderUin = '0';
      try { senderUin = await uin(item.senderUid, item.senderUin); } catch (error) { if (!current()) throw error; }
      record(item, senderUin);
      const elements = await prepare(item.elements, { peer: { chatType: target.chatType, peerUid: target.peerUid }, root: String(item.msgId ?? ''),
        depth: FORWARD_DEPTH, budget: { left: 0 }, skipDownload: true }, String(item.msgId ?? ''));
      prepared.push({ ...item, chatType: item.chatType ?? target.chatType, peerUid: String(item.peerUid ?? target.peerUid), senderUin, elements });
    }
    prepared.sort((a, b) => {
      const timeDiff = Number(a.msgTime ?? 0) - Number(b.msgTime ?? 0);
      if (timeDiff !== 0) return timeDiff;
      const sa = /^\d+$/.test(String(a.msgSeq ?? '')) ? BigInt(a.msgSeq) : 0n;
      const sb = /^\d+$/.test(String(b.msgSeq ?? '')) ? BigInt(b.msgSeq) : 0n;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    if (reverseOrder) prepared.reverse();
    return prepared;
  }

  // get_msg: one message from QQ's local records, prepared like a received one but without downloading media
  // (get_image does that on demand) and without expanding merged forwards (their id still works with get_forward_msg).
  async function fetchMessage(ref) {
    let timer;
    let result;
    try {
      result = await Promise.race([
        session.getMsgService().getMsgsByMsgId({ chatType: ref.chatType, peerUid: ref.peerUid, guildId: '' }, [ref.msgId]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fail('读取消息超时（8 秒）', 1500)), 8000); }),
      ]);
    } finally { clearTimeout(timer); }
    if (!current()) throw new Error('会话已失效');
    if (result?.result !== undefined && result.result !== 0) throw fail(`QQ 拒绝读取消息：${result.errMsg || result.result}`, 1500);
    const found = Array.isArray(result?.msgList) ? result.msgList.find(item => String(item?.msgId) === ref.msgId) : undefined;
    if (!found) throw fail('消息在 QQ 本地记录中找不到', 1404);
    if (!Array.isArray(found.elements) || !found.elements.length) throw fail('消息没有可读取的内容', 1404);
    if (found.elements.some(element => element.elementType === 8)) throw fail('该消息已撤回，或是系统提示，没有可读取的内容', 1404);
    remember(found.senderUid, found.senderUin);
    let senderUin = '0';
    // Like forwarded authors, a sender that cannot be resolved keeps the nickname with user_id 0 instead of failing the read.
    try { senderUin = await uin(found.senderUid, found.senderUin); } catch (error) { if (!current()) throw error; }
    const elements = await prepare(found.elements, { peer: { chatType: ref.chatType, peerUid: ref.peerUid }, root: ref.msgId,
      depth: FORWARD_DEPTH, budget: { left: 0 }, skipDownload: true }, ref.msgId);
    return { ...found, senderUin, elements };
  }

  async function prepare(elements, ctx, msgId) {
    return Promise.all(elements.map(async element => {
      const text = element.textElement;
      if (element.elementType === 1 && Number(text?.atType) === 2 && !validUin(text.atUid)) {
        // An unresolvable @ target keeps the native element (delivered as openqq_element) rather than losing the message.
        const target = await optionalUin(text.atNtUid, 'msg/at');
        return target ? { ...element, textElement: { ...text, atUid: target } } : element;
      }
      if (element.elementType === 2 && element.picElement) {
        const pic = element.picElement;
        if (ctx.skipDownload) {
          rememberMedia(element, ctx, msgId, pic.sourcePath);
          return element;
        }
        let resolved = await existingFile(pic.sourcePath);
        if (!resolved && typeof session.getMsgService?.()?.downloadRichMedia === 'function' && /^\d+$/.test(String(msgId)) && element.elementId) {
          const entry = {
            elementType: 2,
            chatType: ctx.peer.chatType,
            peerUid: String(ctx.peer.peerUid),
            msgId: String(msgId),
            elementId: String(element.elementId),
            fileName: String(pic.fileName ?? ''),
            md5: String(pic.md5HexStr ?? ''),
            fileUuid: String(pic.fileUuid ?? ''),
            fileSize: Number(pic.fileSize ?? 0) || 0,
            path: String(pic.sourcePath ?? ''),
            url: typeof pic.originImageUrl === 'string' && /^https?:\/\//.test(pic.originImageUrl) ? pic.originImageUrl : '',
            thumbPath: pic.thumbPath,
          };
          try {
            resolved = await downloadPicture(entry);
          } catch (error) {
            if (!current()) throw error;
            emit({ type: 'event_error', stage: 'msg/image', error: error.message + '，将继续上报消息' });
            resolved = await pickThumbPath(pic.thumbPath);
          }
          rememberMedia(element, ctx, msgId, resolved || '');
          return { ...element, picElement: { ...pic, sourcePath: resolved || '' } };
        }
        if (!resolved) resolved = await pickThumbPath(pic.thumbPath);
        rememberMedia(element, ctx, msgId, resolved || pic.sourcePath);
        return resolved ? { ...element, picElement: { ...pic, sourcePath: resolved } } : element;
      }
      if (element.elementType === 7 && element.replyElement) {
        const quoted = await quotedMessageId(ctx.peer, element.replyElement);
        return quoted ? { ...element, replyElement: { ...element.replyElement, openqq: { msgId: quoted } } } : element;
      }
      if ([3, 4, 5].includes(element.elementType)) rememberMedia(element, ctx, msgId);
      const forward = element.multiForwardMsgElement;
      if (element.elementType === 16 && forward && /^\d+$/.test(msgId)) {
        const ref = { chatType: ctx.peer.chatType, peerUid: ctx.peer.peerUid, root: ctx.root, parent: msgId };
        let messages;
        if (ctx.depth < FORWARD_DEPTH) {
          try {
            messages = await forwardMessages(ctx, msgId);
            if (forwardSize(messages) > FORWARD_BYTES) {
              messages = undefined;
              emit({ type: 'event_error', stage: 'msg/forward', error: '合并转发内容超过 512 KiB，事件只携带 id，请用 get_forward_msg 获取' });
            }
          } catch (error) {
            if (!current()) throw error;
            emit({ type: 'event_error', stage: 'msg/forward', error: error.message + '，事件只携带 id，可稍后用 get_forward_msg 重试' });
          }
        }
        return { ...element, multiForwardMsgElement: { ...forward, openqq: { ...ref, ...(messages ? { messages } : {}) } } };
      }
      return element;
    }));
  }

  async function message(input, update = false) {
    if (![1, 2, 100].includes(input.chatType)) { native('msg', 'unsupported_chat', [input]); return; }
    remember(input.senderUid, input.senderUin);
    if (input.chatType !== 2) remember(input.peerUid, input.peerUin);
    const gray = input.elements?.find(element => element.elementType === 8)?.grayTipElement;
    const key = `${input.chatType}:${input.peerUid}:${input.msgId}`;
    const time = input.recallTime && Number(input.recallTime) > 0
      ? Math.floor(Number(input.recallTime) / (Number(input.recallTime) > 1e11 ? 1000 : 1)) : input.msgTime;
    if (gray?.revokeElement) {
      if (update && (!Number(input.recallTime) || Number(time) < started - 5)) return;
      const user = await uin(input.senderUid, input.senderUin);
      // Only group recalls carry an operator; a friend recall must not fail on an unused lookup.
      const operator = input.chatType === 2 ? await optionalUin(gray.revokeElement.operatorUid, 'msg/recall/operator',
        gray.revokeElement.isSelfOperate ? self.uin : undefined) : undefined;
      notice({ notice_type: input.chatType === 2 ? 'group_recall' : 'friend_recall', user_id: user,
        ...(input.chatType === 2 ? { group_id: input.peerUin ?? input.peerUid, operator_id: operator ?? 0,
          ...(operator ? {} : { openqq_operator_unknown: true }) } : {}),
      }, `recall:${key}`, time, input);
      return;
    }
    if (update) return;
    // Offline sync replays placeholder records with no elements; there is nothing to report.
    // Note each msgType once at debug level (type numbers only, never content) instead of warning per record.
    if (!Array.isArray(input.elements) || !input.elements.length) {
      native('msg', `empty_message(msgType=${Number(input.msgType)},subMsgType=${Number(input.subMsgType)})`, []);
      return;
    }
    if (String(gray?.jsonGrayTipElement?.busiId) === '1061') {
      if (input.elements.length !== 1) throw new Error('戳一戳包含非预期的混合元素');
      let data;
      try { data = JSON.parse(gray.jsonGrayTipElement.jsonStr); } catch { throw new Error('戳一戳 JSON 无效'); }
      const users = Array.isArray(data?.items) ? data.items.filter(item => item?.uid) : [];
      if (users.length !== 2 || users.some(item => typeof item.uid !== 'string')) throw new Error('戳一戳缺少操作者或被戳者 UID');
      const [userUin, targetUin] = await Promise.all(users.map(item => uin(item.uid)));
      emit({ type: 'message', self, message: { ...input, poke: { userUin, targetUin } } });
      return;
    }
    if (input.chatType !== 2 && String(gray?.jsonGrayTipElement?.busiId) === '19324') {
      if (friends) friends.set(input.peerUid, input.peerUin);
      notice({ notice_type: 'friend_add', user_id: await uin(input.peerUid, input.peerUin) }, `friend-add:${key}`, input.msgTime);
      return;
    }
    if (gray?.xmlElement?.templId === '10382' && input.chatType === 2) {
      const xml = String(gray.xmlElement.content ?? '');
      const sender = xml.match(/<qq[^>]*\bjp="(\d+)"/i)?.[1];
      const msgSeq = xml.match(/<url[^>]*\bmsgseq="(\d+)"/i)?.[1];
      const emojiId = xml.match(/<face[^>]*\bid="(\d+)"/i)?.[1];
      if (sender && msgSeq && emojiId) {
        const group_id = input.peerUin ?? input.peerUid;
        let found;
        try {
          const service = session.getMsgService?.();
          if (typeof service?.getMsgsBySeqAndCount === 'function') {
            found = (await service.getMsgsBySeqAndCount({ chatType: 2, peerUid: String(group_id), guildId: '' }, msgSeq, 1, true, true))?.msgList?.find(item => String(item?.msgSeq) === msgSeq);
          }
        } catch { /* best effort */ }
        notice({ notice_type: 'group_msg_emoji_like', group_id, user_id: sender,
          likes: [{ emoji_id: emojiId, count: 1 }], is_add: true, msg_seq: msgSeq },
        `emoji-like:${group_id}:${msgSeq}:${sender}:${emojiId}:1`, input.msgTime, found);
        return;
      }
    }
    if (String(gray?.jsonGrayTipElement?.busiId) === '2401' && input.chatType === 2) {
      try {
        const data = JSON.parse(gray.jsonGrayTipElement.jsonStr);
        const jp = data?.items?.find(item => typeof item?.jp === 'string' && item.jp.includes('msgSeq='))?.jp;
        if (jp) {
          const params = new URL(jp, 'https://qq.invalid').searchParams;
          const msgSeq = params.get('msgSeq');
          const group_id = params.get('groupCode') || (input.peerUin ?? input.peerUid);
          if (msgSeq && /^\d+$/.test(msgSeq)) {
            let found;
            try {
              const service = session.getMsgService?.();
              if (typeof service?.getMsgsBySeqAndCount === 'function') {
                found = (await service.getMsgsBySeqAndCount({ chatType: 2, peerUid: String(group_id), guildId: '' }, msgSeq, 1, true, true))?.msgList?.find(item => String(item?.msgSeq) === msgSeq);
              }
            } catch { /* best effort */ }
            const senderId = found ? (await optionalUin(found.senderUid, 'msg/essence/sender', found.senderUin)) ?? 0 : 0;
            const operatorId = (await optionalUin(input.senderUid, 'msg/essence/operator', input.senderUin)) ?? 0;
            notice({ notice_type: 'essence', sub_type: 'add', group_id, sender_id: senderId, operator_id: operatorId, msg_seq: msgSeq },
              `essence:${group_id}:${msgSeq}:add`, input.msgTime, found);
            return;
          }
        }
      } catch { /* fall through to openqq_gray_tip */ }
    }
    if (gray?.jsonGrayTipElement?.jsonStr && input.chatType === 2) {
      try {
        const data = JSON.parse(gray.jsonGrayTipElement.jsonStr);
        const items = Array.isArray(data?.items) ? data.items : [];
        if (items.length >= 4 && items.at(-1)?.txt === '头衔') {
          const memberUin = items[1]?.param?.[0];
          const title = items[3]?.txt;
          if (validUin(memberUin) && typeof title === 'string') {
            notice({ notice_type: 'notify', sub_type: 'title', group_id: input.peerUin ?? input.peerUid, user_id: String(memberUin), title }, `title:${key}`, input.msgTime);
            return;
          }
        }
      } catch { /* fall through */ }
    }
    if (gray?.groupElement && input.chatType === 2) {
      const group = gray.groupElement;
      const group_id = input.peerUin ?? input.peerUid;
      if (group.shutUp) {
        const ban = group.shutUp;
        const rawDuration = Number(ban.duration);
        const isWhole = !ban.member?.uid;
        const duration = isWhole && rawDuration >= 0xffffffff ? -1 : rawDuration;
        // user_id 0 means "whole group" in OneBot, so an unresolved member must still fail loudly;
        // only the operator may degrade.
        const operator = await optionalUin(ban.admin?.uid, 'msg/ban/operator');
        notice({ notice_type: 'group_ban', group_id,
          user_id: isWhole ? 0 : await uin(ban.member.uid),
          operator_id: operator ?? 0, ...(operator ? {} : { openqq_operator_unknown: true }), duration,
          sub_type: rawDuration > 0 ? 'ban' : 'lift_ban',
        }, `ban:${key}`, input.msgTime);
        return;
      }
      if (group.type === 5) {
        notice({ notice_type: 'group_name', group_id, user_id: await uin(group.memberUid), group_name: String(group.groupName ?? '') }, key, input.msgTime);
        return;
      }
      // Self joining a group may only arrive as a gray tip; other membership changes use authoritative system pushes.
      if (group.type === 1) {
        if (self.uid && group.memberUid === self.uid) {
          const operator = group.adminUid ? await optionalUin(group.adminUid, 'msg/self_join/operator') : undefined;
          notice({ notice_type: 'group_increase', sub_type: 'approve', group_id, user_id: self.uin,
            operator_id: operator ?? 0, ...(operator ? {} : { openqq_operator_unknown: true }) }, `self-join:${key}`, input.msgTime);
        }
        return;
      }
    }
    if (gray) {
      notice({ notice_type: 'openqq_gray_tip', chat_type: input.chatType, peer_id: input.peerUin ?? input.peerUid,
        element: gray }, `gray:${key}`, input.msgTime);
      return;
    }
    const senderUin = await uin(input.senderUid, input.senderUin);
    record(input, senderUin);
    const elements = await prepare(input.elements ?? [], { peer: { chatType: input.chatType, peerUid: String(input.peerUid) },
      root: String(input.msgId), depth: 0, budget: { left: FORWARD_LIMIT }, skipDownload: String(senderUin) === self.uin }, String(input.msgId));
    let isFriend;
    if (input.chatType === 1) {
      if (friends?.has(input.senderUid) || friends?.has(input.peerUid)) isFriend = true;
      else if (typeof session.getBuddyService?.()?.isBuddy === 'function') {
        try { if (session.getBuddyService().isBuddy(input.senderUid || input.peerUid)) isFriend = true; } catch { /* ignore */ }
      }
    }
    emit({ type: 'message', self, message: { ...input, senderUin, elements, ...(isFriend ? { isFriend: true } : {}) } });
    if (input.chatType === 2) for (const element of elements) {
      const file = element.fileElement;
      if (element.elementType === 3 && file?.fileUuid) notice({ notice_type: 'group_upload', group_id: input.peerUin ?? input.peerUid,
        user_id: senderUin, file: { id: String(file.fileUuid), name: file.fileName, size: file.fileSize, busid: file.fileBizId ?? 0 },
      }, `upload:${key}:${element.elementId ?? file.fileUuid}`, input.msgTime);
    }
  }

  async function groupNotifies(notifies) {
    await batch(notifies, async item => {
      const group_id = item.group?.groupCode;
      const key = `group-notify:${item.seq}:${item.type}`;
      const rawTime = /^\d+$/.test(String(item.seq)) ? Number(BigInt(item.seq) / 1000000n) : 0;
      const time = rawTime > 0 ? rawTime : now();
      if ([1, 5, 7].includes(item.type) && item.status === 1) {
        emit({ type: 'request', self, key, time, event: { request_type: 'group', group_id,
          sub_type: item.type === 1 ? 'invite' : 'add', user_id: await uin(item.type === 1 ? item.user2?.uid : item.user1?.uid),
          // The flag carries everything set_group_add_request needs to answer this notification.
          comment: String(item.postscript ?? ''), flag: `g:${group_id}:${item.type}:${item.seq}`,
        } });
      } else native('group', 'onGroupNotifiesUpdated', [item]);
    }, 'group/notifies');
  }

  async function receive(source, name, args) {
    if (source === 'msg') {
      if (name === 'onNtMsgSyncStart' || name === 'onNtMsgSyncEnd') {
        syncing = name === 'onNtMsgSyncStart';
        emit({ type: 'sync_state', syncing });
        return;
      }
      if (name === 'onMsgInfoListUpdate') notifyWaiters('msg_update', args[0]);
      if (['onRecvMsg', 'onRecvOnlineFileMsg', 'onMsgInfoListUpdate'].includes(name)) {
        await batch(args[0], value => message(value, name === 'onMsgInfoListUpdate'), name);
        return;
      }
      if (name === 'onGroupFileInfoUpdate') { notifyWaiters('group_file_list', args[0]); return; }
      if (name === 'onRichMediaDownloadComplete') { resolveDownloadNotify(args[0]); return; }
      if (name === 'onRichMediaProgerssUpdate' || name === 'onRichMediaUploadComplete') return;
      if (name === 'onRecvSysMsg') {
        const event = readSystemEvent(args[0]);
        if (!event) { native(source, name, args); return; }
        if (event.event.notice_type === 'group_msg_emoji_like') {
          const { user_uid, msg_seq, emoji_id, count, is_add, group_id } = event.event;
          const userId = await uin(user_uid);
          let found;
          try {
            const service = session.getMsgService?.();
            if (typeof service?.getMsgsBySeqAndCount === 'function') {
              found = (await service.getMsgsBySeqAndCount({ chatType: 2, peerUid: String(group_id), guildId: '' }, msg_seq, 1, true, true))?.msgList?.find(item => String(item?.msgSeq) === msg_seq);
            }
          } catch { /* best effort */ }
          notice({ notice_type: 'group_msg_emoji_like', group_id, user_id: userId, likes: [{ emoji_id, count }], is_add, msg_seq },
            event.key, event.time, found);
          return;
        }
        const { user_uid, operator_uid, ...fields } = event.event;
        if (!user_uid && fields.openqq_reason !== 'disband') throw new Error('系统通知缺少成员 UID');
        const member = await memberUin(user_uid || self.uid, `${source}/${name}/member`);
        fields.user_id = member ?? 0;
        if (!member) fields.openqq_user_unknown = true;
        if (operator_uid) {
          // A missing operator mapping must not discard the membership change itself.
          const operator = await optionalUin(operator_uid, `${source}/${name}/operator`);
          fields.operator_id = operator ?? 0;
          if (!operator) fields.openqq_operator_unknown = true;
        } else if (fields.notice_type === 'group_decrease' && fields.sub_type === 'leave') {
          fields.operator_id = fields.user_id;
          if (!member) fields.openqq_operator_unknown = true;
        }
        if (fields.notice_type === 'group_decrease' && fields.sub_type === 'kick' && fields.user_id === self.uin) fields.sub_type = 'kick_me';
        notice(fields, event.key, event.time);
        return;
      }
      if (name === 'onInputStatusPush') {
        const value = args[0];
        if (!value || typeof value !== 'object') return;
        notice({ notice_type: 'notify', sub_type: 'input_status', user_id: await uin(value.fromUin),
          status_text: String(value.statusText ?? ''), event_type: value.eventType }, undefined);
        return;
      }
      if (name === 'onKickedOffLine') {
        emit({ type: 'offline', self_id: self.uin });
        notice({ notice_type: 'bot_offline', reason: String(args[0]?.tipsDesc ?? '') });
        return;
      }
    }
    if (source === 'group') {
      if (name === 'onGroupListUpdate') { updateGroups(args[0], args[1]); return; }
      if (name === 'onShutUpMemberListChanged') {
        notifyWaiters('group_shut_list', { groupCode: String(args[0] ?? ''), members: Array.isArray(args[1]) ? args[1] : [] });
        return;
      }
      if (name === 'onGetGroupBulletinListResult') {
        notifyWaiters('group_bulletin', { groupCode: String(args[0] ?? ''), context: args[1], result: args[2] });
        return;
      }
      if (name === 'onGroupDetailInfoChange') {
        notifyWaiters('group_detail', args[0]);
        return;
      }
      if (name === 'onGroupNotifiesUpdated') return groupNotifies(args[1]);
      if (name === 'onGroupNotifiesUpdatedV2') return groupNotifies(args[2]);
      if (name === 'onGroupSingleScreenNotifies') {
        notifyWaiters('group_notifies', { doubt: Boolean(args[0]), seq: String(args[1] ?? ''), notifies: Array.isArray(args[2]) ? args[2] : [] });
        return groupNotifies(args[2]);
      }
      if (name === 'onMemberListChange') {
        // Member list pushes carry uid → uin pairs; caching them lets membership notices and mentions resolve.
        const infos = args[0]?.infos;
        if (!(infos instanceof Map)) { native(source, name, args); return; }
        for (const [uid, info] of infos) remember(uid, info?.uin);
        return;
      }
      if (name === 'onMemberInfoChange') {
        for (const [uid, info] of args[2] instanceof Map ? args[2] : []) {
          remember(uid, info.uin);
          const key = `${args[0]}:${uid}`;
          const previous = members.get(key);
          members.set(key, { cardName: info.cardName, memberSpecialTitle: info.memberSpecialTitle });
          if (members.size > 10000) members.delete(members.keys().next().value);
          if (previous && info.cardName !== undefined && previous.cardName !== undefined && info.cardName !== previous.cardName) {
            notice({ notice_type: 'group_card', group_id: args[0], user_id: await uin(uid, info.uin), card_old: previous.cardName, card_new: info.cardName });
          }
          if (previous && info.memberSpecialTitle !== undefined && previous.memberSpecialTitle !== undefined && info.memberSpecialTitle !== previous.memberSpecialTitle) {
            notice({ notice_type: 'notify', sub_type: 'title', group_id: args[0], user_id: await uin(uid, info.uin), title: info.memberSpecialTitle });
          }
        }
        return;
      }
    }
    if (source === 'buddy') {
      if (name === 'onBuddyReqChange') {
        await batch(args[0]?.buddyReqs, async req => {
          if (req.isInitiator || !req.isUnread || (req.isDecide && req.reqType !== 13)) return;
          emit({ type: 'request', self, time: req.reqTime, key: `friend:${req.friendUid}:${req.reqTime}`, event: {
            request_type: 'friend', user_id: await uin(req.friendUid), comment: String(req.extWords ?? ''), flag: `f:${req.friendUid}:${req.reqTime}`,
          } });
        }, 'buddy/requests');
        return;
      }
      if (name === 'onBuddyListChange') {
        if (!Array.isArray(args[0]) || args[0].some(category => !Array.isArray(category.buddyList))) throw new Error('好友列表回调结构未适配');
        const next = new Map();
        const details = new Map();
        const categories = [];
        for (const category of args[0] ?? []) {
          const items = [];
          for (const buddy of category.buddyList ?? []) {
            remember(buddy.uid, buddy.uin);
            next.set(buddy.uid, buddy.uin);
            const detail = { uid: buddy.uid, uin: buddy.uin, nick: String(buddy.nick ?? buddy.coreInfo?.nick ?? ''), remark: String(buddy.remark ?? buddy.coreInfo?.remark ?? '') };
            details.set(buddy.uid, detail);
            items.push(detail);
          }
          categories.push({ categoryId: Number(category.categoryId ?? 0), categoryName: String(category.categoryName ?? category.categroyName ?? ''), buddies: items });
        }
        friendDetails = details;
        friendCategories = categories;
        if (friends && !syncing) {
          for (const [uid, hint] of next) if (!friends.has(uid)) notice({ notice_type: 'friend_add', user_id: await uin(uid, hint) });
          for (const [uid, hint] of friends) if (!next.has(uid)) notice({ notice_type: 'friend_delete', user_id: await uin(uid, hint) });
        }
        // The first complete list establishes a baseline; it is not a wave of new friends.
        friends = next;
        return;
      }
    }
    native(source, name, args);
  }
  async function refreshFriendsFromService(noCache) {
    const buddyService = session.getBuddyService?.();
    if (!buddyService) return false;
    let rawCategories;
    if (typeof buddyService.getBuddyListV2 === 'function') {
      try {
        const res = await buddyService.getBuddyListV2('0', Boolean(noCache), 0);
        if (Array.isArray(res?.data)) rawCategories = res.data;
      } catch {
        try {
          const res = await buddyService.getBuddyListV2(Boolean(noCache), 0);
          if (Array.isArray(res?.data)) rawCategories = res.data;
        } catch { /* fallback below */ }
      }
    }
    if (!rawCategories && typeof buddyService.getBuddyListFromCache === 'function') {
      try {
        const cached = await buddyService.getBuddyListFromCache(0);
        if (Array.isArray(cached)) rawCategories = cached;
      } catch { /* ignore */ }
    }
    if (!Array.isArray(rawCategories) || !rawCategories.length) return false;
    const allUids = [...new Set(rawCategories.filter(c => Number(c.categoryId) !== 9999).flatMap(c => Array.isArray(c.buddyUids) ? c.buddyUids : []))];
    const profileMap = new Map();
    const profileService = session.getProfileService?.();
    if (allUids.length && typeof profileService?.getCoreAndBaseInfo === 'function') {
      try {
        const map = await profileService.getCoreAndBaseInfo('nodeStore', allUids);
        if (map instanceof Map) for (const [uid, info] of map) profileMap.set(uid, info);
      } catch { /* best effort */ }
    }
    const next = new Map();
    const details = new Map();
    const categories = [];
    for (const cat of rawCategories) {
      if (Number(cat.categoryId) === 9999) continue;
      const items = [];
      for (const uid of Array.isArray(cat.buddyUids) ? cat.buddyUids : []) {
        const info = profileMap.get(uid);
        const existing = friendDetails?.get(uid);
        const uinVal = info?.uin || info?.coreInfo?.uin || existing?.uin;
        const nick = String(info?.coreInfo?.nick ?? info?.nick ?? existing?.nick ?? '');
        const remark = String(info?.coreInfo?.remark ?? info?.remark ?? existing?.remark ?? '');
        if (uinVal) remember(uid, uinVal);
        next.set(uid, uinVal);
        const entry = { uid, uin: uinVal, nick, remark };
        details.set(uid, entry);
        items.push(entry);
      }
      categories.push({ categoryId: Number(cat.categoryId ?? 0), categoryName: String(cat.categoryName ?? cat.categroyName ?? ''), buddies: items });
    }
    if (!details.size) return false;
    friendDetails = details;
    friendCategories = categories;
    if (!friends) friends = next;
    return true;
  }
  // get_friend_list: returns QQ's pushed list, or actively queries getBuddyListV2 when available (or when no_cache is requested).
  async function friendList(noCache = false) {
    if (!friendDetails || noCache) {
      await refreshFriendsFromService(noCache).catch(() => false);
    }
    if (!friendDetails) throw fail('好友列表尚未同步完成，请稍后重试', 1500);
    const list = [];
    for (const [uid, info] of friendDetails) {
      let user;
      // A friend whose QQ number cannot be resolved is left out rather than failing the whole list.
      try { user = await uin(uid, info.uin); } catch (error) { if (!current()) throw error; continue; }
      list.push({ user_id: Number(user), nickname: info.nick, remark: info.remark });
    }
    return list;
  }
  async function friendsWithCategory(noCache = false) {
    if (!friendCategories || noCache) {
      await refreshFriendsFromService(noCache).catch(() => false);
    }
    if (!friendCategories) throw fail('好友列表尚未同步完成，请稍后重试', 1500);
    const result = [];
    for (const cat of friendCategories) {
      const buddyList = [];
      for (const info of cat.buddies) {
        let user;
        try { user = await uin(info.uid, info.uin); } catch (error) { if (!current()) throw error; continue; }
        buddyList.push({ user_id: Number(user), nickname: info.nick, remark: info.remark });
      }
      result.push({ categoryId: cat.categoryId, categoryName: cat.categoryName, categoryMbCount: buddyList.length, buddyList });
    }
    return result;
  }
  // Services the action handler shares: forward fetching, history, quoted-message metadata, media cache, push waiters and self-sent records.
  receive.friendList = friendList;
  receive.friendsWithCategory = friendsWithCategory;
  receive.expandForward = expandForward;
  receive.fetchMessage = fetchMessage;
  receive.fetchHistory = fetchHistory;
  receive.lookupRecent = lookupRecent;
  receive.resolveMedia = resolveMedia;
  receive.lookupMedia = key => mediaCache.get(key) ?? mediaCache.get(path.basename(key));
  receive.record = record;
  receive.groups = groups;
  receive.waitFor = waitFor;
  receive.resolveUin = uin;
  receive.remember = remember;
  return receive;
}

module.exports = { createEventReceiver };
