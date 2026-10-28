// 已读 session 的用量索引：文件只读一次，结果落 SQLite。
//
// 为什么不再用内存 Map：进程重启/切换 range/回填历史时，固定 session 会被反复
// readFileSync + JSON.parse；这正是控制台磁盘风暴的来源。索引按 (file, mtime, size)
// 命中后直接复用 rows，只有新建/运行中/被改写过的 session 才重新打开文件。
//
// 定稿标记：status 一旦离开 running/waiting，会话文件就不会再被改写（finish 写最终态，
// 启动回收也只碰 running/waiting）。这类条目标 final=1，之后按窗口直接由 SQL 取出，
// 连 stat 都不做；last_at 记录会话内最晚时间，用来判断窗口相交而不必读文件。
//
// 只保存用量行与计数，不保存 prompt/消息正文；SQLite 落盘，内存里只保留当前查询
// 范围内的行。超过保留期的行由 prune 清理（历史日汇总在 usage-daily.json 里）。
import path from 'node:path';
import { openDatabase } from '../core/sqlite.js';
import { DATA_DIR } from '../core/config.js';

const KEEP_MS = 365 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let db = null;
let lastPruneAt = 0;

function indexDb() {
  if (db) return db;
  db = openDatabase(path.join(DATA_DIR, 'usage-index.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS usage_files (
      file TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      rows_json TEXT NOT NULL,
      search_count INTEGER NOT NULL DEFAULT 0,
      tool_counts_json TEXT NOT NULL DEFAULT '{}',
      final INTEGER NOT NULL DEFAULT 0,
      last_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_files_started ON usage_files(started_at);
  `);
  // 老库补列：CREATE TABLE IF NOT EXISTS 不会给已有表加字段。
  // 必须放在建索引之前：老库还没有 last_at 时就 CREATE INDEX 会抛错，
  // 让整个索引层静默失效（退化成每次全量重读文件）。
  // 补齐后旧行 final=0，会被当成未定稿再读一次，之后自然转为 final。
  const cols = new Set(db.prepare('PRAGMA table_info(usage_files)').all().map((r) => r.name));
  if (!cols.has('final')) db.exec('ALTER TABLE usage_files ADD COLUMN final INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('last_at')) db.exec('ALTER TABLE usage_files ADD COLUMN last_at INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS usage_files_last ON usage_files(last_at);');
  return db;
}

/** 命中返回索引条目；mtime/size 任一变化都视为未命中。 */
export function getUsageFile(file, mtimeMs, size) {
  try {
    const row = indexDb().prepare(
      'SELECT * FROM usage_files WHERE file=? AND mtime_ms=? AND size=?'
    ).get(String(file), Number(mtimeMs), Number(size));
    if (!row) return null;
    return {
      mtimeMs: Number(row.mtime_ms),
      size: Number(row.size),
      startedAt: Number(row.started_at) || 0,
      rows: JSON.parse(row.rows_json || '[]'),
      searchCount: Number(row.search_count) || 0,
      toolCounts: JSON.parse(row.tool_counts_json || '{}'),
      final: Number(row.final) === 1,
      lastAt: Number(row.last_at) || 0
    };
  } catch {
    return null;
  }
}

/**
 * 取与窗口相交的已定稿条目（不读任何文件）。
 * 只返回元数据与 rows，调用方仍需按磁盘文件列表剔除已被保留期清理的条目。
 */
export function listFinalUsage(start, end) {
  try {
    const rows = indexDb().prepare(`
      SELECT file, started_at, last_at, rows_json, search_count, tool_counts_json
      FROM usage_files
      WHERE final=1 AND started_at <= ? AND last_at >= ?
    `).all(Number(end) || Number.MAX_SAFE_INTEGER, Number(start) || 0);
    return rows.map((row) => ({
      file: String(row.file),
      startedAt: Number(row.started_at) || 0,
      lastAt: Number(row.last_at) || 0,
      rows: JSON.parse(row.rows_json || '[]'),
      searchCount: Number(row.search_count) || 0,
      toolCounts: JSON.parse(row.tool_counts_json || '{}')
    }));
  } catch {
    return [];
  }
}

/**
 * 删除磁盘上已不存在的文件索引：保留期清理后，已定稿行不能再从索引里计入统计。
 * 只清 updated_at 早于 60 秒的条目，避开"刚建的文件没被本次 readdir 看到"的竞态。
 */
export function pruneMissingUsageFiles(existingFiles) {
  try {
    const cutoff = Date.now() - 60 * 1000;
    const rows = indexDb().prepare('SELECT file FROM usage_files WHERE updated_at < ?').all(cutoff);
    const stale = rows.filter((row) => !existingFiles.has(String(row.file)));
    if (!stale.length) return;
    const del = indexDb().prepare('DELETE FROM usage_files WHERE file=?');
    for (const row of stale) del.run(String(row.file));
  } catch {
    // 清理失败不影响统计；最多多计入一些已删会话。
  }
}

export function putUsageFile(file, entry = {}) {
  try {
    const now = Date.now();
    indexDb().prepare(`
      INSERT INTO usage_files
        (file, mtime_ms, size, started_at, rows_json, search_count, tool_counts_json, final, last_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file) DO UPDATE SET
        mtime_ms=excluded.mtime_ms,
        size=excluded.size,
        started_at=excluded.started_at,
        rows_json=excluded.rows_json,
        search_count=excluded.search_count,
        tool_counts_json=excluded.tool_counts_json,
        final=excluded.final,
        last_at=excluded.last_at,
        updated_at=excluded.updated_at
    `).run(
      String(file),
      Number(entry.mtimeMs) || 0,
      Number(entry.size) || 0,
      Number(entry.startedAt) || 0,
      JSON.stringify(Array.isArray(entry.rows) ? entry.rows : []),
      Number(entry.searchCount) || 0,
      JSON.stringify(entry.toolCounts || {}),
      entry.final === true ? 1 : 0,
      Number(entry.lastAt) || 0,
      now
    );
    if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      try {
        indexDb().prepare('DELETE FROM usage_files WHERE started_at < ?').run(now - KEEP_MS);
      } catch { /* 清理失败不影响写入 */ }
    }
  } catch {
    // 索引用途失败不能影响控制台主流程；下回未命中会重新读文件。
  }
}

export function closeUsageIndex() {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
  lastPruneAt = 0;
}
