import { clearScreenDown, cursorTo, moveCursor } from 'node:readline';

// Terminal presentation. "pretty" renders colored one-line records and keeps the typed command line
// intact; "json" keeps the machine-readable contract: OneBot JSON Lines on stdout, diagnostics on stderr.

const codes = { reset: 0, bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90,
  bgRed: 41, bgGreen: 42, bgYellow: 43, bgBlue: 44, bgMagenta: 45, bgCyan: 46, bgGray: 100, black: 30, white: 97 };

// Strip ANSI escape sequences and C0/C1 control characters from untrusted QQ strings before writing to a TTY.
const ansiSequence = /[\x1b\x9b](?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;
export function sanitizeTerminal(value, allowNewline = false) {
  const cleaned = String(value ?? '').replace(ansiSequence, '');
  return allowNewline
    ? cleaned.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
    : cleaned.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

export function colorEnabled(stream, env = process.env) {
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  return Boolean(stream.isTTY && (stream.hasColors?.() ?? true));
}

function painter(enabled) {
  const paint = (styles, text) => !enabled ? String(text)
    : styles.split(' ').map(name => `\x1b[${codes[name]}m`).join('') + text + '\x1b[0m';
  return paint;
}

// CJK characters take two terminal columns.
const width = text => [...text].reduce((sum, char) => sum + (char.codePointAt(0) >= 0x2e80 ? 2 : 1), 0);
const pad = (text, size) => text + ' '.repeat(Math.max(1, size - width(text)));

const clock = (seconds, zone) => new Date(seconds ? seconds * 1000 : Date.now())
  .toLocaleTimeString('zh-CN', { hour12: false, timeZone: zone });

// Ark cards carry their own one-line summary ("prompt"); fall back to the app name.
function appTitle(raw) {
  try {
    const card = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const title = String(card?.prompt || card?.meta?.detail_1?.title || card?.meta?.news?.title || card?.app || '').trim();
    return title ? ' ' + sanitizeTerminal(title.slice(0, 60), false) : '';
  } catch { return ''; }
}

export function segmentPreview(segment) {
  const data = segment?.data ?? {};
  switch (segment?.type) {
    case 'text': return data.text ?? '';
    case 'at': return data.qq === 'all' ? '@全体成员' : `@${data.qq}`;
    case 'face': return `[表情${data.id ?? ''}]`;
    case 'dice': return `[骰子${data.result ? ' ' + data.result : ''}]`;
    case 'rps': return `[猜拳${data.result ? ' ' + data.result : ''}]`;
    case 'poke': return `[戳一戳]`;
    case 'contact': return `[推荐${data.type === 'group' ? '群' : '好友'} ${data.id ?? ''}]`;
    case 'image': return '[图片]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'file': return `[文件 ${data.file ?? ''}]`;
    case 'reply': return `[回复 #${data.id}]`;
    case 'json': return `[应用${appTitle(data.data)}]`;
    case 'forward': return `[合并转发 #${data.id}${Array.isArray(data.content) ? ` · ${data.content.length} 条` : ''}]`;
    case 'xml': return '[XML 卡片]';
    case 'mface': return `[${data.summary || '商城表情'}]`;
    case 'markdown': return '[Markdown]';
    case 'openqq_element': return `[未识别元素 ${data.element_type}]`;
    default: return `[${segment?.type ?? '?'}]`;
  }
}

const durationText = seconds => {
  if (!(seconds > 0)) return '';
  const units = [['天', 86400], ['小时', 3600], ['分钟', 60], ['秒', 1]];
  for (const [name, size] of units) if (seconds >= size && seconds % size === 0) return `${seconds / size} ${name}`;
  return `${seconds} 秒`;
};
const sizeText = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;

// Returns [badge, badgeStyle, headline, body?] for one converted OneBot event.
export function describeEvent(event) {
  if (event.post_type === 'message' || event.post_type === 'message_sent') {
    const name = event.sender?.card || event.sender?.nickname;
    const who = name ? `${name}(${event.user_id})` : String(event.user_id);
    const body = (event.message ?? []).map(segmentPreview).join('');
    const tag = event.post_type === 'message_sent' ? '自身' : event.message_type === 'group' ? '群聊' : event.sub_type === 'group' ? '临时' : '私聊';
    if (event.message_type === 'group') return [tag, 'bgBlue white', `群 ${event.group_id} · ${who}`, body];
    return [tag, 'bgCyan black', who, body];
  }
  if (event.post_type === 'request') {
    const extra = event.comment ? `「${event.comment}」` : '';
    if (event.request_type === 'friend') return ['请求', 'bgMagenta white', `好友申请 · ${event.user_id}`, extra];
    return ['请求', 'bgMagenta white', `${event.sub_type === 'invite' ? '邀请入群' : '入群申请'} · 群 ${event.group_id} · ${event.user_id}`, extra];
  }
  const e = event;
  const group = e.group_id ? `群 ${e.group_id} · ` : '';
  const notice = text => ['通知', 'bgYellow black', text];
  switch (e.notice_type) {
    case 'group_recall': return notice(`${group}${e.operator_id === e.user_id ? `${e.user_id} 撤回了消息` : `${e.operator_id} 撤回了 ${e.user_id} 的消息`} #${e.message_id}`);
    case 'friend_recall': return notice(`${e.user_id} 撤回了私聊消息 #${e.message_id}`);
    case 'group_increase': return notice(`${group}${e.user_id} ${e.sub_type === 'invite' ? `经 ${e.operator_id} 邀请` : ''}加入了群`);
    case 'group_decrease': return notice(`${group}${{ leave: `${e.user_id} 退出了群`, kick: `${e.user_id} 被 ${e.operator_id || '管理员'} 移出`, kick_me: e.openqq_reason === 'disband' ? '群已解散' : '机器人被移出群' }[e.sub_type] ?? e.sub_type}`);
    case 'group_admin': return notice(`${group}${e.user_id} ${e.sub_type === 'set' ? '成为管理员' : '被取消管理员'}`);
    case 'group_ban': return notice(`${group}${e.user_id === 0 ? (e.sub_type === 'ban' ? '开启全员禁言' : '关闭全员禁言') : e.sub_type === 'ban' ? `${e.user_id} 被禁言 ${durationText(e.duration)}` : `${e.user_id} 被解除禁言`}（操作者 ${e.operator_id}）`);
    case 'group_upload': return notice(`${group}${e.user_id} 上传文件 ${e.file?.name ?? ''}（${sizeText(e.file?.size ?? 0)}）`);
    case 'group_card': return notice(`${group}${e.user_id} 群名片 ${e.card_old || '(空)'} → ${e.card_new || '(空)'}`);
    case 'group_name': return notice(`${group}群名称改为「${e.group_name}」`);
    case 'group_msg_emoji_like': return notice(`${group}${e.user_id || '成员'} ${e.is_add === false ? '取消了' : '回应了'}表情 ${(e.likes ?? []).map(l => l.emoji_id).join(',')} #${e.message_id || e.msg_seq || ''}`);
    case 'essence': return notice(`${group}${e.sub_type === 'delete' ? '移出' : '设为'}精华消息 #${e.message_id || ''}`);
    case 'friend_add': return notice(`新增好友 ${e.user_id}`);
    case 'friend_delete': return notice(`好友 ${e.user_id} 已删除`);
    case 'bot_offline': return ['掉线', 'bgRed white', `账号被迫下线${e.reason ? `：${e.reason}` : ''}`];
    case 'openqq_gray_tip': return notice(`未识别灰条提示 · ${e.chat_type === 2 ? '群' : '会话'} ${e.peer_id}`);
    case 'notify':
      if (e.sub_type === 'poke') return notice(`${group}${e.user_id} 戳了戳 ${e.target_id}`);
      if (e.sub_type === 'title') return notice(`${group}${e.user_id} 获得头衔「${e.title}」`);
      if (e.sub_type === 'input_status') return ['输入', 'bgGray white', `${e.user_id} ${e.status_text || '正在输入…'}`];
  }
  return notice(`${e.notice_type}${e.sub_type ? '/' + e.sub_type : ''} ${group}${e.user_id ?? ''}`);
}

const actionNames = { send_private_msg: '发送私聊', send_group_msg: '发送群聊', send_msg: '发送消息', set_input_status: '输入状态', get_forward_msg: '合并转发',
  get_login_info: '登录信息', get_status: '运行状态' };

function actionTarget(request) {
  const p = request?.params ?? {};
  const kind = request?.action === 'send_group_msg' || (request?.action === 'send_msg' && (p.message_type === 'group' || (p.group_id !== undefined && p.user_id === undefined)));
  if (p.group_id !== undefined && kind) return `群 ${p.group_id}`;
  if (p.user_id !== undefined) return String(p.user_id);
  return '';
}

export function createConsole({ stdout = process.stdout, stderr = process.stderr, mode, verbose = false, color, timeZone } = {}) {
  const pretty = (mode ?? (stdout.isTTY ? 'pretty' : 'json')) === 'pretty';
  const paint = painter(color ?? colorEnabled(stdout));
  let rl;
  let showDebug = verbose;
  let hidden = 0;

  // Clear the prompt and whatever the user has typed, print above it, then redraw the same input.
  function print(text) {
    if (rl && !rl.closed && stdout.isTTY) {
      const rows = rl.getCursorPos?.().rows ?? 0;
      if (rows) moveCursor(stdout, 0, -rows);
      cursorTo(stdout, 0);
      clearScreenDown(stdout);
      stdout.write(text + '\n');
      rl.prompt(true);
    } else stdout.write(text + '\n');
  }
  const time = seconds => paint('gray', clock(seconds, timeZone));
  const badge = (text, style) => paint(style + ' bold', ` ${text} `);
  const indent = ' '.repeat(12);
  const body = text => {
    const lines = sanitizeTerminal(text, true).split('\n');
    const limit = 12;
    const shown = lines.slice(0, limit).join('\n' + indent);
    return shown + (lines.length > limit ? '\n' + indent + paint('gray', `…（还有 ${lines.length - limit} 行）`) : '');
  };
  const line = (level, text) => {
    const marks = { info: ['•', 'cyan'], ok: ['✔', 'green'], warn: ['!', 'yellow'], error: ['✖', 'red'], debug: ['·', 'gray'] };
    const [mark, style] = marks[level] ?? marks.info;
    const safe = sanitizeTerminal(text, false);
    return `${time()}  ${paint(style + ' bold', mark)} ${level === 'debug' ? paint('gray', safe) : level === 'error' ? paint('red', safe) : safe}`;
  };

  const api = {
    pretty,
    get verbose() { return showDebug; },
    paint,
    attach(readline) { rl = readline; rl.once('close', () => { rl = undefined; }); },
    toggleVerbose() { showDebug = !showDebug; return showDebug; },
    log(level, text) {
      if (level === 'debug' && !showDebug) { hidden++; return; }
      if (pretty) print(line(level, text));
      else stderr.write(`[OpenQQ] ${text}\n`);
    },
    // A dashboard-style block, used for startup and session_ready.
    banner(title, rows = [], style = 'cyan') {
      if (!pretty) { stderr.write(`[OpenQQ] ${title}${rows.map(([k, v]) => ` ${k}=${v}`).join('')}\n`); return; }
      const column = Math.max(...rows.map(([key]) => width(key)), 0) + 2;
      const bar = paint(style, '│');
      print(['', `  ${paint(style + ' bold', sanitizeTerminal(title, false))}`, ...rows.map(([key, value]) => `  ${bar} ${paint('gray', pad(key, column))}${sanitizeTerminal(value, false)}`), ''].join('\n'));
    },
    event(event) {
      if (!pretty) { stdout.write(JSON.stringify(event) + '\n'); return; }
      const [label, style, headline, content] = describeEvent(event);
      const head = `${time(event.time)}  ${badge(label, style)} ${paint('bold', sanitizeTerminal(headline, false))}`;
      const id = event.message_id && event.post_type === 'message' ? ' ' + paint('gray', `#${event.message_id}`) : '';
      print(content ? `${head}${id}\n${indent}${body(content)}` : head + id);
    },
    action(request, response, source = 'terminal') {
      if (!pretty) { if (source === 'terminal') stdout.write(JSON.stringify(response) + '\n'); return; }
      const actionKey = request?.action;
      const name = sanitizeTerminal(Object.hasOwn(actionNames, actionKey) ? actionNames[actionKey] : actionKey ?? '输入', false);
      const target = sanitizeTerminal(actionTarget(request), false);
      const from = source === 'webui' ? paint('gray', ' (WebUI)') : source === 'onebot' ? paint('gray', ' (OneBot)') : source === 'bot' ? paint('gray', ' (Bot)') : '';
      const echo = response && Object.hasOwn(response, 'echo') ? paint('gray', ` echo=${sanitizeTerminal(JSON.stringify(response.echo), false)}`) : '';
      if (response?.status === 'ok') {
        const data = response.data == null ? '' : response.data.message_id !== undefined ? paint('gray', ` #${response.data.message_id}`) : ' ' + paint('gray', sanitizeTerminal(JSON.stringify(response.data), false));
        print(`${time()}  ${badge('成功', 'bgGreen black')} ${paint('bold', name)}${target ? ' → ' + target : ''}${data}${echo}${from}`);
      } else {
        print(`${time()}  ${badge('失败', 'bgRed white')} ${paint('bold', name)}${target ? ' → ' + target : ''}${from}${echo}\n${indent}${paint('red', `[${response?.retcode ?? '?'}] ${sanitizeTerminal(response?.message ?? '未知错误', false)}`)}`);
      }
    },
    help(text) {
      if (!pretty) { stderr.write(text + '\n'); return; }
      print(text.split('\n').map(row => {
        const match = row.match(/^(\/\S+(?: \S+)*?)(\s{2,}|\s+— )(.*)$/);
        return match ? `  ${paint('cyan bold', pad(match[1], 24))} ${paint('gray', match[3].replace(/^—\s*/, ''))}` : `  ${paint('gray', row)}`;
      }).join('\n'));
    },
    // Diagnostics from the in-QQ script; json mode keeps the raw JSON on stderr.
    diagnostic(event) {
      if (!pretty) { stderr.write(`[OpenQQ] ${JSON.stringify(event)}\n`); return; }
      if (event.type === 'session_ready') return;
      api.log(...describeDiagnostic(event));
    },
    // One line of the bootstrap process output. QQ's own console output is only shown with /verbose.
    native(text) {
      const described = describeNativeLine(text);
      if (!pretty) { if (described || showDebug) stderr.write(text + '\n'); return; }
      if (described) api.log(...described);
      else if (text.trim()) api.log('debug', 'QQ │ ' + text);
    },
    setPrompt(text) { rl?.setPrompt(text); },
    // Debug-only messages hidden since the last call; lets callers hint that /verbose exists.
    takeHidden() { const value = hidden; hidden = 0; return value; },
  };
  return api;
}

// Maps one line from the C++ bootstrap process. Returns null for QQ's own console output.
export function describeNativeLine(text) {
  const match = text.match(/^\[OpenQQ\/native\] (.*)$/);
  if (!match) return null;
  let payload;
  try { payload = JSON.parse(match[1]); } catch { return ['error', '原生引导：' + match[1]]; }
  switch (payload.stage) {
    case 'runtime_found': return ['info', `找到 QQ 运行时 ${payload.name}（PID ${payload.pid}）`];
    case 'addon_register': return payload.target ? ['ok', `目标 wrapper.node 已注册（${payload.name}）`] : ['debug', `跳过原生模块 ${payload.name || '(无名)'} · ${payload.owner ?? '未知 DLL'}`];
    case 'bootstrapped': return ['ok', '脚本已载入 QQ，原生引导器已脱离'];
    case 'error': return ['error', '原生引导失败：' + payload.error];
    default: return ['debug', '原生引导 ' + match[1]];
  }
}

// Maps an OpenQQ diagnostic from the in-QQ script. session_ready is rendered as a banner by the caller.
export function describeDiagnostic(event) {
  switch (event.type) {
    case 'wrapper_loaded': return ['ok', `已包装会话工厂（${event.factories} 个入口）`];
    case 'session_captured': return ['ok', '已捕获 QQ 会话，等待登录完成'];
    case 'sync_state': return event.syncing ? ['info', 'QQ 正在同步消息与好友列表…'] : ['ok', '同步完成，开始报告好友变化'];
    case 'offline': return ['error', '账号已掉线'];
    case 'hook_error': return ['error', `挂接失败 [${event.stage}] ${event.error}`];
    case 'event_error': return ['warn', `事件处理失败 [${event.stage}] ${event.error}`];
    case 'native_callback': return ['debug', `未适配回调 ${event.source}/${event.event} (${event.argument_shapes.map(shape => Array.isArray(shape) ? 'object' : shape).join(', ')})`];
    default: return ['debug', JSON.stringify(event)];
  }
}
