// Authoritative catalog of every OneBot v11 action supported by OpenQQ.
// Used by the TypeScript/ESM SDK (src/sdk.mjs), the MCP server (src/mcp.mjs), and contract tests.

/**
 * @typedef {'read' | 'send' | 'admin' | 'sensitive'} ActionSafety
 * @typedef {{
 *   action: string;
 *   group: '消息' | '群管理' | '账号' | '扩展';
 *   safety: ActionSafety;
 *   summary: string;
 *   params?: string[];
 *   aliasOf?: string;
 * }} ActionCatalogEntry
 */

/** @type {readonly ActionCatalogEntry[]} */
export const ACTION_SPECS = Object.freeze([
  // ---- 消息 ----
  { action: 'send_private_msg', group: '消息', safety: 'send', summary: '发送私聊消息', params: ['user_id', 'message', 'auto_escape?'] },
  { action: 'send_group_msg', group: '消息', safety: 'send', summary: '发送群消息', params: ['group_id', 'message', 'auto_escape?'] },
  { action: 'send_msg', group: '消息', safety: 'send', summary: '发送消息（自动判断私聊或群聊）', params: ['message_type?', 'user_id?', 'group_id?', 'message', 'auto_escape?'] },
  { action: 'send_group_forward_msg', group: '消息', safety: 'send', summary: '发送群合并转发消息（支持引用节点与自定义节点）', params: ['group_id', 'messages'] },
  { action: 'send_private_forward_msg', group: '消息', safety: 'send', summary: '发送私聊合并转发消息（支持引用节点与自定义节点）', params: ['user_id', 'messages'] },
  { action: 'send_forward_msg', group: '消息', safety: 'send', summary: '发送合并转发消息（自动判断目标）', params: ['message_type?', 'user_id?', 'group_id?', 'messages'] },
  { action: 'forward_group_single_msg', group: '消息', safety: 'send', summary: '转发单条消息到群聊', params: ['group_id', 'message_id'] },
  { action: 'forward_friend_single_msg', group: '消息', safety: 'send', summary: '转发单条消息给好友', params: ['user_id', 'message_id'] },
  { action: 'send_poke', group: '消息', safety: 'send', summary: '发送戳一戳（给群成员或好友）', params: ['user_id', 'group_id?'] },
  { action: 'group_poke', group: '消息', safety: 'send', summary: '在群里戳一戳指定成员', params: ['group_id', 'user_id'] },
  { action: 'friend_poke', group: '消息', safety: 'send', summary: '私聊戳一戳指定好友', params: ['user_id'] },
  { action: 'delete_msg', group: '消息', safety: 'admin', summary: '撤回消息', params: ['message_id'] },
  { action: 'get_msg', group: '消息', safety: 'read', summary: '读取单条消息详情', params: ['message_id'] },
  { action: 'get_forward_msg', group: '消息', safety: 'read', summary: '展开合并转发消息内容', params: ['id'] },
  { action: 'get_group_msg_history', group: '消息', safety: 'read', summary: '获取群历史消息', params: ['group_id', 'message_id?', 'message_seq?', 'count?', 'reverseOrder?'] },
  { action: 'get_friend_msg_history', group: '消息', safety: 'read', summary: '获取私聊历史消息', params: ['user_id', 'message_id?', 'message_seq?', 'count?', 'reverseOrder?'] },
  { action: 'mark_msg_as_read', group: '消息', safety: 'send', summary: '标记会话已读（按 message_id / group_id / user_id）', params: ['message_id?', 'group_id?', 'user_id?'] },
  { action: 'mark_group_msg_as_read', group: '消息', safety: 'send', summary: '标记群聊消息已读', params: ['group_id'] },
  { action: 'mark_private_msg_as_read', group: '消息', safety: 'send', summary: '标记私聊消息已读', params: ['user_id'] },
  { action: '_mark_all_as_read', group: '消息', safety: 'send', summary: '标记所有私聊和群聊消息已读', params: [] },
  { action: 'get_image', group: '消息', safety: 'read', summary: '获取图片本地路径、URL 与 Base64', params: ['file'] },
  { action: 'get_record', group: '消息', safety: 'read', summary: '获取语音并可选转码（wav/pcm/mp3/ogg/flac/m4a/silk）', params: ['file', 'out_format?'] },
  { action: 'get_file', group: '消息', safety: 'read', summary: '获取接收文件本地路径、URL 与 Base64', params: ['file'] },
  { action: 'set_msg_emoji_like', group: '消息', safety: 'send', summary: '给群消息添加或取消表情回应', params: ['message_id', 'emoji_id', 'set?'] },
  { action: 'set_group_reaction', group: '消息', safety: 'send', summary: '给群消息添加或取消表情回应（别名）', params: ['message_id', 'code', 'is_add?'], aliasOf: 'set_msg_emoji_like' },
  { action: 'fetch_emoji_like', group: '消息', safety: 'read', summary: '查询消息某表情的回应用户列表', params: ['message_id', 'emojiId', 'emojiType?', 'count?', 'cookie?'] },
  { action: 'get_emoji_likes', group: '消息', safety: 'read', summary: '查询消息表情回应列表（别名）', params: ['message_id', 'emoji_id', 'emoji_type?', 'count?', 'cookie?'], aliasOf: 'fetch_emoji_like' },
  { action: 'get_msg_emoji_likes', group: '消息', safety: 'read', summary: '查询消息表情回应列表（别名）', params: ['message_id', 'emoji_id', 'emoji_type?', 'count?', 'cookie?'], aliasOf: 'fetch_emoji_like' },
  { action: 'fetch_ptt_text', group: '消息', safety: 'read', summary: '将收到的语音消息转为文字', params: ['message_id'] },
  { action: 'get_ptt_text', group: '消息', safety: 'read', summary: '语音转文字（别名）', params: ['message_id'], aliasOf: 'fetch_ptt_text' },
  { action: 'get_record_text', group: '消息', safety: 'read', summary: '语音转文字（别名）', params: ['message_id'], aliasOf: 'fetch_ptt_text' },

  // ---- 群管理 ----
  { action: 'get_group_list', group: '群管理', safety: 'read', summary: '获取群列表', params: ['no_cache?'] },
  { action: 'get_group_info', group: '群管理', safety: 'read', summary: '获取群基本信息', params: ['group_id', 'no_cache?'] },
  { action: 'get_group_detail_info', group: '群管理', safety: 'read', summary: '获取群详细资料（含简介、备注、禁言状态）', params: ['group_id'] },
  { action: 'get_group_info_ex', group: '群管理', safety: 'read', summary: '获取群详细资料（别名）', params: ['group_id'], aliasOf: 'get_group_detail_info' },
  { action: 'get_group_member_list', group: '群管理', safety: 'read', summary: '获取群成员列表', params: ['group_id', 'no_cache?'] },
  { action: 'get_group_member_info', group: '群管理', safety: 'read', summary: '获取单个群成员信息', params: ['group_id', 'user_id', 'no_cache?'] },
  { action: 'get_group_at_all_remain', group: '群管理', safety: 'read', summary: '获取群 @全体成员 剩余次数', params: ['group_id'] },
  { action: 'get_group_shut_list', group: '群管理', safety: 'read', summary: '获取群禁言成员列表', params: ['group_id'] },
  { action: 'get_group_honor_info', group: '群管理', safety: 'read', summary: '获取群荣誉信息（龙王、群聊之火等）', params: ['group_id', 'type?'] },
  { action: 'get_group_system_msg', group: '群管理', safety: 'read', summary: '获取群系统消息（入群申请与邀请列表）', params: ['count?'] },
  { action: 'get_group_share_link', group: '群管理', safety: 'read', summary: '获取群分享/加群链接', params: ['group_id'] },
  { action: 'set_group_kick', group: '群管理', safety: 'admin', summary: '踢出群成员', params: ['group_id', 'user_id', 'reject_add_request?'] },
  { action: 'set_group_kick_members', group: '群管理', safety: 'admin', summary: '批量踢出群成员', params: ['group_id', 'user_id', 'reject_add_request?'] },
  { action: 'set_group_ban', group: '群管理', safety: 'admin', summary: '禁言或解除禁言群成员', params: ['group_id', 'user_id', 'duration?'] },
  { action: 'set_group_whole_ban', group: '群管理', safety: 'admin', summary: '开启或关闭全员禁言', params: ['group_id', 'enable?'] },
  { action: 'set_group_admin', group: '群管理', safety: 'admin', summary: '设置或取消群管理员', params: ['group_id', 'user_id', 'enable?'] },
  { action: 'set_group_card', group: '群管理', safety: 'admin', summary: '修改群名片', params: ['group_id', 'user_id', 'card?'] },
  { action: 'set_group_name', group: '群管理', safety: 'admin', summary: '修改群名称', params: ['group_id', 'group_name'] },
  { action: 'set_group_remark', group: '群管理', safety: 'admin', summary: '修改群备注', params: ['group_id', 'remark?'] },
  { action: 'set_group_portrait', group: '群管理', safety: 'admin', summary: '设置群头像', params: ['group_id', 'file'] },
  { action: 'set_group_leave', group: '群管理', safety: 'admin', summary: '退出或解散群', params: ['group_id', 'is_dismiss?'] },
  { action: 'set_group_add_request', group: '群管理', safety: 'admin', summary: '处理入群申请或群邀请', params: ['flag', 'approve?', 'reason?'] },
  { action: 'set_essence_msg', group: '群管理', safety: 'admin', summary: '设置群精华消息', params: ['message_id'] },
  { action: 'delete_essence_msg', group: '群管理', safety: 'admin', summary: '移出群精华消息', params: ['message_id'] },
  { action: 'get_essence_msg_list', group: '群管理', safety: 'read', summary: '获取群精华消息列表', params: ['group_id', 'page_start?', 'page_limit?'] },
  { action: '_get_group_notice', group: '群管理', safety: 'read', summary: '获取群公告列表', params: ['group_id'] },
  { action: '_send_group_notice', group: '群管理', safety: 'admin', summary: '发布群公告（支持附带图片与置顶）', params: ['group_id', 'content', 'image?', 'pinned?'] },
  { action: '_del_group_notice', group: '群管理', safety: 'admin', summary: '删除群公告', params: ['group_id', 'notice_id'] },
  { action: 'upload_group_file', group: '群管理', safety: 'send', summary: '上传群文件（支持指定文件夹）', params: ['group_id', 'file', 'name?', 'folder?'] },
  { action: 'get_group_file_system_info', group: '群管理', safety: 'read', summary: '获取群文件空间信息', params: ['group_id'] },
  { action: 'get_group_root_files', group: '群管理', safety: 'read', summary: '获取群根目录文件与文件夹列表', params: ['group_id', 'file_count?'] },
  { action: 'get_group_files_by_folder', group: '群管理', safety: 'read', summary: '获取群子文件夹内的文件列表', params: ['group_id', 'folder_id', 'file_count?'] },
  { action: 'create_group_file_folder', group: '群管理', safety: 'admin', summary: '创建群文件夹', params: ['group_id', 'name'] },
  { action: 'delete_group_folder', group: '群管理', safety: 'admin', summary: '删除群文件夹', params: ['group_id', 'folder_id'] },
  { action: 'delete_group_file_folder', group: '群管理', safety: 'admin', summary: '删除群文件夹（别名）', params: ['group_id', 'folder_id'], aliasOf: 'delete_group_folder' },
  { action: 'delete_group_file', group: '群管理', safety: 'admin', summary: '删除群文件', params: ['group_id', 'file_id', 'busid?'] },
  { action: 'rename_group_file_folder', group: '群管理', safety: 'admin', summary: '重命名群文件夹', params: ['group_id', 'folder_id', 'new_folder_name'] },
  { action: 'trans_group_file', group: '群管理', safety: 'admin', summary: '转存群临时文件为永久文件', params: ['group_id', 'file_id'] },
  { action: 'get_group_file_url', group: '群管理', safety: 'read', summary: '获取群文件下载链接', params: ['group_id', 'file_id', 'busid?'] },

  // ---- 账号与好友 ----
  { action: 'get_login_info', group: '账号', safety: 'read', summary: '获取当前登录账号 QQ 号与昵称', params: [] },
  { action: 'get_status', group: '账号', safety: 'read', summary: '获取运行状态', params: [] },
  { action: 'get_version_info', group: '账号', safety: 'read', summary: '获取 OpenQQ 版本与协议信息', params: [] },
  { action: 'can_send_image', group: '账号', safety: 'read', summary: '检查是否支持发送图片', params: [] },
  { action: 'can_send_record', group: '账号', safety: 'read', summary: '检查是否支持发送语音', params: [] },
  { action: 'get_friend_list', group: '账号', safety: 'read', summary: '获取好友列表（支持主动拉取与 no_cache）', params: ['no_cache?'] },
  { action: 'get_friends_with_category', group: '账号', safety: 'read', summary: '获取带分组的好友列表', params: ['no_cache?'] },
  { action: 'get_stranger_info', group: '账号', safety: 'read', summary: '获取陌生人/用户资料', params: ['user_id'] },
  { action: 'get_recent_contact', group: '账号', safety: 'read', summary: '获取最近会话列表', params: ['count?'] },
  { action: 'set_friend_add_request', group: '账号', safety: 'admin', summary: '处理好友申请（同意后可设置备注）', params: ['flag', 'approve?', 'remark?'] },
  { action: 'set_friend_remark', group: '账号', safety: 'admin', summary: '修改好友备注', params: ['user_id', 'remark?'] },
  { action: 'delete_friend', group: '账号', safety: 'admin', summary: '删除好友', params: ['user_id', 'temp_block?', 'temp_both_del?'] },
  { action: 'send_like', group: '账号', safety: 'send', summary: '给好友资料卡点赞', params: ['user_id', 'times?'] },
  { action: 'upload_private_file', group: '账号', safety: 'send', summary: '向好友发送私聊文件', params: ['user_id', 'file', 'name?'] },
  { action: 'set_qq_profile', group: '账号', safety: 'admin', summary: '修改自身昵称、个性签名或性别', params: ['nickname?', 'personal_note?', 'sex?'] },
  { action: 'set_self_longnick', group: '账号', safety: 'admin', summary: '修改自身个性签名', params: ['longNick'] },
  { action: 'set_qq_avatar', group: '账号', safety: 'admin', summary: '修改自身头像', params: ['file'] },
  { action: 'set_online_status', group: '账号', safety: 'admin', summary: '设置在线状态', params: ['status', 'ext_status?', 'battery_status?'] },
  { action: 'fetch_custom_face', group: '账号', safety: 'read', summary: '获取收藏表情 URL 列表', params: ['count?'] },
  { action: 'get_clientkey', group: '账号', safety: 'sensitive', summary: '获取当前会话 clientkey（敏感凭据）', params: [] },
  { action: 'get_cookies', group: '账号', safety: 'sensitive', summary: '获取指定域名的 Cookies（敏感凭据）', params: ['domain?'] },
  { action: 'get_csrf_token', group: '账号', safety: 'sensitive', summary: '获取指定域名的 CSRF Token / bkn（敏感凭据）', params: ['domain?'] },
  { action: 'get_credentials', group: '账号', safety: 'sensitive', summary: '获取 Cookies 与 CSRF Token（敏感凭据）', params: ['domain?'] },

  // ---- 扩展与工具 ----
  { action: 'set_input_status', group: '扩展', safety: 'send', summary: '发送私聊输入状态通知', params: ['user_id', 'event_type'] },
  { action: 'download_file', group: '扩展', safety: 'send', summary: '下载远程 URL 或 Base64 到本地临时目录', params: ['url?', 'base64?', 'name?', 'headers?'] },
  { action: 'clean_cache', group: '扩展', safety: 'admin', summary: '清理 OpenQQ 临时媒体目录', params: [] },
  { action: 'check_url_safely', group: '扩展', safety: 'read', summary: '检查链接格式安全性', params: ['url'] },
  { action: 'nc_get_packet_status', group: '扩展', safety: 'read', summary: '查询底层协议通道模式', params: [] },
  { action: 'generate_image', group: '扩展', safety: 'send', summary: '调用已配置的 AI 生图接口生成图片', params: ['prompt', 'model?', 'size?', 'n?', 'group_id?', 'user_id?'] },
  { action: '.handle_quick_operation', group: '扩展', safety: 'send', summary: '执行 OneBot 快速操作', params: ['context', 'operation'] },
  { action: 'ArkSharePeer', group: '扩展', safety: 'read', summary: '获取推荐好友或群的 Ark 分享卡片', params: ['user_id?', 'group_id?', 'phoneNumber?'] },
  { action: 'send_ark_share', group: '扩展', safety: 'read', summary: '获取推荐 Ark 卡片（别名）', params: ['user_id?', 'group_id?', 'phoneNumber?'], aliasOf: 'ArkSharePeer' },
  { action: 'share_peer', group: '扩展', safety: 'read', summary: '获取推荐 Ark 卡片（别名）', params: ['user_id?', 'group_id?', 'phoneNumber?'], aliasOf: 'ArkSharePeer' },
  { action: 'ArkShareGroup', group: '扩展', safety: 'read', summary: '获取群推荐 Ark 分享卡片', params: ['group_id'] },
  { action: 'send_group_ark_share', group: '扩展', safety: 'read', summary: '获取群推荐 Ark 卡片（别名）', params: ['group_id'], aliasOf: 'ArkShareGroup' },
  { action: 'share_group_ex', group: '扩展', safety: 'read', summary: '获取群推荐 Ark 卡片（别名）', params: ['group_id'], aliasOf: 'ArkShareGroup' },
]);

/** @type {readonly string[]} */
export const OPENQQ_ACTIONS = Object.freeze(ACTION_SPECS.map(entry => entry.action));

const ACTION_MAP = new Map(ACTION_SPECS.map(entry => [entry.action, entry]));

/** @param {string} name */
export function isOpenQQAction(name) {
  return typeof name === 'string' && ACTION_MAP.has(name);
}

/** @param {string} name */
export function getActionSpec(name) {
  return typeof name === 'string' ? ACTION_MAP.get(name) ?? null : null;
}
