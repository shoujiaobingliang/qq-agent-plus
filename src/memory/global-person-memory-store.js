import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';
import { backupPersonBeforeConsolidation } from './memory-consolidation-backup.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const PEOPLE_DIR = path.join(MEMORY_DIR, 'people');
const MIGRATION_MARKER = path.join(MEMORY_DIR, '_global_people_v1.json');
const MIGRATION_BACKUP_DIR = path.join(MEMORY_DIR, 'backups', 'global-people-v1');

const clean = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const IMPRESSION_HISTORY_LIMIT = 20;
const DEFAULT_IMPRESSION = 50;
const round1 = (value) => Math.round(Number(value) * 10) / 10;
const clampImpression = (value, fallback = DEFAULT_IMPRESSION) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
};
function impressionConfig() {
  const cfg = getConfig().impression;
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
}
function effectiveImpression(member = {}, now = Date.now()) {
  const cfg = impressionConfig();
  const baseline = clampImpression(cfg.baseline, DEFAULT_IMPRESSION);
  const updatedAt = Number(member.impressionUpdatedAt) || 0;
  if (!updatedAt) return baseline;
  const halfLifeDays = Math.min(60, Math.max(1, Number(cfg.decayHalfLifeDays) || 14));
  const elapsed = Math.max(0, Number(now) - updatedAt);
  const factor = Math.pow(0.5, elapsed / (halfLifeDays * 86400000));
  return round1(baseline + (clampImpression(member.impressionScore, baseline) - baseline) * factor);
}
function normalizeImpressionHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      at: Number(item.at) || 0,
      delta: round1(Number(item.delta) || 0),
      score: round1(clampImpression(item.score)),
      reason: clean(item.reason, 80),
      source: clean(item.source, 20),
      chatKey: String(item.chatKey || '')
    }))
    .slice(-IMPRESSION_HISTORY_LIMIT);
}
const validChat = (v) => /^(group|private):\d+$/.test(String(v || ''));
const chatKeyFromDir = (name) => {
  const m = /^(group|private)_(\d+)$/.exec(String(name || ''));
  return m ? `${m[1]}:${m[2]}` : '';
};
const memberFileName = (userId, name = '') => {
  const id = String(userId ?? '').trim();
  if (id) return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  const safe = String(name || 'unknown').replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
};
const memberKey = (userId, name = '') => String(userId || '').trim() || `_n_${memberFileName('', name)}`;
const globalMemberFile = (userId, name = '') => path.join(PEOPLE_DIR, memberFileName(userId, name));

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : fallback;
  } catch (error) {
    // 文件在但读不了（坏 JSON 等）：静默返回 fallback 的话，随后同路径的写入会把它直接
    // 覆盖掉，用户再也查不出人物印象为什么没了。留档成 .broken-<时间戳>（与 reminders /
    // group-game 同口径；2026-10-12 审查）。ENOENT（首次运行没有文件）是正常的。
    if (error?.code !== 'ENOENT') {
      console.error(`[memory-global] 读取 ${file} 失败，本次跳过，原文件已备份为 .broken-<时间戳>：`, error?.message ?? error);
      try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* 备份失败就留在原处，至少不覆盖 */ }
    }
    return fallback;
  }
}
function writeJson(file, value) {
  // 人物印象是隐私正文：目录 0700 / 文件 0600（与 consolidation-backup、identity 库同一口径）。
  // 原来不带 mode，按 umask 022 落成 0644，多用户主机上任意本地用户可读。
  // rename 后显式 chmod：btrfs（部分 NAS）上 writeFileSync 的 mode 会丢失（Issue #11）。
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { encoding: 'utf8', mode: 0o600, flush: true });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
function sourceKeys(value, fallback = '') {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const s = String(v || '').trim();
    if (!validChat(s) || seen.has(s)) return;
    seen.add(s); out.push(s);
  };
  if (Array.isArray(value)) value.forEach(add);
  add(fallback);
  return out;
}
function emptyMember(userId = '', name = '') {
  return {
    version: 2,
    userId: String(userId || ''),
    name: String(name || ''),
    impressions: [],
    sourceChatKeys: [],
    updatedAt: 0,
    lastConsolidatedAt: 0,
    impressionScore: DEFAULT_IMPRESSION,
    impressionUpdatedAt: 0,
    impressionHistory: [],
    lastViceAt: 0
  };
}
// origin：这条印象是怎么来的 —— 'model'（机器人自己 memory_append 记的）、
// 'consolidated'（记忆整理/提炼改写的）、'manual'（控制台手动编辑的）；
// 老数据没有这个字段，保持空串，UI 上显示成"早先"。
export const IMPRESSION_ORIGINS = ['model', 'consolidated', 'manual'];
function normalizeOrigin(raw) {
  const value = String(raw ?? '').trim();
  return IMPRESSION_ORIGINS.includes(value) ? value : '';
}

function normalizeEntry(raw, fallbackChatKey = '') {
  const content = clean(raw?.content ?? raw);
  if (!content) return null;
  const createdAt = Number(raw?.createdAt) || Date.now();
  return {
    content,
    createdAt,
    lastObservedAt: Math.max(createdAt, Number(raw?.lastObservedAt) || 0),
    origin: normalizeOrigin(raw?.origin),
    sourceChatKeys: sourceKeys(raw?.sourceChatKeys, raw?.sourceChatKey || fallbackChatKey)
  };
}
function mergeEntry(member, entry) {
  const old = member.impressions.find((x) => x.content === entry.content);
  if (!old) {
    member.impressions.push({ ...entry, sourceChatKeys: [...entry.sourceChatKeys] });
    return;
  }
  // 同一句话再被记一次：正文没变，来源也不该被改写（手动写的那条别被标成自动）
  old.createdAt = Math.min(Number(old.createdAt) || entry.createdAt, entry.createdAt);
  old.lastObservedAt = Math.max(Number(old.lastObservedAt) || old.createdAt, entry.lastObservedAt || entry.createdAt);
  old.sourceChatKeys = sourceKeys([...(old.sourceChatKeys || []), ...(entry.sourceChatKeys || [])]);
}
function normalizeMember(raw = {}, userId = '', name = '', fallbackChatKey = '') {
  const member = emptyMember(raw.userId ?? userId, raw.name ?? name);
  member.updatedAt = Number(raw.updatedAt) || 0;
  member.lastConsolidatedAt = Number(raw.lastConsolidatedAt) || 0;
  member.impressionScore = clampImpression(raw.impressionScore);
  member.impressionUpdatedAt = Number(raw.impressionUpdatedAt) || 0;
  member.impressionHistory = normalizeImpressionHistory(raw.impressionHistory);
  member.lastViceAt = Number(raw.lastViceAt) || 0;
  member.sourceChatKeys = sourceKeys(raw.sourceChatKeys, fallbackChatKey);
  for (const item of Array.isArray(raw.impressions) ? raw.impressions : []) {
    const entry = normalizeEntry(item, fallbackChatKey);
    if (entry) mergeEntry(member, entry);
  }
  member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, ...member.impressions.flatMap((x) => x.sourceChatKeys || [])]);
  member.impressions.sort((a, b) => (a.lastObservedAt || a.createdAt) - (b.lastObservedAt || b.createdAt));
  return member;
}
function mergeMember(target, incoming) {
  if (!target.userId && incoming.userId) target.userId = incoming.userId;
  if (incoming.name && (!target.name || incoming.updatedAt >= target.updatedAt)) target.name = incoming.name;
  for (const entry of incoming.impressions) mergeEntry(target, entry);
  target.sourceChatKeys = sourceKeys([...target.sourceChatKeys, ...incoming.sourceChatKeys]);
  target.updatedAt = Math.max(target.updatedAt || 0, incoming.updatedAt || 0);
  target.lastConsolidatedAt = Math.max(target.lastConsolidatedAt || 0, incoming.lastConsolidatedAt || 0);
  // 印象分跟着“最近一次调整”走；整理/合并不能把分数冲回默认值。
  if (Number(incoming.impressionUpdatedAt) > Number(target.impressionUpdatedAt)) {
    target.impressionScore = clampImpression(incoming.impressionScore);
    target.impressionUpdatedAt = Number(incoming.impressionUpdatedAt) || 0;
    target.impressionHistory = normalizeImpressionHistory(incoming.impressionHistory);
  }
  target.lastViceAt = Math.max(Number(target.lastViceAt) || 0, Number(incoming.lastViceAt) || 0);
}
function archive(src, rel) {
  try {
    if (!fs.existsSync(src)) return;
    const dst = path.join(MIGRATION_BACKUP_DIR, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
    fs.renameSync(src, dst);
  } catch (error) { console.warn('[memory] 归档旧人物记忆失败:', error?.message ?? error); }
}

export class GlobalPersonMemoryStore {
  constructor({ onLegacyState = null } = {}) {
    this.people = null;
    this.onLegacyState = typeof onLegacyState === 'function' ? onLegacyState : null;
  }
  #persist(member) {
    member.version = 2;
    member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, ...member.impressions.flatMap((x) => x.sourceChatKeys || [])]);
    writeJson(globalMemberFile(member.userId, member.name), member);
  }
  #load() {
    const map = new Map();
    try {
      for (const file of fs.readdirSync(PEOPLE_DIR)) {
        if (!file.endsWith('.json')) continue;
        const raw = readJson(path.join(PEOPLE_DIR, file));
        if (!raw) continue;
        const member = normalizeMember(raw, raw.userId, raw.name);
        map.set(memberKey(member.userId, member.name), member);
      }
    } catch { /* no global dir yet */ }
    return map;
  }
  #merge(map, incoming) {
    const key = memberKey(incoming.userId, incoming.name);
    const member = map.get(key) || emptyMember(incoming.userId, incoming.name);
    mergeMember(member, incoming);
    map.set(key, member);
  }
  #migrateSingle(chatKey, file, map) {
    const old = readJson(file);
    if (!old) return;
    this.onLegacyState?.(chatKey, old);
    const notes = getConfig().memberNotes || {};
    const byName = Object.fromEntries(Object.entries(notes).filter(([, name]) => name).map(([qq, name]) => [String(name), String(qq)]));
    for (const item of Array.isArray(old.memberImpression) ? old.memberImpression : []) {
      const content = clean(item?.content);
      if (!content) continue;
      const target = String(item?.target || '').trim();
      const userId = String(item?.userId || '').trim() || (/^\d{5,15}$/.test(target) ? target : (byName[target] || ''));
      this.#merge(map, normalizeMember({
        userId, name: target || userId, sourceChatKeys: [chatKey], updatedAt: Number(item?.createdAt) || Date.now(),
        impressions: [{ content, createdAt: Number(item?.createdAt) || Date.now(), sourceChatKeys: [chatKey] }]
      }, userId, target, chatKey));
    }
  }
  #ensure() {
    if (this.people) return this.people;
    const map = this.#load();
    const marker = readJson(MIGRATION_MARKER);
    if (!marker?.completed) {
      const archives = [];
      let names = [];
      try { names = fs.readdirSync(MEMORY_DIR); } catch { names = []; }
      for (const name of names) {
        const full = path.join(MEMORY_DIR, name);
        let stat; try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isFile()) {
          const m = /^(group|private)_(\d+)\.json$/.exec(name);
          if (!m) continue;
          const chatKey = `${m[1]}:${m[2]}`;
          this.#migrateSingle(chatKey, full, map);
          archives.push([full, path.join('legacy-single', name)]);
          continue;
        }
        if (!stat.isDirectory()) continue;
        const chatKey = chatKeyFromDir(name);
        if (!chatKey) continue;
        let files = []; try { files = fs.readdirSync(full); } catch { continue; }
        for (const file of files) {
          if (!file.endsWith('.json') || file.startsWith('_')) continue;
          const src = path.join(full, file);
          const raw = readJson(src);
          if (!raw) continue;
          this.#merge(map, normalizeMember(raw, raw.userId, raw.name, chatKey));
          archives.push([src, path.join(name, file)]);
        }
      }
      for (const member of map.values()) this.#persist(member);
      writeJson(MIGRATION_MARKER, { version: 1, completed: true, migratedAt: Date.now(), people: map.size });
      for (const [src, rel] of archives) archive(src, rel);
    }
    this.people = map;
    return map;
  }
  listSourceChats() {
    const out = new Set();
    for (const member of this.#ensure().values()) for (const key of member.sourceChatKeys) out.add(key);
    return [...out];
  }
  members(sourceChatKey = '') {
    const source = String(sourceChatKey || '').trim();
    return [...this.#ensure().values()]
      .filter((m) => (m.impressions.length || m.impressionHistory.length)
        && (!source || m.sourceChatKeys.includes(source)))
      .map((m) => structuredClone(m))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(userId) {
    const uid = String(userId || '').trim();
    return structuredClone(this.#ensure().get(uid) || emptyMember(uid));
  }
  /** 某个人的印象分快照（惰性衰减后），供提示词/控制台使用。 */
  impressionOf(userId, { now = Date.now() } = {}) {
    const uid = String(userId || '').trim();
    const member = this.#ensure().get(uid) || emptyMember(uid);
    return {
      userId: uid,
      name: member.name || '',
      score: effectiveImpression(member, now),
      baseline: clampImpression(impressionConfig().baseline, DEFAULT_IMPRESSION),
      history: normalizeImpressionHistory(member.impressionHistory).slice(-10),
      lastViceAt: Number(member.lastViceAt) || 0
    };
  }
  /**
   * 调整某个人的印象分：先按半衰期衰减，再应用 ±5 内的单次变化。
   * 返回快照；印象分关闭/uid 非法/变化为 0 时返回当前快照或不写盘。
   */
  adjustImpression(userId, {
    delta = 0, reason = '', chatKey = '', source = 'judge', name = '', now = Date.now()
  } = {}) {
    const cfg = impressionConfig();
    if (cfg.enabled === false) return null;
    const uid = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uid)) return null;
    const map = this.#ensure();
    const member = map.get(uid) || emptyMember(uid, name);
    const before = effectiveImpression(member, now);
    const change = Math.min(5, Math.max(-5, Number(delta) || 0));
    const score = clampImpression(before + change, clampImpression(cfg.baseline, DEFAULT_IMPRESSION));
    const actual = round1(score - before);
    if (!actual) return this.impressionOf(uid, { now });
    member.impressionScore = score;
    member.impressionUpdatedAt = now;
    member.impressionHistory = [
      ...normalizeImpressionHistory(member.impressionHistory),
      {
        at: now,
        delta: actual,
        score,
        reason: clean(reason, 80),
        source: clean(source, 20),
        chatKey: String(chatKey || '')
      }
    ].slice(-IMPRESSION_HISTORY_LIMIT);
    if (name) member.name = clean(name, 60) || member.name;
    member.userId = uid;
    if (validChat(chatKey)) member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, chatKey]);
    member.updatedAt = now;
    this.#persist(member);
    map.set(memberKey(member.userId, member.name), member);
    return this.impressionOf(uid, { now });
  }
  /** 批量应用评审返回的按人印象变化；只处理数字 QQ 号，返回成功应用的快照。 */
  adjustImpressions(list, { chatKey = '', source = 'judge', now = Date.now() } = {}) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const uid = String(item?.uid ?? item?.userId ?? '').trim();
      if (!/^\d{1,15}$/.test(uid)) continue;
      const snapshot = this.adjustImpression(uid, {
        delta: item?.delta,
        reason: item?.reason,
        chatKey,
        source,
        name: item?.name || '',
        now
      });
      if (snapshot) out.push(snapshot);
    }
    return out;
  }
  /** 群级“高印象分享”系数：成员平均印象越高，主动分享概率越高。 */
  impressionFactorForChat(chatKey, { now = Date.now() } = {}) {
    const cfg = impressionConfig();
    if (cfg.enabled === false) return 1;
    const members = this.members(chatKey);
    if (!members.length) return 1;
    const baseline = clampImpression(cfg.baseline, DEFAULT_IMPRESSION);
    const scores = members.map((m) => effectiveImpression(m, now));
    const avg = scores.reduce((n, v) => n + v, 0) / scores.length;
    const influence = Math.min(0.5, Math.max(0, Number(cfg.highShareInfluence) || 0));
    return Math.min(1.3, Math.max(0.85, 1 + ((avg - baseline) / Math.max(1, baseline)) * influence));
  }
  /** 低印象回复系数：这批发送者的平均印象低于阈值时，按比例降低回复概率。 */
  replyFactorForUserIds(userIds = [], { now = Date.now() } = {}) {
    const cfg = impressionConfig();
    if (cfg.enabled === false) return 1;
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(String).filter(Boolean))];
    if (!ids.length) return 1;
    const map = this.#ensure();
    const scores = ids.map((uid) => effectiveImpression(map.get(uid) || emptyMember(uid), now));
    if (!scores.length) return 1;
    const avg = scores.reduce((n, v) => n + v, 0) / scores.length;
    const low = Math.min(100, Math.max(1, Number(cfg.lowThreshold) || 30));
    if (avg >= low) return 1;
    const floor = Math.min(0.8, Math.max(0.1, Number(cfg.lowReplyFactor) || 0.4));
    return Math.min(1, Math.max(floor * 0.8, floor + (avg / low) * (1 - floor)));
  }
  markViceTriggered(userId, { now = Date.now() } = {}) {
    const uid = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uid)) return false;
    const map = this.#ensure();
    const member = map.get(uid) || emptyMember(uid, '');
    member.lastViceAt = Number(now) || Date.now();
    member.updatedAt = member.lastViceAt;
    this.#persist(member);
    map.set(memberKey(member.userId, member.name), member);
    return true;
  }
  viceCooldownOk(userId, minutes = 30, now = Date.now()) {
    const member = this.#ensure().get(String(userId || '').trim());
    const last = Number(member?.lastViceAt) || 0;
    if (!last) return true;
    return Number(now) - last >= Math.max(1, Number(minutes) || 30) * 60000;
  }
  append(chatKey, userId, name, content, createdAt = Date.now(), origin = 'model', lastObservedAt = 0) {
    const map = this.#ensure();
    const key = memberKey(userId, name);
    const member = map.get(key) || emptyMember(userId, name);
    const now = Date.now();
    // lastObservedAt 默认取当下（"现在又看到了一次"）；只有把遗留记录并进来时才传它的旧时间 ——
    // 否则那条一年前的印象会被当成今天观察到的：日期前缀显示成今天、按新旧挑最近 3 条时挤掉真正新的、
    // "90 天没再观察到就删"的规则也永远不成立。
    const entry = normalizeEntry({
      content, createdAt, lastObservedAt: Number(lastObservedAt) || now, origin, sourceChatKeys: [chatKey]
    }, chatKey);
    if (!entry) return null;
    mergeEntry(member, entry);
    member.userId = String(userId || member.userId || '');
    member.name = String(name || member.name || member.userId || '');
    member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, chatKey]);
    member.updatedAt = now;
    this.#persist(member); map.set(memberKey(member.userId, member.name), member);
    return structuredClone(entry);
  }
  /**
   * 把一批"只有名字、没有 QQ 号"的遗留印象并到反查出来的那个人名下。
   * 走 append（合并）而不是 replace：对方名下可能已经有印象，整份替换会把它们冲掉。
   */
  adoptImpressions(chatKey, userId, name, entries = []) {
    const uid = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uid)) return 0;
    let adopted = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const content = clean(entry?.content ?? entry, 300);
      if (!content) continue;
      const source = sourceKeys(entry?.sourceChatKeys)[0] || String(chatKey || '');
      // 连同"最后一次观察到"的旧时间一起搬过来（缺了就退回 createdAt）：并记录 ≠ 重新观察到
      const observed = Number(entry?.lastObservedAt) || Number(entry?.createdAt) || 0;
      const saved = this.append(source, uid, name, content, Number(entry?.createdAt) || Date.now(), String(entry?.origin || ''), observed);
      if (saved) adopted += 1;
    }
    return adopted;
  }
  replace(chatKey, userId, name, contents, { origin = 'consolidated' } = {}) {
    const uid = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensure();
    const old = map.get(uid) || emptyMember(uid, name);
    const finalName = clean(name, 60) || old.name || uid;
    const now = Date.now();
    const incoming = (Array.isArray(contents) ? contents : [contents])
      .map((x) => clean(x)).filter(Boolean).slice(0, 20);
    const hadSource = old.sourceChatKeys.includes(String(chatKey || '').trim());
    let member;
    if (old.impressions.length && !hadSource) {
      // A globally known person can appear in a new chat before that chat has ever written memory.
      // Consolidation treats such a person as "new" for the chat. Merge the newly extracted
      // impressions instead of replacing the person's existing global memory.
      member = structuredClone(old);
      member.userId = uid;
      member.name = finalName;
      member.updatedAt = now;
      member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, chatKey]);
      for (const content of incoming) {
        mergeEntry(member, {
          content,
          createdAt: now,
          lastObservedAt: now,
          origin: normalizeOrigin(origin),
          sourceChatKeys: sourceKeys([chatKey])
        });
      }
    } else {
      const sources = sourceKeys([...old.sourceChatKeys, ...old.impressions.flatMap((x) => x.sourceChatKeys || []), chatKey]);
      // 内容没变的条目沿用旧时间戳 —— 整理只是"改写/合并"，不是"重新观察到"。
      // 以前这里一律赋 now：每次整理都把全部印象的年龄刷成当天，展示端的日期前缀
      // 变成"上次整理日期"，"90 天没再观察到就删"这类规则也永远不成立。
      const previous = new Map((old.impressions || []).map((e) => [String(e.content), e]));
      member = {
        version: 2, userId: uid, name: finalName, sourceChatKeys: sources,
        updatedAt: now, lastConsolidatedAt: old.lastConsolidatedAt || 0,
        impressionScore: clampImpression(old.impressionScore),
        impressionUpdatedAt: Number(old.impressionUpdatedAt) || 0,
        impressionHistory: normalizeImpressionHistory(old.impressionHistory),
        lastViceAt: Number(old.lastViceAt) || 0,
        impressions: incoming.map((content) => {
          const prev = previous.get(String(content));
          const createdAt = Number(prev?.createdAt) || now;
          // 每条印象**自己**的来源要如实：正文原样保留的沿用旧来源，新写/改写过的只算这次整理的会话。
          // 原来这里一律写全体来源的并集：整理一次之后，每条印象都声称"来自所有会话"，
          // 于是"删掉某人在某个群的印象"（clearPersonSource / clearSource）就永远删不掉了。
          const prevSources = prev ? sourceKeys(prev.sourceChatKeys) : [];
          return {
            content,
            createdAt,
            lastObservedAt: Math.max(createdAt, Number(prev?.lastObservedAt) || 0),
            // 正文没变就沿用旧来源（整理原样保留的一条，不该被记成"整理改写的"）
            origin: prev ? normalizeOrigin(prev.origin) : normalizeOrigin(origin),
            sourceChatKeys: prevSources.length ? prevSources : sourceKeys([chatKey])
          };
        })
      };
    }
    // 同名的人不止一个时，"只有名字"的旧条目到底是谁的就说不准了：
    // 不能借整理的机会把它并进随便哪个人（重名会互相污染），留给人工处理。
    const sameNamePeople = [...map.values()].filter((m) =>
      m.name === finalName && /^\d{1,15}$/.test(String(m.userId || '').trim())).length;
    for (const [key, candidate] of [...map.entries()]) {
      if (key === uid || candidate.name !== finalName) continue;
      // 有真 QQ 号的是另一个人（重名也一样），不动它
      if (/^\d{1,15}$/.test(String(candidate.userId || '').trim())) continue;
      if (sameNamePeople > 1) continue;
      // 同名但没 QQ 号的旧条目（含早期把名字本身当 id 存的）：印象必须先并进来再删文件。
      // 原来只并了 sourceChatKeys 就 rmSync，那份历史印象会静默消失，而且不在"整理前快照"的覆盖范围内（快照按数字 uid 找）。
      for (const entry of (candidate.impressions || [])) {
        const content = String(entry?.content || '').trim();
        if (!content) continue;
        if ((member.impressions || []).some((v) => v.content === content)) continue;
        member.impressions.push({ ...entry, sourceChatKeys: sourceKeys(entry?.sourceChatKeys) });
      }
      member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, ...candidate.sourceChatKeys]);
      // 先把合并结果落盘、删旧文件前再拍一份快照：原来 rm 在前、#persist 在循环外，
      // 落盘一旦失败（磁盘满/权限），已删掉的旧印象就静默消失且无快照可回滚。
      this.#persist(member);
      try { backupPersonBeforeConsolidation(candidate, { sourceChatKey: '', at: Date.now(), reason: 'merge-absorb' }); } catch { /* 备份失败不阻断 */ }
      try { fs.rmSync(globalMemberFile(candidate.userId, candidate.name), { force: true }); } catch { /* 有意忽略：删残留文件失败仅造成文件残留，数据已先留快照可回滚 */ }
      map.delete(key);
    }
    this.#persist(member); map.set(uid, member);
    return structuredClone(member);
  }
  removeMember(userId) {
    const uid = String(userId || '').trim();
    const map = this.#ensure(); const member = map.get(uid);
    if (!member) return false;
    // 破坏性删除前留一份快照（与整理前快照同一套目录，可回滚）
    try { backupPersonBeforeConsolidation(member, { sourceChatKey: '', at: Date.now(), reason: 'manual-delete' }); } catch { /* 备份失败不阻断 */ }
    map.delete(uid); try { fs.rmSync(globalMemberFile(member.userId, member.name), { force: true }); } catch { /* 有意忽略：删残留文件失败仅造成文件残留，数据已先留快照可回滚 */ }
    return true;
  }
  remove({ userId = '', target = '', content = '', sourceChatKey = '' } = {}) {
    const map = this.#ensure();
    const uid = String(userId || '').trim();
    const name = String(target || '').trim();
    const scope = String(sourceChatKey || '').trim();
    // 只按名字匹配时，重名不敢猜：宁可一条都不删，也不能把同名那个人的全部记忆删掉
    if (!uid && name) {
      const hits = [...map.values()].filter((m) =>
        (m.name || m.userId) === name && (!scope || sourceKeys(m.sourceChatKeys).includes(scope)));
      if (hits.length !== 1) return false;
    }
    let removed = false;
    for (const [key, member] of [...map.entries()]) {
      if (scope && !sourceKeys(member.sourceChatKeys).includes(scope)) continue;
      const match = uid ? member.userId === uid : name ? (member.name || member.userId) === name : true;
      if (!match) continue;
      // 快照要在**清空之前**打：原来放在清空之后，backupPersonBeforeConsolidation 见到空列表
      // 直接返回 null，等于从来没备份过 —— 删掉的东西再也找不回来。
      const before = structuredClone(member);
      if (content) {
        const n = member.impressions.length;
        // 带来源范围时按**条目自己的来源**过滤：这条内容只出现在别的会话的话，不该被这次删掉
        member.impressions = member.impressions.filter((x) =>
          x.content !== content || (scope && !sourceKeys(x.sourceChatKeys).includes(scope)));
        removed ||= member.impressions.length !== n;
      } else { member.impressions = []; removed = true; }
      // 摘掉印象后要重算成员级来源：否则这个人还会声称"来自 A 群"，而他在 A 群已经没有印象了
      //（members(chatKey) / consolidationState 会把他算进 A 群；2026-10-13 全项目审查 P3）。
      member.sourceChatKeys = sourceKeys(member.impressions.flatMap((x) => x.sourceChatKeys || []));
      // 只要真删掉了东西就留快照，不限于"整条被删空"：这个人还有别的来源时，
      // 被摘掉的那几条同样再也回不来 —— 而控制台文案承诺的是"服务端会留可回滚快照"。
      // before 是动手前的克隆；它本来就是空列表时，备份函数自己会返回 null 不落盘。
      if (removed) { try { backupPersonBeforeConsolidation(before, { sourceChatKey: scope, at: Date.now(), reason: 'manual-delete' }); } catch { /* 备份失败不阻断 */ } }
      if (!member.impressions.length) {
        map.delete(key); try { fs.rmSync(globalMemberFile(member.userId, member.name), { force: true }); } catch { /* 有意忽略：删残留文件失败仅造成文件残留，数据已先留快照可回滚 */ }
      } else { member.updatedAt = Date.now(); this.#persist(member); }
      if (uid || name) break;
    }
    return removed;
  }
  clearSource(chatKey) {
    const source = String(chatKey || '').trim(); const map = this.#ensure();
    for (const [key, member] of [...map.entries()]) {
      if (!member.sourceChatKeys.includes(source)) continue;
      // 快照必须在**清空之前**打（backupPersonBeforeConsolidation 见到空列表直接返回 null）；
      // 放在下面那段之后等于从来没备份过 —— 与 remove() 同一处坑，这次一起按同一写法处理。
      const before = structuredClone(member);
      let touched = false;
      for (const entry of member.impressions) {
        if (!(entry.sourceChatKeys || []).includes(source)) continue;
        entry.sourceChatKeys = entry.sourceChatKeys.filter((x) => x !== source);
        touched = true;
      }
      member.impressions = member.impressions.filter((x) => x.sourceChatKeys.length);
      member.sourceChatKeys = sourceKeys(member.impressions.flatMap((x) => x.sourceChatKeys));
      member.updatedAt = Date.now();
      // 同上：这个人还有别的来源时也要留快照 —— 被摘掉的那几条一样回不来
      if (touched) { try { backupPersonBeforeConsolidation(before, { sourceChatKey: source, at: Date.now(), reason: 'manual-delete' }); } catch { /* 备份失败不阻断 */ } }
      if (!member.impressions.length) {
        map.delete(key); try { fs.rmSync(globalMemberFile(member.userId, member.name), { force: true }); } catch { /* 有意忽略：删残留文件失败仅造成文件残留，数据已先留快照可回滚 */ }
      } else this.#persist(member);
    }
  }
  /** 只清掉某个人在某个会话里的印象：控制台"按群删除某个成员"的语义。 */
  clearPersonSource(userId, chatKey) {
    const uid = String(userId || '').trim();
    const source = String(chatKey || '').trim();
    const map = this.#ensure();
    const member = map.get(uid);
    if (!member || !source) return false;
    // 同上：先留快照再动 member
    const before = structuredClone(member);
    let touched = false;
    for (const entry of member.impressions) {
      if (!(entry.sourceChatKeys || []).includes(source)) continue;
      entry.sourceChatKeys = entry.sourceChatKeys.filter((x) => x !== source);
      touched = true;
    }
    member.impressions = member.impressions.filter((x) => (x.sourceChatKeys || []).length);
    member.sourceChatKeys = sourceKeys(member.impressions.flatMap((x) => x.sourceChatKeys));
    member.updatedAt = Date.now();
    // 有东西被摘掉就留快照（不只是整条删空）：这个人还有别的来源时，删掉的同样回不来
    if (touched) { try { backupPersonBeforeConsolidation(before, { sourceChatKey: source, at: Date.now(), reason: 'manual-delete' }); } catch { /* 备份失败不阻断 */ } }
    if (!member.impressions.length) {
      map.delete(uid);
      try { fs.rmSync(globalMemberFile(member.userId, member.name), { force: true }); } catch { /* 有意忽略：删残留文件失败仅造成文件残留，数据已先留快照可回滚 */ }
    } else this.#persist(member);
    return touched;
  }

  markConsolidated(userIds, at = Date.now()) {
    const map = this.#ensure();
    for (const uid of userIds || []) {
      const member = map.get(String(uid || '').trim());
      if (!member) continue;
      member.lastConsolidatedAt = Number(at) || Date.now(); this.#persist(member);
    }
  }
}
