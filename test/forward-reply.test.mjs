import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import nativeEvents from '../native/events.cjs';
import nativeActions from '../native/actions.cjs';
import { createEventConverter } from '../src/onebot.mjs';
import { dispatchAction } from '../src/actions.mjs';
import { segmentPreview } from '../src/console.mjs';
import { segmentText } from '../ui/format.mjs';

const self = { uin: '123456', uid: 'u_self' };
const text = content => ({ elementType: 1, textElement: { content } });
const forwardElement = () => ({ elementType: 16, multiForwardMsgElement: { resId: 'res', xmlContent: '<msg/>' } });
const group = (overrides = {}) => ({ chatType: 2, msgId: '7001', msgSeq: '55', clientSeq: '9', msgTime: '1794470400',
  peerUid: '987654', peerUin: '987654', senderUid: 'u_actor', senderUin: '654321', sendNickName: 'actor',
  elements: [text('hi')], ...overrides });
const inner = (msgId, elements, senderUin = '456789') => ({ msgId, msgTime: '1794470300', senderUid: senderUin ? 'u_other' : 'u_ghost', senderUin,
  sendNickName: 'other', elements });

function harness(sessionOverrides = {}) {
  const raw = [];
  const calls = [];
  const sends = [];
  // Messages QQ "has in its local records" for getMsgsByMsgId, and the lookups made against it.
  const store = new Map();
  const lookups = [];
  const seqLookups = [];
  let rejectLookups = false;
  let failSeq = false;
  const session = {
    getUixConvertService: () => ({ getUin: async () => ({ uinInfo: new Map() }) }),
    getMsgService: () => ({
      async getMultiMsg(peer, root, parent) {
        calls.push([peer.chatType, peer.peerUid, root, parent]);
        if (parent === '7001' || parent === '6400') return { result: 0, msgList: [inner('8001', [text('first')]), inner('8002', [forwardElement()])] };
        if (parent === '8002') return { result: 0, msgList: [inner('9001', [text('nested')], '')] };
        return { result: 1, errMsg: 'gone' };
      },
      async getMsgsBySeqAndCount(peer, seq, count, desc, reverse) {
        seqLookups.push([peer.chatType, peer.peerUid, peer.guildId, seq, count, desc, reverse]);
        if (failSeq) throw new Error('native assertion');
        return { result: 0, msgList: [...store.values()].filter(item => String(item.msgSeq) === seq) };
      },
      async getMsgsByMsgId(peer, ids) {
        lookups.push([peer.chatType, peer.peerUid, peer.guildId, ids]);
        if (rejectLookups) return { result: 7, errMsg: 'not allowed', msgList: [] };
        return { result: 0, msgList: ids.map(item => store.get(item)).filter(Boolean) };
      },
      generateMsgUniqueId: () => String(9007199254740993n + BigInt(sends.length)),
      async sendMsg(id, peer, elements) { sends.push({ peer, elements }); return { result: 0 }; },
    }),
    getMSFService: () => ({ getServerTime: () => '1794470400' }),
    ...sessionOverrides,
  };
  const receive = nativeEvents.createEventReceiver(session, self, event => raw.push(event), () => true);
  const handler = nativeActions.createActionHandler(session, self, () => true,
    { expandForward: receive.expandForward, fetchMessage: receive.fetchMessage, lookupRecent: receive.lookupRecent, record: receive.record });
  const convert = createEventConverter();
  const channel = { request: request => handler.execute(request).then(data => ({ status: 'ok', retcode: 0, data }), error => ({ status: 'failed', retcode: error.retcode ?? 1500, data: null, message: error.message })) };
  const ack = () => handler.observe('onMsgInfoListUpdate', [[{ ...sends.at(-1).peer, msgId: '7999', msgSeq: '56', senderUin: self.uin, sendStatus: 2 }]]);
  return { raw, calls, sends, store, lookups, seqLookups, failSeq: value => { failSeq = value; }, rejectLookups: value => { rejectLookups = value; }, receive, handler, convert, channel, ack };
}

test('merged forwards expand into OneBot nodes, including nested forwards keyed by their root message', async () => {
  const h = harness();
  await h.receive('msg', 'onRecvMsg', [[group({ elements: [forwardElement()] })]]);
  assert.deepEqual(h.calls, [[2, '987654', '7001', '7001'], [2, '987654', '7001', '8002']]);
  const event = h.convert(h.raw.find(item => item.type === 'message'));
  const [segment] = event.message;
  assert.equal(segment.type, 'forward');
  assert.equal(event.raw_message, `[CQ:forward,id=${segment.data.id}]`);
  assert.deepEqual(segment.data.content.map(node => [node.user_id, node.sender.nickname, node.message[0].type]),
    [[456789, 'other', 'text'], [456789, 'other', 'forward']]);
  const nested = segment.data.content[1].message[0].data.content;
  assert.equal(nested[0].message[0].data.text, 'nested');
  assert.equal(nested[0].user_id, 0, 'an unresolved forwarded author keeps its nickname with user_id 0');
  assert.match(segmentPreview(segment), /合并转发 #\d+ · 2 条/);
  assert.equal(segmentText(event.message), '[合并转发 2 条]');

  const fetched = await dispatchAction(h.channel, h.convert, { action: 'get_forward_msg', params: { id: segment.data.id }, echo: 1 });
  assert.equal(fetched.status, 'ok');
  assert.equal(fetched.echo, 1);
  assert.deepEqual(fetched.data.messages.map(node => node.content[0].type), ['text', 'forward']);
  // The id of the carrying message is accepted too, as NapCat does.
  const byMessage = await dispatchAction(h.channel, h.convert, { action: 'get_forward_msg', params: { message_id: event.message_id } });
  assert.equal(byMessage.data.messages.length, 2);
  const unknown = await dispatchAction(h.channel, h.convert, { action: 'get_forward_msg', params: { id: 99999 } });
  assert.equal(unknown.retcode, 1404);
});

test('a failed forward fetch still delivers the message with a forward id and a diagnostic', async () => {
  const h = harness();
  await h.receive('msg', 'onRecvMsg', [[group({ msgId: '7002', elements: [text('see: '), forwardElement()] })]]);
  const event = h.convert(h.raw.find(item => item.type === 'message'));
  assert.deepEqual(event.message.map(segment => segment.type), ['text', 'forward']);
  assert.equal(event.message[1].data.content, undefined);
  assert.match(h.raw.find(item => item.type === 'event_error').error, /gone.*get_forward_msg/);
});

test('reply segments quote a received message in the same chat and are refused otherwise', async () => {
  const h = harness();
  await h.receive('msg', 'onRecvMsg', [[group()]]);
  const event = h.convert(h.raw.find(item => item.type === 'message'));
  const pending = dispatchAction(h.channel, h.convert, { action: 'send_group_msg', params: { group_id: 987654,
    message: [{ type: 'reply', data: { id: String(event.message_id) } }, { type: 'text', data: { text: 'pong' } }] } });
  await setImmediate();
  const [quote, body] = h.sends[0].elements;
  assert.deepEqual(quote, { elementType: 7, elementId: '', replyElement: { replayMsgSeq: '55', replayMsgId: '7001',
    senderUin: '654321', senderUinStr: '654321', replyMsgClientSeq: '9' } });
  assert.equal(body.textElement.content, 'pong');
  h.ack();
  const sent = await pending;
  assert.equal(sent.status, 'ok');
  // Our own sent message can be quoted afterwards without a native lookup.
  const again = dispatchAction(h.channel, h.convert, { action: 'send_group_msg', params: { group_id: 987654,
    message: [{ type: 'reply', data: { id: sent.data.message_id } }, { type: 'text', data: { text: 'again' } }] } });
  await setImmediate();
  assert.equal(h.sends[1].elements[0].replyElement.replayMsgSeq, '56');
  h.ack();
  assert.equal((await again).status, 'ok');

  const count = h.sends.length;
  const missing = await dispatchAction(h.channel, h.convert, { action: 'send_group_msg', params: { group_id: 987654,
    message: [{ type: 'reply', data: { id: 424242 } }, { type: 'text', data: { text: 'x' } }] } });
  assert.equal(missing.retcode, 1404);
  const elsewhere = await dispatchAction(h.channel, h.convert, { action: 'send_group_msg', params: { group_id: 111111,
    message: [{ type: 'reply', data: { id: event.message_id } }, { type: 'text', data: { text: 'x' } }] } });
  assert.match(elsewhere.message, /同一会话/);
  assert.equal(h.sends.length, count, 'refused replies never reach sendMsg');
});

test('ark app messages convert to json segments with a readable preview and can be sent on their own', async () => {
  const h = harness();
  const card = JSON.stringify({ app: 'com.tencent.miniapp', prompt: '[QQ小程序]哔哩哔哩', meta: {} });
  await h.receive('msg', 'onRecvMsg', [[group({ msgId: '7003', elements: [{ elementType: 10, arkElement: { bytesData: card } }] })]]);
  const event = h.convert(h.raw.find(item => item.type === 'message'));
  assert.deepEqual(event.message[0], { type: 'json', data: { data: card } });
  assert.equal(segmentPreview(event.message[0]), '[应用 [QQ小程序]哔哩哔哩]');
  assert.equal(segmentText(event.message), '[应用 [QQ小程序]哔哩哔哩]');

  const pending = dispatchAction(h.channel, h.convert, { action: 'send_group_msg', params: { group_id: 987654, message: [{ type: 'json', data: { data: JSON.parse(card) } }] } });
  await setImmediate();
  assert.deepEqual(h.sends[0].elements, [{ elementType: 10, elementId: '', arkElement: { bytesData: card, linkInfo: null, subElementType: null } }]);
  h.ack();
  assert.equal((await pending).status, 'ok');
  for (const message of [[{ type: 'json', data: { data: card } }, { type: 'text', data: { text: 'x' } }], [{ type: 'json', data: { data: 'not json' } }]]) {
    const refused = await dispatchAction(h.channel, h.convert, { action: 'send_group_msg', params: { group_id: 987654, message } });
    assert.equal(refused.status, 'failed');
  }
  assert.equal(h.sends.length, 1);
});

const quoting = (original, msgId = '7100') => group({ msgId, elements: [{ elementType: 7, replyElement: { sourceMsgIdInRecords: original } }, text('?')] });
// Receives a message that quotes `original` and returns the OneBot id of its reply segment.
async function quoteId(h, original, msgId) {
  await h.receive('msg', 'onRecvMsg', [[quoting(original, msgId)]]);
  return h.convert(h.raw.filter(item => item.type === 'message').at(-1)).message[0].data.id;
}

test('get_msg reads a quoted message that was never received in this run, through the id of its reply segment', async () => {
  const h = harness();
  h.store.set('6000', group({ msgId: '6000', senderUid: 'u_old', senderUin: '777', sendNickName: 'old', sendMemberName: 'old card', msgTime: '1794470000',
    elements: [text('what was said earlier')] }));
  await h.receive('msg', 'onRecvMsg', [[quoting('6000', '7010')]]);
  const event = h.convert(h.raw.find(item => item.type === 'message'));
  assert.deepEqual(event.message.map(segment => segment.type), ['reply', 'text']);
  const quotedId = Number(event.message[0].data.id);

  const response = await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: quotedId }, echo: 'quote-1' });
  // One lookup while the quoting message was received (the id in the element is checked against the records), one for get_msg itself.
  assert.deepEqual(h.lookups, [[2, '987654', '', ['6000']], [2, '987654', '', ['6000']]]);
  assert.equal(response.status, 'ok');
  assert.equal(response.echo, 'quote-1');
  assert.deepEqual(response.data, { time: 1794470000, message_type: 'group', message_id: quotedId, real_id: quotedId, user_id: 777,
    sender: { user_id: 777, nickname: 'old', card: 'old card' }, message: [{ type: 'text', data: { text: 'what was said earlier' } }],
    raw_message: 'what was said earlier', font: 0, group_id: 987654 });
  assert.notEqual(quotedId, event.message_id, 'the quote has its own id; the quoting message keeps its own');
});

test('get_msg works for received, own and private messages, and chains through quotes inside a fetched message', async () => {
  const h = harness();
  h.store.set('7020', group({ msgId: '7020', elements: [text('now')] }));
  await h.receive('msg', 'onRecvMsg', [[group({ msgId: '7020', elements: [text('now')] })]]);
  const received = h.convert(h.raw.find(item => item.type === 'message'));
  const again = await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: received.message_id } });
  assert.equal(again.data.message_id, received.message_id, 'the id of a received message round-trips');
  assert.equal(again.data.sender.nickname, 'actor');

  // A message we sent is readable too, and a quote inside a fetched message yields another readable id.
  h.store.set('6100', group({ msgId: '6100', senderUid: self.uid, senderUin: self.uin, sendNickName: 'me',
    elements: [{ elementType: 7, replyElement: { sourceMsgIdInRecords: '6050' } }, text('answer')] }));
  h.store.set('6050', group({ msgId: '6050', senderUin: '888', senderUid: 'u_888', elements: [text('question')] }));
  const mine = await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: await quoteId(h, '6100', '7030') } });
  assert.equal(mine.data.user_id, Number(self.uin));
  assert.deepEqual(mine.data.message.map(segment => segment.type), ['reply', 'text']);
  const question = await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: mine.data.message[0].data.id } });
  assert.deepEqual([question.data.user_id, question.data.raw_message], [888, 'question']);

  h.store.set('6200', { chatType: 1, msgId: '6200', msgTime: '1794470100', peerUid: 'u_friend', senderUid: 'u_friend', senderUin: '999', sendNickName: 'friend', elements: [text('hi')] });
  await h.receive('msg', 'onRecvMsg', [[{ chatType: 1, msgId: '7040', msgSeq: '3', clientSeq: '1', msgTime: '1794470200', peerUid: 'u_friend', peerUin: '999',
    senderUid: 'u_friend', senderUin: '999', sendNickName: 'friend', elements: [{ elementType: 7, replyElement: { sourceMsgIdInRecords: '6200' } }, text('ok')] }]]);
  const privateEvent = h.convert(h.raw.filter(item => item.type === 'message').at(-1));
  const privateQuote = await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: privateEvent.message[0].data.id } });
  assert.deepEqual([privateQuote.data.message_type, privateQuote.data.group_id, privateQuote.data.sender], ['private', undefined, { user_id: 999, nickname: 'friend' }]);
  assert.deepEqual(h.lookups.at(-1).slice(0, 3), [1, 'u_friend', '']);
});

test('get_msg refuses what cannot be read: unknown ids, missing, recalled or empty messages, and QQ errors', async () => {
  const h = harness();
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: 123456 } })).retcode, 1404);
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: {} })).retcode, 1404);
  assert.deepEqual(h.lookups, [], 'unknown ids never reach QQ');

  const missing = await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: await quoteId(h, '6300', '7101') } });
  assert.equal(missing.retcode, 1404);
  assert.match(missing.message, /找不到/);

  h.store.set('6301', group({ msgId: '6301', elements: [{ elementType: 8, grayTipElement: { revokeElement: { operatorUid: 'u_actor' } } }] }));
  const recalled = await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: await quoteId(h, '6301', '7102') } });
  assert.equal(recalled.retcode, 1404);
  assert.match(recalled.message, /撤回/);

  h.store.set('6302', group({ msgId: '6302', elements: [] }));
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: await quoteId(h, '6302', '7103') } })).retcode, 1404);

  h.store.set('6303', group({ msgId: '6303', elements: [text('exists')] }));
  const id = await quoteId(h, '6303', '7104');
  h.rejectLookups(true);
  const rejected = await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: id } });
  assert.equal(rejected.retcode, 1500);
  assert.match(rejected.message, /not allowed/);
  h.rejectLookups(false);
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: id } })).status, 'ok');
});

test('get_msg keeps images and merged forwards lazy: no download, no expansion, ids that other actions accept', async () => {
  const h = harness();
  h.store.set('6400', group({ msgId: '6400', senderUin: '777', senderUid: 'u_old', elements: [
    { elementType: 2, elementId: '501', picElement: { fileName: 'cat.png', md5HexStr: 'abc', fileUuid: 'uuid-cat', fileSize: '12', sourcePath: '' } },
    forwardElement(),
  ] }));
  const response = await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: await quoteId(h, '6400', '7200') } });
  assert.equal(response.status, 'ok');
  const [image, forward] = response.data.message;
  assert.deepEqual([image.type, image.data.file, image.data.file_id], ['image', 'cat.png', 'uuid-cat']);
  assert.equal(image.data.path, undefined, 'nothing was downloaded just to read the message');
  assert.equal(forward.type, 'forward');
  assert.equal(forward.data.content, undefined, 'the forward is not expanded while reading the message');
  assert.deepEqual(h.calls, [], 'getMultiMsg is not called');
  const expanded = await dispatchAction(h.channel, h.convert, { action: 'get_forward_msg', params: { id: forward.data.id } });
  assert.equal(expanded.status, 'ok', 'the forward id from get_msg works with get_forward_msg');
  assert.deepEqual(h.calls[0], [2, '987654', '6400', '6400'], 'the forward is keyed by the message it was read from');
});

test('a reply segment names the quoted message through its sequence number, because the ids QQ writes into the element can miss the records', async () => {
  const h = harness();
  h.store.set('6000', group({ msgId: '6000', msgSeq: '41', senderUin: '777', senderUid: 'u_old', sendNickName: 'old', elements: [text('the original')] }));
  // The element's own ids point at nothing (as seen for a message the account sent itself); the sequence number is right.
  const quoting = (msgId, reply) => group({ msgId, elements: [{ elementType: 7, replyElement: reply }, text('?')] });
  await h.receive('msg', 'onRecvMsg', [[quoting('7300', { replayMsgSeq: '41', sourceMsgIdInRecords: '999999', replayMsgId: '888888' })]]);
  const event = h.convert(h.raw.find(item => item.type === 'message'));
  assert.deepEqual(h.seqLookups, [[2, '987654', '', '41', 1, true, true]]);
  const realId = h.convert.messageId(self, { chatType: 2, peerUid: '987654', msgId: '6000' });
  assert.equal(Number(event.message[0].data.id), realId, 'the reply id is the id the quoted message itself has');
  const read = await dispatchAction(h.channel, h.convert, { action: 'get_msg', params: { message_id: event.message[0].data.id } });
  assert.equal(read.status, 'ok');
  assert.equal(read.data.raw_message, 'the original');
  assert.deepEqual(h.lookups.at(-1), [2, '987654', '', ['6000']]);

  // When the sequence lookup fails, the ids in the element are tried (and must exist in the records).
  h.failSeq(true);
  await h.receive('msg', 'onRecvMsg', [[quoting('7301', { replayMsgSeq: '41', sourceMsgIdInRecords: '999999', replayMsgId: '6000' })]]);
  const fallback = h.convert(h.raw.filter(item => item.type === 'message').at(-1));
  assert.equal(Number(fallback.message[0].data.id), realId, 'the second id in the element matched a stored message');

  // Nothing matches: the segment keeps the id derived from the element, and the field names are reported once.
  await h.receive('msg', 'onRecvMsg', [[quoting('7302', { replayMsgSeq: '77', sourceMsgIdInRecords: '999999', replayMsgId: '888888', senderUid: 'u_x' })]]);
  await h.receive('msg', 'onRecvMsg', [[quoting('7303', { replayMsgSeq: '78', sourceMsgIdInRecords: '999998' })]]);
  const unresolved = h.convert(h.raw.filter(item => item.type === 'message').at(-2));
  assert.equal(h.convert.resolve(unresolved.message[0].data.id).msgId, '999999');
  const reports = h.raw.filter(item => item.type === 'native_callback' && item.event === 'reply_unresolved');
  assert.equal(reports.length, 1, 'reported once, not for every unmatched quote');
  assert.deepEqual(reports[0].argument_shapes[0], ['replayMsgSeq', 'sourceMsgIdInRecords', 'replayMsgId', 'senderUid']);
});

test('quotes of messages the session cannot look up still convert, and valid element ids are checked against the records', async () => {
  const noLookup = harness({ msgService: { getMsgsBySeqAndCount: undefined, getMsgsByMsgId: undefined } });
  await noLookup.receive('msg', 'onRecvMsg', [[group({ msgId: '7400', elements: [{ elementType: 7, replyElement: { replayMsgSeq: '5', sourceMsgIdInRecords: '6000' } }, text('hi')] })]]);
  const event = noLookup.convert(noLookup.raw.find(item => item.type === 'message'));
  assert.equal(noLookup.convert.resolve(event.message[0].data.id).msgId, '6000', 'without the lookups the old derivation still applies');
});
