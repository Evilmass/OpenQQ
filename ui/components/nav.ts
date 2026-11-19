import { Activity, Blocks, Braces, Cable, CircleUserRound, ImagePlus, LayoutDashboard, MessagesSquare, ScrollText, Settings, Sparkles, type LucideIcon } from 'lucide-react';

export interface NavItem { path: string; title: string; description: string; icon: LucideIcon; keywords?: string }
export interface NavGroup { id: string; title: string; items: NavItem[] }

export const navGroups: NavGroup[] = [
  { id: 'workspace', title: '工作台', items: [
    { path: '/', title: '概览', description: '会话状态、吞吐与连接健康', icon: LayoutDashboard, keywords: 'dashboard overview home' },
    { path: '/messages', title: '消息', description: '按会话查看和发送消息', icon: MessagesSquare, keywords: 'messages chat send' },
  ] },
  { id: 'bot', title: 'Bot', items: [
    { path: '/bot', title: 'Bot 编程', description: '拖积木编制 Bot，设置人设和记忆', icon: Blocks, keywords: 'bot blocks scratch blockly program memory persona ai 积木 机器人 人设 记忆 广告' },
    { path: '/ai', title: 'AI 接入', description: '填写 API Key 与 Base URL，选择模型', icon: Sparkles, keywords: 'ai api key base url model openai relay zelix 模型 接入' },
    { path: '/image', title: 'AI 生图', description: '用 OpenAI 兼容接口生成图片，默认 api.zelix.asia', icon: ImagePlus, keywords: 'image generate draw picture dall-e gpt-image flux zelix key 生图 画图 绘图 图片' },
  ] },
  { id: 'debug', title: '调试', items: [
    { path: '/events', title: '事件', description: '实时 OneBot 事件与动作回执', icon: Activity, keywords: 'events inspector stream' },
    { path: '/actions', title: 'API 调试', description: '构造并执行 OneBot 动作', icon: Braces, keywords: 'api explorer action json request' },
    { path: '/logs', title: '运行日志', description: '原生挂接与运行诊断', icon: ScrollText, keywords: 'logs diagnostics monitoring' },
  ] },
  { id: 'manage', title: '管理', items: [
    { path: '/account', title: '账号', description: 'QQ 会话与登录状态', icon: CircleUserRound, keywords: 'account qq login session' },
    { path: '/connections', title: '连接', description: 'OneBot WebSocket 接入', icon: Cable, keywords: 'connections onebot websocket token' },
    { path: '/settings', title: '设置', description: '外观、客户端与安全', icon: Settings, keywords: 'settings preferences theme' },
  ] },
];

export const navItems = navGroups.flatMap(group => group.items.map(item => ({ ...item, group })));
export const findNav = (pathname: string) => navItems.find(item => item.path === pathname);
