// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';

// 列表分页：一次渲染多少条 / 滚到底部再追加多少条
const SESSION_PAGE = 50;      // 会话页：一次渲染多少条

const SESSION_KEEP = 400;     // 会话页：内存里最多保留多少条（与请求量一致）

const CHAT_MSG_PAGE = 200;    // 存档页：首次加载条数（也是单次拉取上限，2026-10-29 磁盘风暴复盘）

const CHAT_MSG_MORE = 200;    // 存档页：每次滚动追加

/*
 * 工具的中文名与分类，用于"调用明细"弹窗。
 *
 * 用 emoji 当图标只是为了扫一眼好认 —— 这类"没什么实际用处但有趣"的细节，
 * 是特意保留的：一张纯数字的表格很无聊，分类 + 图标能让人真的去看一眼。
 */
const TOOL_META = {
  // 发言类
  send_message:      { name: '发消息',     cat: '发言',   icon: '💬' },
  send_sticker:      { name: '发表情包',   cat: '发言',   icon: '🎴' },
  send_poke:         { name: '戳一戳',     cat: '发言',   icon: '👆' },
  // 查看类
  get_recent_messages: { name: '翻聊天记录', cat: '查看', icon: '📜' },
  get_message_detail:  { name: '看消息详情', cat: '查看', icon: '🔍' },
  get_message_images:  { name: '看图片',     cat: '查看', icon: '🖼️' },
  get_active_members:  { name: '看活跃群友', cat: '查看', icon: '👥' },
  // 表情包
  list_stickers:     { name: '列表情库',   cat: '表情',   icon: '📚' },
  get_sticker_image: { name: '看表情图',   cat: '表情',   icon: '🖼️' },
  collect_sticker:   { name: '收藏表情',   cat: '表情',   icon: '⭐' },
  sticker_note:      { name: '备注表情',   cat: '表情',   icon: '📝' },
  // 记忆
  memory_append:     { name: '记一条',     cat: '记忆',   icon: '🧠' },
  memory_query:      { name: '查记忆',     cat: '记忆',   icon: '🧠' },
  person_memory_lookup: { name: '查人物记忆', cat: '记忆', icon: '🧠' },
  friend_request_propose: { name: '提议加好友', cat: '记忆', icon: '＋' },
  memory_remove:     { name: '删记忆',     cat: '记忆',   icon: '🧹' },
  // 联网
  web_search:        { name: '联网搜索',   cat: '联网',   icon: '🌐' },
  web_fetch:         { name: '抓网页',     cat: '联网',   icon: '🔗' },
  // 其他
  report_feedback:   { name: '汇报反馈',   cat: '其他',   icon: '📣' },
  finish:            { name: '结束本次',   cat: '其他',   icon: '🏁' }
};

/** 分类的展示顺序（"其他"垫底） */
const TOOL_CAT_ORDER = ['发言', '查看', '表情', '记忆', '联网', '其他'];

/** 用量页的时间范围选项：[传给后端的值, 按钮文案] */
const USAGE_RANGES = [
  ['today', '今日'],
  ['7', '近 7 天'],
  ['30', '近 30 天'],
  ['all', '全部']
];

/* ══════════════════════════════════════════════════════════════
   主题（明/暗/系统）
   ══════════════════════════════════════════════════════════════
   持久化两层：
     1. localStorage —— 立即生效，避免每次启动都等接口
     2. 后端 config.ui.theme —— 跨设备/重装后保留（尽力而为，失败不阻塞）
   首屏防闪由 index.html 的内联脚本负责（读 localStorage 直接设 data-theme）。
*/
// 图标名（ui/icons.js 的 SVG 集）：不再用 emoji —— 各系统渲染形状不一致，也不跟文字颜色
const THEME_ICON = { dark: 'moon', light: 'sun', system: 'monitor' };

const THEME_LABEL = { dark: '暗色', light: '亮色', system: '跟随系统' };

const THEME_VALUES = ['dark', 'light', 'system'];

const STATUS_LABEL = { waiting: '等待中', done: '已发言', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };

const CONVERSATION_MODE_LABEL = { legacy: '传统触发', threaded: '参与者续接', lifecycle: '完整生命周期' };

const THREAD_STATE_LABEL = {
  starting: '启动中',
  engaged: '续接窗口中',
  active: '活跃中',
  listening: '监听中',
  rollover_armed: '等待下一条消息续接',
  closed: '已结束'
};

const TRIGGER_KIND_LABEL = {
  mention: '@ 触发',
  keyword: '关键词触发',
  probability: '传统概率触发',
  all: '全部响应',
  lifecycle: '生命周期续接',
  rollover: '换代续接',
  reply: '引用触发',
  private: '私聊触发',
  manual: '控制台触发',
  proactive: '主动触发',
  retry: '失败重试',
  unknown: '其他触发'
};

// 启动提示默认由 CSS 静态隐藏（html.boot-silent .loading-overlay{opacity:0}），
// 正常进入（哪怕要一两秒）一秒都不会出现；只有超过 LOADING_REVEAL_MS 还没就绪
// （服务没起、协议端连不上、启动卡住）才加上 boot-show 淡入。index.html 里还有一份
// 8 秒兜底，负责"脚本压根没加载成功"时把提示显示出来。
const LOADING_REVEAL_MS = 5000;

const CORE_SERVICE_LINKS = [
  { id: 'agent', name: 'QQ Agent', detail: '当前控制台', port: 3210, mark: 'AG' },
  { id: 'dsh', name: 'DeepSeek Harness', detail: '模型与会话', port: 3080, mark: 'DS' },
  { id: 'bridge', name: 'Bridge Console', detail: '旧架构运维', port: 3100, mark: 'BR' },
  { id: 'snowluma', name: 'SnowLuma', detail: 'QQ 网关', port: 5099, mark: 'SL' },
  { id: 'novnc', name: 'QQ 远程桌面', detail: '登录与客户端维护', port: 6081, mark: 'QQ' }
];

// ── 更新进度：更新器把当前阶段写进状态文件（phase），排队阶段只有 status。
//    这里只做展示，不推断阶段；阶段起点用 progressAt（每次阶段推进都续期）。───────
const UPDATE_PHASE_LABELS = {
  startup: '启动更新器',
  connectivity: '检查网络连通性',
  checking: '检查最新版本',
  testing: '跑部署前测试',
  deploying: '部署（服务会短暂重启）',
  complete: '收尾'
};

const UPDATE_STATUS_LABELS = {
  queued: '等待更新器接手',
  checking: '检查最新版本',
  testing: '跑部署前测试',
  deploying: '部署（服务会短暂重启）'
};

// 「这轮更新在跑」的口径要与更新器一致（src/auto-update.js 的 ACTIVE_STATES）：
// status() 的 busy 只说明更新器进程在（跳过间隔、被禁用这类情形也留个进程），
// 那种时刻状态文件还停在上一轮的终态，单看 busy 会闪出一条"正在更新…收尾"的假进度行。
const UPDATE_ACTIVE_STATUSES = new Set(['queued', 'checking', 'testing', 'deploying']);

// ── AI 资产观测 ──
const ASSET_KINDS = [
  ['stickers', '表情包'],
  ['slang', '黑话'],
  ['slang-research', '黑话研究']
];

const SLANG_RESEARCH_STATUS = {
  pending_research: '待研究审批',
  research_queued: '等待研究',
  researching: '研究中',
  research_interrupted: '研究中断',
  research_failed: '研究失败',
  pending_admission: '待入库审批',
  admitted_candidate: '已加入候选',
  research_rejected: '已拒绝研究',
  admission_rejected: '已拒绝收录'
};

// ── 角色正文的结构化渲染 ──
// 卡正文是 markdown，只给一个大 textarea 太糙：这里解析成分节面板 ——
// 「你的标志」渲染成一排标签、「AI 味黑名单」渲染成打叉标签、示例渲染成聊天气泡，
// 让人一眼看出这张卡会让它怎么说话。保存仍然以 #cfg-roletext 的原文为准（视图只读）。
/** 管理员附加规则的常用例子：点一下就填进去，省得对着空白框发呆。 */
const PERSONA_RULE_EXAMPLES = [
  '别装傻、别反问，不想接就安静',
  '说话短一点，一轮最多两条',
  '被怼只淡淡带过，不还嘴',
  '称呼固定用「老板」',
  '不用网络梗和颜文字'
];

const PERSONA_SECTION_EMOJI = {
  你是谁: '🪪',
  说话方式: '💬',
  偏好: '🍜',
  工具: '🧰',
  分寸: '🧭'
};

const PERSONA_TAG_SECTIONS = /标志|招牌/;

const PERSONA_BAD_SECTIONS = /黑名单|禁止|不要/;

const FRIEND_PROPOSAL_STATUS = {
  pending: '待审批',
  approved_manual: '已批准 · 待手动执行',
  dispatching: '发送中',
  sent: '已提交申请',
  held_unknown: '发送结果未知',
  failed: '发送失败',
  accepted: '已成为好友',
  rejected: '已拒绝'
};

const FRIEND_PROPOSAL_REASON = {
  interest: '感兴趣',
  frequent: '互动频繁',
  banter: '想继续互怼'
};

const FRIEND_OPPORTUNITY_STATUS = {
  lottery_miss: '抽签未命中',
  review_budget: '评估预算已满',
  queued: '等待评估',
  reviewing: '评估中',
  skipped: '模型跳过',
  proposed: '已生成候选',
  review_failed: '评估失败',
  cancelled: '已取消',
  expired: '队列过期',
  interrupted: '重启中断'
};

const INCOMING_FRIEND_STATUS = {
  pending: '待审批',
  deciding: '处理中',
  approved: '已同意 · 等待好友事件',
  held_unknown: '处理结果未知',
  failed: '处理失败',
  accepted: '已成为好友',
  rejected: '已拒绝'
};

const INCIDENT_SEVERITY_LABELS = {
  info: '信息', warning: '警告', error: '错误', critical: '严重'
};

const INCIDENT_STATE_LABELS = {
  open: '待处理', acknowledged: '已确认', resolved: '已解决'
};

const TIME_RULE_LABELS = {
  inherit: '继承全局', 'deepseek-offpeak': 'DS 低峰时段',
  custom: '自定义时段', always: '全天活跃'
};

const TIME_DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const MOMENT_STATUS_LABELS = {
  running: '生成中', preview: '草稿', skipped: '决定不发布',
  publishing: '发布中', published: '已发布', 'publish-unknown': '发布结果待核对',
  'publish-missed': '已核对 · 确认未发出',
  failed: '生成失败', interrupted: '生成已中断', deferred: '等待活跃时间',
  missed: '已错过窗口', cancelled: '已取消', pending: '待执行'
};

const QZONE_RUN_LABELS = {
  running: '运行中',
  baseline: '已建立初始基线',
  idle: '没有新内容',
  done: '已完成',
  'partial-unknown': '部分结果待核对',
  'partial-feed-error': '好友动态未取到',
  failed: '执行失败',
  interrupted: '执行中断',
  deferred: '等待活跃时间'
};

const QZONE_ACTION_LABELS = {
  like: '点赞',
  comment: '评论',
  reply: '回复'
};

// 表情包积极程度档位：[值, 显示名]
const STICKER_LEVELS = [
  [0, '0 · 不鼓励（只在很贴切时偶尔用）'],
  [1, '1 · 偶尔（合适时配一张）'],
  [2, '2 · 较积极（优先考虑配图）'],
  [3, '3 · 很积极（表情包爱好者）']
];

// 模型连接的「服务预设」展示层（行为以服务端 src/core/provider-presets.js 为准；
// 这里只负责下拉选项、预填地址、档位提示的文案。档位/来源与那边一一对应）。
const MODEL_SERVICES_UI = [
  { id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', hosts: ['api.deepseek.com'], levels: ['off', 'low', 'high', 'max'], canDisable: true,
    defaultNote: '默认开启思考、档位默认 high（官方文档）',
    note: '可关闭；档位 low / high / max。模型例：deepseek-flash（V4.1 Flash，支持图片）/ deepseek-v4-pro。' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', hosts: ['open.bigmodel.cn', 'api.z.ai'], levels: ['off', 'low', 'high', 'max'], canDisable: true,
    note: '档位 low/high/max（GLM-5.3 系官方枚举）；默认开启思考、档位默认 max。GLM-5.3 系与 4.7/4.5V 强制思考、关不掉（会被安全兜底忽略）。模型例：glm-5.3-flash（若「获取列表」拉不到就手填）。' },
  { id: 'qwen', label: '通义千问（百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hosts: ['dashscope.aliyuncs.com'], levels: ['off', 'low', 'medium', 'max'], canDisable: null,
    defaultNote: '混合思考模型随模型；qwen3.8-omni-flash 默认 xhigh',
    note: '官方文档：enable_thinking 可关；档位仅 qwen3.8-omni-flash 支持（低/中/最高=low/medium/max，官方把 high/max 映射到 xhigh）；其他模型用 thinking_budget（走「额外请求参数」）。模型例：qwen-max / qwen3-*。' },
  { id: 'openai', label: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', hosts: ['api.openai.com'], levels: ['off', 'low', 'medium', 'high', 'max'], canDisable: null,
    defaultNote: '默认随模型（如 gpt-5.5 默认 medium）',
    note: '档位与 none（关闭）随模型不同（官方文档）；不支持 none 的模型会 400，会被安全兜底自动去掉重试。模型例：gpt-5.x 系列。' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', hosts: ['api.siliconflow.cn'], levels: ['off', 'high', 'max'], canDisable: true,
    defaultNote: '推理模式下默认 high（复杂 Agent 请求自动用 max）',
    note: '官方文档：enable_thinking 可关、thinking_budget 限思维链（走「额外请求参数」）；档位仅 high/max（点名 DeepSeek-V4、V4-Flash、GLM-5.2；low/medium 官方映射到 high）。模型形如 deepseek-ai/DeepSeek-V3、Qwen/Qwen3-*。' },
  { id: 'commandcode', label: 'Command Code（聚合网关 / Token Plan）', baseUrl: 'https://api.commandcode.ai/provider/v1', hosts: ['api.commandcode.ai'], levels: ['low', 'medium', 'high', 'max'], canDisable: false,
    note: '实测：关不掉思考——界面不提供「关闭」，要最低思考选「低」（发的是同一个值）。默认档位高于 low。模型例：deepseek/deepseek-v4.1-flash、z-ai/glm-5.3-flash。' },
  { id: 'opendesign', label: 'OpenDesign（amr-link 网关）', baseUrl: 'https://amr-link.open-design.ai/v1', hosts: ['amr-link.open-design.ai'], levels: ['off', 'low', 'high', 'max'], canDisable: null,
    defaultNote: '随模型（实测：deepseek 系默认思考、glm-5.3 系默认低思考）',
    note: '实测：deepseek 系可关（none 真正关闭）、档位 low/medium/high/xhigh/max；glm-5.3 系只认 low/high/max（none 与 medium 会 400，由安全兜底自动摘参重试）。界面只列两端都通的 off/low/high/max。模型例：deepseek-v4.1-flash、glm-5.3-flash。' },
  { id: 'opencode', label: 'OpenCode（Go 订阅）', baseUrl: 'https://opencode.ai/zen/go/v1', hosts: ['opencode.ai', 'api.opencode.ai'], levels: ['low', 'medium', 'high', 'max'], canDisable: null,
    defaultNote: '随模型（官方客户端文档：OpenAI 系约 none…xhigh）',
    note: '官方文档（客户端）：用 OpenAI 风格 reasoningEffort（Anthropic 系则是 thinking.budgetTokens）；但 Zen/Go 的 API 请求字段未文档化——先「测试思考能力」实测，不接受会被安全兜底自动去掉。Go 订阅模型名形如 opencode-go/xxx；非 Go 订阅改地址为 https://zen/v1 见官网。' },
  { id: 'custom', label: '自定义 / 自建（OpenAI 兼容）', baseUrl: '', hosts: [], levels: [], canDisable: null,
    note: '表外渠道：填你的服务地址；档位可在「自定义档位映射」里自定义（填了就会出档位条），其余参数用「额外请求参数」。' }
];

/** 按任务分设的四条：聊天 / 判断 · 总结 / 写作 / 其他；每条都含「默认」。 */
const THINKING_PURPOSES = [
  { key: 'chat', label: '聊天' },
  { key: 'judge', label: '判断 · 总结' },
  { key: 'write', label: '写作' },
  { key: 'default', label: '其他任务' }
];

// 语音识别服务预设：选一下把 provider / 地址填好，模型一律**从服务商官网拉**（见「获取模型列表」）——
// 写死的模型名会过时（用户明确要求：硅基流动上了新的免费模型，预设跟不上）。
// 事实核查于 2026-09-26（见 docs/CONFIG-EXAMPLES.md）：硅基流动的 SenseVoiceSmall 标"免费"、国内可直连；
// Groq 有免费额度。这里只提供入口，实际可用模型以官网列表为准。
const ASR_SERVICES = [
  { id: 'siliconflow', label: '硅基流动（免费模型，国内可直连）', provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', creds: ['key'], needsBaseUrl: true, note: '注册拿一个 Key 就能用；SenseVoiceSmall 此前标免费，其余模型是否免费以官网价目表为准。' },
  { id: 'aliyun', label: '阿里云百炼（qwen3-asr-flash，新用户有免费额度）', provider: 'aliyun', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', creds: ['key'], needsBaseUrl: true, note: '百炼的 API Key；模型默认 qwen3-asr-flash，可点「获取模型列表」换。' },
  { id: 'iflytek', label: '讯飞语音听写（每日 500 次免费）', provider: 'iflytek', baseUrl: '', creds: ['appId', 'key', 'secretKey'], needsBaseUrl: false, note: '讯飞控制台「语音听写」的三个值：AppID、APIKey、APISecret（APISecret 填在「APISecret」框）。' },
  { id: 'tencent', label: '腾讯云一句话识别（每月 5000 次免费）', provider: 'tencent', baseUrl: '', creds: ['secretId', 'secretKey'], needsBaseUrl: false, note: '腾讯云访问密钥里的 SecretId 与 SecretKey（不是 API Key）；地域默认广州。' },
  { id: 'baidu', label: '百度短语音识别（个人 5 万次免费）', provider: 'baidu', baseUrl: '', creds: ['key', 'secretKey'], needsBaseUrl: false, note: '百度语音应用的 API Key；老的「API Key + Secret Key」还要填 Secret Key（新的 bce-v3 Key 只填 API Key）。' },
  { id: 'volc', label: '火山引擎 · 大模型录音识别（Seed-ASR，按量计费）', provider: 'volc', baseUrl: '', creds: ['key'], needsBaseUrl: false, note: '火山语音技术的 API Key；走它自己的协议（不用选模型）。' },
  { id: 'groq', label: 'Groq（有免费额度）', provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', creds: ['key'], needsBaseUrl: true, note: '给 whisper-large-v3-turbo 用；国内可否直连未确认。' },
  { id: 'openai', label: 'OpenAI 官方（按量计费）', provider: 'openai', baseUrl: 'https://api.openai.com/v1', creds: ['key'], needsBaseUrl: true, note: '国内多数网络直连不通，需要中转。' },
  { id: 'custom', label: '自定义 / 自建（OpenAI 兼容）', provider: 'openai', baseUrl: '', creds: ['key'], needsBaseUrl: true, note: '任何 OpenAI 兼容的转写服务：填地址 + 模型名即可。' }
];


export {
  ASR_SERVICES, ASSET_KINDS, CHAT_MSG_MORE, CHAT_MSG_PAGE, CONVERSATION_MODE_LABEL, CORE_SERVICE_LINKS,
  FRIEND_OPPORTUNITY_STATUS, FRIEND_PROPOSAL_REASON, FRIEND_PROPOSAL_STATUS, INCIDENT_SEVERITY_LABELS,
  INCIDENT_STATE_LABELS, INCOMING_FRIEND_STATUS, LOADING_REVEAL_MS, MODEL_SERVICES_UI, MOMENT_STATUS_LABELS,
  PERSONA_BAD_SECTIONS, PERSONA_RULE_EXAMPLES, PERSONA_SECTION_EMOJI, PERSONA_TAG_SECTIONS,
  QZONE_ACTION_LABELS, QZONE_RUN_LABELS, SESSION_KEEP, SESSION_PAGE, SLANG_RESEARCH_STATUS, STATUS_LABEL,
  STICKER_LEVELS, THEME_ICON, THEME_LABEL, THEME_VALUES, THINKING_PURPOSES,
  THREAD_STATE_LABEL, TIME_DAYS, TIME_RULE_LABELS, TOOL_CAT_ORDER, TOOL_META, TRIGGER_KIND_LABEL,
  UPDATE_ACTIVE_STATUSES, UPDATE_PHASE_LABELS, UPDATE_STATUS_LABELS, USAGE_RANGES
};