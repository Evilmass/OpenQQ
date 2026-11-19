# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。每个版本的完整改动见 [GitHub Releases](https://github.com/feijx3/OpenQQ/releases)。

## 0.4.0 - 2026-11-19

### 新增

- **OneBot HTTP 服务。** 在「连接」页打开（默认关闭，监听 `127.0.0.1:5700`），机器人用 `GET` / `POST /<动作名>` 调用动作：参数可以放在查询字符串、JSON 或表单里，路径可以带 `_async` 后缀（立即返回，后台执行）或 `_rate_limited` 后缀。和 WebSocket 共用 Access Token，`Authorization: Bearer`、`Authorization: Token` 和 `?access_token=` 都可以；没带令牌 `401`、令牌不对 `403`，同一来源 60 秒内连续失败超过 20 次 `429`。没有开正向 WebSocket 时，收到的图片链接也由它提供。
- **HTTP POST 上报。** 最多 8 个接收端，把消息、通知和请求事件 `POST` 过去（不含心跳）。配了密钥会带 `X-Signature: sha1=<HMAC-SHA1>`；2xx 才算成功，5 秒超时；慢接收端不会拖慢其他接收端。WebUI 的「连接」页和概览显示每个接收端的状态。
- **快速操作。** 上报响应体里可以直接带，也可以调用 `.handle_quick_operation`（WebSocket 和 HTTP 都支持）：回复（群聊默认 @ 发送者）、撤回、踢人、禁言、处理好友请求和入群请求。请求类只有明确写了 `approve` 才会处理。
- **`get_msg`**：按 `message_id` 读取一条消息的内容，也可以用 `reply` 段里的 id 读取被引用的消息。已撤回的消息返回 `1404`。读消息不会触发图片下载，合并转发只带 `id`。
- **`get_friend_list`**：返回 `user_id`、`nickname`、`remark`，数据来自 QQ 最近一次推送的好友列表。
- **`set_msg_emoji_like`**：给群消息添加或取消表情回应。
- **`clean_cache`**：清理 OpenQQ 媒体临时目录里一小时前的残留。
- **`message_id` 重启后保持不变。** 映射保存在 `.runtime/ids.json`（只有会话和消息编号，没有内容，保留最近 1 万个），重启后之前返回过的 id 仍然可以用来引用、撤回和 `get_msg`。
- 配置文件新增可选的 `http` 和 `httpPost`，旧配置文件不用改。Docker 镜像声明 `5700` 端口，`compose.yaml` 里有对应的注释行。

### 变更

- 至少要启用一种接入方式（正向 / 反向 WebSocket、HTTP 服务、HTTP 上报），不再要求必须有 WebSocket。
- 启动横幅会列出所有接入方式。
- WebUI 和终端里的动作记录，会把内联的 `base64://` / `data:` 数据换成大小占位符，`get_image` 响应里的 `base64` 也一样。原来超过 2 MiB 的记录会被 WebUI 整条丢掉，不进历史和计数。
- WebSocket 的 `Authorization` 头也接受 `Token <令牌>` 的写法。

### 修复

- **#12：发送超过约 760 KiB 的 `base64://` 图片或媒体报 `1400 动作帧超过 1 MiB`。** 媒体段处理完后只保留 `openqq_media`（图片再加不超过 64 字符的 `summary`），不再把来源数据一起放进发往原生层的帧里。感谢 @15963360 的报告和 PR #13。
- **`auto_escape: false` 的 CQ 字符串不会被解析**，里面的 CQ 图片等媒体发不出去。现在 `false` 和不写等价，不是布尔值的写法仍然报错。
- **`reply` 段的 id 对自己发出的消息指向 QQ 记录里不存在的消息**，导致引用读不回来。现在先用被引用消息的序号在 QQ 记录里查，查不到再试元素里的 id。
- **#8：QQ 启动即退出（`0x80000003`）的加固，未在报告者的机器上验证。** 硬件断点命中后，如果调试寄存器读回为 0，不再把我们的断点当成别人的交还给 QQ；恢复线程时不再把读回的调试寄存器写回去；启动失败的报错里带上最后一个交给 QQ 的异常。如果触发了读回为 0 的情况，日志里会出现 `debug_registers_unread`。

### 验证

在 Windows 11 + QQ 9.9.37-54395 + 真实账号上做过：launcher 挂接、1.2 MB 的 base64 图片发送、HTTP 服务（鉴权、`_async`、错误状态码）、`get_msg`（含引用）、`.handle_quick_operation`、`get_friend_list`（235 个好友）、`message_id` 重启后保持、HTTP POST 上报（签名校验、事件类型）、`delete_msg` 以及 `set_msg_emoji_like`（添加和取消「赞」，群里可见）。`clean_cache` 和 HTTP 的表单、查询字符串传参只有自动测试。

### 已知限制

- `set_msg_emoji_like` 只支持群消息。
- `get_friend_list` 不会向 QQ 刷新，登录同步完成前返回 `1500`。
- HTTP 服务没有 SSE；`_rate_limited` 后缀只是被接受，不做排队。
- 事件去重用的键不持久化，重启后可能重复上报同一个事件。

## 0.3.0 - 2026-11-18

- 新增块式 Bot 编辑器：可视化编排，支持 AI 回复、每个 Bot 独立的人设和记忆。
- 新增动作 `get_stranger_info`。
- 修复语音发送：补全发出的 `pttElement` 字段。

## 0.2.1 - 2026-11-17

- 收到图片时自动让 QQ 下载并补上本地 `path`；新增动作 `get_image`；开启正向 WebSocket 时通过 `/openqq/media/` 提供图片链接，纯反向 WebSocket 时补充本地路径。
- WebSocket 单帧上限提高到 48 MiB，支持 `data:...;base64,` 形式的媒体来源。
- 修复 Docker：安装 QQ 的地址查找、容器里正向 WebSocket 的默认监听地址、Dockerfile 里写错的 `ENV` 行。

## 0.2.0 - 2026-11-16

- 新增 Linux（x64 / arm64）和 Docker 支持。

## 0.1.0 - 2026-11-16

- 第一个发布版本：Windows x64 QQ NT 的 OneBot v11 桥接，正向和反向 WebSocket，发送与管理动作，WebUI 控制台，C++ 原生启动器。
