// 梗/黑话词库的唯一读写层（slang.json）。
//
// 为什么单独一层：这个库现在有两个入口 —— 控制台资产页（人工维护）和
// meme_lookup 工具（模型按需查询、外部结果进 candidate）。两边必须用同一套
// 归一化与去重口径，否则同一个词会以 "开香槟" / "开 香槟" / 别名 的形态
// 各存一行，候选库越用越脏。
//
// 作用域字段（scope/scopeChatKey）保留只是为了读旧数据；新工具不再按群隔离：
// 梗来源是公开网络内容，不存在群隐私问题。旧 chat-private 条目仍按原样保存，
// 但查询时不做过滤（用户 2026-10-22 明确要求）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const MAX_CONTENT = 80;
const MAX_MEANING = 500;
const MAX_USAGE = 300;
const MAX_ALIAS = 40;
const MAX_ALIASES = 12;
const MAX_SOURCE = 40;
const MAX_URL = 500;

export function cleanText(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 词条归一化：NFKC + 小写 + 去首尾引号/括号/标点，用于精确匹配与去重。 */
export function normalizeTerm(value) {
  return cleanText(value, MAX_CONTENT)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[\s"'“”‘’「」『』【】\[\]（）()<>《》]+/, '')
    .replace(/[\s"'“”‘’「」『』【】\[\]（）()<>《》]+$/, '')
    .replace(/\s+/g, ' ');
}

function clampConfidence(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function normalizeAliases(value, content = '') {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set([normalizeTerm(content)].filter(Boolean));
  const out = [];
  for (const item of list) {
    const alias = cleanText(item, MAX_ALIAS);
    const key = normalizeTerm(alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

function normalizeSource(value) {
  const source = cleanText(value, MAX_SOURCE).toLowerCase();
  return /^[\p{L}\p{N}][\p{L}\p{N}:_-]*$/u.test(source) ? source : 'ai';
}

function normalizeUrl(value) {
  const raw = cleanText(value, MAX_URL);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function slangFile(dataDir = DATA_DIR) {
  return path.join(dataDir, 'slang.json');
}

export function slangRecord(entry, index = 0, { strictStatus = false } = {}) {
  const rawStatus = entry?.status;
  if (
    strictStatus
    && rawStatus !== undefined
    && !['candidate', 'confirmed', 'rejected'].includes(rawStatus)
  ) {
    throw new Error('黑话状态必须是 candidate、confirmed 或 rejected');
  }
  const status = ['candidate', 'confirmed', 'rejected'].includes(rawStatus)
    ? rawStatus
    : 'candidate';
  const content = cleanText(entry?.content, MAX_CONTENT);
  return {
    ...(entry && typeof entry === 'object' ? entry : {}),
    id: cleanText(entry?.id || `slang-${index + 1}`, 100),
    content,
    meaning: cleanText(entry?.meaning, MAX_MEANING),
    usage: cleanText(entry?.usage, MAX_USAGE),
    example: cleanText(entry?.example, 300),
    risk: cleanText(entry?.risk, 300),
    aliases: normalizeAliases(entry?.aliases, content),
    status,
    // 旧数据只有 manual/ai；外部检索写入时保留来源（moegirl/bing/...）。
    source: entry?.source === 'manual' ? 'manual' : normalizeSource(entry?.source),
    sourceUrl: normalizeUrl(entry?.sourceUrl),
    confidence: clampConfidence(entry?.confidence, status === 'confirmed' ? 1 : 0.5),
    lastVerifiedAt: cleanText(entry?.lastVerifiedAt, 40),
    scope: entry?.scope === 'chat-private' ? 'chat-private' : 'global-safe',
    scopeChatKey: /^(group|private):\d+$/.test(String(entry?.scopeChatKey || ''))
      ? String(entry.scopeChatKey)
      : '',
    sources: Array.isArray(entry?.sources)
      ? entry.sources.map((item) => cleanText(item, MAX_URL)).filter(Boolean).slice(0, 10)
      : [],
    researchId: cleanText(entry?.researchId, 100),
    count: Math.max(0, Math.round(Number(entry?.count) || 0)),
    evidence: Array.isArray(entry?.evidence) ? entry.evidence.slice(0, 100) : [],
    updatedAt: String(entry?.updatedAt || new Date().toISOString())
  };
}

export function readSlangRecords(dataDir = DATA_DIR, { strict = false } = {}) {
  const file = slangFile(dataDir);
  let raw;
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    raw = JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (strict) throw new Error(`黑话库读取失败，已停止写入：${String(error?.message ?? error)}`);
    return [];
  }
  if (!Array.isArray(raw)) {
    if (strict) throw new Error('黑话库格式错误，已停止写入');
    return [];
  }
  return raw
    .map(slangRecord)
    .filter((entry) => entry.content);
}

export function writeSlangRecords(entries, dataDir = DATA_DIR) {
  const file = slangFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function matchScore(entry, term) {
  const content = normalizeTerm(entry.content);
  if (!content || !term) return 0;
  if (content === term) return 1;
  const aliases = (entry.aliases || []).map(normalizeTerm);
  if (aliases.includes(term)) return 0.95;
  // 中文短词没有分词器：只在长度都 ≥2 时做包含匹配，避免 "典" 命中整库。
  if (term.length >= 2 && content.length >= 2) {
    if (content.includes(term)) return 0.6;
    if (term.includes(content)) return 0.55;
  }
  if (term.length >= 2 && aliases.some((alias) => alias.length >= 2 && alias.includes(term))) {
    return 0.5;
  }
  return 0;
}

/**
 * 按词/别名查本地库。不按 scope 过滤：梗来源是公开网络内容，
 * 同一条库就是唯一真源（用户 2026-10-22 明确取消按群隔离）。
 * rejected 条目不返回，避免管理员否掉的内容被模型重新捡起来。
 */
export function lookupSlang(term, { dataDir = DATA_DIR, limit = 5 } = {}) {
  const key = normalizeTerm(term);
  if (!key) return [];
  const size = Math.min(10, Math.max(1, Number(limit) || 5));
  return readSlangRecords(dataDir)
    .filter((entry) => entry.status !== 'rejected' && (entry.meaning || entry.usage))
    .map((entry) => ({ entry, score: matchScore(entry, key) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (a.entry.status !== b.entry.status) return a.entry.status === 'confirmed' ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      return Number(b.entry.count || 0) - Number(a.entry.count || 0);
    })
    .slice(0, size)
    .map(({ entry, score }) => ({ ...entry, matchScore: score }));
}

function mergeAliases(existing, incoming) {
  return normalizeAliases([...(existing || []), ...(incoming || [])], '');
}

function mergeSources(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const value = cleanText(item, MAX_URL);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * 外部检索/模型理解后的写入。默认只写 candidate：
 * 管理员在控制台确认后才变成 confirmed，之后工具查询会优先命中。
 *
 * @returns {{entry: object, created: boolean, updated: boolean, skipped: string}}
 */
export function upsertSlangCandidate(input = {}, { dataDir = DATA_DIR, now = Date.now() } = {}) {
  const content = cleanText(input.term ?? input.content, MAX_CONTENT);
  if (!content) throw new Error('梗词不能为空');
  const meaning = cleanText(input.meaning, MAX_MEANING);
  const usage = cleanText(input.usage, MAX_USAGE);
  const aliases = normalizeAliases(input.aliases, content);
  const source = normalizeSource(input.source || 'ai');
  const sourceUrl = normalizeUrl(input.sourceUrl);
  const confidence = clampConfidence(input.confidence, 0.5);
  const status = input.status === 'confirmed' ? 'confirmed' : 'candidate';
  const key = normalizeTerm(content);

  const entries = readSlangRecords(dataDir, { strict: true });
  const index = entries.findIndex((entry) => normalizeTerm(entry.content) === key);

  if (index >= 0) {
    const existing = entries[index];
    // 管理员明确拒绝过的词不自动复活：外部搜索经常会把同一个词再推回来。
    if (existing.status === 'rejected' && input.allowRejected !== true) {
      return { entry: existing, created: false, updated: false, skipped: 'rejected' };
    }
    const next = slangRecord({
      ...existing,
      content: content || existing.content,
      // 已确认条目以人工解释为准；候选条目允许模型用更清楚的解释覆盖原摘要。
      meaning: existing.status === 'confirmed'
        ? (existing.meaning || meaning)
        : (input.overrideMeaning === true && meaning ? meaning : (existing.meaning || meaning)),
      usage: existing.usage || usage,
      aliases: mergeAliases(existing.aliases, aliases),
      // 候选条目被模型用 memorize 再写一次时，不要把 moegirl/bing 来源降级成 ai。
      source: existing.status === 'confirmed'
        ? existing.source
        : (source === 'ai' && existing.source && existing.source !== 'ai' ? existing.source : source),
      sourceUrl: sourceUrl || existing.sourceUrl,
      sources: mergeSources(existing.sources, [sourceUrl || source]),
      confidence: existing.status === 'confirmed'
        ? existing.confidence
        : Math.max(existing.confidence, confidence),
      lastVerifiedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString()
    }, index, { strictStatus: true });
    const updated = JSON.stringify(next) !== JSON.stringify(existing);
    if (updated) {
      entries[index] = next;
      writeSlangRecords(entries, dataDir);
    }
    return { entry: next, created: false, updated, skipped: '' };
  }

  const entry = slangRecord({
    id: `slang_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
    content,
    meaning,
    usage,
    aliases,
    status,
    source,
    sourceUrl,
    sources: sourceUrl ? [sourceUrl] : [source],
    confidence,
    lastVerifiedAt: new Date(now).toISOString(),
    // 新工具不再按群隔离；旧字段保留为空，兼容控制台与旧备份。
    scope: 'global-safe',
    scopeChatKey: '',
    count: 0,
    evidence: [],
    updatedAt: new Date(now).toISOString()
  }, entries.length, { strictStatus: true });
  entries.push(entry);
  writeSlangRecords(entries, dataDir);
  return { entry, created: true, updated: false, skipped: '' };
}
