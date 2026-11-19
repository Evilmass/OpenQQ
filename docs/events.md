# 接收事件

这里列出已经转换的事件，「有监听回调」不等于所有字段都已适配。发送动作见 [actions.md](actions.md)。

## 已实现

| 事件 | 输出 | 说明 |
| --- | --- | --- |
| 私聊、群聊文本 | `message` | |
| 群临时会话 | `message/private/group` | |
| 图片、表情、混合消息 | `image`、`face` 等消息段 | 收图会自动触发 QQ 下载并补充本地 `path`；开启正向 WS 时附带可访问的 `url`，纯反向 WS 时补充本地路径；也可调用 `get_image` |
| @、语音、视频、回复、JSON/XML 卡片 | 标准消息段 | 回复 ID 与消息、撤回共用同一套映射；`reply` 段只带被引用消息的 id，内容用 `get_msg` 读取 |
| 合并转发 | `forward` 段，`data.content` 带展开后的节点 | 拉取失败时只带 `id`，可以用 `get_forward_msg` 重试 |
| 文件、商城表情、Markdown | 扩展消息段 | 不自动下载 |
| 群内戳一戳 | `notice/notify/poke` | 业务 `1061`；按 UID 解析操作者和目标 |
| 私聊戳一戳 | `notice/notify/poke`，省略 `group_id` | OpenQQ 扩展；`user_id` 始终是操作者 |
| 群聊/私聊撤回 | `group_recall`、`friend_recall` | 读取消息更新里的撤回元素，并关联原消息的 ID；忽略启动前的历史撤回，保留 5 秒时钟容差 |
| 成员加入、退出、被踢、机器人被踢 | `group_increase`、`group_decrease` | 系统推送类型 `33`、`34` |
| 管理员设置/取消 | `group_admin` | 系统推送 `44` |
| 禁言、解禁、全员禁言 | `group_ban` | 来自群灰条；全员禁言时 `user_id=0` |
| 群文件上传 | `group_upload` | 保留客户端文件 UUID、名称、大小和业务 ID |
| 好友新增 | `friend_add` | 来自灰条业务 `19324`，或同步结束后好友列表的变化 |
| 好友删除 | `friend_delete`（扩展） | 来自同步结束后好友列表的差异 |
| 群名片、头衔变化 | `group_card`、`notify/title`（扩展） | 需要先有旧值作为基线，首次加载不算变化 |
| 群名称变化 | `group_name`（扩展） | 群灰条类型 `5` |
| 好友申请 | `request/friend` | 过滤已读、已处理和自己发起的记录；`flag` 为 `f:<UID>:<申请时间>`，可交给 `set_friend_add_request` 处理 |
| 入群申请、邀请机器人入群 | `request/group` | 群通知 `1`、`5`、`7`，未处理状态为 `1`；`flag` 为 `g:<群号>:<通知类型>:<序号>`，可交给 `set_group_add_request` 处理；已接 V2 通知入口 |
| 对方输入状态 | `notify/input_status`（扩展） | 接收 `onInputStatusPush`；不会主动发送输入状态 |
| 被踢下线 | `bot_offline`（扩展） | 接收下线回调并更新运行状态 |

缺少操作者的成员系统事件使用 `operator_id=0`，并附 `openqq_operator_unknown=true`，不会猜成群主或机器人。成员本身的 UID 无法转换成 QQ 号时（刚入群或刚退群的成员常见），OpenQQ 会结合 QQ 推送的群成员列表重试一次；仍然失败就照常上报，`user_id=0` 并附 `openqq_user_unknown=true`，同时记录一条运行诊断。解散群使用 `kick_me`，附 `openqq_reason=disband`。这些降级字段是 OpenQQ 的扩展，使用方需要自己识别。

## 尚未适配

红包运气王、群荣誉、精华消息、表情回应、个人资料点赞、公告、群待办、音视频通话、在线文件传输进度、频道事件，以及其他客户端内部的变化，都还没有逐项适配。OneBot HTTP 接口、SDK 和 MCP 也没有实现。

未识别的聊天灰条输出 `openqq_gray_tip` 扩展并保留原始元素；未识别的消息段输出 `openqq_element`。未知的服务回调只会在标准错误里输出一次 `native_callback` 参数结构摘要，不表示对应事件已经实现。频道等未适配的聊天类型同样只输出结构摘要，不保证能收到完整内容。

## 自己验证

改了代码要重启 OpenQQ 和 QQ：先 Ctrl+C 停掉 OpenQQ，手动退出 QQ，再执行 `npm start`。`session_ready.services` 里应该有 `msg`、`buddy`、`group`。

建议用测试账号依次验证：私聊/群聊戳一戳、撤回、@、媒体、入群与退出、管理员设置/取消、禁言/解禁、好友申请和入群申请。接收事件不会自动回复，也不会自动批准申请；只有明确输入发送动作才会调用 QQ 发送。

启动同步期间不应出现批量的 `friend_add`；等到出现 `sync_state` 且 `syncing=false`，再观察真实的变化。QQ 的原始控制台输出写在 `.runtime/qq.log`，默认不显示；需要排查时输入 `/verbose` 或直接看这个文件。

## 参考

协议依据：[OneBot v11 通知](https://github.com/botuniverse/onebot-11/blob/master/event/notice.md)、[请求](https://github.com/botuniverse/onebot-11/blob/master/event/request.md)、[消息段](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)。原生接口参考了已有项目的声明和字段布局；本项目没有引入或执行它们的运行时，转换逻辑是独立实现的。
