// 精力系统纯模型：E（即时精力）/ S（睡眠压力）/ φ（昼夜相位）。
//
// 设计约束（对应 docs/requirements/energy.md 的 P0）：
//   · 不读配置、不落盘、不依赖 Date.now —— now 一律由调用方传入；
//   · 纯函数，便于单测、shadow 回放与后续迁移；
//   · E 的恢复项乘 u_sleep：本项目只有睡觉能涨精力；
//   · H（唤醒度）v1 不参与，字段不预留到状态里，避免半成品状态被持久化。

export const ENERGY_MODEL_DEFAULTS = Object.freeze({
  kr: 0.020,
  kc: 0.012,
  ks: 0.015,
  gamma: 0.0035,
  delta: 0.010,
  alpha: 0.7,
  beta: 0.15,
  eta: 0.3,
  dayMinutes: 1440,
  phaseOffsetMinutes: 960,   // φ=0 对应本地 16:00
  eMin: 0.02,
  maxStepMinutes: 60,
  tickSeconds: 30,
  activity: Object.freeze({
    windowMinutes: 10,
    fullTokensPerMinute: 2000,
    maxTokensPerCall: 20000,
    wThink: 0.7,
    wSession: 0.2,
    wTool: 0.1,
    toolFullRate: 3,
    emaMinutes: 5,
    estimateCharsPerToken: 1.5,
    sessionWindowMinutes: 5,
    includePurposes: Object.freeze(['chat', 'reply-correction'])
  })
});

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp01(value, fallback = 0) {
  return Math.min(1, Math.max(0, num(value, fallback)));
}

function clampScore(value, min, max, fallback = min) {
  return Math.min(max, Math.max(min, num(value, fallback)));
}

function round2(value) {
  return Math.round(num(value, 0) * 100) / 100;
}

function wrapPhase(value) {
  const tau = Math.PI * 2;
  const n = num(value, 0);
  return ((n % tau) + tau) % tau;
}

/** 合并默认参数；activity 单独合并，避免调用方只传一个字段时丢掉其它默认值。 */
export function resolveEnergyParams(params = {}) {
  const source = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const activity = source.activity && typeof source.activity === 'object' && !Array.isArray(source.activity)
    ? { ...ENERGY_MODEL_DEFAULTS.activity, ...source.activity }
    : { ...ENERGY_MODEL_DEFAULTS.activity };
  return { ...ENERGY_MODEL_DEFAULTS, ...source, activity };
}

/**
 * 本地时间 → 昼夜相位。
 * φ=0 对应 phaseOffsetMinutes（默认 960 = 16:00）；16:00 cosφ=1，04:00 cosφ=-1。
 */
export function phaseFor(now = Date.now(), params = {}) {
  const p = resolveEnergyParams(params);
  const day = Math.max(1, num(p.dayMinutes, 1440));
  const date = new Date(num(now, Date.now()));
  const minutes = date.getHours() * 60
    + date.getMinutes()
    + date.getSeconds() / 60
    + date.getMilliseconds() / 60000;
  const offset = ((num(p.phaseOffsetMinutes, 960) % day) + day) % day;
  return wrapPhase((2 * Math.PI * (((minutes - offset) % day + day) % day)) / day);
}

export function normalizeEnergyState(state = {}, { now = Date.now(), params = {} } = {}) {
  const p = resolveEnergyParams(params);
  const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  return {
    // 内部保留足够精度：如果每步都四舍五入到两位，1 分钟子步的微小变化会被舍掉。
    E: clampScore(source.E, p.eMin, 1, 0.55),
    S: clamp01(source.S),
    phase: Number.isFinite(Number(source.phase)) ? wrapPhase(source.phase) : phaseFor(now, p),
    lastTickAt: num(source.lastTickAt, now)
  };
}

export function defaultEnergyState({ now = Date.now(), E = 0.55, S = 0, phase, params = {} } = {}) {
  const p = resolveEnergyParams(params);
  return normalizeEnergyState({
    E,
    S,
    phase: phase === undefined ? phaseFor(now, p) : phase,
    lastTickAt: now
  }, { now, params: p });
}

/**
 * 旧 `mood.json` 的 energy(0-100) / lastSleepAt → 新状态。
 * S 取“1-E”和“已清醒小时数/16”的较大值，避免升级瞬间状态跳变。
 */
export function migrateLegacyEnergy({
  energy, lastSleepAt, now = Date.now(), params = {}
} = {}) {
  const p = resolveEnergyParams(params);
  const E = clampScore(num(energy, 55) / 100, p.eMin, 1, 0.55);
  const awakeHours = Math.max(0, (num(now, Date.now()) - num(lastSleepAt, now)) / HOUR_MS);
  const S = clamp01(Math.max(1 - E, awakeHours / 16));
  return normalizeEnergyState({
    E,
    S,
    phase: phaseFor(now, p),
    lastTickAt: now
  }, { now, params: p });
}

/**
 * 单步半隐式欧拉。dtMinutes 由调用方保证；长时间推进请用 advanceEnergy（会拆子步）。
 * 睡觉时 activity 强制为 0；恢复项乘 u_sleep。
 */
export function tickEnergy(state, {
  now = Date.now(),
  dtMinutes = 0,
  activity = 0,
  sleeping = false,
  params = {}
} = {}) {
  const p = resolveEnergyParams(params);
  const current = normalizeEnergyState(state, { now, params: p });
  const dt = clampScore(dtMinutes, 0, 1e9, 0);
  if (dt <= 0) return { ...current, lastTickAt: now };

  const asleep = sleeping === true;
  const u = asleep ? 1 : 0;
  const a = asleep ? 0 : clamp01(activity);
  const S = clamp01(current.S + (num(p.gamma, 0.0035) * a - num(p.delta, 0.01) * u * current.S) * dt);
  const recovery = num(p.kr, 0.02) * u * (1 - num(p.alpha, 0.7) * S) * (1 - current.E);
  const consumption = num(p.kc, 0.012) * a * current.E + num(p.ks, 0.015) * S;
  const E = clampScore(current.E + (recovery - consumption) * dt, p.eMin, 1, current.E);
  const phase = wrapPhase(current.phase + (2 * Math.PI * dt) / Math.max(1, num(p.dayMinutes, 1440)));
  return {
    E,
    S,
    phase,
    lastTickAt: num(now, current.lastTickAt)
  };
}

/**
 * 推进一段时间。minutes 不传时按 state.lastTickAt → now 的差值。
 * 内部按 maxStepMinutes 拆子步，避免一次推进几小时造成明显近似误差。
 */
export function advanceEnergy(state, {
  now = Date.now(),
  minutes,
  activity = 0,
  sleeping = false,
  params = {},
  maxStepMinutes
} = {}) {
  const p = resolveEnergyParams(params);
  let current = normalizeEnergyState(state, { now, params: p });
  const total = minutes === undefined
    ? Math.max(0, (num(now, current.lastTickAt) - current.lastTickAt) / MINUTE_MS)
    : Math.max(0, num(minutes, 0));
  if (total <= 0) return { ...current, lastTickAt: now };

  const step = Math.max(0.1, Math.min(
    num(maxStepMinutes, p.maxStepMinutes),
    num(p.maxStepMinutes, 60)
  ));
  let remaining = total;
  let cursor = current.lastTickAt;
  while (remaining > 1e-9) {
    const dt = Math.min(step, remaining);
    const stepNow = cursor + dt * MINUTE_MS;
    current = tickEnergy(current, {
      now: stepNow,
      dtMinutes: dt,
      activity,
      sleeping,
      params: p
    });
    cursor = stepNow;
    remaining -= dt;
  }
  return { ...current, lastTickAt: num(now, cursor) };
}

/** 观测层：E_obs = clip(E*(1+βcosφ) - ηS, 0, 1)。 */
export function observeEnergy(state, params = {}) {
  const p = resolveEnergyParams(params);
  const current = normalizeEnergyState(state, { params: p });
  const Eobs = clamp01(
    current.E * (1 + num(p.beta, 0.15) * Math.cos(current.phase))
    - num(p.eta, 0.3) * current.S
  );
  return {
    E: round2(current.E),
    S: round2(current.S),
    phase: current.phase,
    Eobs: round2(Eobs),
    energy: Math.round(Eobs * 100),
    fatigue: Math.round(current.S * 100),
    lastTickAt: current.lastTickAt
  };
}

/**
 * 单次模型调用 → 思考样本的 token 数。
 * 优先级：reasoning_tokens → completion_tokens（总输出）→ 内容长度估算。
 */
export function thinkingTokensForSample({
  reasoningTokens = 0,
  completionTokens = 0,
  reasoningChars = 0,
  contentChars = 0,
  params = {}
} = {}) {
  const p = resolveEnergyParams(params).activity;
  const cap = Math.max(1, num(p.maxTokensPerCall, 20000));
  const reasoning = Math.max(0, num(reasoningTokens, 0));
  if (reasoning > 0) return Math.min(reasoning, cap);
  const completion = Math.max(0, num(completionTokens, 0));
  if (completion > 0) return Math.min(completion, cap);
  const chars = Math.max(0, num(reasoningChars, 0)) + Math.max(0, num(contentChars, 0));
  if (!chars) return 0;
  const per = Math.max(0.1, num(p.estimateCharsPerToken, 1.5));
  return Math.min(Math.ceil(chars / per), cap);
}

/**
 * 从思考/工具/会话样本计算活动强度。
 * samples: [{ at, kind?: 'thinking'|'tool'|'session', tokens?, purpose? }]
 * previousActivity 用于 EMA；首次传 0 或省略。
 */
export function activityFromSamples(samples, {
  now = Date.now(),
  previousActivity = 0,
  params = {}
} = {}) {
  const p = resolveEnergyParams(params).activity;
  const list = Array.isArray(samples) ? samples : [];
  const windowMinutes = Math.max(1, num(p.windowMinutes, 10));
  const windowMs = windowMinutes * MINUTE_MS;
  const since = num(now, Date.now()) - windowMs;
  const include = Array.isArray(p.includePurposes) && p.includePurposes.length
    ? new Set(p.includePurposes.map(String))
    : null;

  let tokens = 0;
  let toolCount = 0;
  let sessionActive = false;
  const sessionSince = num(now, Date.now()) - Math.max(1, num(p.sessionWindowMinutes, 5)) * MINUTE_MS;
  for (const sample of list) {
    if (!sample || typeof sample !== 'object') continue;
    const at = num(sample.at, 0);
    if (at < since || at > num(now, Date.now())) continue;
    const kind = String(sample.kind || 'thinking');
    if (kind === 'tool') { toolCount += 1; continue; }
    if (kind === 'session') {
      if (at >= sessionSince) sessionActive = true;
      continue;
    }
    if (include && !include.has(String(sample.purpose || 'chat'))) continue;
    tokens += Math.max(0, num(sample.tokens, 0));
  }

  const rate = tokens / windowMinutes;
  const aThink = clamp01(rate / Math.max(1, num(p.fullTokensPerMinute, 2000)));
  const aSession = sessionActive ? 1 : 0;
  const aTool = clamp01((toolCount / windowMinutes) / Math.max(0.1, num(p.toolFullRate, 3)));
  const aRaw = clamp01(
    num(p.wThink, 0.7) * aThink
    + num(p.wSession, 0.2) * aSession
    + num(p.wTool, 0.1) * aTool
  );
  const prev = Number.isFinite(Number(previousActivity))
    ? clamp01(previousActivity)
    : aRaw;
  const emaMinutes = Math.max(0.1, num(p.emaMinutes, 5));
  const alpha = 1 - Math.pow(0.5, windowMinutes / emaMinutes);
  return {
    activity: clamp01(prev + (aRaw - prev) * alpha),
    aThink,
    aSession,
    aTool,
    tokens,
    rate,
    windowMinutes
  };
}
