// 记忆激活打分：把“相似度/词法/重要度/近因/频率/情境”合成一个可解释的召回分数。
// 纯函数；候选生成（FTS/embedding）在存储层完成，这里只负责排序。
import { keywordMatchesQuery } from './memory-text.js';

export const DEFAULT_ACTIVATION_WEIGHTS = Object.freeze({
  similarity: 0.35,
  lexical: 0.25,
  importance: 0.20,
  recency: 0.10,
  frequency: 0.05,
  context: 0.05
});

const clamp01 = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};
const DAY_MS = 86400000;

/**
 * 归一化权重：全部非负，和为 1。
 * 没有 embedding 时把 similarity 的权重并给 lexical —— 不引入向量也能用同一套公式。
 */
export function normalizeActivationWeights(raw = {}, { hasEmbedding = false } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of Object.keys(DEFAULT_ACTIVATION_WEIGHTS)) {
    out[key] = Math.max(0, Number(source[key] ?? DEFAULT_ACTIVATION_WEIGHTS[key]) || 0);
  }
  if (!hasEmbedding) {
    out.lexical += out.similarity;
    out.similarity = 0;
  }
  const total = Object.values(out).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { ...DEFAULT_ACTIVATION_WEIGHTS, similarity: hasEmbedding ? 0.35 : 0, lexical: hasEmbedding ? 0.25 : 0.60 };
  for (const key of Object.keys(out)) out[key] /= total;
  return out;
}

/** 情境匹配：当事人相关 + 话题关键词 + 同会话。 */
export function contextMatchScore(entry = {}, context = {}) {
  let score = 0;
  const subject = String(entry.subjectUserId || entry.userId || '');
  const relevant = new Set((context.relevantUserIds || []).map(String));
  const mentioned = new Set((context.mentionedUserIds || []).map(String));
  if (subject && relevant.has(subject)) score += 0.5;
  else if (subject && mentioned.has(subject)) score += 0.3;

  const topic = String(context.topicText || '');
  if (topic) {
    const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
    if (keywords.some((kw) => keywordMatchesQuery(kw, topic))) score += 0.3;
  }

  const entryChat = String(entry.chatKey ?? entry.sourceChatKey ?? '');
  if (entryChat && context.chatKey && entryChat === String(context.chatKey)) score += 0.2;
  return clamp01(score);
}

/**
 * 单条候选的激活分数。
 * entry: { importance, lastSeenAt, seenCount, subjectUserId, userId, keywords, chatKey }
 */
export function activationScore(entry = {}, {
  similarity = 0,
  lexical = 0,
  context = {},
  weights = {},
  now = Date.now(),
  tauRecallDays = 7
} = {}) {
  const sim = clamp01(similarity);
  const w = normalizeActivationWeights(weights, { hasEmbedding: sim > 0 });
  const importance = Math.min(1, Math.max(0, (Math.round(Number(entry.importance) || 3) || 3) / 5));
  const last = Number(entry.lastSeenAt ?? entry.updatedAt ?? 0) || 0;
  const idleDays = last > 0 ? Math.max(0, Number(now) - last) / DAY_MS : 999;
  const recency = Math.exp(-idleDays / Math.max(1, Number(tauRecallDays) || 7));
  const seen = Math.max(1, Number(entry.seenCount) || 1);
  const frequency = Math.min(1, Math.log1p(seen - 1) / Math.log1p(19));   // seen=1→0, 20→1
  const ctx = contextMatchScore(entry, context);

  const parts = {
    similarity: w.similarity * sim,
    lexical: w.lexical * clamp01(lexical),
    importance: w.importance * importance,
    recency: w.recency * recency,
    frequency: w.frequency * frequency,
    context: w.context * ctx
  };
  const score = Object.values(parts).reduce((sum, value) => sum + value, 0);
  return { score: Math.round(score * 10000) / 10000, parts, contextMatch: ctx };
}

/**
 * 批量排序。similarityOf / lexicalOf 是 (entry) => number 的回调；
 * 固定候选（精确记忆）不经过阈值过滤，由调用方单独合并。
 */
export function rankCandidates(entries = [], {
  similarityOf = () => 0,
  lexicalOf = () => 0,
  context = {},
  weights = {},
  minScore = 0.25,
  limit = 8,
  now = Date.now(),
  tauRecallDays = 7
} = {}) {
  const seen = new Set();
  const scored = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = String(entry?.id ?? '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const similarity = clamp01(similarityOf(entry));
    const lexical = clamp01(lexicalOf(entry));
    const result = activationScore(entry, {
      similarity,
      lexical,
      context,
      weights,
      now,
      tauRecallDays
    });
    if (result.score < Number(minScore)) continue;
    scored.push({
      ...entry,
      similarity,
      lexical,
      activationScore: result.score,
      scoreParts: result.parts,
      contextMatch: result.contextMatch
    });
  }
  scored.sort((a, b) => b.activationScore - a.activationScore);
  return scored.slice(0, Math.max(1, Number(limit) || 8));
}
