# 机器人接入

OpenQQ 通过 OneBot v11 的正向和反向 WebSocket 推送事件、接收动作；也可以打开 HTTP 服务来调用动作，并用 HTTP 上报把事件 POST 给机器人。`examples/bot.mjs` 是一个最小的机器人客户端示例。

## 配置

配置会原子写入 `config/openqq.json`，也可以用 `--config <路径>` 指定别的文件。`config/openqq.json` 已在 `.gitignore` 里，里面有密钥，不要提交。

### 方式 A：Web 配置向导（推荐）

执行 `npm run webui`；没有配置时直接 `npm start` 也会进入向导。打开终端里打印的完整地址（带 `#token=...`），然后：

1. 在「环境概览 / 本地路径」一步确认探测到的 QQ NT 目录和 C++ 原生启动器的状态。点「重新检测」会重新检查 PE64 导出表和原生组件。
2. 选择 OneBot 连接模式：
   - 正向 WebSocket：OpenQQ 监听本地端口（默认 `127.0.0.1:3001`），机器人客户端主动连上来。
   - 反向 WebSocket：OpenQQ 主动连到最多 8 个外部服务端（`ws://` 或 `wss://`）。
   - 两者同时启用。
3. 设置 `OneBot Access Token`（16–256 位、不含空格的 ASCII 字符）和 WebUI 端口（只绑定 `127.0.0.1`，默认 `17860`）。
4. 保存后点「启动 QQ 桥接」，或者回终端运行 `npm start`。

### 方式 B：命令行

```powershell
npm run init
```

或者把 `config/openqq.example.json` 复制成 `config/openqq.json`，自己改 `qqRoot` 和随机生成的 `accessToken`。

> 如果把正向监听绑到 `0.0.0.0` 让局域网里的其他设备连接，请用足够强的 `accessToken`，并用防火墙限制来源网段。WebUI 始终只监听 `127.0.0.1`。令牌还决定谁能让 OpenQQ 发送本机文件，见 [actions.md](actions.md) 的「媒体来源」。

## 连接方式

### 正向 WebSocket

- 默认地址：`ws://127.0.0.1:3001/`
- 鉴权，二选一：
  - HTTP Header：`Authorization: Bearer <accessToken>`
  - URL 查询参数：`?access_token=<accessToken>`
- 路径：`/` 同时收事件、发动作；`/api` 只处理动作，不推送事件；`/event` 只推送事件，会忽略收到的动作。
- 连接成功且账号就绪后会推送 `lifecycle`（`connect`）；QQ 登录成功后会发送 `meta_event` / `heartbeat`。心跳间隔固定 15 秒（`interval: 15000`），正向和反向连接都一样，目前不能配置。
- 限流：同一来源 IP 在 60 秒内连续鉴权失败超过 20 次，会返回 `429 Too Many Requests`。

### 反向 WebSocket

- 请求头带 `X-Self-ID` 和 `X-Client-Role: Universal`；如果给这个连接单独配了密钥，还会带 `Authorization: Bearer <token>`。
- 至少要启用一种接入方式（正向 / 反向 WebSocket、HTTP 服务、HTTP 上报）。反向连接断开后，只要 QQ 会话仍然就绪，就每隔 3 秒自动重连，直到成功；QQ 未就绪时只等待，就绪后再连。这个间隔目前不能配置。

### HTTP 服务

在 WebUI 的「连接」页打开，默认监听 `127.0.0.1:5700`（容器里默认 `0.0.0.0`）；也可以在 `config/openqq.json` 里写 `"http": { "enabled": true, "host": "127.0.0.1", "port": 5700 }`。它和正向 WebSocket 是两个独立的端口，不能与 WebUI、WebSocket 端口相同。

- 鉴权：和 WebSocket 共用 `accessToken`，必须带上，二选一：`Authorization: Bearer <令牌>`（`Token <令牌>` 也可以）或 `?access_token=<令牌>`。没带令牌返回 `401`，令牌不对返回 `403`；同一来源 IP 在 60 秒内连续鉴权失败超过 20 次返回 `429`。
- 调用：路径就是动作名，`GET` 的参数放在查询字符串里，`POST` 可以用 `application/json` 或 `application/x-www-form-urlencoded`（其他类型返回 `406`，JSON 不合法返回 `400`，请求体超过 48 MiB 返回 `413`）。查询字符串和表单里的值都是字符串：`auto_escape`、`approve` 等布尔参数写 `true` / `false`，`message` 写成以 `[{` 开头的 JSON 数组时按消息段处理，否则按文本或 CQ 码处理。
- 返回：HTTP `200`，正文是 `{"status","retcode","data"}`，错误码见 [actions.md](actions.md)；QQ 还没就绪时是 `retcode 1502`，同时执行的动作超过 16 个时是 `1503`。HTTP 请求没有 `echo`。
- 后缀：路径以 `_async` 结尾（例如 `/send_private_msg_async`）时立刻返回 `{"status":"async","retcode":1,"data":null}`，动作在后台执行；以 `_rate_limited` 结尾时按普通调用处理。
- 事件不会通过这个服务推送，请同时使用 WebSocket 或下面的 HTTP 上报。
- `message_id` 会保存在 `.runtime/ids.json`，重启 OpenQQ 后同一条消息的 id 不变，之前返回过的 id 仍然可以用来引用、撤回和 `get_msg`（保留最近 1 万个）。文件里只有会话和消息的编号，没有消息内容。
- 打开 HTTP 服务后，收到的图片链接（`/openqq/media/…`）也由它提供，没有开正向 WebSocket 时也一样；这些链接带随机标识，不需要令牌。

```powershell
curl.exe -H "Authorization: Bearer $env:ONEBOT_TOKEN" -H "Content-Type: application/json" `
  -d '{"user_id":123456789,"message":"你好"}' http://127.0.0.1:5700/send_private_msg
```

### HTTP 上报

在「连接」页添加接收地址（最多 8 个），或在配置里写 `"httpPost": [{ "enabled": true, "url": "http://127.0.0.1:8080/onebot", "secret": "" }]`。OpenQQ 把每个**消息、通知和请求**事件用 `POST` 发给这些地址，不发送心跳和生命周期事件。

- 请求头：`Content-Type: application/json; charset=UTF-8`、`X-Self-ID: <机器人 QQ 号>`；配了 `secret` 时还有 `X-Signature: sha1=<HMAC-SHA1(secret, 请求体)>`，接收端用同样的方式算一遍来核对来源。
- 响应：状态码 `2xx` 才算成功（`204` 即可）；3xx、4xx、5xx、连接失败和 5 秒内没有响应都算失败，不会重发。失败状态显示在 WebUI 的「连接」页和概览，下一次成功后恢复。
- 响应体可以是一个**快速操作**（见下），只对消息和请求事件生效；空响应、不是 JSON 对象的内容都会被忽略。
- 每个接收端同时最多 4 个请求在途，排队超过 256 个事件时丢弃最旧的，所以慢接收端不会拖慢其他接收端。

### 快速操作

OneBot v11 的快速操作可以在两处使用：HTTP 上报的响应体，以及 `.handle_quick_operation` 动作（WebSocket 和 HTTP 服务都支持，参数是 `{"context": <事件>, "operation": <操作>}`，带 `_async` 后缀时在后台执行）。操作按下面的顺序换成普通动作依次执行，其中一个失败就停止并返回它的错误：

| 事件 | 字段 | 执行的动作 |
| --- | --- | --- |
| 消息 | `reply`（文本、CQ 码或消息段数组）、`auto_escape`（默认 `false`）、`at_sender`（仅群聊，默认 `true`） | `send_msg`，发到事件所在的会话；群聊默认在开头 @ 发送者 |
| 群消息 | `delete` | `delete_msg` |
| 群消息 | `kick` | `set_group_kick`（踢出发送者，不拒绝再次申请） |
| 群消息 | `ban`、`ban_duration`（秒，默认 1800） | `set_group_ban` |
| 好友请求 | `approve`、`remark` | `set_friend_add_request` |
| 入群请求 | `approve`、`reason` | `set_group_add_request` |

请求只有明确写了 `approve` 才会被处理，不会因为空响应而默认同意。通知和心跳事件不支持快速操作。

## 运行示例机器人

先在一个终端里保持 `npm start` 运行并登录 QQ，再在另一个终端设置环境变量并启动：

```powershell
$env:ONEBOT_TOKEN = "<config/openqq.json 里的 accessToken>"
# 可选：连接地址，默认 ws://127.0.0.1:3001/
# $env:ONEBOT_URL = "ws://127.0.0.1:3001/"
# 可选：只允许这些 QQ 号触发回复，逗号分隔
# $env:BOT_ALLOW_USERS = "123456789"
npm run bot
```

要让 `/ai <问题>` 命令走 OpenAI 兼容的 chat completions 接口，再设置：

```powershell
$env:BOT_API_URL = "https://api.example.com/v1/chat/completions"
$env:BOT_API_KEY = "<你的 API Key>"
$env:BOT_MODEL   = "<模型名称>"
```

示例机器人在私聊里支持 `/ping`（回复 `pong`）和 `/ai <内容>`。

## 参考

- [OneBot v11 正向 WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)
- [OneBot v11 反向 WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws-reverse.md)
- [OneBot v11 HTTP](https://github.com/botuniverse/onebot-11/blob/master/communication/http.md)
- [OneBot v11 HTTP POST](https://github.com/botuniverse/onebot-11/blob/master/communication/http-post.md)
- [OneBot v11 快速操作](https://github.com/botuniverse/onebot-11/blob/master/api/hidden.md)
- [OneBot v11 鉴权](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md)
- [OneBot v11 元事件](https://github.com/botuniverse/onebot-11/blob/master/event/meta.md)
- [Chat Completions API 参考](https://developers.openai.com/api/reference/resources/chat)
