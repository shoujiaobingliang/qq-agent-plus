// 每日长期记忆的 SQLite 存储（Phase 1）。
//
// 设计见 docs/requirements/human-like-memory.md 与 daily-memory.md：
//   - 单文件 DATA_DIR/memory/daily-memory.sqlite，不启用 WAL（备份链路按整目录复制）；
//   - 表里同时存 L0 abstract、L2 content、保真度/强度/隐私作用域与版本历史；
//   - 召回先做隐私/作用域硬过滤，再在候选集内做词法 + 激活打分；
//   - 所有写入都有明确的去重/merge/supersede 语义，模型不能 delete。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../core/sqlite.js';
import { DATA_DIR, getConfig } from '../core/config.js';
import { todayKey, sanitizeUserText } from '../core/util.js';
import {
  dailyMemoryDatabasePath,
  normalizeDailyMemoryConfig
} from '../core/daily-memory-config.js';
import {
  decideFidelity,
  initialStrength,
  isTransientExpired,
  shouldFade,
  shouldFadeDetail,
  strengthAfterDecay,
  strengthenOnObserve,
  strengthenOnRecall
} from './memory-fidelity.js';
import {
  decidePrivacy,
  disclosureLabel,
  isRecallVisible,
  privacyRank,
  usableInForScope,
  PRIVACY_SCOPES,
  USABLE_IN
} from './memory-privacy.js';
import { rankCandidates } from './memory-activation.js';
import {
  buildMatchQuery,
  buildSearchText,
  normalizeForHash,
  normalizeForSearch,
  tokenizeForSearch
} from './memory-text.js';

export const DAILY_MEMORY_KINDS = Object.freeze([
  'convention', 'decision', 'fact', 'event', 'person_fact', 'person_preference'
]);
const KIND_SET = new Set(DAILY_MEMORY_KINDS);
const FIDELITY_SET = new Set(['verbatim', 'gist', 'transient']);
const DAY_MS = 86400000;
const RECALL_LOG_RETENTION_DAYS = 30;

const KIND_FOLDERS = {
  convention: 'conventions',
  decision: 'decisions',
  fact: 'facts',
  event: 'events',
  person_fact: 'facts',
  person_preference: 'preferences'
};
const KIND_LABELS = {
  convention: '约定',
  decision: '决定',
  fact: '事实',
  event: '事件',
  person_fact: '人物事实',
  person_preference: '人物偏好'
};

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
const hashOf = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex');

function jsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function jsonArrayOfStrings(value) {
  return jsonArray(value).map((item) => String(item)).filter(Boolean);
}
function jsonObject(value) {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function normalizeKeywords(value) {
  const list = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,\s，、]+/) : []);
  return [...new Set(list.map((item) => clean(item, 40)).filter(Boolean))].slice(0, 12);
}
function normalizeMessageIds(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0)
    .map((item) => String(item)))].slice(0, 50);
}
function normalizeKind(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const alias = {
    rule: 'convention',
    plan: 'decision',
    preference: 'person_preference',
    person_fact: 'person_fact',
    person_preference: 'person_preference'
  };
  const kind = alias[raw] || raw;
  return KIND_SET.has(kind) ? kind : '';
}
function pathSegment(value, fallback = 'misc') {
  const text = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return text || fallback;
}
function pathChatKey(chatKey) {
  return pathSegment(String(chatKey ?? '').replace(':', '_'), 'unknown');
}
function dayPart(sourceDate, now) {
  const text = String(sourceDate || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : todayKey(now);
}

/** 虚拟路径：只用于控制台展示/排查，不落真实文件。 */
export function memoryPathFor({
  privacyScope = 'chat', storageScope = 'chat', chatKey = '', kind = 'fact',
  subject = 'misc', userId = '', sourceDate = '', now = Date.now()
} = {}) {
  const folder = KIND_FOLDERS[kind] || 'facts';
  const name = pathSegment(subject, kind);
  if (privacyScope === 'knowledge') return `knowledge/${folder}/${name}`;
  if (privacyScope === 'person' || storageScope === 'person') {
    return `people/${pathSegment(userId, 'unknown')}/${folder}/${name}`;
  }
  if (privacyScope === 'secret') {
    return `chat/${pathChatKey(chatKey)}/secret/${name}`;
  }
  if (kind === 'event') {
    const day = dayPart(sourceDate, now);
    return `chat/${pathChatKey(chatKey)}/events/${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}/${name}`;
  }
  return `chat/${pathChatKey(chatKey)}/${folder}/${name}`;
}

function entryFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    path: String(row.path || ''),
    scope: String(row.scope || 'chat'),
    chatKey: String(row.chat_key || ''),
    userId: String(row.user_id || ''),
    userName: String(row.user_name || ''),
    kind: String(row.kind || ''),
    subject: String(row.subject || ''),
    abstract: String(row.abstract || ''),
    content: String(row.content || ''),
    contentHash: String(row.content_hash || ''),
    importance: Number(row.importance) || 3,
    confidence: Number(row.confidence) || 0,
    sourceDate: String(row.source_date || ''),
    sourceMessageIds: jsonArrayOfStrings(row.source_message_ids),
    version: Number(row.version) || 1,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    lastSeenAt: Number(row.last_seen_at) || 0,
    seenCount: Number(row.seen_count) || 1,
    status: String(row.status || 'active'),
    supersededBy: Number(row.superseded_by) || 0,
    supersededAt: Number(row.superseded_at) || 0,
    expiresAt: Number(row.expires_at) || 0,
    fidelity: FIDELITY_SET.has(row.fidelity) ? row.fidelity : 'gist',
    strength: Number(row.strength) || 1,
    lastRecalledAt: Number(row.last_recalled_at) || 0,
    recallCount: Number(row.recall_count) || 0,
    detailFadedAt: Number(row.detail_faded_at) || 0,
    keywords: jsonArrayOfStrings(row.keywords),
    embedding: row.embedding ?? null,
    embeddingModel: String(row.embedding_model || ''),
    embeddingUpdatedAt: Number(row.embedding_updated_at) || 0,
    searchText: String(row.search_text || ''),
    privacyScope: String(row.privacy_scope || 'chat'),
    usableIn: String(row.usable_in || 'chat'),
    disclosable: Boolean(row.disclosable),
    subjectUserId: String(row.subject_user_id || ''),
    sensitivity: String(row.sensitivity || 'low'),
    classificationConfidence: Number(row.classification_confidence) || 0,
    classifiedBy: String(row.classified_by || ''),
    privacyReason: String(row.privacy_reason || '')
  };
}

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  scope TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  user_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  abstract TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 3,
  confidence REAL NOT NULL DEFAULT 0.7,
  source_date TEXT NOT NULL DEFAULT '',
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by INTEGER NOT NULL DEFAULT 0,
  superseded_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  fidelity TEXT NOT NULL DEFAULT 'gist',
  strength REAL NOT NULL DEFAULT 1.0,
  last_recalled_at INTEGER NOT NULL DEFAULT 0,
  recall_count INTEGER NOT NULL DEFAULT 0,
  detail_faded_at INTEGER NOT NULL DEFAULT 0,
  keywords TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_updated_at INTEGER NOT NULL DEFAULT 0,
  search_text TEXT NOT NULL DEFAULT '',
  privacy_scope TEXT NOT NULL DEFAULT 'chat',
  usable_in TEXT NOT NULL DEFAULT 'chat',
  disclosable INTEGER NOT NULL DEFAULT 0,
  subject_user_id TEXT NOT NULL DEFAULT '',
  sensitivity TEXT NOT NULL DEFAULT 'low',
  classification_confidence REAL NOT NULL DEFAULT 0.5,
  classified_by TEXT NOT NULL DEFAULT '',
  privacy_reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS memory_entry_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  abstract TEXT NOT NULL,
  content TEXT NOT NULL,
  source_date TEXT NOT NULL DEFAULT '',
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(entry_id, version)
);

CREATE TABLE IF NOT EXISTS daily_summaries (
  chat_key TEXT NOT NULL,
  day TEXT NOT NULL,
  overview TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  usage_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_key, day)
);

CREATE TABLE IF NOT EXISTS daily_jobs (
  chat_key TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  messages_read INTEGER NOT NULL DEFAULT 0,
  entries_created INTEGER NOT NULL DEFAULT 0,
  entries_merged INTEGER NOT NULL DEFAULT 0,
  entries_superseded INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  usage_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_key, day)
);

CREATE TABLE IF NOT EXISTS daily_days (
  day TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  chat_count INTEGER NOT NULL DEFAULT 0,
  done_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_recall_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  chat_key TEXT NOT NULL,
  query_hash TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0,
  matched_by TEXT NOT NULL DEFAULT '',
  injected INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS daily_memory_entries_dedupe
  ON memory_entries(scope, chat_key, user_id, kind, subject, content_hash)
  WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS daily_memory_entries_knowledge
  ON memory_entries(privacy_scope, subject, content_hash)
  WHERE status = 'active' AND privacy_scope = 'knowledge';
CREATE INDEX IF NOT EXISTS daily_memory_entries_inject
  ON memory_entries(chat_key, status, kind, importance DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS daily_memory_entries_person
  ON memory_entries(subject_user_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS daily_memory_entries_decay
  ON memory_entries(status, fidelity, last_seen_at);
CREATE INDEX IF NOT EXISTS daily_memory_entries_privacy
  ON memory_entries(privacy_scope, usable_in, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS daily_memory_entries_path
  ON memory_entries(path, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS daily_summaries_day ON daily_summaries(day);
CREATE INDEX IF NOT EXISTS daily_jobs_day ON daily_jobs(day, status);
CREATE INDEX IF NOT EXISTS memory_recall_log_chat ON memory_recall_log(chat_key, at DESC);
`;

const COLUMN_MAP = {
  path: 'path', scope: 'scope', chatKey: 'chat_key', userId: 'user_id', userName: 'user_name',
  kind: 'kind', subject: 'subject', abstract: 'abstract', content: 'content',
  contentHash: 'content_hash', importance: 'importance', confidence: 'confidence',
  sourceDate: 'source_date', sourceMessageIds: 'source_message_ids', version: 'version',
  createdAt: 'created_at', updatedAt: 'updated_at', lastSeenAt: 'last_seen_at',
  seenCount: 'seen_count', status: 'status', supersededBy: 'superseded_by',
  supersededAt: 'superseded_at', expiresAt: 'expires_at', fidelity: 'fidelity',
  strength: 'strength', lastRecalledAt: 'last_recalled_at', recallCount: 'recall_count',
  detailFadedAt: 'detail_faded_at', keywords: 'keywords', embedding: 'embedding',
  embeddingModel: 'embedding_model', embeddingUpdatedAt: 'embedding_updated_at',
  searchText: 'search_text', privacyScope: 'privacy_scope', usableIn: 'usable_in',
  disclosable: 'disclosable', subjectUserId: 'subject_user_id', sensitivity: 'sensitivity',
  classificationConfidence: 'classification_confidence', classifiedBy: 'classified_by',
  privacyReason: 'privacy_reason'
};

const INSERT_COLUMNS = Object.values(COLUMN_MAP);

export class DailyMemoryStore {
  constructor({ file = dailyMemoryDatabasePath(DATA_DIR), config = null, now = Date.now } = {}) {
    this.file = file;
    this.now = () => Number(now()) || Date.now();
    this.fullConfig = config || getConfig();
    this.dailyConfig = normalizeDailyMemoryConfig(this.fullConfig?.dailyMemory || {});
    const visibility = this.fullConfig?.memory?.visibility || {};
    this.human = {
      ...this.dailyConfig.human,
      privacy: {
        ...this.dailyConfig.human.privacy,
        visibilityMode: visibility.mode === 'perChat' ? 'perChat' : 'global',
        hidePrivateInGroup: visibility.hidePrivateInGroup === true
      }
    };
    this.fts = false;
    this.closed = false;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = openDatabase(file);
    try { fs.chmodSync(file, 0o600); } catch { /* 非 POSIX 或权限受限：尽力而为 */ }
    this.#migrate();
  }

  /** 控制台改配置后刷新内存里的策略（不重开数据库）。 */
  reconfigure(config = getConfig()) {
    this.fullConfig = config || this.fullConfig;
    this.dailyConfig = normalizeDailyMemoryConfig(this.fullConfig?.dailyMemory || {});
    const visibility = this.fullConfig?.memory?.visibility || {};
    this.human = {
      ...this.dailyConfig.human,
      privacy: {
        ...this.dailyConfig.human.privacy,
        visibilityMode: visibility.mode === 'perChat' ? 'perChat' : 'global',
        hidePrivateInGroup: visibility.hidePrivateInGroup === true
      }
    };
  }

  #migrate() {    this.db.exec(TABLE_SQL);
    this.#ensureColumns('memory_entries', [
      ['fidelity', "TEXT NOT NULL DEFAULT 'gist'"],
      ['strength', 'REAL NOT NULL DEFAULT 1.0'],
      ['last_recalled_at', 'INTEGER NOT NULL DEFAULT 0'],
      ['recall_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['detail_faded_at', 'INTEGER NOT NULL DEFAULT 0'],
      ['keywords', "TEXT NOT NULL DEFAULT '[]'"],
      ['embedding', 'BLOB'],
      ['embedding_model', "TEXT NOT NULL DEFAULT ''"],
      ['embedding_updated_at', 'INTEGER NOT NULL DEFAULT 0'],
      ['search_text', "TEXT NOT NULL DEFAULT ''"],
      ['privacy_scope', "TEXT NOT NULL DEFAULT 'chat'"],
      ['usable_in', "TEXT NOT NULL DEFAULT 'chat'"],
      ['disclosable', 'INTEGER NOT NULL DEFAULT 0'],
      ['subject_user_id', "TEXT NOT NULL DEFAULT ''"],
      ['sensitivity', "TEXT NOT NULL DEFAULT 'low'"],
      ['classification_confidence', 'REAL NOT NULL DEFAULT 0.5'],
      ['classified_by', "TEXT NOT NULL DEFAULT ''"],
      ['privacy_reason', "TEXT NOT NULL DEFAULT ''"]
    ]);
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(search_text, tokenize='unicode61');");
      this.fts = true;
    } catch {
      this.fts = false;
    }
    try { this.db.exec('PRAGMA user_version = 1;'); } catch { /* 只读或受限环境 */ }
  }

  #ensureColumns(table, defs) {
    const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    for (const [name, type] of defs) {
      if (existing.has(name)) continue;
      try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type};`); } catch { /* 已存在/受限 */ }
    }
  }

  #tx(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw error;
    }
  }

  #syncFts(id, searchText) {
    if (!this.fts) return;
    try {
      this.db.prepare('DELETE FROM memory_entries_fts WHERE rowid = ?').run(Number(id));
      if (searchText) {
        this.db.prepare('INSERT INTO memory_entries_fts(rowid, search_text) VALUES (?, ?)')
          .run(Number(id), String(searchText));
      }
    } catch { /* FTS 失败不影响主表读写 */ }
  }

  #deleteFts(id) {
    if (!this.fts) return;
    try { this.db.prepare('DELETE FROM memory_entries_fts WHERE rowid = ?').run(Number(id)); } catch { /* 尽力 */ }
  }

  #rowById(id) {
    const numeric = Number(id);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
    return this.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(numeric) || null;
  }

  #findDuplicate(candidate) {
    const exact = this.db.prepare(`
      SELECT * FROM memory_entries
      WHERE status = 'active' AND scope = ? AND chat_key = ? AND user_id = ?
        AND kind = ? AND subject = ? AND content_hash = ?
      LIMIT 1
    `).get(
      candidate.scope, candidate.chatKey, candidate.userId,
      candidate.kind, candidate.subject, candidate.contentHash
    );
    if (exact) return exact;
    if (candidate.privacyScope === 'knowledge') {
      return this.db.prepare(`
        SELECT * FROM memory_entries
        WHERE status = 'active' AND privacy_scope = 'knowledge'
          AND subject = ? AND content_hash = ?
        LIMIT 1
      `).get(candidate.subject, candidate.contentHash) || null;
    }
    return null;
  }

  #insert(candidate) {
    const sql = `INSERT INTO memory_entries (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`;
    const values = INSERT_COLUMNS.map((column) => {
      switch (column) {
        case 'source_message_ids': return JSON.stringify(candidate.sourceMessageIds || []);
        case 'keywords': return JSON.stringify(candidate.keywords || []);
        case 'disclosable': return candidate.disclosable ? 1 : 0;
        default: return candidate[Object.keys(COLUMN_MAP).find((key) => COLUMN_MAP[key] === column)] ?? '';
      }
    });
    // 数值字段不能落成空串
    const numeric = new Set(['importance', 'confidence', 'version', 'created_at', 'updated_at',
      'last_seen_at', 'seen_count', 'superseded_by', 'superseded_at', 'expires_at', 'strength',
      'last_recalled_at', 'recall_count', 'detail_faded_at', 'embedding_updated_at',
      'classification_confidence']);
    for (let i = 0; i < INSERT_COLUMNS.length; i += 1) {
      if (numeric.has(INSERT_COLUMNS[i]) && (values[i] === '' || values[i] === undefined)) values[i] = 0;
    }
    const info = this.db.prepare(sql).run(...values);
    const id = Number(info.lastInsertRowid);
    this.#syncFts(id, candidate.searchText);
    return id;
  }

  #update(id, fields) {
    const columns = [];
    const values = [];
    for (const [key, value] of Object.entries(fields || {})) {
      const column = COLUMN_MAP[key];
      if (!column) continue;
      columns.push(`${column} = ?`);
      if (key === 'sourceMessageIds') values.push(JSON.stringify(value || []));
      else if (key === 'keywords') values.push(JSON.stringify(value || []));
      else if (key === 'disclosable') values.push(value ? 1 : 0);
      else values.push(value);
    }
    if (!columns.length) return;
    this.db.prepare(`UPDATE memory_entries SET ${columns.join(', ')} WHERE id = ?`).run(...values, Number(id));
  }

  #writeVersion(row, reason = '') {
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO memory_entry_versions
          (entry_id, version, abstract, content, source_date, source_message_ids, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Number(row.id), Number(row.version) || 1, String(row.abstract || ''),
        String(row.content || ''), String(row.source_date || ''),
        String(row.source_message_ids || '[]'), clean(reason, 80), this.now()
      );
    } catch { /* 版本历史失败不阻断主写入 */ }
  }

  #privacyFieldsFromRecord(record) {
    return {
      privacyScope: record.privacyScope,
      usableIn: record.usableIn,
      disclosable: record.disclosable === true,
      subjectUserId: record.subjectUserId || '',
      sensitivity: record.sensitivity,
      classificationConfidence: record.classificationConfidence,
      classifiedBy: record.classifiedBy,
      privacyReason: record.privacyReason
    };
  }

  #keepStricterPrivacy(oldRow, candidate) {
    const oldScope = String(oldRow?.privacy_scope || 'chat');
    if (privacyRank(oldScope) > privacyRank(candidate.privacyScope)) {
      Object.assign(candidate, {
        privacyScope: oldScope,
        usableIn: String(oldRow.usable_in || candidate.usableIn),
        disclosable: Boolean(oldRow.disclosable),
        subjectUserId: String(oldRow.subject_user_id || candidate.subjectUserId || ''),
        sensitivity: String(oldRow.sensitivity || candidate.sensitivity),
        classificationConfidence: Number(oldRow.classification_confidence) || candidate.classificationConfidence,
        classifiedBy: String(oldRow.classified_by || candidate.classifiedBy),
        privacyReason: String(oldRow.privacy_reason || candidate.privacyReason)
      });
    }
  }

  #prepareCandidate(chatKey, item, { sourceDate, now } = {}) {
    const kind = normalizeKind(item?.kind);
    if (!kind) return { skip: 'kind 非法' };
    const importance = clampInt(item?.importance, 1, 5, 3);
    const confidence = clamp01(item?.confidence, 0.7);
    if (confidence < Number(this.dailyConfig.minConfidence)) return { skip: '置信度不足' };
    const abstract = clean(item?.abstract, this.dailyConfig.abstractMaxChars);
    if (!abstract) return { skip: 'abstract 为空' };
    const content = clean(item?.content, this.dailyConfig.contentMaxChars);
    const subject = clean(item?.subject, 60) || kind;
    const rawUserId = String(item?.userId || item?.user_id || item?.privacy?.subject_user_id || '').trim();
    const fidelity = decideFidelity({ kind, importance, config: this.human });
    const privacy = decidePrivacy({
      abstract,
      content,
      kind,
      subjectUserId: rawUserId,
      guess: item?.privacy || null,
      config: this.human.privacy
    });
    const storageScope = kind.startsWith('person_') || privacy.privacyScope === 'person'
      ? 'person'
      : 'chat';
    const subjectUserId = privacy.privacyScope === 'person' ? privacy.subjectUserId : '';
    const day = dayPart(sourceDate, now);
    const pathValue = memoryPathFor({
      privacyScope: privacy.privacyScope,
      storageScope,
      chatKey,
      kind,
      subject,
      userId: subjectUserId || rawUserId,
      sourceDate: day,
      now
    });
    const keywords = normalizeKeywords(item?.keywords);
    const searchText = buildSearchText({ abstract, content, keywords });
    const expiresAt = fidelity === 'transient'
      ? now + this.human.transientMaxDays * DAY_MS
      : (kind === 'event' ? now + this.dailyConfig.eventRetentionDays * DAY_MS : 0);
    return {
      path: pathValue,
      scope: storageScope,
      chatKey,
      userId: subjectUserId || rawUserId,
      userName: clean(item?.userName || item?.target || '', 60),
      kind,
      subject,
      abstract,
      content: content || (fidelity === 'verbatim' ? abstract : ''),
      contentHash: hashOf(normalizeForHash(content || abstract)),
      importance,
      confidence,
      sourceDate: day,
      sourceMessageIds: normalizeMessageIds(item?.evidence_message_ids || item?.source_message_ids),
      version: 1,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      seenCount: 1,
      status: 'active',
      supersededBy: 0,
      supersededAt: 0,
      expiresAt,
      fidelity,
      strength: initialStrength({ importance, fidelity }),
      lastRecalledAt: 0,
      recallCount: 0,
      detailFadedAt: 0,
      keywords,
      embedding: null,
      embeddingModel: '',
      embeddingUpdatedAt: 0,
      searchText,
      privacyScope: privacy.privacyScope,
      usableIn: privacy.usableIn,
      disclosable: privacy.disclosable,
      subjectUserId,
      sensitivity: privacy.sensitivity,
      classificationConfidence: privacy.classificationConfidence,
      classifiedBy: privacy.classifiedBy,
      privacyReason: privacy.privacyReason
    };
  }

  #touch(existingRow, candidate) {
    const now = this.now();
    const oldKeywords = jsonArrayOfStrings(existingRow.keywords);
    const keywords = [...new Set([...oldKeywords, ...candidate.keywords])].slice(0, 12);
    const sourceMessageIds = [...new Set([
      ...jsonArrayOfStrings(existingRow.source_message_ids),
      ...candidate.sourceMessageIds
    ])].slice(-50);
    const fidelity = String(existingRow.fidelity) === 'verbatim' ? 'verbatim' : candidate.fidelity;
    const fields = {
      importance: Math.max(Number(existingRow.importance) || 0, candidate.importance),
      confidence: Math.max(Number(existingRow.confidence) || 0, candidate.confidence),
      keywords,
      sourceMessageIds,
      seenCount: Number(existingRow.seen_count) + 1,
      lastSeenAt: now,
      strength: strengthenOnObserve(Number(existingRow.strength) || 1, { boost: this.human.observeBoost }),
      fidelity,
      searchText: buildSearchText({
        abstract: existingRow.abstract,
        content: existingRow.content,
        keywords
      })
    };
    this.#keepStricterPrivacy(existingRow, candidate);
    Object.assign(fields, this.#privacyFieldsFromRecord(candidate));
    this.#update(existingRow.id, fields);
    this.#syncFts(existingRow.id, fields.searchText);
    return Number(existingRow.id);
  }

  #mergeInto(targetRow, candidate) {
    const now = this.now();
    const content = candidate.content || String(targetRow.content || '');
    const fidelity = String(targetRow.fidelity) === 'verbatim' ? 'verbatim' : candidate.fidelity;
    const keywords = [...new Set([...jsonArrayOfStrings(targetRow.keywords), ...candidate.keywords])].slice(0, 12);
    const sourceMessageIds = [...new Set([
      ...jsonArrayOfStrings(targetRow.source_message_ids),
      ...candidate.sourceMessageIds
    ])].slice(-50);
    const searchText = buildSearchText({ abstract: candidate.abstract, content, keywords });
    const fields = {
      path: candidate.path,
      subject: candidate.subject,
      abstract: candidate.abstract,
      content,
      contentHash: hashOf(normalizeForHash(content || candidate.abstract)),
      importance: Math.max(Number(targetRow.importance) || 0, candidate.importance),
      confidence: Math.max(Number(targetRow.confidence) || 0, candidate.confidence),
      sourceDate: candidate.sourceDate,
      sourceMessageIds,
      keywords,
      fidelity,
      version: Number(targetRow.version) + 1,
      updatedAt: now,
      lastSeenAt: now,
      strength: Math.max(Number(targetRow.strength) || 1, candidate.strength),
      expiresAt: candidate.expiresAt,
      searchText,
      ...this.#privacyFieldsFromRecord(candidate)
    };
    this.#update(targetRow.id, fields);
    this.#syncFts(targetRow.id, searchText);
    return Number(targetRow.id);
  }

  #supersede(targetRow, newId, now) {
    this.#update(targetRow.id, {
      status: 'superseded',
      supersededBy: Number(newId),
      supersededAt: now,
      updatedAt: now
    });
  }

  /**
   * 应用一次抽取结果。模型只能 create/merge/skip/supersede，delete 一律忽略。
   * @returns {{created:number, merged:number, superseded:number, skipped:number, touched:number}}
   */
  applyExtraction(chatKey, result = {}, { sourceDate = '', now = this.now() } = {}) {
    const counts = { created: 0, merged: 0, superseded: 0, skipped: 0, touched: 0 };
    const entries = Array.isArray(result?.entries) ? result.entries : [];
    const day = dayPart(sourceDate, now);
    this.#tx(() => {
      for (const item of entries) {
        const operation = String(item?.operation || 'create').trim().toLowerCase();
        if (operation === 'skip' || operation === 'delete') { counts.skipped += 1; continue; }
        const candidate = this.#prepareCandidate(chatKey, item, { sourceDate: day, now });
        if (candidate.skip) { counts.skipped += 1; continue; }

        if (operation === 'merge' || operation === 'supersede') {
          const targetRow = this.#rowById(item?.targetId);
          const sameChat = String(targetRow?.chat_key) === String(chatKey);
          const globalKnowledge = targetRow?.privacy_scope === 'knowledge' && targetRow?.usable_in === 'global';
          if (!targetRow || targetRow.status !== 'active' || (!sameChat && !globalKnowledge)) {
            counts.skipped += 1;
            continue;
          }
          this.#keepStricterPrivacy(targetRow, candidate);
          this.#writeVersion(targetRow, operation);
          if (operation === 'merge') {
            this.#mergeInto(targetRow, candidate);
            counts.merged += 1;
          } else {
            const newId = this.#insert(candidate);
            this.#supersede(targetRow, newId, now);
            counts.superseded += 1;
          }
          continue;
        }

        const duplicate = this.#findDuplicate(candidate);
        if (duplicate) {
          this.#touch(duplicate, candidate);
          counts.touched += 1;
        } else {
          this.#insert(candidate);
          counts.created += 1;
        }
      }
      if (result?.summary && typeof result.summary === 'object'
        && (result.summary.overview || result.summary.summary || result.summary.details)) {
        this.upsertSummary(chatKey, day, result.summary, { now });
      }
    });
    return counts;
  }

  upsertSummary(chatKey, day, summary = {}, { now = this.now() } = {}) {    const existing = this.db.prepare('SELECT * FROM daily_summaries WHERE chat_key = ? AND day = ?')
      .get(String(chatKey), String(day));
    const value = {
      overview: clean(summary.overview, this.dailyConfig.summaryOverviewChars),
      summary: clean(summary.summary, this.dailyConfig.summaryMaxChars),
      details: clean(summary.details, this.dailyConfig.summaryMaxChars * 2)
    };
    if (existing) {
      this.db.prepare(`
        UPDATE daily_summaries SET overview = ?, summary = ?, details = ?, updated_at = ?
        WHERE chat_key = ? AND day = ?
      `).run(value.overview, value.summary, value.details, now, String(chatKey), String(day));
    } else {
      this.db.prepare(`
        INSERT INTO daily_summaries (chat_key, day, overview, summary, details, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(String(chatKey), String(day), value.overview, value.summary, value.details, now, now);
    }
    return value;
  }

  jobFromRow(row) {
    if (!row) return null;
    return {
      chatKey: String(row.chat_key || ''),
      day: String(row.day || ''),
      status: String(row.status || 'pending'),
      error: String(row.error || ''),
      attempts: Number(row.attempts) || 0,
      messagesRead: Number(row.messages_read) || 0,
      entriesCreated: Number(row.entries_created) || 0,
      entriesMerged: Number(row.entries_merged) || 0,
      entriesSuperseded: Number(row.entries_superseded) || 0,
      model: String(row.model || ''),
      usage: jsonObject(row.usage_json),
      startedAt: Number(row.started_at) || 0,
      finishedAt: Number(row.finished_at) || 0,
      updatedAt: Number(row.updated_at) || 0
    };
  }

  getJob(chatKey, day) {
    return this.jobFromRow(this.db.prepare('SELECT * FROM daily_jobs WHERE chat_key = ? AND day = ?')
      .get(String(chatKey), String(day)));
  }

  setJob(chatKey, day, fields = {}) {
    const existing = this.getJob(chatKey, day);
    const now = this.now();
    const value = {
      status: fields.status ?? existing?.status ?? 'pending',
      error: clean(fields.error ?? existing?.error ?? '', 300),
      attempts: clampInt(fields.attempts ?? existing?.attempts ?? 0, 0, 1000, 0),
      messagesRead: clampInt(fields.messagesRead ?? existing?.messagesRead ?? 0, 0, 1000000, 0),
      entriesCreated: clampInt(fields.entriesCreated ?? existing?.entriesCreated ?? 0, 0, 10000, 0),
      entriesMerged: clampInt(fields.entriesMerged ?? existing?.entriesMerged ?? 0, 0, 10000, 0),
      entriesSuperseded: clampInt(fields.entriesSuperseded ?? existing?.entriesSuperseded ?? 0, 0, 10000, 0),
      model: clean(fields.model ?? existing?.model ?? '', 120),
      usageJson: JSON.stringify(fields.usage ?? existing?.usage ?? {}),
      startedAt: Number(fields.startedAt ?? existing?.startedAt ?? 0) || 0,
      finishedAt: Number(fields.finishedAt ?? existing?.finishedAt ?? 0) || 0,
      updatedAt: Number(fields.updatedAt ?? now) || now
    };
    this.db.prepare(`
      INSERT INTO daily_jobs
        (chat_key, day, status, error, attempts, messages_read, entries_created,
         entries_merged, entries_superseded, model, usage_json, started_at, finished_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_key, day) DO UPDATE SET
        status = excluded.status, error = excluded.error, attempts = excluded.attempts,
        messages_read = excluded.messages_read, entries_created = excluded.entries_created,
        entries_merged = excluded.entries_merged, entries_superseded = excluded.entries_superseded,
        model = excluded.model, usage_json = excluded.usage_json,
        started_at = excluded.started_at, finished_at = excluded.finished_at,
        updated_at = excluded.updated_at
    `).run(
      String(chatKey), String(day), value.status, value.error, value.attempts,
      value.messagesRead, value.entriesCreated, value.entriesMerged, value.entriesSuperseded,
      value.model, value.usageJson, value.startedAt, value.finishedAt, value.updatedAt
    );
    return this.getJob(chatKey, day);
  }

  listJobs({ day = '', limit = 50 } = {}) {
    const rows = day
      ? this.db.prepare('SELECT * FROM daily_jobs WHERE day = ? ORDER BY updated_at DESC LIMIT ?')
        .all(String(day), clampInt(limit, 1, 500, 50))
      : this.db.prepare('SELECT * FROM daily_jobs ORDER BY updated_at DESC LIMIT ?')
        .all(clampInt(limit, 1, 500, 50));
    return rows.map((row) => this.jobFromRow(row));
  }

  #candidates({ chatKey, relevantUserIds = [], mentionedUserIds = [], limit = 200, now = this.now() } = {}) {
    const cfg = { ...this.human, ...this.human.privacy };
    const relevant = [...new Set((relevantUserIds || []).map(String).filter(validUid))];
    const personIds = [...new Set([
      ...relevant,
      ...(cfg.personUsableWhenAbsent ? (mentionedUserIds || []).map(String).filter(validUid) : [])
    ])];
    const params = [now];
    const branches = [
      "(usable_in = 'global' AND privacy_scope <> 'secret')",
      "(usable_in IN ('chat', 'source') AND chat_key = ?)"
    ];
    params.push(String(chatKey));
    if (personIds.length) {
      branches.push(`(usable_in = 'person' AND subject_user_id IN (${personIds.map(() => '?').join(', ')}))`);
      params.push(...personIds);
    }
    let sql = `
      SELECT * FROM memory_entries
      WHERE status = 'active'
        AND (expires_at = 0 OR expires_at > ?)
        AND (${branches.join(' OR ')})
    `;
    if (cfg.hidePrivateInGroup && String(chatKey).startsWith('group:')) {
      sql += " AND chat_key NOT LIKE 'private:%'";
    }
    if (cfg.visibilityMode === 'perChat') {
      sql += ' AND chat_key = ?';
      params.push(String(chatKey));
    }
    if (!cfg.allowKnowledgeAcrossChats) {
      sql += " AND (chat_key NOT LIKE 'private:%' OR chat_key = ?)";
      params.push(String(chatKey));
    }
    sql += ' ORDER BY importance DESC, last_seen_at DESC, strength DESC LIMIT ?';
    params.push(clampInt(limit, 1, 1000, 200));
    const rows = this.db.prepare(sql).all(...params).map(entryFromRow);
    return rows.filter((entry) => isRecallVisible(entry, { chatKey, relevantUserIds, mentionedUserIds }, {
      privacy: cfg,
      visibility: { mode: cfg.visibilityMode, hidePrivateInGroup: cfg.hidePrivateInGroup }
    }));
  }
  #lexicalMap(query, candidates, limit) {
    const text = String(query || '').trim();
    if (!text || !candidates.length) return new Map();
    const allowed = new Set(candidates.map((entry) => String(entry.id)));
    const out = new Map();

    // 优先走 FTS5：BM25 排序后按名次归一化（第 1 名=1，最后一名≈0）。
    const match = buildMatchQuery(text);
    if (this.fts && match) {
      try {
        const rows = this.db.prepare(`
          SELECT rowid AS id, bm25(memory_entries_fts) AS rank
          FROM memory_entries_fts
          WHERE memory_entries_fts MATCH ?
          ORDER BY rank ASC
          LIMIT ?
        `).all(match, clampInt(limit, 1, 1000, 200));
        let index = 0;
        for (const row of rows) {
          const id = String(row.id);
          if (!allowed.has(id)) continue;
          out.set(id, 1 - index / Math.max(1, rows.length));
          index += 1;
        }
      } catch { /* FTS 不可用/查询语法失败：走下面的包含匹配 */ }
    }

    // 兜底：单字中文（如「农」）不是 bigram，FTS 可能漏；用 token 包含率补足。
    const tokens = [...new Set(tokenizeForSearch(text))];
    if (tokens.length) {
      for (const entry of candidates) {
        const id = String(entry.id);
        if (out.has(id)) continue;
        const haystack = normalizeForSearch([
          entry.abstract, entry.content, entry.subject, ...(entry.keywords || [])
        ].filter(Boolean).join(' '));
        const hits = tokens.filter((token) => haystack.includes(token)).length;
        if (hits > 0) out.set(id, hits / tokens.length);
      }
    }
    return out;
  }

  /**
   * 召回：固定注入精确约定/决定 + 激活分数排序的模糊记忆。
   * @returns {Array} 带有 matchedBy / activationScore / scoreParts 的条目
   */
  recall({
    chatKey, relevantUserIds = [], mentionedUserIds = [], query = '',
    now = this.now(), record = true, includeContent = false
  } = {}) {
    const cfg = this.human;
    const maxCandidates = clampInt(cfg.maxCandidates, 10, 500, 200);
    const candidates = this.#candidates({ chatKey, relevantUserIds, mentionedUserIds, limit: maxCandidates, now });
    if (!candidates.length) return [];
    const lexical = this.#lexicalMap(query, candidates, maxCandidates);
    const context = { chatKey, relevantUserIds, mentionedUserIds, topicText: query };

    const fixed = [];
    const fixedIds = new Set();
    for (const entry of candidates) {
      if (entry.fidelity !== 'verbatim') continue;
      if (entry.kind !== 'convention' && entry.kind !== 'decision') continue;
      fixed.push({ ...entry, matchedBy: 'fixed', activationScore: 1, scoreParts: { fixed: 1 } });
      fixedIds.add(entry.id);
    }
    const fixedConventions = fixed.filter((entry) => entry.kind === 'convention')
      .slice(0, this.dailyConfig.injectConvention);
    const fixedDecisions = fixed.filter((entry) => entry.kind === 'decision')
      .slice(0, this.dailyConfig.injectDecision);
    const fixedPicked = [...fixedConventions, ...fixedDecisions];
    const fixedPickedIds = new Set(fixedPicked.map((entry) => entry.id));

    const rest = candidates.filter((entry) => !fixedIds.has(entry.id));
    const ranked = rankCandidates(rest, {
      lexicalOf: (entry) => lexical.get(String(entry.id)) || 0,
      context,
      weights: {},
      minScore: cfg.activationMin,
      limit: Math.max(1, cfg.maxRecall),
      now,
      tauRecallDays: cfg.tauRecallDays
    }).map((entry) => ({
      ...entry,
      matchedBy: lexical.get(String(entry.id)) > 0 ? 'fts' : 'context'
    }));

    let gistCount = 0;
    const activated = [];
    for (const entry of ranked) {
      if (entry.fidelity !== 'verbatim') {
        if (gistCount >= cfg.maxInjectGist) continue;
        gistCount += 1;
      }
      if (!fixedPickedIds.has(entry.id)) activated.push(entry);
    }

    const combined = [...fixedPicked, ...activated];
    const seen = new Set();
    const output = [];
    for (const entry of combined) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const copy = { ...entry };
      if (!includeContent) {
        const canDetail = copy.fidelity === 'verbatim' || !copy.detailFadedAt;
        if (!canDetail) copy.content = '';
      }
      output.push(copy);
    }
    if (record) {
      for (const entry of output) {
        this.recordRecall({
          entry,
          chatKey,
          query,
          score: Number(entry.activationScore) || 0,
          matchedBy: entry.matchedBy,
          now
        });
      }
    }
    return output;
  }

  /**
   * 显式查找（memory_lookup 工具）：按关键词/人物/类型查长期记忆。
   * 与 recall 不同，这里不要求达到激活阈值；有关键词时只返回词法命中的条目。
   */
  lookup({
    chatKey, query = '', userId = '', kind = '', relevantUserIds = [],
    includeContent = false, limit = 10, record = true, now = this.now()
  } = {}) {
    const cfg = this.human;
    const personIds = userId
      ? [String(userId)]
      : (Array.isArray(relevantUserIds) ? relevantUserIds.map(String) : []);
    const candidates = this.#candidates({
      chatKey,
      relevantUserIds: personIds,
      mentionedUserIds: [],
      limit: cfg.maxCandidates,
      now
    });
    let pool = candidates;
    if (userId) pool = pool.filter((entry) => String(entry.subjectUserId) === String(userId));
    if (kind) pool = pool.filter((entry) => entry.kind === String(kind));
    const lexical = this.#lexicalMap(query, pool, cfg.maxCandidates);
    let picked;
    if (String(query || '').trim()) {
      picked = pool
        .map((entry) => ({ ...entry, lexical: lexical.get(String(entry.id)) || 0 }))
        .filter((entry) => entry.lexical > 0)
        .sort((a, b) => b.lexical - a.lexical
          || b.importance - a.importance
          || b.lastSeenAt - a.lastSeenAt);
    } else {
      picked = [...pool].sort((a, b) => b.importance - a.importance
        || b.lastSeenAt - a.lastSeenAt);
    }
    picked = picked.slice(0, clampInt(limit, 1, 50, 10)).map((entry) => {
      const copy = { ...entry };
      const canDetail = includeContent && (copy.fidelity === 'verbatim' || !copy.detailFadedAt);
      if (!canDetail) copy.content = '';
      return copy;
    });
    if (record && picked.length) {
      for (const entry of picked) {
        this.recordRecall({
          entry, chatKey, query, score: Number(entry.lexical) || 0,
          matchedBy: 'lookup', now
        });
      }
    }
    return picked;
  }

  recordRecall({
    entry, chatKey, query = '', score = 0, matchedBy = '', injected = true, now = this.now()
  } = {}) {
    const id = Number(entry?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    try {
      this.db.prepare(`
        INSERT INTO memory_recall_log (entry_id, chat_key, query_hash, score, matched_by, injected, at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, String(chatKey || entry.chatKey || ''),
        hashOf(String(query || '')).slice(0, 16),
        Number(score) || 0, String(matchedBy || ''), injected ? 1 : 0, Number(now) || this.now()
      );
      this.db.prepare(`
        UPDATE memory_entries
        SET last_recalled_at = ?, recall_count = recall_count + 1, strength = ?
        WHERE id = ?
      `).run(
        Number(now) || this.now(),
        strengthenOnRecall(Number(entry.strength) || 1, { boost: this.human.recallBoost }),
        id
      );
    } catch { /* 召回统计失败不影响本轮返回 */ }
  }

  /** 提示词注入文本：固定约定/决定 + 激活召回；模糊与不可披露项带标记。 */
  formatForPrompt(chatKey, {
    relevantUserIds = [], mentionedUserIds = [], query = '', now = this.now(), maxChars = null
  } = {}) {
    const entries = this.recall({
      chatKey, relevantUserIds, mentionedUserIds, query, now, record: true, includeContent: false
    });
    if (!entries.length) return '';
    const lines = ['【长期记忆】'];
    for (const entry of entries) {
      const label = KIND_LABELS[entry.kind] || '记忆';
      let line = `- ${label}：${sanitizeUserText(entry.abstract)}`;
      if (entry.fidelity !== 'verbatim' && this.human.uncertaintyLabel) line += '（模糊）';
      const disclosure = disclosureLabel(entry);
      if (disclosure) line += disclosure;
      lines.push(line);
    }
    const cap = Math.max(200, Number(maxChars) || this.dailyConfig.maxInjectChars);
    const out = [];
    let used = 0;
    for (const line of lines) {
      const cost = line.length + (out.length ? 1 : 0);
      if (out.length && used + cost > cap) break;
      out.push(line);
      used += cost;
    }
    return out.join('\n');
  }

  /**
   * 每日巩固：强度衰减、gist 细节淡出、transient 到期、召回日志清理。
   * 返回各动作计数，便于控制台/运维观察。
   */
  consolidate({ chatKey = '', now = this.now() } = {}) {
    const cfg = this.human;
    const sql = chatKey
      ? "SELECT * FROM memory_entries WHERE status = 'active' AND chat_key = ?"
      : "SELECT * FROM memory_entries WHERE status = 'active'";
    const rows = chatKey
      ? this.db.prepare(sql).all(String(chatKey))
      : this.db.prepare(sql).all();
    const counts = { decayed: 0, detailFaded: 0, faded: 0, expired: 0 };
    this.#tx(() => {
      for (const row of rows) {
        const entry = entryFromRow(row);
        if (isTransientExpired({ fidelity: entry.fidelity, expiresAt: entry.expiresAt, now })) {
          this.#update(entry.id, { status: 'faded', updatedAt: now });
          counts.expired += 1;
          continue;
        }
        const lastActiveAt = Math.max(
          entry.lastRecalledAt || 0, entry.lastSeenAt || 0,
          entry.updatedAt || 0, entry.createdAt || 0
        );
        let strength = strengthAfterDecay({
          strength: entry.strength,
          importance: entry.importance,
          fidelity: entry.fidelity,
          lastActiveAt,
          now,
          tauBaseDays: cfg.tauBaseDays,
          minStrength: 0.05,
          maxStrength: 2
        });
        const fields = { strength };
        if (shouldFadeDetail({
          fidelity: entry.fidelity,
          updatedAt: entry.updatedAt,
          detailFadedAt: entry.detailFadedAt,
          now,
          gistDetailDays: cfg.gistDetailDays
        })) {
          const searchText = buildSearchText({ abstract: entry.abstract, content: '', keywords: entry.keywords });
          Object.assign(fields, {
            content: '',
            detailFadedAt: now,
            updatedAt: now,
            searchText
          });
          counts.detailFaded += 1;
        }
        if (shouldFade({ strength, fidelity: entry.fidelity, threshold: cfg.fadeThreshold })) {
          fields.status = 'faded';
          counts.faded += 1;
        }
        if (Number(strength) !== Number(entry.strength) || fields.content !== undefined || fields.status) {
          counts.decayed += 1;
        }
        this.#update(entry.id, fields);
        if (fields.searchText !== undefined) this.#syncFts(entry.id, fields.searchText);
      }
      try {
        this.db.prepare('DELETE FROM memory_recall_log WHERE at < ?')
          .run(now - RECALL_LOG_RETENTION_DAYS * DAY_MS);
      } catch { /* 清理失败不阻断 */ }
    });
    return counts;
  }

  listEntries({
    chatKey = '', query = '', kind = '', fidelity = '', privacyScope = '',
    status = 'active', limit = 100, offset = 0
  } = {}) {
    const where = [];
    const params = [];
    if (chatKey) { where.push('chat_key = ?'); params.push(String(chatKey)); }
    if (kind) { where.push('kind = ?'); params.push(String(kind)); }
    if (fidelity) { where.push('fidelity = ?'); params.push(String(fidelity)); }
    if (privacyScope) { where.push('privacy_scope = ?'); params.push(String(privacyScope)); }
    if (status) { where.push('status = ?'); params.push(String(status)); }
    if (String(query || '').trim()) {
      const like = `%${String(query).trim()}%`;
      where.push('(abstract LIKE ? OR content LIKE ? OR subject LIKE ?)');
      params.push(like, like, like);
    }
    const sql = `SELECT * FROM memory_entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY importance DESC, updated_at DESC LIMIT ? OFFSET ?`;
    params.push(clampInt(limit, 1, 500, 100), clampInt(offset, 0, 100000, 0));
    return this.db.prepare(sql).all(...params).map(entryFromRow);
  }

  getEntry(id) {
    return entryFromRow(this.#rowById(id));
  }

  listVersions(entryId) {
    const rows = this.db.prepare(`
      SELECT version, abstract, content, source_date, source_message_ids, reason, created_at
      FROM memory_entry_versions WHERE entry_id = ? ORDER BY version DESC LIMIT 50
    `).all(Number(entryId));
    return rows.map((row) => ({
      version: Number(row.version) || 1,
      abstract: String(row.abstract || ''),
      content: String(row.content || ''),
      sourceDate: String(row.source_date || ''),
      sourceMessageIds: jsonArrayOfStrings(row.source_message_ids),
      reason: String(row.reason || ''),
      createdAt: Number(row.created_at) || 0
    }));
  }

  /** 控制台左侧列表：按会话汇总条目数/最近更新时间/最近总结日。 */
  listChats() {
    const rows = this.db.prepare(`
      SELECT chat_key,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
             MAX(updated_at) AS updatedAt
      FROM memory_entries GROUP BY chat_key ORDER BY updatedAt DESC
    `).all();
    const summaries = this.db.prepare(`
      SELECT chat_key, MAX(day) AS lastDay FROM daily_summaries GROUP BY chat_key
    `).all();
    const lastDay = new Map(summaries.map((row) => [String(row.chat_key), String(row.lastDay || '')]));
    return rows.map((row) => ({
      chatKey: String(row.chat_key),
      total: Number(row.total) || 0,
      active: Number(row.active) || 0,
      updatedAt: Number(row.updatedAt) || 0,
      lastSummaryDay: lastDay.get(String(row.chat_key)) || ''
    }));
  }

  listSummaries({ chatKey = '', limit = 30 } = {}) {
    const rows = chatKey
      ? this.db.prepare('SELECT * FROM daily_summaries WHERE chat_key = ? ORDER BY day DESC LIMIT ?')
        .all(String(chatKey), clampInt(limit, 1, 200, 30))
      : this.db.prepare('SELECT * FROM daily_summaries ORDER BY day DESC LIMIT ?')
        .all(clampInt(limit, 1, 200, 30));
    return rows.map((row) => ({
      chatKey: String(row.chat_key), day: String(row.day),
      overview: String(row.overview || ''), summary: String(row.summary || ''),
      details: String(row.details || ''), messageCount: Number(row.message_count) || 0,
      entryCount: Number(row.entry_count) || 0, updatedAt: Number(row.updated_at) || 0
    }));
  }

  /** 最近召回记录（带条目摘要），用于解释“为什么想起它”。 */
  listRecallLog({ chatKey = '', limit = 50 } = {}) {
    const rows = this.db.prepare(`
      SELECT l.id, l.entry_id, l.chat_key, l.query_hash, l.score, l.matched_by, l.injected, l.at,
             e.kind, e.subject, e.abstract
      FROM memory_recall_log l
      LEFT JOIN memory_entries e ON e.id = l.entry_id
      ${chatKey ? 'WHERE l.chat_key = ?' : ''}
      ORDER BY l.at DESC LIMIT ?
    `).all(
      ...(chatKey ? [String(chatKey)] : []),
      clampInt(limit, 1, 500, 50)
    );
    return rows.map((row) => ({
      id: Number(row.id) || 0,
      entryId: Number(row.entry_id) || 0,
      chatKey: String(row.chat_key || ''),
      score: Number(row.score) || 0,
      matchedBy: String(row.matched_by || ''),
      injected: Boolean(row.injected),
      at: Number(row.at) || 0,
      kind: String(row.kind || ''),
      subject: String(row.subject || ''),
      abstract: String(row.abstract || '')
    }));
  }

  /** 固定为精确记忆：不被自动衰减/细节淡出。 */
  pinEntry(id) {
    const row = this.#rowById(id);
    if (!row) return null;
    const abstract = String(row.abstract || '');
    const content = String(row.content || '') || abstract;
    const keywords = jsonArrayOfStrings(row.keywords);
    const searchText = buildSearchText({ abstract, content, keywords });
    this.#update(row.id, {
      fidelity: 'verbatim',
      status: 'active',
      content,
      strength: Math.max(1.5, Number(row.strength) || 0),
      detailFadedAt: 0,
      updatedAt: this.now(),
      searchText
    });
    this.#syncFts(row.id, searchText);
    return this.getEntry(row.id);
  }

  /** 软删除（模型不可见；控制台仍可查）。hard=true 时连版本与 FTS 一起删。 */
  forgetEntry(id, { hard = false } = {}) {
    const row = this.#rowById(id);
    if (!row) return false;
    if (!hard) {
      this.#update(row.id, { status: 'deleted', updatedAt: this.now() });
      return true;
    }
    this.#tx(() => {
      this.#deleteFts(row.id);
      this.db.prepare('DELETE FROM memory_entry_versions WHERE entry_id = ?').run(Number(row.id));
      this.db.prepare('DELETE FROM memory_recall_log WHERE entry_id = ?').run(Number(row.id));
      this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(Number(row.id));
    });
    return true;
  }

  /** 管理员手动改隐私作用域；自动抽取永远不能放宽既往结论。 */
  setEntryPrivacy(id, changes = {}) {
    const row = this.#rowById(id);
    if (!row) throw new Error('记忆条目不存在');
    const scope = String(changes.privacyScope || row.privacy_scope || 'chat').trim();
    if (!PRIVACY_SCOPES.includes(scope)) throw new Error(`privacyScope 非法：${scope}`);
    const subjectUserId = scope === 'person'
      ? String(changes.subjectUserId || row.subject_user_id || '').trim()
      : '';
    if (scope === 'person' && !validUid(subjectUserId)) {
      throw new Error('person 作用域必须提供有效 subjectUserId');
    }
    const usableRaw = String(changes.usableIn || '').trim();
    let usableIn = USABLE_IN.includes(usableRaw) ? usableRaw : usableInForScope(scope);
    if (scope === 'secret') usableIn = 'source';
    const disclosable = scope === 'knowledge' && changes.disclosable !== false;
    const sensitivity = ['low', 'medium', 'high'].includes(String(changes.sensitivity))
      ? String(changes.sensitivity)
      : (scope === 'secret' ? 'high' : scope === 'person' ? 'medium' : 'low');
    const pathValue = memoryPathFor({
      privacyScope: scope,
      storageScope: String(row.scope || 'chat'),
      chatKey: String(row.chat_key || ''),
      kind: String(row.kind || 'fact'),
      subject: String(row.subject || ''),
      userId: subjectUserId || String(row.user_id || ''),
      sourceDate: String(row.source_date || ''),
      now: this.now()
    });
    this.#update(row.id, {
      privacyScope: scope,
      usableIn,
      disclosable,
      subjectUserId,
      sensitivity,
      classifiedBy: 'manual',
      privacyReason: clean(changes.reason, 160) || '管理员手动调整',
      path: pathValue,
      updatedAt: this.now()
    });
    return this.getEntry(row.id);
  }

  /**
   * 保留期清理：软删除/被替代/淡出的旧条目超过 retentionDays 后物理删除；
   * 同时清理过期的每日总结。返回删除计数。
   */
  pruneRetention({
    now = this.now(), retentionDays = this.dailyConfig.retentionDays, limit = 500
  } = {}) {
    const days = clampInt(retentionDays, 7, 3650, 180);
    const cutoff = Number(now) - days * DAY_MS;
    const rows = this.db.prepare(`
      SELECT id FROM memory_entries
      WHERE status IN ('faded', 'superseded', 'deleted') AND updated_at < ?
      LIMIT ?
    `).all(cutoff, clampInt(limit, 1, 5000, 500));
    let entries = 0;
    let summaries = 0;
    this.#tx(() => {
      for (const row of rows) {
        this.#deleteFts(row.id);
        this.db.prepare('DELETE FROM memory_entry_versions WHERE entry_id = ?').run(Number(row.id));
        this.db.prepare('DELETE FROM memory_recall_log WHERE entry_id = ?').run(Number(row.id));
        this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(Number(row.id));
        entries += 1;
      }
      const dayCutoff = todayKey(cutoff);
      const removed = this.db.prepare('DELETE FROM daily_summaries WHERE day < ?').run(dayCutoff);
      summaries = Number(removed.changes) || 0;
    });
    return { entries, summaries };
  }

  stats() {
    const by = (column) => {
      const rows = this.db.prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM memory_entries GROUP BY ${column}`).all();
      return Object.fromEntries(rows.map((row) => [String(row.key), Number(row.count)]));
    };
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM memory_entries').get();
    const avg = this.db.prepare("SELECT AVG(strength) AS avg FROM memory_entries WHERE status = 'active'").get();
    return {
      total: Number(total?.count) || 0,
      active: Number(this.db.prepare("SELECT COUNT(*) AS count FROM memory_entries WHERE status = 'active'").get()?.count) || 0,
      byStatus: by('status'),
      byFidelity: by('fidelity'),
      byPrivacy: by('privacy_scope'),
      averageStrength: Math.round((Number(avg?.avg) || 0) * 1000) / 1000
    };
  }

  clearChat(chatKey) {
    const rows = this.db.prepare('SELECT id FROM memory_entries WHERE chat_key = ?').all(String(chatKey));
    this.#tx(() => {
      for (const row of rows) this.#deleteFts(row.id);
      this.db.prepare('DELETE FROM memory_entries WHERE chat_key = ?').run(String(chatKey));
      this.db.prepare('DELETE FROM memory_recall_log WHERE chat_key = ?').run(String(chatKey));
    });
    return rows.length;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } catch { /* 已关闭 */ }
  }
}

export default DailyMemoryStore;
