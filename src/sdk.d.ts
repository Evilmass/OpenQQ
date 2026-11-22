export type ActionSafety = 'read' | 'send' | 'admin' | 'sensitive';

export interface ActionCatalogEntry {
  readonly action: string;
  readonly group: '消息' | '群管理' | '账号' | '扩展';
  readonly safety: ActionSafety;
  readonly summary: string;
  readonly params?: readonly string[];
  readonly aliasOf?: string;
}

export declare const ACTION_SPECS: readonly ActionCatalogEntry[];
export declare const OPENQQ_ACTIONS: readonly string[];
export declare function isOpenQQAction(name: string): boolean;
export declare function getActionSpec(name: string): ActionCatalogEntry | null;

export interface Segment {
  type: string;
  data: Record<string, unknown>;
}

export type MessageInput = string | Segment[] | MessageBuilder;

export interface OpenQQClientOptions {
  url?: string;
  token?: string;
  timeoutMs?: number;
  reconnect?: boolean;
  reconnectIntervalMs?: number;
}

export interface CallOptions {
  timeoutMs?: number;
  raw?: boolean;
}

export declare class OpenQQError extends Error {
  retcode: number;
  action: string;
  response: unknown;
  constructor(message: string, opts?: { retcode?: number; action?: string; response?: unknown });
}

export declare class MessageBuilder {
  constructor(initial?: Segment[]);
  raw(type: string, data?: Record<string, unknown>): this;
  text(text: string): this;
  at(qq: string | number, name?: string): this;
  face(id: string | number): this;
  dice(): this;
  rps(): this;
  image(file: string, opts?: { summary?: string; sub_type?: number; name?: string }): this;
  record(file: string): this;
  video(file: string, opts?: { thumb?: string; cover?: string; name?: string }): this;
  file(file: string, name?: string): this;
  reply(id: string | number): this;
  replySeq(seq: string | number): this;
  json(data: string | Record<string, unknown>): this;
  mface(emoji_id: string, emoji_package_id: number, opts?: { key?: string; summary?: string }): this;
  markdown(content: string): this;
  contact(type: 'qq' | 'group', id: string | number): this;
  nodeRef(id: string | number, name?: string): this;
  node(content: MessageInput, opts?: { name?: string; uin?: string | number }): this;
  build(): Segment[];
  toJSON(): Segment[];
}

export declare function msg(initial?: Segment[]): MessageBuilder;

export declare class OpenQQClient {
  readonly url: string;
  readonly transport: 'http' | 'ws';
  readonly token: string;
  readonly connected: boolean;
  constructor(options?: OpenQQClientOptions);
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this;
  removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
  emit(event: string | symbol, ...args: any[]): boolean;
  connect(): Promise<this>;
  close(): Promise<void>;
  call<T = unknown>(action: string, params?: Record<string, unknown>, options?: CallOptions): Promise<T>;

  sendPrivateMsg(user_id: number | string, message: MessageInput, extra?: { auto_escape?: boolean }): Promise<{ message_id: number }>;
  sendGroupMsg(group_id: number | string, message: MessageInput, extra?: { auto_escape?: boolean }): Promise<{ message_id: number }>;
  sendMsg(params: { message_type?: 'private' | 'group'; user_id?: number | string; group_id?: number | string; message: MessageInput; auto_escape?: boolean }): Promise<{ message_id: number }>;
  sendGroupForwardMsg(group_id: number | string, messages: Segment[] | MessageBuilder): Promise<{ message_id: number }>;
  sendPrivateForwardMsg(user_id: number | string, messages: Segment[] | MessageBuilder): Promise<{ message_id: number }>;
  sendForwardMsg(params: { message_type?: 'private' | 'group'; user_id?: number | string; group_id?: number | string; messages: Segment[] | MessageBuilder }): Promise<{ message_id: number }>;
  forwardGroupSingleMsg(group_id: number | string, message_id: number | string): Promise<{ message_id: number }>;
  forwardFriendSingleMsg(user_id: number | string, message_id: number | string): Promise<{ message_id: number }>;
  sendPoke(user_id: number | string, group_id?: number | string): Promise<null>;
  groupPoke(group_id: number | string, user_id: number | string): Promise<null>;
  friendPoke(user_id: number | string): Promise<null>;
  deleteMsg(message_id: number | string): Promise<null>;
  getMsg(message_id: number | string): Promise<Record<string, unknown>>;
  getForwardMsg(id: number | string): Promise<{ messages: Record<string, unknown>[] }>;
  getGroupMsgHistory(group_id: number | string, opts?: { message_id?: number | string; message_seq?: number | string; count?: number; reverseOrder?: boolean }): Promise<{ messages: Record<string, unknown>[] }>;
  getFriendMsgHistory(user_id: number | string, opts?: { message_id?: number | string; message_seq?: number | string; count?: number; reverseOrder?: boolean }): Promise<{ messages: Record<string, unknown>[] }>;
  markMsgAsRead(params: { message_id?: number | string; group_id?: number | string; user_id?: number | string }): Promise<null>;
  markGroupMsgAsRead(group_id: number | string): Promise<null>;
  markPrivateMsgAsRead(user_id: number | string): Promise<null>;
  markAllAsRead(): Promise<null>;
  getImage(file: string): Promise<{ file: string; filename: string; file_name: string; size: number; file_size: number; url: string; base64?: string }>;
  getRecord(file: string, out_format?: string): Promise<{ file: string; filename: string; file_name: string; size: number; file_size: number; url: string; base64?: string }>;
  getFile(file: string): Promise<{ file: string; filename: string; file_name: string; size: number; file_size: number; url: string; base64?: string }>;
  fetchPttText(message_id: number | string): Promise<{ text: string }>;
  setMsgEmojiLike(message_id: number | string, emoji_id: string | number, set?: boolean): Promise<null>;
  fetchEmojiLike(message_id: number | string, emojiId: string | number, opts?: { emojiType?: string; count?: number; cookie?: string }): Promise<Record<string, unknown>>;

  getGroupList(no_cache?: boolean): Promise<Record<string, unknown>[]>;
  getGroupInfo(group_id: number | string, no_cache?: boolean): Promise<Record<string, unknown>>;
  getGroupDetailInfo(group_id: number | string): Promise<Record<string, unknown>>;
  getGroupMemberList(group_id: number | string, no_cache?: boolean): Promise<Record<string, unknown>[]>;
  getGroupMemberInfo(group_id: number | string, user_id: number | string, no_cache?: boolean): Promise<Record<string, unknown>>;
  getGroupAtAllRemain(group_id: number | string): Promise<{ can_at_all: boolean; remain_at_all_count_for_group: number; remain_at_all_count_for_uin: number }>;
  getGroupShutList(group_id: number | string): Promise<Record<string, unknown>[]>;
  getGroupHonorInfo(group_id: number | string, type?: string): Promise<Record<string, unknown>>;
  getGroupSystemMsg(count?: number): Promise<{ invited_requests: Record<string, unknown>[]; join_requests: Record<string, unknown>[] }>;
  getGroupShareLink(group_id: number | string): Promise<{ url: string }>;
  setGroupKick(group_id: number | string, user_id: number | string, reject_add_request?: boolean): Promise<null>;
  setGroupKickMembers(group_id: number | string, user_id: (number | string)[], reject_add_request?: boolean): Promise<null>;
  setGroupBan(group_id: number | string, user_id: number | string, duration?: number): Promise<null>;
  setGroupWholeBan(group_id: number | string, enable?: boolean): Promise<null>;
  setGroupAdmin(group_id: number | string, user_id: number | string, enable?: boolean): Promise<null>;
  setGroupCard(group_id: number | string, user_id: number | string, card?: string): Promise<null>;
  setGroupName(group_id: number | string, group_name: string): Promise<null>;
  setGroupRemark(group_id: number | string, remark?: string): Promise<null>;
  setGroupPortrait(group_id: number | string, file: string): Promise<null>;
  setGroupLeave(group_id: number | string, is_dismiss?: boolean): Promise<null>;
  setGroupAddRequest(flag: string, approve?: boolean, reason?: string): Promise<null>;
  setEssenceMsg(message_id: number | string): Promise<null>;
  deleteEssenceMsg(message_id: number | string): Promise<null>;
  getEssenceMsgList(group_id: number | string, opts?: { page_start?: number; page_limit?: number }): Promise<Record<string, unknown>[]>;
  getGroupNotice(group_id: number | string): Promise<Record<string, unknown>[]>;
  sendGroupNotice(group_id: number | string, content: string, opts?: { image?: string; pinned?: boolean }): Promise<null>;
  delGroupNotice(group_id: number | string, notice_id: string): Promise<null>;
  uploadGroupFile(group_id: number | string, file: string, opts?: { name?: string; folder?: string }): Promise<{ message_id: number }>;
  getGroupFileSystemInfo(group_id: number | string): Promise<{ file_count: number; limit_count: number; used_space: number; total_space: number }>;
  getGroupRootFiles(group_id: number | string, file_count?: number): Promise<{ files: Record<string, unknown>[]; folders: Record<string, unknown>[] }>;
  getGroupFilesByFolder(group_id: number | string, folder_id: string, file_count?: number): Promise<{ files: Record<string, unknown>[]; folders: Record<string, unknown>[] }>;
  createGroupFileFolder(group_id: number | string, name: string): Promise<{ folder_id: string }>;
  deleteGroupFolder(group_id: number | string, folder_id: string): Promise<null>;
  deleteGroupFile(group_id: number | string, file_id: string, busid?: number): Promise<null>;
  renameGroupFileFolder(group_id: number | string, folder_id: string, new_folder_name: string): Promise<null>;
  transGroupFile(group_id: number | string, file_id: string): Promise<Record<string, unknown>>;
  getGroupFileUrl(group_id: number | string, file_id: string, busid?: number): Promise<{ url: string }>;

  getLoginInfo(): Promise<{ user_id: number; nickname: string }>;
  getStatus(): Promise<{ online: boolean; good: boolean }>;
  getVersionInfo(): Promise<{ app_name: string; app_version: string; protocol_version: string }>;
  getFriendList(no_cache?: boolean): Promise<Record<string, unknown>[]>;
  getFriendsWithCategory(no_cache?: boolean): Promise<Record<string, unknown>[]>;
  getStrangerInfo(user_id: number | string): Promise<Record<string, unknown>>;
  getRecentContact(count?: number): Promise<Record<string, unknown>[]>;
  setFriendAddRequest(flag: string, approve?: boolean, remark?: string): Promise<null>;
  setFriendRemark(user_id: number | string, remark?: string): Promise<null>;
  deleteFriend(user_id: number | string, opts?: { temp_block?: boolean; temp_both_del?: boolean }): Promise<null>;
  sendLike(user_id: number | string, times?: number): Promise<null>;
  uploadPrivateFile(user_id: number | string, file: string, name?: string): Promise<{ message_id: number }>;
  setQQProfile(params: { nickname?: string; personal_note?: string; sex?: number }): Promise<null>;
  setSelfLongnick(longNick: string): Promise<null>;
  setQQAvatar(file: string): Promise<null>;
  fetchCustomFace(count?: number): Promise<string[]>;
  setOnlineStatus(status: number, ext_status?: number, battery_status?: number): Promise<null>;
  setInputStatus(user_id: number | string, event_type?: number): Promise<null>;
  downloadFile(params: { url?: string; base64?: string; name?: string; headers?: Record<string, string> | string[] }): Promise<{ file: string }>;
  cleanCache(): Promise<null>;
  generateImage(params: { prompt: string; model?: string; size?: string; n?: number; group_id?: number; user_id?: number }): Promise<Record<string, unknown>>;
}
