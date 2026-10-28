// 每日长期记忆抽取：消息抽样、提示词、模型输出校验。
// 纯函数为主，不直接调模型；调用方（DailyMemoryManager）负责 LLM 与记账。
//
// 原则：
//   - 只提炼“以后还用得上”的约定/决定/事实/事件/人物关键事实；
//   - 暗号/口令原文保留，不翻译不改写；
//   - 模型输出 delete 一律忽略；merge/supersede 必须指向已有条目；
//   - privacy 只收模型的初判，最终作用域由 memory-privacy 归一化。
import { repairJsonObject } from '../core/json-repair.js';
import { sanitizeUserText, ZONE_OFFSET_MS } from '../core/util.js';
import { normalizeForHash } from './memory-text.js';

export const EXTRACTION_PROMPT_VERSION = 'daily-memory-extract-v1';
export const DAILY_MEMORY_KINDS = Object.freeze([
  'convention', 'decision', 'fact', 'event', 'person_fact', 'person_preference'
]);
const KIND_SET = new Set(DAILY_MEMORY_KINDS);
const OPERATIONS = new Set(['create', 'merge', 'skip', 'supersede', 'delete']);
const KIND_ALIAS = {
  rule: 'convention',
  rules: 'convention',
  plan: 'decision',
  plans: 'decision',
  preference: 'person_preference',
  preferences: 'person_preference',
  profile: 'person_fact'
};
const PRIORITY_RE = /(暗号|口令|密码|约定|以后|记住|别忘|规则|决定|说好|叫我|称呼|生日|过敏|喜欢|讨厌|雷点|怕|不吃|不能吃)/;

const clean = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const clamp01 = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};
const validUid = (value) => /^\d{1,15}$/.test(String(value ?? '').trim());
const cleanList = (value, maxItems = 8, maxChars = 200) => {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const text = clean(item, maxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
};

function shanghaiClock(ts) {
  const at = Number(ts) || 0;
  if (!at) return '';
  const iso = new Date(at + ZONE_OFFSET_MS).toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

export function normalizeKind(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const kind = KIND_ALIAS[raw] || raw;
  return KIND_SET.has(kind) ? kind : '';
}

/** 单条消息渲染成抽取提示词里的一行。 */
export function renderTranscriptMessage(message = {}) {
  const text = sanitizeUserText(String(message.text ?? '').replace(/\s+/g, ' ').trim()).slice(0, 600);
  if (!text) return '';
  const who = message.self
    ? '我'
    : `${clean(message.senderName || message.senderId || '某人', 40)}(${String(message.senderId || '')})`;
  return `#${Number(message.id) || 0} [${shanghaiClock(message.ts)}] ${who}: ${text}`;
}

/**
 * 抽样：始终保留最近一半；其余名额优先给含约定/记忆关键词的行，再均匀补足。
 * 返回按 id 升序的消息数组与省略条数。
 */
export function selectTranscriptMessages(messages = [], {
  maxMessages = 300, maxChars = 8000, maxScan = 2000
} = {}) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && Number(message.id) > 0)
    .filter((message) => String(message.eventKind || 'message') !== 'game-secret')
    .filter((message) => String(message.text || '').trim())
    .slice(-clampInt(maxScan, 10, 20000, 2000));
  const limit = clampInt(maxMessages, 2, 2000, 300);
  if (list.length <= limit) return { messages: list, omitted: 0 };

  const recentCount = Math.floor(limit / 2);
  const recent = list.slice(-recentCount);
  const older = list.slice(0, -recentCount);
  const picked = new Set(recent.map((message) => Number(message.id)));
  const priority = older.filter((message) => PRIORITY_RE.test(String(message.text || '')));

  for (const message of priority) {
    if (picked.size >= limit) break;
    picked.add(Number(message.id));
  }
  const remaining = limit - picked.size;
  if (remaining > 0) {
    const pool = older.filter((message) => !picked.has(Number(message.id)));
    if (pool.length <= remaining) {
      for (const message of pool) picked.add(Number(message.id));
    } else {
      const step = pool.length / remaining;
      for (let i = 0; i < remaining; i += 1) {
        picked.add(Number(pool[Math.floor(i * step)].id));
      }
    }
  }

  const selected = list.filter((message) => picked.has(Number(message.id)));
  // 字符预算：从最近往回收，保证最新消息一定在；超预算的老消息丢弃。
  const charsCap = clampInt(maxChars, 500, 200000, 8000);
  const kept = [];
  let used = 0;
  for (const message of [...selected].reverse()) {
    const line = renderTranscriptMessage(message);
    const cost = line.length + (kept.length ? 1 : 0);
    if (kept.length && used + cost > charsCap) break;
    kept.push(message);
    used += cost;
  }
  kept.reverse();
  return { messages: kept, omitted: list.length - kept.length };
}

/** 已有条目压缩成去重上下文，控制条数与字符。 */
export function buildExistingForDedup(entries = [], maxItems = 60) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && Number(entry.id) > 0)
    .slice(0, clampInt(maxItems, 1, 200, 60))
    .map((entry) => ({
      id: Number(entry.id),
      kind: String(entry.kind || ''),
      subject: clean(entry.subject, 60),
      abstract: clean(entry.abstract, 160)
    }));
}

function systemPrompt() {
  return [
    '你是群聊长期记忆抽取器。只提炼“以后跨天、跨会话还用得上”的内容，不写流水账。',
    '',
    '输出严格 JSON，不要 Markdown。结构：',
    '{"summary":{"overview":"一句话","summary":"- 主题","details":"可选"},"entries":[...]}',
    '',
    'entry 字段：',
    '- operation: create | merge | skip | supersede（禁止 delete；删除只由管理员执行）',
    '- scope: chat | person；chat=群/会话级约定或事实，person=关于某个群友的关键事实',
    '- kind: convention | decision | fact | event | person_fact | person_preference',
    '- subject: 合并主题键（暗号/群规/开黑/生日/称呼/过敏…），同一主题必须复用同一写法',
    '- abstract: 注入用短句，≤120 字；暗号/口令必须原文出现',
    '- content: 完整陈述，≤500 字；gist 可写得粗，但不能编造',
    '- importance: 1-5；confidence: 0-1；keywords: 2-6 个检索线索；evidence_message_ids: 消息前的 #id',
    '- userId: person 作用域必填（数字 QQ）；target: 显示名',
    '- privacy: {"scope_guess":"knowledge|chat|person|secret","subject_user_id":"","sensitivity":"low|medium|high","confidence":0-1,"reason":"一句话"}',
    '',
    '隐私初判规则：',
    '- 通用语言/游戏黑话、无个人标识 → knowledge；',
    '- 群约定/群规/暗号 → chat；',
    '- 关于某人的健康/偏好/生日等 → person；',
    '- 凭据、联系方式、住址、明确“别告诉别人”、健康/财务/家庭敏感信息 → secret。',
    '判不准时 confidence 写低，系统会按最严格处理。',
    '',
    '去重规则：',
    '- 已有记忆里有的内容 → skip；',
    '- 同主题补充 → merge + targetId；',
    '- 同主题被新事实取代 → supersede + targetId；',
    '- 全新 → create。',
    '',
    '只提炼：会话约定/暗号/群规/固定安排、人物关键事实、值得记住的事件。',
    '不写性格评价、不写流水账、不猜测、不编造；没有可记的就输出空 entries。'
  ].join('\n');
}

/**
 * 构建抽取请求消息。existing 由 buildExistingForDedup 生成。
 */
export function buildExtractionPrompt({
  chatKey = '', chatName = '', day = '', messages = [], existing = [],
  maxMessages = 300, maxChars = 8000, maxScan = 2000
} = {}) {
  const selected = selectTranscriptMessages(messages, { maxMessages, maxChars, maxScan });
  const lines = selected.messages.map(renderTranscriptMessage).filter(Boolean);
  const transcript = lines.length ? lines.join('\n') : '（没有可用的消息）';
  const existingText = existing.length
    ? existing.map((entry) => `- id=${entry.id} [${entry.kind}] ${entry.subject}: ${entry.abstract}`).join('\n')
    : '（暂无）';
  const omitted = selected.omitted > 0 ? `\n（较早的 ${selected.omitted} 条消息已省略）` : '';
  return [
    { role: 'system', content: systemPrompt() },
    {
      role: 'user',
      content: [
        `会话：${clean(chatName, 60) || clean(chatKey, 60)}（${chatKey}）`,
        `日期：${day || '（未知）'}`,
        '',
        '【已有记忆】',
        existingText,
        '',
        '【聊天记录】',
        `${transcript}${omitted}`
      ].join('\n')
    }
  ];
}

function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const repaired = repairJsonObject(candidate);
    return repaired || null;
  }
}

function normalizePrivacyGuess(raw, kind, scope) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const scopeGuess = clean(value.scope_guess || value.scope, 20).toLowerCase();
  const validScope = ['knowledge', 'chat', 'person', 'secret'].includes(scopeGuess)
    ? scopeGuess
    : (scope === 'person' || String(kind).startsWith('person_') ? 'person' : 'chat');
  const hasConfidence = value.confidence !== undefined && value.confidence !== null
    && String(value.confidence).trim() !== '';
  return {
    scope_guess: validScope,
    subject_user_id: clean(value.subject_user_id || value.userId || '', 20),
    sensitivity: ['low', 'medium', 'high'].includes(String(value.sensitivity))
      ? String(value.sensitivity)
      : 'low',
    // 模型常省略 confidence；有明确 scope_guess 时按“尚可”处理，而不是一律当 0 降成 secret。
    confidence: hasConfidence ? clamp01(value.confidence, 0) : 0.7,
    reason: clean(value.reason, 160)
  };
}

/**
 * 校验模型输出。坏条目丢弃（不整轮失败），返回可用于 store.applyExtraction 的结果。
 * @param {string|object} raw 模型文本或已解析对象
 * @param {{messageIds?:Array<number|string>, existing?:Array<object>, config?:object}} options
 * @returns {{summary:object, entries:Array, rejected:Array<{index:number, reason:string}>}}
 */
export function parseExtractionResult(raw, {
  messageIds = [], existing = [], config = {}
} = {}) {
  const parsed = typeof raw === 'string' ? extractJsonObject(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { summary: {}, entries: [], rejected: [{ index: -1, reason: '不是合法 JSON 对象' }] };
  }
  const abstractMaxChars = clampInt(config.abstractMaxChars, 20, 500, 120);
  const contentMaxChars = clampInt(config.contentMaxChars, 50, 2000, 500);
  const minConfidence = clamp01(config.minConfidence, 0.4);
  const allowedMessageIds = new Set((messageIds || []).map((id) => String(Number(id))).filter((id) => id !== '0'));
  const existingIds = new Set((existing || []).map((entry) => String(Number(entry.id))).filter((id) => id !== '0'));

  const summary = {
    overview: clean(parsed.summary?.overview, clampInt(config.summaryOverviewChars, 20, 1000, 200)),
    summary: clean(parsed.summary?.summary, clampInt(config.summaryMaxChars, 100, 8000, 1200)),
    details: clean(parsed.summary?.details, clampInt(config.summaryMaxChars, 100, 8000, 1200) * 2)
  };
  const entries = [];
  const rejected = [];
  const seen = new Set();
  const list = Array.isArray(parsed.entries) ? parsed.entries : [];

  list.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejected.push({ index, reason: '不是对象' });
      return;
    }
    const operation = String(item.operation || 'create').trim().toLowerCase();
    if (!OPERATIONS.has(operation)) {
      rejected.push({ index, reason: 'operation 非法' });
      return;
    }
    if (operation === 'delete' || operation === 'skip') return;

    const kind = normalizeKind(item.kind);
    if (!kind) {
      rejected.push({ index, reason: 'kind 非法' });
      return;
    }
    const abstract = clean(item.abstract, abstractMaxChars);
    if (!abstract) {
      rejected.push({ index, reason: 'abstract 为空' });
      return;
    }
    const content = clean(item.content, contentMaxChars);
    const confidence = clamp01(item.confidence, 0.7);
    if (confidence < minConfidence) {
      rejected.push({ index, reason: '置信度不足' });
      return;
    }
    const importance = clampInt(item.importance, 1, 5, 3);
    const rawScope = String(item.scope || '').trim().toLowerCase();
    const scope = rawScope === 'person' || kind.startsWith('person_') ? 'person' : 'chat';
    const userId = clean(item.userId || item.user_id || item.privacy?.subject_user_id, 20);
    if (scope === 'person' && !validUid(userId)) {
      rejected.push({ index, reason: 'person 缺少有效 userId' });
      return;
    }
    const targetId = Number(item.targetId ?? item.target_id ?? 0);
    if ((operation === 'merge' || operation === 'supersede') && !existingIds.has(String(targetId))) {
      rejected.push({ index, reason: `${operation} 的 targetId 不存在` });
      return;
    }
    const subject = clean(item.subject, 60) || kind;
    const key = `${scope}|${kind}|${subject}|${normalizeForHash(content || abstract)}`;
    if (seen.has(key)) {
      rejected.push({ index, reason: '同批次重复' });
      return;
    }
    seen.add(key);

    const evidence = (Array.isArray(item.evidence_message_ids) ? item.evidence_message_ids : [])
      .map((id) => String(Number(id)))
      .filter((id) => allowedMessageIds.has(id))
      .slice(0, 20);
    const keywords = cleanList(item.keywords, 6, 40);
    entries.push({
      operation: operation === 'create' ? 'create' : operation,
      scope,
      kind,
      subject,
      abstract,
      content,
      importance,
      confidence,
      userId: validUid(userId) ? userId : '',
      target: clean(item.target, 60),
      keywords,
      evidence_message_ids: evidence,
      privacy: normalizePrivacyGuess(item.privacy, kind, scope),
      ...(operation === 'merge' || operation === 'supersede' ? { targetId } : {})
    });
  });

  return { summary, entries, rejected };
}
