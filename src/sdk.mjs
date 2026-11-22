import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { ACTION_SPECS, OPENQQ_ACTIONS, getActionSpec, isOpenQQAction } from './action-catalog.mjs';

export { ACTION_SPECS, OPENQQ_ACTIONS, getActionSpec, isOpenQQAction };

export class OpenQQError extends Error {
  constructor(message, { retcode = 1500, action = '', response = null } = {}) {
    super(message);
    this.name = 'OpenQQError';
    this.retcode = retcode;
    this.action = action;
    this.response = response;
  }
}

function unwrapMessage(value) {
  if (value instanceof MessageBuilder) return value.build();
  return value;
}

export class MessageBuilder {
  constructor(initial = []) {
    this._segments = Array.isArray(initial) ? [...initial] : [];
  }
  raw(type, data = {}) { this._segments.push({ type, data }); return this; }
  text(text) { return this.raw('text', { text: String(text) }); }
  at(qq, name) { return this.raw('at', { qq: String(qq), ...(name !== undefined ? { name: String(name) } : {}) }); }
  face(id) { return this.raw('face', { id: String(id) }); }
  dice() { return this.raw('dice', {}); }
  rps() { return this.raw('rps', {}); }
  image(file, opts = {}) { return this.raw('image', { file, ...opts }); }
  record(file) { return this.raw('record', { file }); }
  video(file, opts = {}) { return this.raw('video', { file, ...opts }); }
  file(file, name) { return this.raw('file', { file, ...(name ? { name } : {}) }); }
  reply(id) { return this.raw('reply', { id: String(id) }); }
  replySeq(seq) { return this.raw('reply', { seq: String(seq) }); }
  json(data) { return this.raw('json', { data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  mface(emoji_id, emoji_package_id, opts = {}) { return this.raw('mface', { emoji_id: String(emoji_id), emoji_package_id, ...opts }); }
  markdown(content) { return this.raw('markdown', { content: String(content) }); }
  contact(type, id) { return this.raw('contact', { type, id: String(id) }); }
  nodeRef(id, name) { return this.raw('node', { id: String(id), ...(name ? { name } : {}) }); }
  node(content, opts = {}) { return this.raw('node', { ...opts, content: unwrapMessage(content) }); }
  build() { return this._segments.map(seg => ({ type: seg.type, data: { ...seg.data } })); }
  toJSON() { return this.build(); }
}

export function msg(initial) {
  return new MessageBuilder(initial);
}

export class OpenQQClient extends EventEmitter {
  constructor({ url = 'http://127.0.0.1:5700', token = '', timeoutMs = 20000, reconnect = true, reconnectIntervalMs = 3000 } = {}) {
    super();
    const parsed = new URL(url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
      throw new Error('url 必须是 http(s):// 或 ws(s):// 地址');
    }
    this.url = parsed.href.replace(/\/+$/, '');
    this.transport = parsed.protocol === 'ws:' || parsed.protocol === 'wss:' ? 'ws' : 'http';
    this.token = String(token ?? '');
    this.timeoutMs = timeoutMs;
    this.reconnect = reconnect;
    this.reconnectIntervalMs = reconnectIntervalMs;
    this._ws = null;
    this._closed = false;
    this._reconnectTimer = null;
    this._pending = new Map();
  }

  get connected() {
    return this.transport === 'http' ? !this._closed : this._ws?.readyState === WebSocket.OPEN;
  }

  async connect() {
    if (this.transport === 'http') return this;
    this._closed = false;
    if (this._ws?.readyState === WebSocket.OPEN) return this;
    return new Promise((resolve, reject) => {
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
      const ws = new WebSocket(this.url, { headers });
      this._ws = ws;
      let settled = false;
      const done = (ok, err) => {
        if (settled) return;
        settled = true;
        if (ok) resolve(this);
        else reject(err);
      };
      ws.once('open', () => {
        this.emit('open');
        done(true);
      });
      ws.on('message', raw => {
        let payload;
        try { payload = JSON.parse(raw.toString('utf8')); } catch { return; }
        if (payload && typeof payload === 'object' && Object.hasOwn(payload, 'echo') && this._pending.has(payload.echo)) {
          const entry = this._pending.get(payload.echo);
          this._pending.delete(payload.echo);
          clearTimeout(entry.timer);
          entry.resolve(payload);
          return;
        }
        if (payload && typeof payload === 'object' && typeof payload.post_type === 'string') {
          this.emit('event', payload);
          this.emit(payload.post_type, payload);
          if (payload.post_type === 'message' && payload.message_type) this.emit(`message.${payload.message_type}`, payload);
          if (payload.post_type === 'notice' && payload.notice_type) this.emit(`notice.${payload.notice_type}`, payload);
          if (payload.post_type === 'request' && payload.request_type) this.emit(`request.${payload.request_type}`, payload);
        }
      });
      ws.on('error', err => {
        if (!settled) done(false, err);
        else if (this.listenerCount('error') > 0) this.emit('error', err);
      });
      ws.on('close', (code, reason) => {
        if (this._ws === ws) this._ws = null;
        for (const [echo, entry] of this._pending) {
          clearTimeout(entry.timer);
          entry.reject(new OpenQQError('WebSocket 连接已断开', { retcode: 1502, action: entry.action }));
          this._pending.delete(echo);
        }
        if (!settled) done(false, new OpenQQError(`WebSocket 握手关闭 (${code})`, { retcode: 1502 }));
        this.emit('close', { code, reason: reason?.toString('utf8') ?? '' });
        if (!this._closed && this.reconnect && !this._reconnectTimer) {
          this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect().catch(() => {});
          }, this.reconnectIntervalMs);
          this._reconnectTimer.unref?.();
        }
      });
    });
  }

  async close() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    for (const [echo, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new OpenQQError('客户端已关闭', { retcode: 1502, action: entry.action }));
      this._pending.delete(echo);
    }
    const ws = this._ws;
    this._ws = null;
    if (!ws) return;
    await new Promise(resolve => {
      if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      ws.once('close', () => resolve());
      ws.close();
    });
  }

  async call(action, params = {}, { timeoutMs = this.timeoutMs, raw = false } = {}) {
    if (typeof action !== 'string' || !action) throw new OpenQQError('action 不能为空', { retcode: 1400 });
    let response;
    if (this.transport === 'http') {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
      const res = await fetch(`${this.url}/${encodeURIComponent(action)}`, {
        method: 'POST', headers, body: JSON.stringify(params ?? {}), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new OpenQQError(`HTTP ${res.status}`, { retcode: res.status === 401 || res.status === 403 ? 1403 : 1500, action });
      response = await res.json();
    } else {
      if (this._ws?.readyState !== WebSocket.OPEN) await this.connect();
      const echo = randomUUID();
      response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(echo);
          reject(new OpenQQError(`动作 ${action} 超时`, { retcode: 1501, action }));
        }, timeoutMs);
        this._pending.set(echo, { resolve, reject, timer, action });
        this._ws.send(JSON.stringify({ action, params: params ?? {}, echo }));
      });
    }
    if (raw) return response;
    if (response?.status === 'ok' || response?.status === 'async') return response.data;
    throw new OpenQQError(response?.message || `动作 ${action} 失败`, {
      retcode: Number.isInteger(response?.retcode) ? response.retcode : 1500, action, response,
    });
  }

  // ---- Messaging ----
  sendPrivateMsg(user_id, message, extra = {}) { return this.call('send_private_msg', { user_id, message: unwrapMessage(message), ...extra }); }
  sendGroupMsg(group_id, message, extra = {}) { return this.call('send_group_msg', { group_id, message: unwrapMessage(message), ...extra }); }
  sendMsg(params) { return this.call('send_msg', { ...params, message: unwrapMessage(params?.message) }); }
  sendGroupForwardMsg(group_id, messages) { return this.call('send_group_forward_msg', { group_id, messages: unwrapMessage(messages) }); }
  sendPrivateForwardMsg(user_id, messages) { return this.call('send_private_forward_msg', { user_id, messages: unwrapMessage(messages) }); }
  sendForwardMsg(params) { return this.call('send_forward_msg', { ...params, messages: unwrapMessage(params?.messages) }); }
  forwardGroupSingleMsg(group_id, message_id) { return this.call('forward_group_single_msg', { group_id, message_id }); }
  forwardFriendSingleMsg(user_id, message_id) { return this.call('forward_friend_single_msg', { user_id, message_id }); }
  sendPoke(user_id, group_id) { return this.call('send_poke', { user_id, ...(group_id !== undefined ? { group_id } : {}) }); }
  groupPoke(group_id, user_id) { return this.call('group_poke', { group_id, user_id }); }
  friendPoke(user_id) { return this.call('friend_poke', { user_id }); }
  deleteMsg(message_id) { return this.call('delete_msg', { message_id }); }
  getMsg(message_id) { return this.call('get_msg', { message_id }); }
  getForwardMsg(id) { return this.call('get_forward_msg', { id: String(id) }); }
  getGroupMsgHistory(group_id, opts = {}) { return this.call('get_group_msg_history', { group_id, ...opts }); }
  getFriendMsgHistory(user_id, opts = {}) { return this.call('get_friend_msg_history', { user_id, ...opts }); }
  markMsgAsRead(params) { return this.call('mark_msg_as_read', params); }
  markGroupMsgAsRead(group_id) { return this.call('mark_group_msg_as_read', { group_id }); }
  markPrivateMsgAsRead(user_id) { return this.call('mark_private_msg_as_read', { user_id }); }
  markAllAsRead() { return this.call('_mark_all_as_read'); }
  getImage(file) { return this.call('get_image', { file }); }
  getRecord(file, out_format) { return this.call('get_record', { file, ...(out_format ? { out_format } : {}) }); }
  getFile(file) { return this.call('get_file', { file }); }
  fetchPttText(message_id) { return this.call('fetch_ptt_text', { message_id }); }
  setMsgEmojiLike(message_id, emoji_id, set = true) { return this.call('set_msg_emoji_like', { message_id, emoji_id: String(emoji_id), set }); }
  fetchEmojiLike(message_id, emojiId, opts = {}) { return this.call('fetch_emoji_like', { message_id, emojiId: String(emojiId), ...opts }); }

  // ---- Group Admin / Essence / Notices / Files ----
  getGroupList(no_cache = false) { return this.call('get_group_list', { no_cache }); }
  getGroupInfo(group_id, no_cache = false) { return this.call('get_group_info', { group_id, no_cache }); }
  getGroupDetailInfo(group_id) { return this.call('get_group_detail_info', { group_id }); }
  getGroupMemberList(group_id, no_cache = false) { return this.call('get_group_member_list', { group_id, no_cache }); }
  getGroupMemberInfo(group_id, user_id, no_cache = false) { return this.call('get_group_member_info', { group_id, user_id, no_cache }); }
  getGroupAtAllRemain(group_id) { return this.call('get_group_at_all_remain', { group_id }); }
  getGroupShutList(group_id) { return this.call('get_group_shut_list', { group_id }); }
  getGroupHonorInfo(group_id, type = 'all') { return this.call('get_group_honor_info', { group_id, type }); }
  getGroupSystemMsg(count = 50) { return this.call('get_group_system_msg', { count }); }
  getGroupShareLink(group_id) { return this.call('get_group_share_link', { group_id }); }
  setGroupKick(group_id, user_id, reject_add_request = false) { return this.call('set_group_kick', { group_id, user_id, reject_add_request }); }
  setGroupKickMembers(group_id, user_id, reject_add_request = false) { return this.call('set_group_kick_members', { group_id, user_id, reject_add_request }); }
  setGroupBan(group_id, user_id, duration = 1800) { return this.call('set_group_ban', { group_id, user_id, duration }); }
  setGroupWholeBan(group_id, enable = true) { return this.call('set_group_whole_ban', { group_id, enable }); }
  setGroupAdmin(group_id, user_id, enable = true) { return this.call('set_group_admin', { group_id, user_id, enable }); }
  setGroupCard(group_id, user_id, card = '') { return this.call('set_group_card', { group_id, user_id, card }); }
  setGroupName(group_id, group_name) { return this.call('set_group_name', { group_id, group_name }); }
  setGroupRemark(group_id, remark = '') { return this.call('set_group_remark', { group_id, remark }); }
  setGroupPortrait(group_id, file) { return this.call('set_group_portrait', { group_id, file }); }
  setGroupLeave(group_id, is_dismiss = false) { return this.call('set_group_leave', { group_id, is_dismiss }); }
  setGroupAddRequest(flag, approve = true, reason = '') { return this.call('set_group_add_request', { flag, approve, reason }); }
  setEssenceMsg(message_id) { return this.call('set_essence_msg', { message_id }); }
  deleteEssenceMsg(message_id) { return this.call('delete_essence_msg', { message_id }); }
  getEssenceMsgList(group_id, opts = {}) { return this.call('get_essence_msg_list', { group_id, ...opts }); }
  getGroupNotice(group_id) { return this.call('_get_group_notice', { group_id }); }
  sendGroupNotice(group_id, content, opts = {}) { return this.call('_send_group_notice', { group_id, content, ...opts }); }
  delGroupNotice(group_id, notice_id) { return this.call('_del_group_notice', { group_id, notice_id }); }
  uploadGroupFile(group_id, file, opts = {}) { return this.call('upload_group_file', { group_id, file, ...opts }); }
  getGroupFileSystemInfo(group_id) { return this.call('get_group_file_system_info', { group_id }); }
  getGroupRootFiles(group_id, file_count = 50) { return this.call('get_group_root_files', { group_id, file_count }); }
  getGroupFilesByFolder(group_id, folder_id, file_count = 50) { return this.call('get_group_files_by_folder', { group_id, folder_id, file_count }); }
  createGroupFileFolder(group_id, name) { return this.call('create_group_file_folder', { group_id, name }); }
  deleteGroupFolder(group_id, folder_id) { return this.call('delete_group_folder', { group_id, folder_id }); }
  deleteGroupFile(group_id, file_id, busid = 102) { return this.call('delete_group_file', { group_id, file_id, busid }); }
  renameGroupFileFolder(group_id, folder_id, new_folder_name) { return this.call('rename_group_file_folder', { group_id, folder_id, new_folder_name }); }
  transGroupFile(group_id, file_id) { return this.call('trans_group_file', { group_id, file_id }); }
  getGroupFileUrl(group_id, file_id, busid = 102) { return this.call('get_group_file_url', { group_id, file_id, busid }); }

  // ---- Account / Friends / Utils ----
  getLoginInfo() { return this.call('get_login_info'); }
  getStatus() { return this.call('get_status'); }
  getVersionInfo() { return this.call('get_version_info'); }
  getFriendList(no_cache = false) { return this.call('get_friend_list', { no_cache }); }
  getFriendsWithCategory(no_cache = false) { return this.call('get_friends_with_category', { no_cache }); }
  getStrangerInfo(user_id) { return this.call('get_stranger_info', { user_id }); }
  getRecentContact(count = 10) { return this.call('get_recent_contact', { count }); }
  setFriendAddRequest(flag, approve = true, remark) { return this.call('set_friend_add_request', { flag, approve, ...(remark !== undefined ? { remark } : {}) }); }
  setFriendRemark(user_id, remark = '') { return this.call('set_friend_remark', { user_id, remark }); }
  deleteFriend(user_id, opts = {}) { return this.call('delete_friend', { user_id, ...opts }); }
  sendLike(user_id, times = 1) { return this.call('send_like', { user_id, times }); }
  uploadPrivateFile(user_id, file, name) { return this.call('upload_private_file', { user_id, file, ...(name ? { name } : {}) }); }
  setQQProfile(params) { return this.call('set_qq_profile', params); }
  setSelfLongnick(longNick) { return this.call('set_self_longnick', { longNick }); }
  setQQAvatar(file) { return this.call('set_qq_avatar', { file }); }
  fetchCustomFace(count = 48) { return this.call('fetch_custom_face', { count }); }
  setOnlineStatus(status, ext_status = 0, battery_status = 0) { return this.call('set_online_status', { status, ext_status, battery_status }); }
  setInputStatus(user_id, event_type = 1) { return this.call('set_input_status', { user_id, event_type }); }
  downloadFile(params) { return this.call('download_file', params); }
  cleanCache() { return this.call('clean_cache'); }
  generateImage(params) { return this.call('generate_image', params); }
}
