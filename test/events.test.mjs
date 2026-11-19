import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import nativeEvents from '../native/events.cjs';
import system from '../native/system.cjs';
import sessionModule from '../native/session.cjs';
import { createEventConverter } from '../src/onebot.mjs';

const self = { uin: '123456', uid: 'u_self' };
const base = (overrides = {}) => ({ chatType: 2, msgId: '9007199254740993', msgTime: '1794470400',
  peerUid: '987654', peerUin: '987654', senderUid: 'u_actor', senderUin: '654321',
  elements: [{ elementType: 1, textElement: { content: 'test' } }], ...overrides });
function fixture() {
  const raw = [];
  const events = [];
  const convert = createEventConverter();
  const receive = nativeEvents.createEventReceiver({
    getUixConvertService: () => ({ getUin: async uids => ({ uinInfo: new Map(uids.map(uid => [uid, { u_actor: '654321', u_other: '456789', u_self: self.uin }[uid]])) }) }),
  }, self, event => { raw.push(event); const result = convert(event); if (result) events.push(result); }, () => true);
  return { receive, events, raw };
}

function varint(number) {
  let n = BigInt(number);
  const bytes = [];
  do { const value = Number(n & 127n); n >>= 7n; bytes.push(value | (n ? 128 : 0)); } while (n);
  return Buffer.from(bytes);
}
const uint = (tag, value) => Buffer.concat([varint(tag * 8), varint(value)]);
const bytes = (tag, value) => { const body = Buffer.from(value); return Buffer.concat([varint(tag * 8 + 2), varint(body.length), body]); };
const packet = (type, content) => Buffer.concat([bytes(2, Buffer.concat([uint(1, type), uint(5, 42), uint(6, 1794470400)])), bytes(3, bytes(2, content))]);
const change = (type, reason, operator = 'u_other') => packet(type, Buffer.concat([
  uint(1, 987654), bytes(3, 'u_actor'), uint(4, reason), bytes(5, operator),
]));

test('system pushes decode member joins, leaves, kicks, nested operators and admin changes', async () => {
  for (const [type, reason, expected] of [[33, 131, 'invite'], [33, 130, 'approve'], [34, 130, 'leave'], [34, 131, 'kick'], [34, 3, 'kick_me']]) {
    const f = fixture();
    await f.receive('msg', 'onRecvSysMsg', [change(type, reason, type === 34 && reason === 3 ? bytes(1, bytes(1, 'u_other')) : 'u_other')]);
    const event = f.events[0];
    assert.equal(event.sub_type, expected);
    assert.equal(event.group_id, 987654);
    assert.equal(event.user_id, 654321);
    assert.equal(event.operator_id, 456789);
    await f.receive('msg', 'onRecvSysMsg', [change(type, reason, type === 34 && reason === 3 ? bytes(1, bytes(1, 'u_other')) : 'u_other')]);
    assert.equal(f.events.length, 1);
  }
  for (const [field, subtype] of [[1, 'unset'], [2, 'set']]) {
    const f = fixture();
    await f.receive('msg', 'onRecvSysMsg', [packet(44, Buffer.concat([uint(1, 987654), bytes(4, bytes(field, bytes(1, 'u_actor')))]))]);
    assert.equal(f.events[0].notice_type, 'group_admin');
    assert.equal(f.events[0].sub_type, subtype);
  }
});

test('system pushes fall back to group UID lookup and keep the notice when only the operator is unknown', async () => {
  const raw = [];
  const receive = nativeEvents.createEventReceiver({
    getUixConvertService: () => ({ getUin: async () => ({ uinInfo: new Map() }) }),
    getProfileService: () => ({ getUinByUid: async () => new Map() }),
    getGroupService: () => ({ getUinByUids: async uids => ({ uins: new Map(uids.filter(uid => uid === 'u_actor').map(uid => [uid, '654321'])) }) }),
  }, self, event => raw.push(event), () => true);
  await receive('msg', 'onRecvSysMsg', [change(34, 131, 'u_ghost')]);
  const notice = raw.find(event => event.type === 'notice');
  assert.equal(notice.event.user_id, '654321');
  assert.equal(notice.event.operator_id, 0);
  assert.equal(notice.event.openqq_operator_unknown, true);
  assert.match(raw.find(event => event.type === 'event_error').error, /u_ghost/);
  raw.length = 0;
  await receive('msg', 'onRecvSysMsg', [change(33, 130, '0')]);
  assert.equal(raw.filter(event => event.type === 'event_error').length, 0);
  assert.equal(raw[0].event.operator_id, 0);
});

test('membership notices retry members via member list pushes and degrade instead of being dropped', async () => {
  const raw = [];
  const events = [];
  const convert = createEventConverter();
  const receive = nativeEvents.createEventReceiver({
    getUixConvertService: () => ({ getUin: async () => ({ uinInfo: new Map() }) }),
    getProfileService: () => ({ getUinByUid: async () => new Map() }),
    getGroupService: () => ({ getUinByUids: async () => ({ uins: new Map() }) }),
  }, self, event => { raw.push(event); const result = convert(event); if (result) events.push(result); }, () => true, { memberRetryMs: 20 });

  // Every lookup misses at first; the member list QQ pushes meanwhile lets the delayed retry resolve the kick.
  const pending = receive('msg', 'onRecvSysMsg', [change(34, 131, 'u_other')]);
  await receive('group', 'onMemberListChange', [{ sceneId: 'scene', ids: ['u_actor'], infos: new Map([['u_actor', { uid: 'u_actor', uin: '654321' }]]), finish: true }]);
  await pending;
  assert.deepEqual([events[0].notice_type, events[0].sub_type, events[0].user_id, events[0].openqq_user_unknown], ['group_decrease', 'kick', 654321, undefined]);
  assert.equal(raw.filter(event => event.type === 'event_error' && /u_actor/.test(event.error)).length, 0);

  // Still unknown after the retry: the leave is reported with user_id 0, flagged, plus one diagnostic.
  await receive('msg', 'onRecvSysMsg', [packet(34, Buffer.concat([uint(1, 987654), bytes(3, 'u_stranger'), uint(4, 130), bytes(5, '0')]))]);
  const leave = events.at(-1);
  assert.deepEqual([leave.sub_type, leave.user_id, leave.operator_id, leave.openqq_user_unknown, leave.openqq_operator_unknown], ['leave', 0, 0, true, true]);
  assert.equal(raw.filter(event => event.type === 'event_error' && /u_stranger.*已按未知处理/.test(event.error)).length, 1);

  // Unexpected member list shapes are reported once like other unadapted callbacks.
  await receive('group', 'onMemberListChange', [{ infos: [] }]);
  assert.ok(raw.some(event => event.type === 'native_callback' && event.event === 'onMemberListChange'));
});

test('the converter only accepts user_id 0 on membership notices explicitly flagged as unknown', () => {
  const convert = createEventConverter();
  const raw = (event, key) => ({ type: 'notice', self, key, event: { group_id: '987654', operator_id: 0, ...event } });
  assert.equal(convert(raw({ notice_type: 'group_increase', sub_type: 'approve', user_id: 0, openqq_user_unknown: true }, 'a')).user_id, 0);
  assert.throws(() => convert(raw({ notice_type: 'group_increase', sub_type: 'approve', user_id: 0 }, 'b')), /user_id/);
  assert.throws(() => convert(raw({ notice_type: 'friend_add', user_id: 0, openqq_user_unknown: true }, 'c')), /user_id/);
});

test('unresolvable optional identities degrade instead of dropping messages, recalls and bans', async () => {
  const raw = [];
  let lookups = 0;
  const known = { u_actor: '654321' };
  const receive = nativeEvents.createEventReceiver({
    getUixConvertService: () => ({ getUin: async uids => { lookups++; await setImmediate(); return { uinInfo: new Map(uids.filter(uid => known[uid]).map(uid => [uid, known[uid]])) }; } }),
  }, self, event => raw.push(event), () => true);
  const convert = createEventConverter();
  // A message @-ing a stranger is still delivered; the @ stays a native element.
  await receive('msg', 'onRecvMsg', [[base({ elements: [
    { elementType: 1, textElement: { content: 'hi ' } },
    { elementType: 1, textElement: { content: '@ghost', atType: 2, atUid: '0', atNtUid: 'u_ghost' } },
  ] })]]);
  const delivered = raw.find(event => event.type === 'message');
  assert.ok(delivered);
  assert.deepEqual(convert(delivered).message.map(segment => segment.type), ['text', 'openqq_element']);
  assert.match(raw.find(event => event.type === 'event_error').error, /u_ghost.*继续上报/);
  // A friend recall never needs the operator lookup.
  raw.length = 0;
  await receive('msg', 'onRecvMsg', [[base({ chatType: 1, peerUid: 'u_actor', peerUin: '654321', msgId: '2',
    elements: [{ elementType: 8, grayTipElement: { revokeElement: { operatorUid: 'u_ghost' } } }] })]]);
  assert.equal(raw.filter(event => event.type === 'event_error').length, 0);
  assert.equal(convert(raw[0]).notice_type, 'friend_recall');
  // Group recall and ban keep the notice with operator_id 0.
  raw.length = 0;
  await receive('msg', 'onRecvMsg', [[
    base({ msgId: '3', elements: [{ elementType: 8, grayTipElement: { revokeElement: { operatorUid: 'u_ghost' } } }] }),
    base({ msgId: '4', senderUin: '0', elements: [{ elementType: 8, grayTipElement: { groupElement: { type: 8,
      shutUp: { member: { uid: 'u_actor' }, admin: { uid: 'u_ghost' }, duration: '60' } } } }] }),
  ]]);
  const notices = raw.filter(event => event.type === 'notice').map(event => convert(event));
  assert.deepEqual(notices.map(event => [event.notice_type, event.operator_id, event.openqq_operator_unknown]),
    [['group_recall', 0, true], ['group_ban', 0, true]]);
  // Non-UID strings fail fast without a native call, and concurrent lookups of one UID share a call.
  const before = lookups;
  await receive('msg', 'onRecvMsg', [[base({ msgId: '5', senderUin: undefined, senderUid: '0' })]]);
  assert.equal(lookups, before);
  assert.match(raw.at(-1).error, /格式无效/);
  known.u_new = '111111';
  await receive('msg', 'onRecvMsg', [[1, 2, 3].map(n => base({ msgId: String(10 + n), senderUin: undefined, senderUid: 'u_new' }))]);
  assert.equal(lookups, before + 1);
  assert.equal(raw.filter(event => event.type === 'message' && event.message.senderUin === '111111').length, 3);
});

test('empty sync placeholder messages are skipped with one debug note per msgType', async () => {
  const f = fixture();
  await f.receive('msg', 'onRecvMsg', [[1, 2, 3].map(n => base({ msgId: String(n), msgType: 5, elements: [] }))]);
  assert.equal(f.events.length, 0);
  assert.equal(f.raw.length, 1);
  assert.equal(f.raw[0].type, 'native_callback');
  assert.match(f.raw[0].event, /msgType=5/);
});

test('wire decoder rejects truncation, bad lengths, overlong integers, invalid bytes and field zero', () => {
  for (const invalid of [[128], [10, 255], [0, 0], [15], [8, ...Array(11).fill(255)], [-1], [256], [1.5]]) {
    assert.throws(() => system.readSystemEvent(invalid), /系统通知/);
  }
  assert.equal(system.readSystemEvent(packet(999, [])), null);
  assert.deepEqual(system.readSystemEvent(Array.from(change(34, 130), value => value > 127 ? value - 256 : value)), system.readSystemEvent(change(34, 130)));
  assert.throws(() => system.readSystemEvent([-129]), /字节无效/);
});

test('group/friend recalls correlate with received IDs, deduplicate updates and allow recall-before-message', async () => {
  const recallTime = Math.floor(Date.now() / 1000);
  for (const chatType of [1, 2]) {
    const f = fixture();
    const original = base({ chatType });
    await f.receive('msg', 'onRecvMsg', [[original]]);
    const update = { ...original, recallTime: String(recallTime * 1000), elements: [{ elementType: 8, grayTipElement: { revokeElement: { operatorUid: 'u_other' } } }] };
    await f.receive('msg', 'onMsgInfoListUpdate', [[update]]);
    await f.receive('msg', 'onMsgInfoListUpdate', [[update]]);
    assert.equal(f.events.length, 2);
    assert.equal(f.events[1].message_id, f.events[0].message_id);
    assert.equal(f.events[1].time, recallTime);
    assert.equal(f.events[1].notice_type, chatType === 2 ? 'group_recall' : 'friend_recall');
    if (chatType === 2) assert.equal(f.events[1].operator_id, 456789);
  }
  const f = fixture();
  const recalled = base({ elements: [{ elementType: 8, grayTipElement: { revokeElement: { operatorUid: 'u_actor' } } }] });
  await f.receive('msg', 'onRecvMsg', [[recalled]]);
  await f.receive('msg', 'onRecvMsg', [[base()]]);
  assert.equal(f.events[0].message_id, f.events[1].message_id);
});

test('history recall updates are ignored and a failed request does not discard the rest of a batch', async () => {
  const f = fixture();
  await f.receive('msg', 'onMsgInfoListUpdate', [[base({ recallTime: '1600000000', elements: [{ elementType: 8, grayTipElement: { revokeElement: { operatorUid: 'u_actor' } } }] })]]);
  assert.equal(f.events.length, 0);
  await f.receive('buddy', 'onBuddyReqChange', [{ buddyReqs: [
    { friendUid: '', isUnread: true, isDecide: false, reqTime: '1794470400' },
    { friendUid: 'u_actor', isUnread: true, isDecide: false, reqTime: '1794470400' },
  ] }]);
  assert.equal(f.raw.some(event => event.type === 'event_error'), true);
  assert.equal(f.events[0].request_type, 'friend');
});

test('ban, all-member mute, unmute and group upload retain their OneBot fields', async () => {
  const f = fixture();
  for (const [index, member, duration] of [[0, 'u_actor', '60'], [1, '', '600'], [2, '', '0']]) {
    await f.receive('msg', 'onRecvMsg', [[base({ msgId: String(10 + index), senderUin: '0', elements: [{ elementType: 8, grayTipElement: {
      groupElement: { type: 8, shutUp: { member: { uid: member }, admin: { uid: 'u_other' }, duration } },
    } }] })]]);
  }
  assert.deepEqual(f.events.map(event => [event.user_id, event.sub_type, event.duration]), [[654321, 'ban', 60], [0, 'ban', 600], [0, 'lift_ban', 0]]);
  await f.receive('msg', 'onRecvOnlineFileMsg', [[base({ msgId: '20', elements: [{ elementType: 3, fileElement: {
    fileName: 'test.txt', fileUuid: 'file-uuid', fileSize: '42', fileBizId: 102,
  } }] })]]);
  assert.equal(f.events.at(-2).message[0].type, 'file');
  assert.deepEqual(f.events.at(-1).file, { id: 'file-uuid', name: 'test.txt', size: 42, busid: 102 });
});

test('friend and group requests filter handled/outgoing entries and retain flags for later actions', async () => {
  const f = fixture();
  const req = { friendUid: 'u_actor', reqTime: '1794470400', reqType: 1, extWords: 'hi', isUnread: true, isDecide: false };
  await f.receive('buddy', 'onBuddyReqChange', [{ buddyReqs: [req, { ...req, isInitiator: true }, { ...req, isDecide: true }, { ...req, isUnread: false }] }]);
  assert.equal(f.events.length, 1);
  // The flag carries what set_friend_add_request needs: the requester's UID and the request time.
  assert.equal(f.events[0].flag, 'f:u_actor:1794470400');
  assert.equal(f.events[0].request_type, 'friend');
  for (const type of [1, 5, 7]) {
    const notify = { type, status: 1, seq: String(1794470400000000n + BigInt(type)), group: { groupCode: '987654' },
      user1: { uid: 'u_actor' }, user2: { uid: 'u_other' }, postscript: 'join' };
    await f.receive('group', 'onGroupNotifiesUpdated', [false, [notify, { ...notify, status: 2 }]]);
  }
  const requests = f.events.filter(event => event.post_type === 'request');
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.slice(1).map(event => [event.sub_type, event.user_id, event.time]), [['invite', 456789, 1794470400], ['add', 654321, 1794470400], ['add', 654321, 1794470400]]);
  const v2 = { type: 7, status: 1, seq: '1794470400000099', group: { groupCode: '987654' }, user1: { uid: 'u_actor' } };
  await f.receive('group', 'onGroupNotifiesUpdatedV2', [false, 'cursor', [v2], []]);
  await f.receive('group', 'onGroupNotifiesUpdated', [false, [v2]]);
  assert.equal(f.events.filter(event => event.post_type === 'request').length, 5);
  // group code, notification type and sequence: everything set_group_add_request needs.
  assert.equal(f.events.at(-1).flag, `g:987654:7:${v2.seq}`);
});

test('friend/member snapshots establish a baseline and emit real changes without startup floods', async () => {
  const f = fixture();
  const list = users => [{ buddyList: users.map(([uid, uin]) => ({ uid, uin })) }];
  await f.receive('buddy', 'onBuddyListChange', [list([['u_actor', '654321']])]);
  assert.equal(f.events.length, 0);
  await f.receive('msg', 'onNtMsgSyncEnd', []);
  await f.receive('buddy', 'onBuddyListChange', [list([['u_actor', '654321'], ['u_other', '456789']])]);
  await f.receive('buddy', 'onBuddyListChange', [list([['u_other', '456789']])]);
  assert.deepEqual(f.events.map(event => event.notice_type), ['friend_add', 'friend_delete']);
  await f.receive('group', 'onMemberInfoChange', ['987654', 0, new Map([['u_actor', { uin: '654321', cardName: 'old', memberSpecialTitle: 'old title' }]])]);
  await f.receive('group', 'onMemberInfoChange', ['987654', 0, new Map([['u_actor', { uin: '654321', cardName: 'new', memberSpecialTitle: 'new title' }]])]);
  assert.equal(f.events.at(-2).card_old, 'old');
  assert.equal(f.events.at(-2).card_new, 'new');
  assert.equal(f.events.at(-1).title, 'new title');
  await assert.rejects(f.receive('buddy', 'onBuddyListChange', [[{}]]), /结构未适配/);
});

test('mixed media, mentions and 64-bit reply IDs are preserved, including unrecognized elements', () => {
  const convert = createEventConverter();
  const original = convert({ type: 'message', self, message: base() });
  const result = convert({ type: 'message', self, message: base({ msgId: '9007199254740994', elements: [
    { elementType: 1, textElement: { content: '[CQ:face,id=1]&' } },
    { elementType: 1, textElement: { content: '@all', atType: 1 } },
    { elementType: 1, textElement: { content: '@other', atType: 2, atUid: '456789' } },
    { elementType: 6, faceElement: { faceIndex: 0 } },
    { elementType: 2, picElement: { fileName: 'image.png', originImageUrl: 'https://example.com/a,b.png', fileSize: 42 } },
    { elementType: 4, pttElement: { fileName: 'voice.silk' } },
    { elementType: 5, videoElement: { fileName: 'video.mp4' } },
    { elementType: 7, replyElement: { sourceMsgIdInRecords: '9007199254740993' } },
    { elementType: 10, arkElement: { bytesData: '{"a":[1,2]}' } },
    { elementType: 13, structLongMsgElement: { xmlContent: '<msg />' } },
    { elementType: 999, special: { content: 'still received' } },
  ] }) });
  assert.deepEqual(result.message.map(segment => segment.type), ['text', 'at', 'at', 'face', 'image', 'record', 'video', 'reply', 'json', 'xml', 'openqq_element']);
  assert.equal(result.message[7].data.id, String(original.message_id));
  assert.match(result.raw_message, /&#91;CQ:face,id=1&#93;&amp;/);
  assert.match(result.raw_message, /a&#44;b.png/);
  assert.equal(result.message.at(-1).data.element.special.content, 'still received');
});

test('unknown callback diagnostics expose names and shapes once, never opaque buffer or secret values', async () => {
  const f = fixture();
  await f.receive('msg', 'onUnknown', [{ token: 'do-not-export' }, Buffer.from('private bytes')]);
  await f.receive('msg', 'onUnknown', [{ token: 'do-not-export' }]);
  assert.equal(f.events.length, 0);
  assert.equal(f.raw.length, 1);
  assert.equal(f.raw[0].type, 'native_callback');
  assert.equal(JSON.stringify(f.raw).includes('do-not-export'), false);
  assert.equal(JSON.stringify(f.raw).includes('private bytes'), false);
});

test('startup empty and incremental buddy snapshots do not create false add/delete events', async () => {
  const f = fixture();
  const first = [{ buddyList: [{ uid: 'u_actor', uin: '654321' }] }];
  const complete = [{ buddyList: [{ uid: 'u_actor', uin: '654321' }, { uid: 'u_other', uin: '456789' }] }];
  await f.receive('msg', 'onNtMsgSyncStart', []);
  await f.receive('buddy', 'onBuddyListChange', [[]]);
  await f.receive('buddy', 'onBuddyListChange', [first]);
  await f.receive('buddy', 'onBuddyListChange', [complete]);
  await f.receive('msg', 'onNtMsgSyncEnd', []);
  assert.equal(f.events.length, 0);
  await f.receive('buddy', 'onBuddyListChange', [first]);
  assert.equal(f.events[0].notice_type, 'friend_delete');
  assert.equal(f.events[0].user_id, 456789);
});

test('all registered service listeners are removed on reinit and disposal', async t => {
  const registrations = [];
  const removed = [];
  const service = (source, add, remove) => ({ [add](listener) { registrations.push({ source, listener }); return source; }, [remove](id) { removed.push(id); } });
  const msg = service('msg', 'addKernelMsgListener', 'removeKernelMsgListener');
  const buddy = service('buddy', 'addKernelBuddyListener', 'removeKernelBuddyListener');
  const group = service('group', 'addKernelGroupListener', 'removeKernelGroupListener');
  const events = [];
  const session = { init(_config, _a, _b, callback) { callback.onSessionInitComplete({ result: 0 }); }, getMsgService: () => msg, getBuddyService: () => buddy, getGroupService: () => group };
  const hook = sessionModule.createSessionHook(event => events.push(event));
  t.after(() => hook.dispose());
  const wrapper = hook.hookWrapper({ NodeIQQNTWrapperSession: { get: () => session } });
  const init = () => wrapper.NodeIQQNTWrapperSession.get().init({ selfUin: self.uin, selfUid: self.uid }, {}, {}, {});
  init();
  await setImmediate();
  assert.deepEqual(events.at(-1).services, ['msg', 'buddy', 'group']);
  init();
  await setImmediate();
  assert.deepEqual(removed, ['msg', 'buddy', 'group']);
  hook.dispose();
  assert.equal(removed.length, 6);
  const count = events.length;
  registrations[0].listener.onRecvMsg([base()]);
  await setImmediate();
  assert.equal(events.length, count);
});

test('an optional listener registration failure leaves other services receiving and cleaning up', async t => {
  const events = [];
  const removed = [];
  let listener;
  const session = {
    init(_config, _a, _b, callback) { callback.onSessionInitComplete({ result: 0 }); },
    getMsgService: () => ({ addKernelMsgListener(value) { listener = value; return 1; }, removeKernelMsgListener(id) { removed.push(id); } }),
    getBuddyService() { throw new Error('unsupported buddy service'); },
  };
  const hook = sessionModule.createSessionHook(event => events.push(event));
  t.after(() => hook.dispose());
  const facade = hook.hookWrapper({ NodeIQQNTWrapperSession: { get: () => session } });
  facade.NodeIQQNTWrapperSession.get().init({ selfUin: self.uin, selfUid: self.uid }, {}, {}, {});
  await setImmediate();
  assert.deepEqual(events.at(-1).services, ['msg']);
  assert.equal(events.some(event => event.type === 'event_error' && event.stage === 'buddy/listener'), true);
  listener.onRecvMsg([base()]);
  await setImmediate();
  assert.equal(events.at(-1).type, 'message');
  hook.dispose();
  assert.deepEqual(removed, [1]);
});

test('received images trigger downloadRichMedia when missing on disk, preserve sourcePath/thumbPath, and expose mediaUrl or path fallback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openqq-recv-img-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const oriPath = join(dir, 'downloaded.png');
  const thumbPath = join(dir, 'thumb.png');
  await writeFile(thumbPath, Buffer.from('thumb-bytes'));

  const downloads = [];
  const raw = [];
  const events = [];
  const convert = createEventConverter({ mediaUrl: (p, f) => `http://127.0.0.1:3001/openqq/media/${encodeURIComponent(f)}?p=${encodeURIComponent(p)}` });
  let receive;
  receive = nativeEvents.createEventReceiver({
    getUixConvertService: () => ({ getUin: async uids => ({ uinInfo: new Map(uids.map(uid => [uid, '654321'])) }) }),
    getMsgService: () => ({
      async downloadRichMedia(req) {
        downloads.push(req);
        if (req.msgId === '101') {
          await writeFile(oriPath, Buffer.from('real-png-bytes'));
          // Intermediate thumbnail notification must not prematurely resolve original download.
          queueMicrotask(async () => {
            await receive('msg', 'onRichMediaDownloadComplete', [{ msgId: '101', msgElementId: '201', thumbSize: 198, filePath: thumbPath, fileErrCode: '0', trasferStatus: 2 }]);
            await receive('msg', 'onRichMediaDownloadComplete', [{ msgId: '101', msgElementId: '201', thumbSize: 0, filePath: oriPath, fileErrCode: '0', trasferStatus: 2 }]);
          });
          return { result: 0 };
        }
        return { result: 5, errMsg: 'denied' };
      },
    }),
  }, self, event => { raw.push(event); const converted = convert(event); if (converted) events.push(converted); }, () => true, { mediaTimeoutMs: 100 });

  // Case 1: missing sourcePath -> downloadRichMedia downloads oriPath, segments carry path + url.
  await receive('msg', 'onRecvMsg', [[base({
    msgId: '101',
    elements: [{ elementType: 2, elementId: '201', picElement: { fileName: 'pic.png', md5HexStr: 'abc', fileUuid: 'uuid-1', fileSize: '14', sourcePath: '' } }],
  })]]);
  assert.equal(downloads.length, 1);
  assert.deepEqual([downloads[0].downloadType, downloads[0].thumbSize, downloads[0].elementId], [1, 0, '201']);
  const imgData = events[0].message[0].data;
  assert.equal(imgData.path, oriPath);
  assert.match(imgData.url, /^http:\/\/127\.0\.0\.1:3001\/openqq\/media\/pic\.png/);
  assert.match(events[0].raw_message, /url=http:\/\/127\.0\.0\.1:3001/);

  // Case 2: downloadRichMedia fails -> falls back to thumbPath and reports non-fatal event_error without dropping message.
  await receive('msg', 'onRecvMsg', [[base({
    msgId: '102',
    elements: [{ elementType: 2, elementId: '202', picElement: { fileName: 'fallback.png', fileUuid: 'uuid-2', thumbPath: new Map([[198, thumbPath]]) } }],
  })]]);
  assert.equal(events[1].message[0].data.path, thumbPath);
  assert.equal(raw.some(e => e.type === 'event_error' && e.stage === 'msg/image'), true);

  // Case 3: pure reverse WS (mediaUrl returns null) falls back data.file to local path for AstrBot/local readers.
  const reverseConvert = createEventConverter({ mediaUrl: () => null });
  const revEvent = reverseConvert(raw.find(e => e.type === 'message' && e.message.msgId === '101'));
  assert.equal(revEvent.message[0].data.file, oriPath);
  assert.equal(revEvent.message[0].data.path, oriPath);
  assert.equal(revEvent.message[0].data.url, undefined);

  // Case 4: resolveMedia resolves cached image by fileName or fileUuid for get_image.
  const resolved = await receive.resolveMedia('uuid-1', 'image');
  assert.deepEqual([resolved.file, resolved.file_name, resolved.file_size], [oriPath, 'pic.png', 14]);
});

test('a download receipt is a success when it names the finished file, as QQ 9.9.37 reports it with trasferStatus 4; only an error code or message is a failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openqq-recv-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = { done: join(dir, 'done.png'), later: join(dir, 'later.png'), stuck: join(dir, 'stuck.png') };
  await writeFile(files.done, Buffer.from('png-bytes'));
  const raw = [];
  const events = [];
  const convert = createEventConverter({ mediaUrl: () => null });
  let receive;
  const notify = fields => receive('msg', 'onRichMediaDownloadComplete', [{ thumbSize: 0, fileDownType: 1, fileErrMsg: '', totalSize: 0, ...fields }]);
  receive = nativeEvents.createEventReceiver({
    getUixConvertService: () => ({ getUin: async uids => ({ uinInfo: new Map(uids.map(uid => [uid, '654321'])) }) }),
    getMsgService: () => ({
      async downloadRichMedia(request) {
        const element = request.elementId;
        // 1: the receipt exactly as the real client sends it (status 4, error code 0, the file's path).
        if (element === '501') queueMicrotask(() => notify({ msgId: '301', msgElementId: '501', trasferStatus: 4, fileErrCode: 0, filePath: files.done }));
        // 2: a progress receipt that names a file that is not there yet, then the finished one.
        if (element === '502') queueMicrotask(async () => {
          await notify({ msgId: '302', msgElementId: '502', trasferStatus: 1, fileErrCode: '0', filePath: files.later });
          await writeFile(files.later, Buffer.from('later-bytes'));
          await notify({ msgId: '302', msgElementId: '502', trasferStatus: 4, fileErrCode: '0', filePath: files.later });
        });
        // 3: QQ reports an error.
        if (element === '503') queueMicrotask(() => notify({ msgId: '303', msgElementId: '503', trasferStatus: 3, fileErrCode: '9004', fileErrMsg: 'no space left' }));
        // 4: an error message without a code.
        if (element === '504') queueMicrotask(() => notify({ msgId: '304', msgElementId: '504', trasferStatus: 4, fileErrMsg: 'denied' }));
        // 5: only progress, never finishing: the timeout names the last receipt.
        if (element === '505') queueMicrotask(() => notify({ msgId: '305', msgElementId: '505', trasferStatus: 1, fileErrCode: '0', filePath: files.stuck }));
        return { result: 0 };
      },
    }),
  }, self, event => { raw.push(event); const converted = convert(event); if (converted) events.push(converted); }, () => true, { mediaTimeoutMs: 120 });
  const image = (msgId, elementId) => base({ msgId, elements: [{ elementType: 2, elementId, picElement: { fileName: msgId + '.png', md5HexStr: msgId, fileUuid: 'uuid-' + msgId, sourcePath: '' } }] });
  const errors = () => raw.filter(item => item.type === 'event_error' && item.stage === 'msg/image').map(item => item.error);

  await receive('msg', 'onRecvMsg', [[image('301', '501')]]);
  assert.equal(events.at(-1).message[0].data.path, files.done, 'status 4 without an error is a finished download');
  assert.deepEqual(errors(), []);

  await receive('msg', 'onRecvMsg', [[image('302', '502')]]);
  assert.equal(events.at(-1).message[0].data.path, files.later, 'a progress receipt does not end the wait');
  assert.deepEqual(errors(), []);

  await receive('msg', 'onRecvMsg', [[image('303', '503')]]);
  assert.match(errors().at(-1), /no space left（trasferStatus=3, fileErrCode=9004, fileErrMsg=no space left/);
  assert.equal(events.at(-1).message[0].data.path, undefined, 'the message is still delivered, without a path');

  await receive('msg', 'onRecvMsg', [[image('304', '504')]]);
  assert.match(errors().at(-1), /denied（/);

  await receive('msg', 'onRecvMsg', [[image('305', '505')]]);
  assert.match(errors().at(-1), /图片下载超时（最后一次回执：trasferStatus=1, fileErrCode=0, .*有 filePath）/);
  assert.equal(errors().length, 3);
  assert.equal(raw.filter(item => item.type === 'native_callback' && item.event === 'richmedia_receipt').length, 1, 'the receipt\'s field names are reported once');
});
