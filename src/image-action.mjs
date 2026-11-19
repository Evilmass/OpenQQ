// OneBot 扩展动作 generate_image：用「AI 生图」页保存的设置生成图片，可以顺便把图发到一个群或好友。
//
//   params: prompt（必填）、model / size / n（可选，覆盖保存的设置）、group_id 或 user_id（可选，二选一）
//   没给目标：返回 images，每张的 file 是 base64://…，可以直接放进 image 段发出去。
//   给了目标：把图发过去，返回 message_id；images 里只有尺寸等信息，不再带图片数据。
const fail = (message, retcode = 1400) => Object.assign(new Error(message), { retcode });

function identifier(value, name) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw fail(`${name} 必须是有效的 QQ 数值标识`);
  }
  return value;
}

/**
 * @param {object} params 动作参数
 * @param {object} context
 * @param {{ generate(options: object): Promise<object> } | undefined} context.image 生图客户端（和 WebUI 的生图页共用，所以同一时间只会有一个任务）
 * @param {(request: object) => Promise<object>} context.send 发送动作的执行函数（走和 send_group_msg 一样的完整流程）
 */
export async function generateImage(params, { image, send }) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw fail('params 必须为对象');
  if (!image) throw fail('当前没有接入生图功能', 1500);
  if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw fail('请先写下想生成的画面（prompt）');
  const hasGroup = params.group_id !== undefined && params.group_id !== null;
  const hasUser = params.user_id !== undefined && params.user_id !== null;
  if (hasGroup && hasUser) throw fail('group_id 和 user_id 只能给一个');
  const target = hasGroup ? { action: 'send_group_msg', params: { group_id: identifier(params.group_id, 'group_id') } }
    : hasUser ? { action: 'send_private_msg', params: { user_id: identifier(params.user_id, 'user_id') } } : null;
  for (const name of ['model', 'size']) if (params[name] !== undefined && typeof params[name] !== 'string') throw fail(`${name} 必须是字符串`);

  // 错误已经带着返回码：设置或参数有问题 1400，已有任务在跑 1503，接口和网络问题 1500。
  const generated = await image.generate({ prompt: params.prompt, model: params.model, size: params.size, count: params.n });
  const info = item => ({ mime: item.mime, width: item.width, height: item.height, bytes: item.bytes, ...(item.revisedPrompt ? { revised_prompt: item.revisedPrompt } : {}) });
  const payload = item => 'base64://' + item.dataUrl.slice(item.dataUrl.indexOf(',') + 1);
  const summary = { model: generated.model, size: generated.size, elapsed_ms: generated.elapsedMs };
  if (!target) return { images: generated.images.map(item => ({ file: payload(item), ...info(item) })), ...summary };

  const sent = await send({ action: target.action, params: { ...target.params, message: generated.images.map(item => ({ type: 'image', data: { file: payload(item) } })) } });
  if (sent?.status !== 'ok') throw fail(`图片已生成，但发送失败：${sent?.message ?? '未知错误'}`, Number.isInteger(sent?.retcode) && sent.retcode !== 0 ? sent.retcode : 1500);
  return { message_id: sent.data?.message_id, images: generated.images.map(info), ...summary };
}
