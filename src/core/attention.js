// 注意力层：在正式回复之前，用一个低成本模型判断这批新消息值不值得开口。
//
// 设计边界：
//   · 只做“判定”，不扮演角色、不生成回复；
//   · 输入只带收件箱（最近消息 + 本批新消息 + 交接摘要 + 短人设），不带工具表；
//   · 输出严格 JSON，解析失败由调用方回落到概率或忽略；
//   · 不读写存储，调用方负责时间控制、预算、缓存与已读标记。
import { repairJsonObject } from './json-repair.js';
import { displayNameOf } from './display-name.js';

export const ATTENTION_ATTENDS = Object.freeze(['ignore', 'peek', 'reply']);

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function messageLine(m) {
  const who = m?.self ? '我' : (displayNameOf(m?.senderId, m?.senderName) || '某人');
  const mid = m?.mid ?? m?.id;
  return `#${mid ?? '?'} ${who}：${clip(m?.text, 200)}`;
}

export function buildAttentionMessages({
  persona = {},
  selfNickname = '',
  entries = [],
  contextMessages = [],
  handoff = null,
  maxInputChars = 4000
} = {}) {
  const name = String(selfNickname || persona.selfNickname || persona.botName || '机器人').trim();
  const role = clip(persona.roleText || persona.system || '', 500);
  const system = [
    '你是 QQ 群聊的注意力判定器，不扮演角色、不写回复。',
    '判断机器人现在是否应该参与这批新消息。',
    '规则：',
    '- 明确叫它（@、引用、点名）或与它正在参与的话题直接相关 → reply。',
    '- 有可接的梗、新信息、明确的问题，且此时插话自然 → reply。',
    '- 只是别人之间的闲聊、别人已经答好、话题与它无关、它刚说过很多 → ignore。',
    '- 不确定时 ignore；不要为了显得活跃而回复。',
    '- 如果现有上下文不够判断，可以 attend=peek，并给 readCount（1-100，想额外读多少条）。',
    '只输出严格 JSON，不要 Markdown：',
    '{"attend":"ignore|peek|reply","readCount":0,"confidence":0.0,"reason":"不超过40字"}'
  ].join('\n');

  const parts = [`【机器人】${name}`];
  if (role) parts.push(`【人设摘要】${role}`);
  if (handoff?.topic || handoff?.summary) {
    parts.push(`【上次交接】${clip([handoff.topic, handoff.summary].filter(Boolean).join('；'), 600)}`);
  }
  const context = (Array.isArray(contextMessages) ? contextMessages : [])
    .filter((m) => m && m.eventKind !== 'game-secret')
    .slice(-Math.max(0, Number(contextMessages.length) || 20));
  if (context.length) parts.push(`【最近消息】\n${context.map(messageLine).join('\n')}`);
  const fresh = (Array.isArray(entries) ? entries : [])
    .filter((m) => m && m.eventKind !== 'game-secret');
  if (fresh.length) parts.push(`【本批新消息】\n${fresh.map(messageLine).join('\n')}`);

  let user = parts.join('\n\n');
  const cap = Math.max(500, Number(maxInputChars) || 4000);
  if (user.length > cap) user = `${user.slice(0, cap)}…`;
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    name
  };
}

/** 解析判定 JSON；形状不对返回 null（调用方回落概率/忽略）。 */
export function parseAttentionDecision(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = repairJsonObject(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const attend = String(parsed.attend || '').trim().toLowerCase();
  if (!ATTENTION_ATTENDS.includes(attend)) return null;
  const readCountRaw = Number(parsed.readCount);
  const confidenceRaw = Number(parsed.confidence);
  return {
    attend,
    readCount: Number.isFinite(readCountRaw)
      ? Math.min(100, Math.max(0, Math.round(readCountRaw)))
      : 0,
    confidence: Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0.5,
    reason: clip(parsed.reason, 80) || '未说明'
  };
}

/** 判定是否达到“可以回”的置信度。 */
export function attentionShouldReply(decision, minConfidence = 0.55) {
  if (!decision || decision.attend !== 'reply') return false;
  return Number(decision.confidence) >= Number(minConfidence);
}

/** 主回复读取多少条历史：优先用模型给的 readCount，否则用配置默认值。 */
export function attentionContextCount(decision, fallback = 40) {
  const n = Number(decision?.readCount);
  if (Number.isFinite(n) && n > 0) return Math.min(300, Math.round(n));
  return Math.min(300, Math.max(1, Number(fallback) || 40));
}
