// 印象分 → 嘴臭副人格触发概率。
//
// 不是“低于某个硬阈值就必触发”，而是从 lowThreshold 开始梯度上升：
// 印象越低，副人格越容易出现；单次大跌会进入一个短时间的“爆点”窗口，
// 下一次该用户发言时直接具备触发资格（仍然由主模型决定要不要调用副人格）。
function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** 当前印象分对应的单轮触发概率（0..maxChance）。 */
export function viceChance(score, cfg = {}) {
  const low = clamp(cfg.lowThreshold, 1, 100, 30);
  const base = clamp(cfg.vice?.baseChance, 0, 1, 0.12);
  const max = Math.max(base, clamp(cfg.vice?.maxChance, 0, 1, 0.7));
  const value = Number(score);
  if (!Number.isFinite(value) || value >= low) return 0;
  const t = (low - Math.max(0, value)) / low;
  return Math.min(max, base + t * (max - base));
}

/** 是否具备触发资格：爆点窗口直接通过；否则按概率 roll。 */
export function viceEligible({
  score, cfg = {}, burst = false, cooldownOk = true, random = Math.random
} = {}) {
  if (!cooldownOk) return false;
  if (burst) return true;
  const roll = typeof random === 'function' ? Number(random()) : Number(random);
  return Number.isFinite(roll) && roll < viceChance(score, cfg);
}

/** 给提示词/UI 用的印象档位。 */
export function impressionBand(score, cfg = {}) {
  const value = Number(score);
  const low = clamp(cfg.lowThreshold, 1, 100, 30);
  const hostile = clamp(cfg.hostileThreshold, 0, low, 15);
  const high = clamp(cfg.highThreshold, low, 100, 80);
  if (!Number.isFinite(value)) return '未知';
  if (value < hostile) return '很差';
  if (value < low) return '偏低';
  if (value >= high) return '很好';
  return '正常';
}
