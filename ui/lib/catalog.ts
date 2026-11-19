// OneBot actions implemented by src/actions.mjs (see docs/actions.md). Keep in sync when adding actions.
export interface ParamSpec { name: string; type: string; required?: boolean; description: string }
export interface ActionSpec {
  action: string;
  group: '消息' | '群管理' | '账号' | '扩展';
  summary: string;
  description: string;
  params: ParamSpec[];
  example: Record<string, unknown>;
  /** Performs a real send through the logged-in QQ account. */
  sends?: boolean;
  /** Changes a group, a request or the account for real (kick, mute, rename, approve, recall...). */
  changes?: boolean;
}

const message: ParamSpec = { name: 'message', type: 'string | segment[]', required: true, description: '纯文本、CQ 码字符串，或最多 100 个消息段（text、at、face、image、record、video、file、reply、json、dice、rps），文本总长不超过 64 KiB' };
const autoEscape: ParamSpec = { name: 'auto_escape', type: 'boolean', description: '为 true 时字符串按纯文本原样发送，不解析 CQ 码' };

export const catalog: ActionSpec[] = [
  { action: 'send_private_msg', group: '消息', sends: true, summary: '发送私聊消息', description: '向好友发送一条消息。成功表示收到 QQ 的发送回调，不代表对方已读。',
    params: [{ name: 'user_id', type: 'number', required: true, description: '对方 QQ 号' }, message, autoEscape],
    example: { user_id: 123456789, message: '你好', auto_escape: true } },
  { action: 'send_group_msg', group: '消息', sends: true, summary: '发送群消息', description: '向群聊发送一条消息；reply 段只能引用同一会话的消息。',
    params: [{ name: 'group_id', type: 'number', required: true, description: '群号' }, message, autoEscape],
    example: { group_id: 987654321, message: [{ type: 'text', data: { text: '群消息测试' } }] } },
  { action: 'send_msg', group: '消息', sends: true, summary: '发送消息（自动判断）', description: '指定 message_type，或只提供 user_id / group_id 其中之一来确定目标。',
    params: [{ name: 'message_type', type: "'private' | 'group'", description: '会话类型，可省略' }, { name: 'user_id', type: 'number', description: '私聊目标 QQ 号' },
      { name: 'group_id', type: 'number', description: '群号' }, message, autoEscape],
    example: { message_type: 'private', user_id: 123456789, message: '你好', auto_escape: true } },
  { action: 'get_msg', group: '消息', summary: '读取消息', description: '按 message_id 读取一条消息的内容；reply 段的 id 也可以，用来读取被引用的消息。',
    params: [{ name: 'message_id', type: 'number', required: true, description: '消息 id，或 reply 段的 data.id；仅限本次运行期间收发过或被引用的消息' }],
    example: { message_id: 12 } },
  { action: 'get_forward_msg', group: '消息', summary: '获取合并转发', description: '按 forward 段的 id，或携带转发的那条消息的 message_id 获取转发内容。',
    params: [{ name: 'id', type: 'string', required: true, description: '合并转发 id 或 message_id，仅限本次运行期间收到的消息' }],
    example: { id: '15' } },
  { action: 'get_image', group: '消息', summary: '获取图片详情', description: '按收到图片段的 file 或 file_id 拉取并返回本地路径、URL 和 Base64（16 MiB 内）。',
    params: [{ name: 'file', type: 'string', required: true, description: 'image 段里的 file 或 file_id' }],
    example: { file: 'example.png' } },
  { action: 'get_login_info', group: '账号', summary: '获取登录信息', description: '返回当前账号的 QQ 号；昵称暂为空字符串。', params: [], example: {} },
  { action: 'get_status', group: '账号', summary: '获取运行状态', description: '反映原生会话是否可用，未包含完整的网络连通性探测。', params: [], example: {} },
  { action: 'set_msg_emoji_like', group: '消息', changes: true, summary: '给消息添加表情回应', description: '对一条群消息添加或取消表情回应；消息必须还在 QQ 的本地记录里。',
    params: [{ name: 'message_id', type: 'number', required: true, description: '消息 id，或 reply 段的 data.id' }, { name: 'emoji_id', type: 'string', required: true, description: 'QQ 表情编号，或 emoji 的码点' },
      { name: 'set', type: 'boolean', description: '默认 true；false 为取消回应' }],
    example: { message_id: 12, emoji_id: '76' } },
  { action: 'clean_cache', group: '扩展', summary: '清理临时媒体', description: '清理 OpenQQ 媒体临时目录里一小时前的残留，不会动 QQ 的缓存。', params: [], example: {} },
  { action: 'set_input_status', group: '扩展', summary: '设置输入状态', description: '向私聊对象提交「正在输入」等状态通知；成功只表示原生调用完成。',
    params: [{ name: 'user_id', type: 'number', required: true, description: '对方 QQ 号' }, { name: 'event_type', type: 'number', required: true, description: '事件码，1 为正在输入；其他值原样传给 QQ' }],
    example: { user_id: 123456789, event_type: 1 } },
  { action: 'delete_msg', group: '消息', changes: true, summary: '撤回消息', description: '按 message_id 撤回一条消息，仅限本次运行期间收发过的消息，并受 QQ 的撤回时限和权限约束。成功只表示 QQ 接受了调用，请以撤回通知为准。',
    params: [{ name: 'message_id', type: 'number', required: true, description: '发送回执或接收事件里的 message_id' }], example: { message_id: 1 } },
  { action: 'set_group_kick', group: '群管理', changes: true, summary: '踢出群成员', description: '把成员移出群；需要管理员权限。',
    params: [{ name: 'group_id', type: 'number', required: true, description: '群号' }, { name: 'user_id', type: 'number', required: true, description: '成员 QQ 号' }, { name: 'reject_add_request', type: 'boolean', description: '是否拒绝此人再次申请，默认 false' }],
    example: { group_id: 987654321, user_id: 123456789, reject_add_request: false } },
  { action: 'set_group_ban', group: '群管理', changes: true, summary: '群成员禁言', description: '禁言一名成员；duration 为 0 即解除。需要管理员权限。',
    params: [{ name: 'group_id', type: 'number', required: true, description: '群号' }, { name: 'user_id', type: 'number', required: true, description: '成员 QQ 号' }, { name: 'duration', type: 'number', description: '禁言秒数，0 解除，默认 1800，最大 2592000' }],
    example: { group_id: 987654321, user_id: 123456789, duration: 60 } },
  { action: 'set_group_whole_ban', group: '群管理', changes: true, summary: '全员禁言', description: '开启或关闭全员禁言。需要管理员权限。',
    params: [{ name: 'group_id', type: 'number', required: true, description: '群号' }, { name: 'enable', type: 'boolean', description: '默认 true；false 为关闭' }], example: { group_id: 987654321, enable: true } },
  { action: 'set_group_admin', group: '群管理', changes: true, summary: '设置或取消管理员', description: '只有群主可以操作。',
    params: [{ name: 'group_id', type: 'number', required: true, description: '群号' }, { name: 'user_id', type: 'number', required: true, description: '成员 QQ 号' }, { name: 'enable', type: 'boolean', description: '默认 true；false 为取消管理员' }],
    example: { group_id: 987654321, user_id: 123456789, enable: true } },
  { action: 'set_group_card', group: '群管理', changes: true, summary: '修改群名片', description: '修改成员的群名片，空字符串为清除；需要管理员权限（改自己的名片除外）。',
    params: [{ name: 'group_id', type: 'number', required: true, description: '群号' }, { name: 'user_id', type: 'number', required: true, description: '成员 QQ 号' }, { name: 'card', type: 'string', description: '不超过 60 个字符，默认空' }],
    example: { group_id: 987654321, user_id: 123456789, card: '新名片' } },
  { action: 'set_group_name', group: '群管理', changes: true, summary: '修改群名', description: '需要管理员权限。',
    params: [{ name: 'group_id', type: 'number', required: true, description: '群号' }, { name: 'group_name', type: 'string', required: true, description: '不超过 48 个字符' }], example: { group_id: 987654321, group_name: '新群名' } },
  { action: 'set_group_leave', group: '群管理', changes: true, summary: '退出或解散群', description: '退出群；is_dismiss 为 true 时解散群，仅群主可用。无法撤销，请谨慎。',
    params: [{ name: 'group_id', type: 'number', required: true, description: '群号' }, { name: 'is_dismiss', type: 'boolean', description: '是否解散，默认 false' }], example: { group_id: 987654321, is_dismiss: false } },
  { action: 'set_group_add_request', group: '群管理', changes: true, summary: '处理入群申请', description: '同意或拒绝入群申请 / 邀请。flag 取自入群申请事件，格式由 OpenQQ 定义，请原样传回。',
    params: [{ name: 'flag', type: 'string', required: true, description: '申请事件里的 flag' }, { name: 'approve', type: 'boolean', description: '默认 true' }, { name: 'reason', type: 'string', description: '拒绝理由，不超过 256 个字符' }],
    example: { flag: 'g:987654321:7:1794470400000099', approve: true } },
  { action: 'get_friend_list', group: '账号', summary: '获取好友列表', description: '返回 QQ 最近一次推送的好友列表（user_id、nickname、remark），不会向 QQ 刷新；登录同步完成前不可用。', params: [], example: {} },
  { action: 'get_group_list', group: '群管理', summary: '获取群列表', description: '向 QQ 刷新并返回全部群；返回 group_id、group_name、member_count、max_member_count。', params: [], example: {} },
  { action: 'get_group_info', group: '群管理', summary: '获取群信息', description: '返回一个群的名称和人数（来自最近一次群列表）。', params: [{ name: 'group_id', type: 'number', required: true, description: '群号' }], example: { group_id: 987654321 } },
  { action: 'get_group_member_list', group: '群管理', summary: '获取群成员列表', description: '返回群成员及其角色、名片、头衔、禁言到期时间戳。', params: [{ name: 'group_id', type: 'number', required: true, description: '群号' }], example: { group_id: 987654321 } },
  { action: 'get_group_member_info', group: '群管理', summary: '获取群成员信息', description: '返回单个成员的资料；找不到时返回 1404。', params: [{ name: 'group_id', type: 'number', required: true, description: '群号' }, { name: 'user_id', type: 'number', required: true, description: '成员 QQ 号' }], example: { group_id: 987654321, user_id: 123456789 } },
  { action: 'set_friend_add_request', group: '账号', changes: true, summary: '处理好友申请', description: '同意或拒绝好友申请。flag 取自好友申请事件，请原样传回。',
    params: [{ name: 'flag', type: 'string', required: true, description: '申请事件里的 flag' }, { name: 'approve', type: 'boolean', description: '默认 true' }], example: { flag: 'f:u_abc:1794470400', approve: true } },
  { action: 'send_like', group: '账号', changes: true, summary: '给好友资料点赞', description: '每次 1 到 20 个赞，受 QQ 每日额度限制。',
    params: [{ name: 'user_id', type: 'number', required: true, description: '对方 QQ 号' }, { name: 'times', type: 'number', description: '1..20，默认 1' }], example: { user_id: 123456789, times: 1 } },
  { action: 'get_version_info', group: '账号', summary: '获取版本信息', description: '返回 OpenQQ 的名称、版本和 OneBot 协议版本。', params: [], example: {} },
];

export const retcodes: Record<number, string> = {
  0: '成功',
  1400: '参数或输入格式无效，未提交发送',
  1404: '动作尚未支持，或引用 / 转发的 id 不存在、已过期',
  1500: '原生调用失败或回执无效',
  1501: '超时，已提交的发送结果可能未确认',
  1502: '会话未就绪、重新初始化或 IPC 断开',
  1503: '动作队列已满，或单个连接同时进行的动作过多，未提交',
};

export function requestTemplate(spec: ActionSpec) {
  return JSON.stringify({ action: spec.action, ...(spec.params.length ? { params: spec.example } : {}), echo: 'webui' }, null, 2);
}
