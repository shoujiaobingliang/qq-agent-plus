// 心情状态：心情 + 精力两轴（0-100），全局一份，规则驱动。
//
// 为什么单独一个 JSON 文件而不进 config.json：
//   · config.json 含凭据、每次保存都会走审计与全局 status 刷新；
//   · 心情是高频变化的运行状态，不该把整份配置重写一遍。
//
// 这里只做「纯状态 + 原子持久化」，不读配置、不起定时器：
//   · 衰减是惰性的（读取/应用时按经过时间计算），重启与长时间空闲都不会多算；
//   · 只在真正发生加减分或重置时写盘，控制台轮询只读不写。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { todayKey } from './util.js';

export const MOOD_STATE_VERSION = 1;
export const DEFAULT_MOOD = 55;
export const DEFAULT_ENERGY = 55;
export const DEFAULT_HISTORY_LIMIT = 200;
export const DEFAULT_DAILY_KEEP_DAYS = 90;
export const MAX_EVENT_DELTA = 5;
export const MAX_HOURLY_DELTA = 12;
export const MAX_HOURLY_ACTOR_DELTA = 6;

const HOUR_MS = 60 * 60 * 1000;

export function moodFile(dataDir = DATA_DIR) {
  return path.join(dataDir, 'mood.json');
}

function clampScore(value, fallback = DEFAULT_MOOD) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function clampDelta(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 0;
  return Math.min(MAX_EVENT_DELTA, Math.max(-MAX_EVENT_DELTA, n));
}

function normalizeLastChange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    at: Number(value.at) || 0,
    moodDelta: round1(Number(value.moodDelta) || 0),
    energyDelta: round1(Number(value.energyDelta) || 0),
    reason: String(value.reason || '')
  };
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      at: Number(item.at) || 0,
      actorId: String(item.actorId || ''),
      moodDelta: round1(Number(item.moodDelta) || 0),
      energyDelta: round1(Number(item.energyDelta) || 0),
      mood: round1(clampScore(item.mood)),
      energy: round1(clampScore(item.energy)),
      reason: String(item.reason || ''),
      chatKey: String(item.chatKey || '')
    }));
}

function normalizeDaily(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    out[key] = {
      date: key,
      events: Math.max(0, Math.round(Number(item.events) || 0)),
      moodDelta: round1(Number(item.moodDelta) || 0),
      energyDelta: round1(Number(item.energyDelta) || 0),
      startMood: round1(clampScore(item.startMood)),
      endMood: item.endMood === undefined ? undefined : round1(clampScore(item.endMood)),
      startEnergy: round1(clampScore(item.startEnergy)),
      endEnergy: item.endEnergy === undefined ? undefined : round1(clampScore(item.endEnergy))
    };
  }
  return out;
}

function normalizeRest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const until = Number(value.until);
  if (!Number.isFinite(until) || until <= 0) return null;
  const kind = value.kind === 'slack' ? 'slack' : 'sleep';
  const reason = String(value.reason || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return {
    kind,
    startedAt: Number(value.startedAt) || 0,
    until,
    reason
  };
}

export function defaultMoodState(now = Date.now(), baseline = {}) {
  const mood = clampScore(baseline.mood, DEFAULT_MOOD);
  const energy = clampScore(baseline.energy, DEFAULT_ENERGY);
  return {
    version: MOOD_STATE_VERSION,
    mood,
    energy,
    updatedAt: Number(now) || Date.now(),
    lastDecayAt: Number(now) || Date.now(),
    lastChange: null,
    history: [],
    daily: {},
    rest: null
  };
}

function normalizeState(raw, { now = Date.now(), baseline = {} } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultMoodState(now, baseline);
  return {
    version: MOOD_STATE_VERSION,
    mood: round1(clampScore(raw.mood, clampScore(baseline.mood, DEFAULT_MOOD))),
    energy: round1(clampScore(raw.energy, clampScore(baseline.energy, DEFAULT_ENERGY))),
    updatedAt: Number(raw.updatedAt) || now,
    lastDecayAt: Number(raw.lastDecayAt) || now,
    lastChange: normalizeLastChange(raw.lastChange),
    history: normalizeHistory(raw.history),
    daily: normalizeDaily(raw.daily),
    rest: normalizeRest(raw.rest)
  };
}

/**
 * 读状态。文件不存在/损坏都返回默认值；损坏文件先改名留档，不影响后续聊天。
 * 不在这里做衰减 —— 衰减由 decayMood / snapshot 负责。
 */
export function readMoodState({ dataDir = DATA_DIR, now = Date.now(), baseline = {}, log = () => {} } = {}) {
  const file = moodFile(dataDir);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`[mood] 读取失败，按默认值继续：${error?.message ?? error}`);
    return defaultMoodState(now, baseline);
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* 留档失败也不影响继续 */ }
    log('[mood] 状态文件损坏，已改名留档并按默认值继续');
    return defaultMoodState(now, baseline);
  }
  return normalizeState(parsed, { now, baseline });
}

/** 原子写：同目录临时文件 → rename；文件名带 pid，避免并发写互相覆盖。 */
export function writeMoodState(state, { dataDir = DATA_DIR } = {}) {
  const file = moodFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flush: true
    });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* 某些文件系统不支持 chmod */ }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  return state;
}

/**
 * 惰性衰减：按半衰期向 baseline 指数回归。
 * 不修改入参数；返回值带新的 lastDecayAt（调用方决定是否落盘）。
 */
export function decayMood(state, {
  now = Date.now(),
  baseline = {},
  halfLifeHours = 12
} = {}) {
  const current = normalizeState(state, { now, baseline });
  const baseMood = clampScore(baseline.mood, DEFAULT_MOOD);
  const baseEnergy = clampScore(baseline.energy, DEFAULT_ENERGY);
  const halfLifeMs = Math.max(1, Number(halfLifeHours) || 12) * HOUR_MS;
  const elapsed = Math.max(0, Number(now) - Number(current.lastDecayAt || now));
  if (elapsed <= 0) {
    return { ...current, lastDecayAt: Number(now) || Date.now() };
  }
  const factor = Math.pow(0.5, elapsed / halfLifeMs);
  return {
    ...current,
    mood: round1(baseMood + (current.mood - baseMood) * factor),
    energy: round1(baseEnergy + (current.energy - baseEnergy) * factor),
    lastDecayAt: Number(now) || Date.now()
  };
}

export function moodBand(score) {
  const value = clampScore(score);
  if (value < 20) return '很低落';
  if (value < 40) return '低落';
  if (value < 60) return '平静';
  if (value < 80) return '开心';
  return '很开心';
}

export function energyBand(score) {
  const value = clampScore(score);
  if (value < 20) return '疲惫';
  if (value < 40) return '没精神';
  if (value < 60) return '正常';
  if (value < 80) return '有活力';
  return '亢奋';
}

/** 只读快照：会做惰性衰减，但不写盘。 */
export function moodSnapshot(state, {
  now = Date.now(),
  baseline = {},
  halfLifeHours = 12
} = {}) {
  const current = decayMood(state, { now, baseline, halfLifeHours });
  const day = todayKey(now);
  const rest = current.rest;
  const active = Boolean(rest && rest.until > Number(now));
  return {
    enabled: true,
    mood: current.mood,
    energy: current.energy,
    moodLabel: moodBand(current.mood),
    energyLabel: energyBand(current.energy),
    label: `${moodBand(current.mood)} · ${energyBand(current.energy)}`,
    updatedAt: current.updatedAt,
    lastChange: current.lastChange,
    today: current.daily?.[day] || null,
    rest: rest ? {
      kind: rest.kind,
      startedAt: rest.startedAt,
      until: rest.until,
      reason: rest.reason,
      active,
      remainingMinutes: active ? Math.max(0, Math.ceil((rest.until - Number(now)) / 60000)) : 0
    } : null
  };
}

function pruneDaily(daily, keepDays) {
  const keys = Object.keys(daily).sort();
  const keep = Math.max(1, Math.round(Number(keepDays) || DEFAULT_DAILY_KEEP_DAYS));
  if (keys.length <= keep) return daily;
  const drop = new Set(keys.slice(0, keys.length - keep));
  return Object.fromEntries(Object.entries(daily).filter(([key]) => !drop.has(key)));
}

function capDelta(current, delta, cap) {
  if (delta > 0) return Math.max(0, Math.min(delta, cap - current));
  if (delta < 0) return Math.min(0, Math.max(delta, -cap - current));
  return 0;
}

function appendDaily(state, { now, baseMood, baseEnergy, mood, energy, moodDelta, energyDelta, keepDays }) {
  const day = todayKey(now);
  const daily = { ...state.daily };
  // 跨天时把上一天的结束值补上（当天没有事件时 end 会一直是 undefined）
  const previous = Object.keys(daily).filter((key) => key < day).sort().pop();
  if (previous && daily[previous] && daily[previous].endMood === undefined) {
    daily[previous] = {
      ...daily[previous],
      endMood: round1(baseMood),
      endEnergy: round1(baseEnergy)
    };
  }
  const current = daily[day] && typeof daily[day] === 'object'
    ? daily[day]
    : {
      date: day,
      events: 0,
      moodDelta: 0,
      energyDelta: 0,
      startMood: round1(baseMood),
      startEnergy: round1(baseEnergy)
    };
  daily[day] = {
    ...current,
    events: (Number(current.events) || 0) + 1,
    moodDelta: round1((Number(current.moodDelta) || 0) + moodDelta),
    energyDelta: round1((Number(current.energyDelta) || 0) + energyDelta),
    endMood: round1(mood),
    endEnergy: round1(energy)
  };
  return pruneDaily(daily, keepDays);
}

/**
 * 应用一次心情事件（已做衰减）。
 * 单次 ±5；每小时全局 ±12、单用户 ±6。返回新状态，不写盘。
 */
export function applyMoodEvent(state, event = {}, {
  now = Date.now(),
  baseline = {},
  halfLifeHours = 12,
  historyLimit = DEFAULT_HISTORY_LIMIT,
  dailyKeepDays = DEFAULT_DAILY_KEEP_DAYS,
  bypassLimits = false
} = {}) {
  const base = decayMood(state, { now, baseline, halfLifeHours });
  let moodDelta = bypassLimits ? Number(event.moodDelta) || 0 : clampDelta(event.moodDelta);
  let energyDelta = bypassLimits ? Number(event.energyDelta) || 0 : clampDelta(event.energyDelta);
  if (!bypassLimits) {
    const since = Number(now) - HOUR_MS;
    const recent = base.history.filter((item) => Number(item.at) >= since);
    const sum = (items, key) => items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
    const actorId = String(event.actorId || '');
    const actorRecent = actorId ? recent.filter((item) => item.actorId === actorId) : [];
    const globalMood = sum(recent, 'moodDelta');
    const globalEnergy = sum(recent, 'energyDelta');
    const actorMood = sum(actorRecent, 'moodDelta');
    const actorEnergy = sum(actorRecent, 'energyDelta');
    moodDelta = capDelta(globalMood, moodDelta, MAX_HOURLY_DELTA);
    energyDelta = capDelta(globalEnergy, energyDelta, MAX_HOURLY_DELTA);
    if (actorId) {
      moodDelta = capDelta(actorMood, moodDelta, MAX_HOURLY_ACTOR_DELTA);
      energyDelta = capDelta(actorEnergy, energyDelta, MAX_HOURLY_ACTOR_DELTA);
    }
  }
  const mood = round1(clampScore(base.mood + moodDelta, base.mood));
  const energy = round1(clampScore(base.energy + energyDelta, base.energy));
  const actualMood = round1(mood - base.mood);
  const actualEnergy = round1(energy - base.energy);
  if (!actualMood && !actualEnergy) {
    return { ...base, updatedAt: Number(now) || Date.now() };
  }
  const lastChange = {
    at: Number(now) || Date.now(),
    moodDelta: actualMood,
    energyDelta: actualEnergy,
    reason: String(event.reason || '')
  };
  const entry = {
    at: lastChange.at,
    actorId: String(event.actorId || ''),
    moodDelta: actualMood,
    energyDelta: actualEnergy,
    mood,
    energy,
    reason: lastChange.reason,
    chatKey: String(event.chatKey || '')
  };
  const limit = Math.max(1, Math.round(Number(historyLimit) || DEFAULT_HISTORY_LIMIT));
  const history = [...base.history, entry].slice(-limit);
  const daily = appendDaily(base, {
    now: lastChange.at,
    baseMood: base.mood,
    baseEnergy: base.energy,
    mood,
    energy,
    moodDelta: actualMood,
    energyDelta: actualEnergy,
    keepDays: dailyKeepDays
  });
  return { ...base, mood, energy, updatedAt: lastChange.at, lastChange, history, daily };
}

/** 手动重置：直接回到 baseline，绕过年/时上限，但保留一条 history。 */
export function resetMoodState(state, {
  now = Date.now(),
  baseline = {},
  halfLifeHours = 12,
  historyLimit = DEFAULT_HISTORY_LIMIT,
  dailyKeepDays = DEFAULT_DAILY_KEEP_DAYS
} = {}) {
  const base = decayMood(state, { now, baseline, halfLifeHours });
  const mood = round1(clampScore(baseline.mood, DEFAULT_MOOD));
  const energy = round1(clampScore(baseline.energy, DEFAULT_ENERGY));
  const moodDelta = round1(mood - base.mood);
  const energyDelta = round1(energy - base.energy);
  const at = Number(now) || Date.now();
  const lastChange = { at, moodDelta, energyDelta, reason: '手动重置' };
  const entry = {
    at,
    actorId: '',
    moodDelta,
    energyDelta,
    mood,
    energy,
    reason: lastChange.reason,
    chatKey: ''
  };
  const limit = Math.max(1, Math.round(Number(historyLimit) || DEFAULT_HISTORY_LIMIT));
  const daily = appendDaily(base, {
    now: at,
    baseMood: base.mood,
    baseEnergy: base.energy,
    mood,
    energy,
    moodDelta,
    energyDelta,
    keepDays: dailyKeepDays
  });
  return {
    ...base,
    mood,
    energy,
    updatedAt: at,
    lastChange,
    history: [...base.history, entry].slice(-limit),
    daily,
    rest: null
  };
}
