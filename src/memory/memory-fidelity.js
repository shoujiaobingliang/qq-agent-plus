// 记忆保真度与强度：决定“记多清楚”和“多久忘”。
// 纯函数；存储层只负责读写字段，不在这里塞 SQL。
//
// 与 docs/requirements/human-like-memory.md §4.2 / §5.2 对应：
//   verbatim：逐字、近似不衰减；
//   gist：只留大意，细节到期淡出；
//   transient：短 TTL，低价值事件。

export const FIDELITY_LEVELS = Object.freeze(['verbatim', 'gist', 'transient']);

export const DEFAULT_FIDELITY_CONFIG = Object.freeze({
  verbatimMinImportance: 4,
  gistDetailDays: 30,
  transientMaxDays: 7,
  tauBaseDays: 14,
  fadeThreshold: 0.15,
  recallBoost: 0.15,
  observeBoost: 0.10,
  minStrength: 0.05,
  maxStrength: 2.0
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const clampImportance = (value) => clamp(Math.round(Number(value) || 3), 1, 5);
const DAY_MS = 86400000;

export function normalizeFidelityConfig(raw = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (key, min, max, fallback) => {
    const n = Number(value[key]);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  };
  return {
    verbatimMinImportance: Math.round(num('verbatimMinImportance', 1, 5,
      DEFAULT_FIDELITY_CONFIG.verbatimMinImportance)),
    gistDetailDays: Math.round(num('gistDetailDays', 0, 365, DEFAULT_FIDELITY_CONFIG.gistDetailDays)),
    transientMaxDays: Math.round(num('transientMaxDays', 1, 30, DEFAULT_FIDELITY_CONFIG.transientMaxDays)),
    tauBaseDays: num('tauBaseDays', 1, 180, DEFAULT_FIDELITY_CONFIG.tauBaseDays),
    fadeThreshold: num('fadeThreshold', 0.01, 0.9, DEFAULT_FIDELITY_CONFIG.fadeThreshold),
    recallBoost: num('recallBoost', 0, 1, DEFAULT_FIDELITY_CONFIG.recallBoost),
    observeBoost: num('observeBoost', 0, 1, DEFAULT_FIDELITY_CONFIG.observeBoost),
    minStrength: num('minStrength', 0.01, 0.5, DEFAULT_FIDELITY_CONFIG.minStrength),
    maxStrength: num('maxStrength', 1, 5, DEFAULT_FIDELITY_CONFIG.maxStrength)
  };
}

/**
 * 保真度由规则决定，不让模型自选。
 * convention/decision 即使模型给了低重要度，也强制逐字（暗号/群规不能记成大意）。
 */
export function decideFidelity({ kind = '', importance = 3, config = {} } = {}) {
  const cfg = normalizeFidelityConfig(config);
  const k = String(kind ?? '');
  const imp = clampImportance(importance);
  if (k === 'convention' || k === 'decision') return 'verbatim';
  if (k === 'person_fact' && imp >= cfg.verbatimMinImportance) return 'verbatim';
  if (imp >= cfg.verbatimMinImportance) return 'verbatim';
  if (k === 'event' && imp <= 2) return 'transient';
  return 'gist';
}

/** 新记忆的初始强度：重要的事一开始就更牢（0.6–1.5）。 */
export function initialStrength({ importance = 3, fidelity = 'gist' } = {}) {
  const imp = clampImportance(importance);
  const base = 0.5 + imp / 10;
  // verbatim 从更强开始；transient 更弱，方便快速淡出
  const factor = fidelity === 'verbatim' ? 1.15 : fidelity === 'transient' ? 0.75 : 1;
  return clamp(base * factor, 0.2, 2.0);
}

/** 衰减时间常数（天）：重要性越高越慢；verbatim ×10 近似不衰减。 */
export function tauDaysFor({ importance = 3, fidelity = 'gist', tauBaseDays = 14 } = {}) {
  const imp = clampImportance(importance);
  const base = clamp(Number(tauBaseDays) || 14, 1, 180);
  const importanceFactor = 0.5 + imp / 5;      // 1..5 → 0.7..1.5
  const fidelityFactor = fidelity === 'verbatim' ? 10 : 1;
  return base * importanceFactor * fidelityFactor;
}

/**
 * 按空闲时间衰减强度。lastActiveAt 取 last_recalled_at / last_seen_at / updated_at / created_at 的最大值。
 * 返回新强度；旧强度非法时按 1.0 处理。
 */
export function strengthAfterDecay({
  strength = 1,
  importance = 3,
  fidelity = 'gist',
  lastActiveAt = 0,
  now = Date.now(),
  tauBaseDays = 14,
  minStrength = DEFAULT_FIDELITY_CONFIG.minStrength,
  maxStrength = DEFAULT_FIDELITY_CONFIG.maxStrength
} = {}) {
  const current = Number.isFinite(Number(strength)) ? Number(strength) : 1;
  const last = Number(lastActiveAt) || 0;
  const idleDays = last > 0 ? Math.max(0, Number(now) - last) / DAY_MS : 0;
  const tau = tauDaysFor({ importance, fidelity, tauBaseDays });
  const decayed = idleDays > 0 ? current * Math.exp(-idleDays / tau) : current;
  return clamp(decayed, minStrength, maxStrength);
}

/** 被召回：+boost，上限 maxStrength。 */
export function strengthenOnRecall(strength = 1, {
  boost = DEFAULT_FIDELITY_CONFIG.recallBoost,
  maxStrength = DEFAULT_FIDELITY_CONFIG.maxStrength
} = {}) {
  return clamp((Number(strength) || 0) + (Number(boost) || 0), 0, maxStrength);
}

/** 被再次观察：+boost（通常比召回小）。 */
export function strengthenOnObserve(strength = 1, {
  boost = DEFAULT_FIDELITY_CONFIG.observeBoost,
  maxStrength = DEFAULT_FIDELITY_CONFIG.maxStrength
} = {}) {
  return clamp((Number(strength) || 0) + (Number(boost) || 0), 0, maxStrength);
}

/** 是否淡出：verbatim 永不自动淡出。 */
export function shouldFade({
  strength = 1, fidelity = 'gist', threshold = DEFAULT_FIDELITY_CONFIG.fadeThreshold
} = {}) {
  if (fidelity === 'verbatim') return false;
  return Number(strength) < Number(threshold);
}

/** gist 细节是否到期淡出（content 清空，abstract 保留）。 */
export function shouldFadeDetail({
  fidelity = 'gist',
  updatedAt = 0,
  detailFadedAt = 0,
  now = Date.now(),
  gistDetailDays = DEFAULT_FIDELITY_CONFIG.gistDetailDays
} = {}) {
  if (fidelity !== 'gist' || Number(detailFadedAt) > 0) return false;
  const at = Number(updatedAt) || 0;
  if (!at) return false;
  const days = Math.max(0, Number(now) - at) / DAY_MS;
  return days >= Number(gistDetailDays);
}

/** transient 是否已到期。 */
export function isTransientExpired({ fidelity, expiresAt = 0, now = Date.now() } = {}) {
  return fidelity === 'transient' && Number(expiresAt) > 0 && Number(expiresAt) <= Number(now);
}
