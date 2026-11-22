'use strict';

const { createHash } = require('node:crypto');

// Read only the protobuf wire format; field paths below describe QQ's system notifications.
function fields(input) {
  const bytes = Buffer.from(input);
  if (bytes.length > 1024 * 1024) throw new Error('系统通知超过 1 MiB');
  const result = new Map();
  let offset = 0;
  function varint() {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error('系统通知 varint 截断');
      const byte = bytes[offset++];
      if (i === 9 && byte > 1) throw new Error('系统通知 varint 溢出');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error('系统通知 varint 无效');
  }
  while (offset < bytes.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (number <= 0 || number > 0x1fffffff) throw new Error('系统通知字段号无效');
    if (wire === 0) result.set(number, varint());
    else {
      const size = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (!Number.isSafeInteger(size) || size < 0 || size > bytes.length - offset) throw new Error('系统通知长度或 wire 类型无效');
      result.set(number, bytes.subarray(offset, offset + size));
      offset += size;
    }
  }
  return result;
}
const child = (value, key) => fields(value.get(key) ?? []);
const text = value => Buffer.isBuffer(value) ? value.toString('utf8') : '';

function readSystemEvent(input) {
  if (!Array.isArray(input) && !Buffer.isBuffer(input) && !(input instanceof Uint8Array)) throw new Error('系统通知不是字节数组');
  // The native binding may expose C++ signed char values; Buffer.from preserves their low eight bits.
  if (Array.isArray(input) && input.some(byte => !Number.isInteger(byte) || byte < -128 || byte > 255)) throw new Error('系统通知字节无效（须为 -128..255 的整数）');
  const root = fields(input);
  const head = child(root, 2);
  const type = Number(head.get(1));
  const subType = Number(head.get(2) ?? 0);
  const content = child(root, 3).get(2);
  if (!content) return null;
  if (type === 732 && subType === 16) {
    if (content.length <= 7) return null;
    try {
      const notify = fields(content.subarray(7));
      if (Number(notify.get(13) ?? 0) !== 35) return null;
      const groupId = notify.has(4) ? String(notify.get(4)) : '';
      const inner = child(child(child(notify, 44), 1), 1);
      const seq = child(inner, 2).get(1);
      const react = child(inner, 3);
      const code = text(react.get(1));
      const count = Number(react.get(3) ?? 1n);
      const operatorUid = text(react.get(4));
      const reactType = Number(react.get(5) ?? 0n);
      if (!groupId || !/^[1-9]\d*$/.test(groupId) || !seq || !code || (!/^u_[\w-]+$/.test(operatorUid) && !/^[1-9]\d*$/.test(operatorUid))) return null;
      return {
        event: {
          notice_type: 'group_msg_emoji_like',
          group_id: groupId,
          user_uid: operatorUid,
          msg_seq: String(seq),
          emoji_id: code,
          count: Number.isSafeInteger(count) && count > 0 ? count : 1,
          is_add: reactType === 1,
        },
        time: head.has(6) ? Number(head.get(6)) : Math.floor(Date.now() / 1000),
        key: `system:${createHash('sha256').update(Buffer.from(input)).digest('hex')}`,
      };
    } catch { return null; }
  }
  if (![33, 34, 44].includes(type)) return null;
  const body = fields(content);
  let event;
  if (type === 44) {
    const changes = child(body, 4);
    const enabled = changes.has(2);
    event = { notice_type: 'group_admin', group_id: String(body.get(1)), sub_type: enabled ? 'set' : 'unset',
      user_uid: text(child(changes, enabled ? 2 : 1).get(1)) };
  } else {
    const reason = Number(body.get(4));
    let member = text(body.get(3));
    if (!/^u_[\w-]+$/.test(member) && !/^[1-9]\d*$/.test(member)) member = '';
    const operatorBytes = body.get(5);
    let operator = text(operatorBytes);
    if (operatorBytes?.[0] === 10) operator = text(child(fields(operatorBytes), 1).get(1));
    // "0" is QQ's placeholder for "no operator", not a convertible UID.
    if (!/^u_[\w-]+$/.test(operator) && !/^[1-9]\d*$/.test(operator)) operator = '';
    if (type === 34 && ![3, 129, 130, 131].includes(reason)) return null;
    event = { notice_type: type === 33 ? 'group_increase' : 'group_decrease', group_id: String(body.get(1)),
      user_uid: member, operator_uid: operator,
      sub_type: type === 33 ? (reason === 131 ? 'invite' : 'approve') : reason === 130 ? 'leave' : [3, 129].includes(reason) ? 'kick_me' : 'kick',
    };
    if (!operator && event.sub_type !== 'leave') { event.operator_id = 0; event.openqq_operator_unknown = true; }
    if (reason === 129) event.openqq_reason = 'disband';
  }
  return { event, time: head.has(6) ? Number(head.get(6)) : Math.floor(Date.now() / 1000),
    key: `system:${createHash('sha256').update(Buffer.from(input)).digest('hex')}` };
}

module.exports = { readSystemEvent };
