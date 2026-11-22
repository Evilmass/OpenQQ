# 更新日志

每个版本的完整改动见 [GitHub Releases](https://github.com/feijx3/OpenQQ/releases)。`[+]` 表示新增，`[/]` 表示修改或修复。

## OpenQQ v0.5.0 已释放（2026-11-22）

[+] 主动戳一戳：支持 `send_poke`、`group_poke`、`friend_poke`（通过 QQ 原生 `msgService.sendNudge` 实现，无需额外发包插件）
[+] 历史消息与已读回执：新增 `get_group_msg_history`、`get_friend_msg_history`、`mark_msg_as_read`、`mark_group_msg_as_read`、`mark_private_msg_as_read`、`_mark_all_as_read`
[+] 合并转发与单条转发发送：新增 `send_group_forward_msg`、`send_private_forward_msg`、`send_forward_msg`（支持引用已有消息节点与自定义图文节点）及 `forward_group_single_msg`、`forward_friend_single_msg`
[+] 语音、文件与下载增强：新增 `get_record`（支持按 `out_format` 自动转码为 WAV / PCM / MP3 等）、`get_file`、`fetch_ptt_text`（语音转文字）、`download_file`、`upload_group_file`、`upload_private_file`
[+] 群文件与群公告完整管理：新增群空间查询、根目录与子目录浏览、新建/重命名/删除文件夹、删除文件、转存永久文件、取文件链接，以及 `_get_group_notice`、`_send_group_notice`（含配图与置顶）、`_del_group_notice`
[+] 群精华、群荣誉与群管扩展：新增 `set_essence_msg`、`delete_essence_msg`、`get_essence_msg_list`、`set_group_kick_members`、`set_group_remark`、`set_group_portrait`、`get_group_at_all_remain`、`get_group_shut_list`、`get_group_honor_info`、`get_group_system_msg`、`get_group_detail_info`（`get_group_info_ex`）、`get_group_share_link`
[+] 好友、资料与凭据接口：新增 `get_friends_with_category`、`set_friend_remark`、`delete_friend`、`set_qq_profile`、`set_self_longnick`、`set_qq_avatar`、`get_recent_contact`、`fetch_custom_face`、`set_online_status`、`ArkSharePeer`、`ArkShareGroup`、`get_clientkey`、`get_cookies`、`get_csrf_token`、`get_credentials`、`check_url_safely`、`nc_get_packet_status`
[+] 更多消息段与通知事件：发送新增 `mface`、`markdown`、`contact`、`image.sub_type`、`reply.seq`；接收新增 `dice`、`rps`、`poke` 段及 `image.summary` / `sub_type`；新增群表情回应（`group_msg_emoji_like`）、精华消息（`essence`）、群头衔（`notify/title`）与自身入群通知
[+] 内置官方 SDK 与 MCP Server：新增 `src/sdk.mjs` + `src/sdk.d.ts`（支持 HTTP / WebSocket 与链式 `MessageBuilder`）、统一动作清单 `src/action-catalog.mjs` 与 stdio MCP 服务 `npm run mcp`（默认拦截敏感凭据接口，支持只读模式与白/黑名单）
[+] 更多连接配置与 WS 异步后缀：`config/openqq.json` 新增可选 `heartbeatInterval`、`reconnectInterval`、`reportSelfMessage`（上报 `message_sent`）；WebSocket 动作同步支持 `_async` 与 `_rate_limited` 后缀
[+] WebUI 升级：动作调试页补齐 95+ 动作与模板；账号页就绪后自动读取并显示昵称；推广横幅升级流光旋转边框、极光扫光、鼠标聚光灯与炫光按钮特效并同步展示在「AI 接入」与「AI 生图」页顶部
[/] 修复 `get_login_info` 昵称始终为空字符串的问题，现自动拉取并缓存真实昵称
[/] 修复 `get_friend_list` 仅能被动等推送的问题，支持主动拉取与 `no_cache` 刷新
[/] 修复 `set_friend_add_request` 同意申请时 `remark` 备注不生效的问题
[/] 修复好友私聊 `sub_type` 始终为 `other` 的问题，现正确区分 `friend` 与 `other`
[/] 修复部分私聊回复找不到被引用消息的问题、文本单独 `\r` 换行归一化为 `\n`，以及全员永久禁言时长 `0xffffffff` 归一化为 `-1`
[/] 改进媒体下载与 Base64 兼容：支持无填充及 URL-safe Base64、重定向放宽至 5 次、优化请求头减少图床 403
[/] 改进 Windows 原生引导器诊断日志：异常详情记录线程 ID、所属模块及偏移地址

【广告】zelix.asia —— AI API 中转站，由 OpenQQ 维护者运营。可直接用于 OpenQQ 的「AI 接入」与「AI 生图」页面，点击获取 Key：https://zelix.asia （这是一条推广信息）

说明：
- 所有新增原生服务调用签名已对照 QQ `9.9.37-54395` 的 `wrapper.node` / `major.node` 核对，并通过 249 项自动化单元测试与类型检查；新增动作尚未全部在真机账号上逐条实测
- 仍未支持：必须走底层原始发包（非 `wrapper.node` 公开接口）的能力，如设置群专属头衔（`set_group_special_title`）、图片 OCR 与音乐卡片签名

## OpenQQ v0.4.0 已释放（2026-11-19）

[+] OneBot HTTP 服务：`GET` / `POST /<动作名>` 调用动作，参数可放在查询字符串、JSON 或表单里，支持 `_async` 后缀；默认关闭（`127.0.0.1:5700`），和 WebSocket 共用 Access Token（`Authorization: Bearer`、`Token` 或 `?access_token=`），鉴权失败有限流
[+] HTTP POST 上报：最多 8 个接收端，推送消息、通知和请求事件，可用 `X-Signature`（HMAC-SHA1）校验来源；2xx 才算成功，5 秒超时，慢接收端不拖慢其他接收端
[+] 快速操作：在上报响应里或调用 `.handle_quick_operation`，直接回复、撤回、踢人、禁言、处理好友和入群请求；请求类只有明确写了 `approve` 才会处理
[+] AI 生图页：控制台新增「AI 生图」，调用 OpenAI 兼容的 `/images/generations`，默认接口 `api.zelix.asia`，API Key 旁边有「点击获取 KEY」按钮，可选模型、尺寸、张数，预览并下载
[+] 动作 `generate_image`：外部程序直接生图，不给目标时返回 `base64://` 图片，给了 `group_id` 或 `user_id` 就生成后直接发过去；同一时间只跑一个生成任务
[+] 动作 `get_msg`：读取消息内容，`reply` 段里的 id 也能读到被引用的消息
[+] 动作 `get_friend_list`、`set_msg_emoji_like`（群消息表情回应）、`clean_cache`
[+] `message_id` 重启后保持不变（保存在 `.runtime/ids.json`，只有编号，没有内容）
[+] 配置文件新增可选的 `http` 和 `httpPost`，旧配置不用改；Docker 镜像声明 `5700` 端口
[/] 修复收到的图片总是下载失败、机器人拿不到图（#10）：QQ 9.9.37 把下载成功回执写成 `trasferStatus=4`，旧代码只认 0 和 2，每张图都被判成失败；失败和超时的提示现在带上回执的关键字段
[/] 修复发送超过约 760 KiB 的 `base64://` 图片报 `1400 动作帧超过 1 MiB`（#12），感谢 @15963360 的报告和 PR #13
[/] 修复 `auto_escape: false` 的 CQ 消息里的图片发不出去
[/] 修复引用自己发出的消息时 reply 的 id 读不回来
[/] 「AI 接入」页的模型选择改成真正的下拉框，「AI 生图」页同样（原来的候选列表只显示和已输入文字匹配的项，看起来像没有列表）
[/] 加固 QQ 启动即退出（`0x80000003`，#8）的断点处理：调试寄存器读回为 0 时不再把断点交还给 QQ（未在报告者的机器上验证）
[/] 至少启用一种接入方式即可（WebSocket、HTTP 服务、HTTP 上报），不再要求必须有 WebSocket
[/] WebUI 和终端里的动作记录会把内联图片数据换成大小占位符，大图不再被整条丢掉；Base URL 粘贴完整的 `…/images/generations` 地址会被还原成 `/v1` 根地址

【广告】zelix.asia —— AI API 中转站，由 OpenQQ 维护者运营。可以作为「AI 接入」和「AI 生图」的接口地址，点击进入获取 Key：https://zelix.asia （这是一条推广信息）

说明：
- 真机验证过（Windows 11 + QQ 9.9.37 + 真实账号）：launcher 挂接、1.2 MB 的 base64 图片发送、HTTP 服务、`get_msg`（含引用）、快速操作、`get_friend_list`、`message_id` 重启后保持、HTTP POST 上报、`delete_msg`、`set_msg_emoji_like`，以及收图（群聊里的 GIF、WebP、PNG、JPEG 都拿到了本地路径和链接）
- 只有自动测试、没有在真机上验证：AI 生图页和 `generate_image`（用本地模拟网关测过，没用真实 Key 试过，可用的模型名和尺寸以你使用的服务为准）、`clean_cache`、私聊图片、合并转发里的图片、表情包和几 MB 以上的大图
- 已知限制：`set_msg_emoji_like` 只支持群消息；`get_friend_list` 不会向 QQ 刷新，登录同步完成前返回 `1500`；HTTP 服务没有 SSE；商城表情是 `mface` 段，不会作为图片下载；收图每张最多等 12 秒，超时退回缩略图

## OpenQQ v0.3.0 已释放（2026-11-18）

[+] 块式 Bot 编辑器：可视化编排，支持 AI 回复、每个 Bot 独立的人设和记忆
[+] 动作 `get_stranger_info`
[/] 修复语音发送：补全发出的 `pttElement` 字段

## OpenQQ v0.2.1 已释放（2026-11-17）

[+] 收到图片时自动让 QQ 下载并补上本地 `path`；新增动作 `get_image`；开启正向 WebSocket 时通过 `/openqq/media/` 提供图片链接，纯反向 WebSocket 时补充本地路径
[/] WebSocket 单帧上限提高到 48 MiB，支持 `data:...;base64,` 形式的媒体来源
[/] 修复 Docker：安装 QQ 的地址查找、容器里正向 WebSocket 的默认监听地址、Dockerfile 里写错的 `ENV` 行

## OpenQQ v0.2.0 已释放（2026-11-16）

[+] Linux（x64 / arm64）和 Docker 支持

## OpenQQ v0.1.0 已释放（2026-11-16）

[+] 第一个发布版本：Windows x64 QQ NT 的 OneBot v11 桥接，正向和反向 WebSocket，发送与管理动作，WebUI 控制台，C++ 原生启动器
