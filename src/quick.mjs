// OneBot v11 快速操作：把「事件 + 操作字典」换成要依次执行的动作。
// 来源有两处：HTTP POST 上报的响应体，以及 `.handle_quick_operation` 动作的参数。

const fail = message => Object.assign(new Error(message), { retcode: 1400 });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const flag = (value, name, fallback) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw fail(`快速操作的 ${name} 必须为布尔值`);
  return value;
};

// Returns the actions ({ action, params }) the operation stands for, in execution order.
export function quickActions(context, operation) {
  if (!isObject(context) || typeof context.post_type !== 'string') throw fail('快速操作需要 context 事件对象');
  if (!isObject(operation)) throw fail('快速操作需要 operation 对象');
  const actions = [];
  if (context.post_type === 'message') {
    const group = context.message_type === 'group';
    const target = group ? { group_id: context.group_id } : { user_id: context.user_id };
    if (operation.reply !== undefined && operation.reply !== null) {
      const autoEscape = flag(operation.auto_escape, 'auto_escape', false);
      const atSender = group && flag(operation.at_sender, 'at_sender', true);
      let message = operation.reply;
      if (typeof message === 'string') {
        if (atSender) message = autoEscape ? [{ type: 'at', data: { qq: String(context.user_id) } }, { type: 'text', data: { text: ' ' + message } }]
          : `[CQ:at,qq=${context.user_id}] ${message}`;
      } else if (Array.isArray(message)) {
        if (atSender) message = [{ type: 'at', data: { qq: String(context.user_id) } }, ...message];
      } else throw fail('快速操作的 reply 必须是文本或消息段数组');
      const empty = typeof operation.reply === 'string' ? !operation.reply : operation.reply.length === 0;
      if (!empty) actions.push({ action: 'send_msg', params: { message_type: group ? 'group' : 'private', ...target, message, ...(typeof message === 'string' && autoEscape ? { auto_escape: true } : {}) } });
    }
    if (group) {
      if (flag(operation.delete, 'delete', false)) actions.push({ action: 'delete_msg', params: { message_id: context.message_id } });
      if (flag(operation.kick, 'kick', false)) actions.push({ action: 'set_group_kick', params: { group_id: context.group_id, user_id: context.user_id, reject_add_request: false } });
      if (flag(operation.ban, 'ban', false)) {
        const duration = operation.ban_duration ?? 30 * 60;
        if (!Number.isInteger(duration) || duration < 0) throw fail('快速操作的 ban_duration 必须是非负整数（秒）');
        actions.push({ action: 'set_group_ban', params: { group_id: context.group_id, user_id: context.user_id, duration } });
      }
    }
  } else if (context.post_type === 'request') {
    if (!['friend', 'group'].includes(context.request_type)) throw fail('快速操作只支持好友和入群请求');
    const approve = flag(operation.approve, 'approve', true);
    if (operation.approve !== undefined && operation.approve !== null) {
      if (context.request_type === 'friend') actions.push({ action: 'set_friend_add_request', params: { flag: context.flag, approve, ...(typeof operation.remark === 'string' ? { remark: operation.remark } : {}) } });
      else actions.push({ action: 'set_group_add_request', params: { flag: context.flag, sub_type: context.sub_type, approve, ...(typeof operation.reason === 'string' ? { reason: operation.reason } : {}) } });
    }
  } else throw fail('只有消息和请求事件支持快速操作');
  return actions;
}
