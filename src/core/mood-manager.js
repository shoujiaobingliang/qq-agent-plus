// 心情运行时封装：把纯状态模块接到配置、持久化与判定系数上。
//
// 设计取舍：
//   · 不额外起定时器 —— 快照/应用时惰性衰减，重启与长时间空闲都不会多算；
//   · 快照只读不写 —— 控制台 15 秒轮询不会制造磁盘写；
//   · 任何写失败只记日志、保留内存状态，不影响聊天主流程；
//   · 关闭时不读不写，所有系数恒为 1，行为完全回到现状。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import {
  activityFromSamples,
  advanceEnergy,
  migrateLegacyEnergy,
  observeEnergy,
  thinkingTokensForSample
} from './energy-model.js';
import { sleepWindowFor } from './mood-schedule.js';
import { todayKey } from './util.js';
import {
  DEFAULT_DAILY_KEEP_DAYS,
  DEFAULT_ENERGY,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_MOOD,
  applyMoodEvent,
  decayMood,
  defaultMoodState,
  moodSnapshot,
  readMoodState,
  resetMoodState,
  writeMoodState
} from './mood-state.js';

function numIn(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export class MoodManager {
  constructor({
    dataDir = DATA_DIR,
    now = Date.now,
    random = Math.random,
    log = () => {}
  } = {}) {
    this.dataDir = dataDir;
    this.now = typeof now === 'function' ? now : Date.now;
    this.random = typeof random === 'function' ? random : Math.random;
    this.log = typeof log === 'function'
      ? log
      : (typeof log?.info === 'function' ? (...args) => log.info(...args) : () => {});
    this.state = null;
    this.loaded = false;
    // P1 shadow：思考/工具/会话样本只存在内存里；重启后活动从 0 重新累积。
    this.energySamples = [];
    this.lastShadowLogAt = 0;
    // JSONL 采集：默认 15 分钟一条，按天落盘。
    this.lastCollectAt = 0;
    this.lastCollectorPruneDay = '';
  }

  config() {
    const cfg = getConfig()?.mood;
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  }

  enabled() {
    // 新配置默认开启；只有显式 false 才关闭。
    return this.config().enabled !== false;
  }

  baseline() {
    const value = this.config().baseline;
    const cfg = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      mood: numIn(cfg.mood, DEFAULT_MOOD, 0, 100),
      energy: numIn(cfg.energy, DEFAULT_ENERGY, 0, 100)
    };
  }

  #halfLife() {
    return numIn(this.config().decayHalfLifeHours, 12, 1, 168);
  }

  /** 精力每小时单向消耗量；0 = 不随时间下降。只有睡觉能补回来。 */
  #energyDrain() {
    return numIn(this.config().energyDrainPerHour, 1, 0, 10);
  }

  /** 连续清醒多久后消耗速度翻倍；0 = 关闭累积疲劳。 */
  #fatigueRamp() {
    return numIn(this.config().energyFatigueRampHours, 12, 0, 72);
  }

  #historyLimit() {
    return Math.round(numIn(this.config().historyLimit, DEFAULT_HISTORY_LIMIT, 20, 1000));
  }

  #dailyKeepDays() {
    return Math.round(numIn(this.config().dailyKeepDays, DEFAULT_DAILY_KEEP_DAYS, 7, 365));
  }

  #toneInfluence() {
    return numIn(this.config().toneInfluence, 0.6, 0, 1);
  }

  #frequencyInfluence() {
    return numIn(this.config().frequencyInfluence, 0.2, 0, 0.5);
  }

  #restConfig() {
    const value = this.config().rest;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  #scheduleConfig() {
    const value = this.#restConfig().schedule;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  #energyConfig() {
    const value = this.config().energyModel;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  restEnabled() {
    return this.enabled() && this.#restConfig().enabled !== false;
  }

  #load() {
    if (!this.loaded) {
      this.state = readMoodState({
        dataDir: this.dataDir,
        now: this.now(),
        baseline: this.baseline(),
        log: this.log
      });
      this.loaded = true;
    }
    return this.state;
  }

  #energyEnabled() {
    return this.#energyConfig().enabled !== false;
  }

  /** P2：只有显式 shadow=false 才让 E_obs/S 接管决策；shadow=true 仍走旧逻辑。 */
  #energyActive() {
    const cfg = this.#energyConfig();
    return this.enabled() && cfg.enabled !== false && cfg.shadow === false;
  }

  /** 决策用精力（0-100）：active 时用 E_obs，否则沿用旧 energy。 */
  #decisionEnergy(current = null) {
    if (!this.#energyActive()) return Number((current || this.#current()).energy) || 0;
    const observed = this.#tickEnergyShadow(this.now());
    return Number(observed?.energy) || 0;
  }

  #trimEnergySamples(now = this.now()) {
    const cfg = this.#energyConfig();
    const window = Math.max(1, Number(cfg.activity?.windowMinutes) || 10);
    const since = Number(now) - (window + 5) * 60 * 1000;
    this.energySamples = this.energySamples
      .filter((sample) => Number(sample?.at) >= since)
      .slice(-2000);
  }

  /** P1 shadow：记录一次模型调用的思考 Token；不影响任何决策。 */
  noteThinking({
    at = this.now(),
    reasoningTokens = 0,
    completionTokens = 0,
    reasoningChars = 0,
    contentChars = 0,
    purpose = 'chat'
  } = {}) {
    if (!this.#energyEnabled()) return;
    const tokens = thinkingTokensForSample({
      reasoningTokens,
      completionTokens,
      reasoningChars,
      contentChars,
      params: this.#energyConfig()
    });
    if (!tokens) return;
    const sampleAt = Number(at) || this.now();
    this.energySamples.push({
      at: sampleAt,
      kind: 'thinking',
      tokens,
      purpose: String(purpose || 'chat')
    });
    this.#trimEnergySamples(sampleAt);
  }

  noteToolCall({ at = this.now() } = {}) {
    if (!this.#energyEnabled()) return;
    const sampleAt = Number(at) || this.now();
    this.energySamples.push({ at: sampleAt, kind: 'tool' });
    this.#trimEnergySamples(sampleAt);
  }

  noteSession({ at = this.now() } = {}) {
    if (!this.#energyEnabled()) return;
    const sampleAt = Number(at) || this.now();
    this.energySamples.push({ at: sampleAt, kind: 'session' });
    this.#trimEnergySamples(sampleAt);
  }

  /** P1 shadow tick：更新 energyModel 并返回观测值；不参与行为决策。 */
  #tickEnergyShadow(now = this.now(), { sleeping } = {}) {
    if (!this.#energyEnabled()) return null;
    const cfg = this.#energyConfig();
    const state = this.#load();
    if (!state.energyModel) {
      // 旧状态/手动重置后没有 shadow：按当前旧 energy/lastSleepAt 生成初值。
      const migrated = migrateLegacyEnergy({
        energy: state.energy,
        lastSleepAt: state.lastSleepAt,
        now,
        params: cfg
      });
      state.energyModel = {
        ...migrated,
        activity: 0,
        activityEma: 0,
        updatedAt: now
      };
    }
    const asleep = sleeping === undefined ? this.sleeping() : sleeping === true;
    const previousTickAt = Number(state.energyModel.lastTickAt) || now;
    const activity = activityFromSamples(this.energySamples, {
      now,
      previousActivity: Number(state.energyModel.activityEma) || 0,
      params: cfg
    });
    const advanced = advanceEnergy(state.energyModel, {
      now,
      activity: activity.activity,
      sleeping: asleep,
      params: cfg
    });
    const observed = observeEnergy(advanced, cfg);
    state.energyModel = {
      ...advanced,
      activity: activity.activity,
      activityEma: activity.activity,
      updatedAt: now
    };
    this.state = state;
    this.loaded = true;
    if (cfg.shadow !== false && now - this.lastShadowLogAt >= 15 * 60 * 1000) {
      this.lastShadowLogAt = now;
      this.log(`[energy-shadow] E=${observed.E} S=${observed.S} Eobs=${observed.Eobs}`
        + ` activity=${Math.round(activity.activity * 100) / 100}`
        + ` rate=${Math.round(activity.rate)}/min`);
    }
    this.#collectEnergyShadow({
      now,
      observed,
      activity,
      sleeping: asleep,
      state,
      previousTickAt
    });
    return {
      ...observed,
      activity: activity.activity,
      rate: activity.rate,
      tokens: activity.tokens,
      aThink: activity.aThink,
      aSession: activity.aSession,
      aTool: activity.aTool
    };
  }

  /** 按 intervalMinutes 追加一行 JSONL；shadow/active 两种模式都记录。 */
  #collectEnergyShadow({ now, observed, activity, sleeping, state, previousTickAt }) {
    const cfg = this.#energyConfig();
    const collector = cfg.collector && typeof cfg.collector === 'object' ? cfg.collector : {};
    if (collector.enabled === false) return;
    const intervalMinutes = Math.max(1, Math.min(1440, Number(collector.intervalMinutes) || 15));
    if (now - this.lastCollectAt < intervalMinutes * 60 * 1000) return;
    this.lastCollectAt = now;
    const day = todayKey(now);
    const dir = path.join(this.dataDir, 'energy-shadow');
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (this.lastCollectorPruneDay !== day) {
        this.lastCollectorPruneDay = day;
        this.#pruneEnergyShadow(dir, day, collector.keepDays);
      }
      const lastSleepAt = Number(state?.lastSleepAt) || 0;
      const lastTickAt = Number(previousTickAt) || 0;
      const awakeHours = lastSleepAt > 0
        ? Math.round(Math.max(0, (now - lastSleepAt) / 3600000) * 10) / 10
        : null;
      const line = JSON.stringify({
        at: now,
        iso: new Date(now).toISOString(),
        lastSleepAt,
        lastTickAt,
        awakeHours,
        mode: this.#energyActive() ? 'active' : 'shadow',
        E: observed.E,
        S: observed.S,
        phase: observed.phase,
        Eobs: observed.Eobs,
        energy: observed.energy,
        fatigue: observed.fatigue,
        activity: activity.activity,
        rate: activity.rate,
        tokens: activity.tokens,
        aThink: activity.aThink,
        aSession: activity.aSession,
        aTool: activity.aTool,
        legacyEnergy: Math.round(Number(this.#current().energy) || 0),
        rest: sleeping ? 'sleep' : (this.slacking() ? 'slack' : '')
      });
      fs.appendFileSync(path.join(dir, `${day}.jsonl`), `${line}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
    } catch (error) {
      this.log(`[energy-shadow] JSONL 采集失败：${error?.message ?? error}`);
    }
  }

  #pruneEnergyShadow(dir, today, keepDays) {
    const days = Math.max(1, Math.min(3650, Number(keepDays) || 90));
    const cutoffDate = new Date(`${today}T00:00:00Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    try {
      for (const name of fs.readdirSync(dir)) {
        const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (!match || match[1] >= cutoff) continue;
        try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* ignore */ }
      }
    } catch { /* 目录读不了不影响采集 */ }
  }

  /** 供 rest ticker 调用：让 shadow 在空闲时也能按时推进/采集。 */
  tickShadow(now = this.now()) {
    return this.#tickEnergyShadow(now);
  }

  /** 当前值（已做惰性衰减），不写盘。 */
  #current() {
    return decayMood(this.#load(), {
      now: this.now(),
      baseline: this.baseline(),
      halfLifeHours: this.#halfLife(),
      energyDrainPerHour: this.#energyDrain(),
      energyFatigueRampHours: this.#fatigueRamp()
    });
  }

  snapshot() {
    if (!this.enabled()) {
      return {
        enabled: false,
        mood: null,
        energy: null,
        moodLabel: '',
        energyLabel: '',
        label: '未启用',
        toneInfluence: 0,
        updatedAt: 0,
        lastChange: null,
        today: null,
        rest: null,
        restEnabled: false
      };
    }
    const current = this.#current();
    const snap = moodSnapshot(current, {
      now: this.now(),
      baseline: this.baseline(),
      halfLifeHours: this.#halfLife(),
      energyDrainPerHour: this.#energyDrain(),
      energyFatigueRampHours: this.#fatigueRamp()
    });
    const scheduleCfg = this.#scheduleConfig();
    const window = this.scheduledSleepWindow();
    return {
      ...snap,
      toneInfluence: this.#toneInfluence(),
      restEnabled: this.restEnabled(),
      energyModel: this.#tickEnergyShadow(this.now()),
      energyModelActive: this.#energyActive(),
      restSuggestS: numIn(this.#energyConfig().decision?.restSuggestS, 0.75, 0, 1),
      schedule: {
        enabled: scheduleCfg.enabled !== false,
        sleepAt: scheduleCfg.sleepAt || '23:30',
        wakeAt: scheduleCfg.wakeAt || '07:30',
        active: Boolean(window?.active),
        // 作息只提示，不在系统层自动 sleep；调用方把它注入用户提示词。
        suggestsSleep: Boolean(
          window?.active
          && !snap.rest?.active
          && scheduleCfg.allowStayUp !== false
        )
      }
    };
  }

  /** 提示词只读快照：关闭或语气影响为 0 时返回 null（调用方不注入任何文本）。 */
  promptSnapshot() {
    if (!this.enabled() || this.#toneInfluence() <= 0) return null;
    return this.snapshot();
  }

  #apply(event, { bypassLimits = false } = {}) {
    if (!this.enabled()) return null;
    this.#tickEnergyShadow(this.now());
    const current = this.#current();
    const next = applyMoodEvent(current, event, {
      now: this.now(),
      baseline: this.baseline(),
      halfLifeHours: this.#halfLife(),
      energyDrainPerHour: this.#energyDrain(),
      energyFatigueRampHours: this.#fatigueRamp(),
      historyLimit: this.#historyLimit(),
      dailyKeepDays: this.#dailyKeepDays(),
      bypassLimits
    });
    this.state = next;
    this.loaded = true;
    try {
      writeMoodState(next, { dataDir: this.dataDir });
    } catch (error) {
      this.log(`[mood] 状态写入失败（内存值继续可用）：${error?.message ?? error}`);
    }
    return this.snapshot();
  }

  /**
   * 模型评审结果：只接受夹紧后的 delta；reason 只留一行，避免把整段用户原文带进状态文件。
   * 精力只能被互动消耗（<=0）：恢复只来自睡觉，评审不能把精力凭空加回来。
   */
  applyJudge({ moodDelta = 0, energyDelta = 0, reason = '' } = {}) {
    if (!this.enabled()) return null;
    const text = String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || '模型判断';
    const safeEnergy = Math.min(0, Number(energyDelta) || 0);
    return this.#apply({ moodDelta, energyDelta: safeEnergy, reason: text });
  }

  /** 当前休息状态；已到期但尚未结算时 `active=false`，由编排器的 tick 结算。 */
  restStatus() {
    if (!this.enabled()) return null;
    const rest = this.#current().rest;
    if (!rest) return null;
    const now = this.now();
    const active = rest.until > now;
    return {
      kind: rest.kind,
      scheduled: rest.scheduled === true,
      startedAt: rest.startedAt,
      until: rest.until,
      reason: rest.reason,
      active,
      remainingMinutes: active ? Math.max(0, Math.ceil((rest.until - now) / 60000)) : 0
    };
  }

  sleeping() {
    const rest = this.restStatus();
    return Boolean(rest?.active && rest.kind === 'sleep');
  }

  slacking() {
    const rest = this.restStatus();
    return Boolean(rest?.active && rest.kind === 'slack');
  }

  resting() {
    return Boolean(this.restStatus()?.active);
  }

  /**
   * 开始休息。窗口外只有心情/精力低时才允许；作息窗口内模型主动睡不受门槛限制。
   * 窗口内且未指定 minutes：睡到 wakeAt（按作息结算恢复）。
   * 返回快照；不可休息（未启用/已休息/状态还很好）返回 null。
   */
  startRest({ kind = 'sleep', minutes, reason = '' } = {}) {
    if (!this.restEnabled()) return null;
    if (this.restStatus()?.active) return null;
    // 上一次休息已经到期但 ticker 还没结算：先结算，避免把上一次的恢复量吞掉。
    if (this.#current().rest) this.finishDueRest();
    const safeKind = kind === 'slack' ? 'slack' : 'sleep';
    const window = safeKind === 'sleep' ? this.scheduledSleepWindow() : null;
    // 作息窗口内、模型没指定时长：按作息睡到起床时间。
    if (window?.active && minutes === undefined) {
      return this.startScheduledSleep({
        windowStart: window.start,
        windowEnd: window.end,
        reason: reason || '按作息睡觉'
      });
    }
    const state = this.#current();
    const cfg = this.#restConfig();
    const maxMood = numIn(cfg.maxMoodForRest, 45, 0, 100);
    const maxEnergy = numIn(cfg.maxEnergyForRest, 40, 0, 100);
    // 作息窗口内是“建议睡觉”，模型主动睡不要求状态很低；窗口外维持原门槛。
    const observed = this.#energyActive() ? this.#tickEnergyShadow(this.now()) : null;
    const energyForRest = observed ? Number(observed.energy) : Number(state.energy);
    if (!window?.active && Number(state.mood) > maxMood && energyForRest > maxEnergy) return null;
    const defaultMinutes = safeKind === 'sleep'
      ? numIn(cfg.sleepMinutes, 90, 30, 180)
      : numIn(cfg.slackMinutes, 30, 10, 60);
    const minMinutes = safeKind === 'sleep' ? 30 : 10;
    const maxMinutes = safeKind === 'sleep' ? 180 : 60;
    const duration = Math.round(numIn(minutes, defaultMinutes, minMinutes, maxMinutes));
    const at = this.now();
    const reasonText = String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const next = {
      ...state,
      rest: {
        kind: safeKind,
        startedAt: at,
        until: at + duration * 60000,
        reason: reasonText
      },
      updatedAt: at
    };
    this.state = next;
    this.loaded = true;
    try {
      writeMoodState(next, { dataDir: this.dataDir });
    } catch (error) {
      this.log(`[mood] 休息状态写入失败（内存值继续可用）：${error?.message ?? error}`);
    }
    return this.snapshot();
  }

  /** 当前/下一次作息窗口；未启用或关闭时返回 null。 */
  scheduledSleepWindow(now = this.now()) {
    if (!this.restEnabled()) return null;
    const cfg = this.#scheduleConfig();
    if (cfg.enabled === false) return null;
    return sleepWindowFor(now, { sleepAt: cfg.sleepAt, wakeAt: cfg.wakeAt });
  }

  /**
   * 按作息开始睡觉：不受“心情/精力低”门槛限制，睡到窗口结束。
   * 只由编排器的休息 ticker 调用；窗口已过/已在休息中返回 null。
   */
  startScheduledSleep({ windowStart, windowEnd, reason = '按作息睡觉' } = {}) {
    if (!this.restEnabled()) return null;
    const cfg = this.#scheduleConfig();
    if (cfg.enabled === false) return null;
    if (this.restStatus()?.active) return null;
    // 上一次休息已到期但 ticker 还没结算：先结算，避免把它吞掉。
    if (this.#current().rest) this.finishDueRest();
    const now = this.now();
    const end = Number(windowEnd) || 0;
    const start = Number(windowStart) || now;
    if (!Number.isFinite(end) || end <= now) return null;
    const state = this.#current();
    const reasonText = String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || '按作息睡觉';
    const next = {
      ...state,
      rest: {
        kind: 'sleep',
        scheduled: true,
        windowStart: start,
        windowEnd: end,
        startedAt: now,
        until: end,
        reason: reasonText
      },
      updatedAt: now
    };
    this.state = next;
    this.loaded = true;
    try {
      writeMoodState(next, { dataDir: this.dataDir });
    } catch (error) {
      this.log(`[mood] 作息睡觉状态写入失败（内存值继续可用）：${error?.message ?? error}`);
    }
    return this.snapshot();
  }

  /**
   * 结算到期的休息。自然结束给全额恢复；被管理员提前叫醒按已休息比例给部分恢复。
   * 返回 `{ finished, kind?, snapshot?, forced? }`；没有到期休息时 `{ finished:false }`。
   */
  finishDueRest({ force = false } = {}) {
    if (!this.enabled()) return { finished: false };
    const before = this.#current();
    const rest = before.rest;
    if (!rest) return { finished: false };
    const now = this.now();
    if (!force && rest.until > now) return { finished: false };
    // 先把 shadow 推进到结算时刻（按“还在睡”处理），再清 rest。
    this.#tickEnergyShadow(now, { sleeping: rest.kind === 'sleep' });
    const state = this.#current();
    const cfg = this.#restConfig();
    const kind = rest.kind === 'slack' ? 'slack' : 'sleep';
    const scheduled = rest.scheduled === true && kind === 'sleep'
      && Number(rest.windowEnd) > Number(rest.windowStart);
    const moodGain = kind === 'sleep'
      ? numIn(cfg.sleepMoodGain, 12, 0, 50)
      : numIn(cfg.slackMoodGain, 6, 0, 50);
    let moodDelta = 0;
    let energyDelta = 0;
    let reason = '';

    if (scheduled) {
      // 作息睡觉：按“实际睡到的时间 / 整晚窗口”恢复。
      // 睡满整晚 → 精力补到 100；晚睡或早醒 → 只补对应比例。
      const windowStart = Number(rest.windowStart) || Number(rest.startedAt);
      const windowEnd = Number(rest.windowEnd) || Number(rest.until);
      const windowMs = Math.max(1, windowEnd - windowStart);
      const sleptFrom = Math.max(Number(rest.startedAt) || windowStart, windowStart);
      const sleptTo = Math.min(now, windowEnd);
      const fraction = Math.min(1, Math.max(0, (sleptTo - sleptFrom) / windowMs));
      const currentEnergy = Math.min(100, Math.max(0, Number(state.energy) || 0));
      moodDelta = Math.round(moodGain * fraction * 10) / 10;
      energyDelta = Math.round(Math.max(0, 100 - currentEnergy) * fraction * 10) / 10;
      reason = force ? '被叫醒（提前结束睡觉）' : '睡了一觉（按作息）';
    } else {
      const total = Math.max(1, rest.until - rest.startedAt);
      const fraction = Math.min(1, Math.max(0, (now - rest.startedAt) / total));
      const factor = force ? Math.max(0.25, fraction) : 1;
      // 摸鱼只恢复心情；精力只有睡觉能补。
      const energyGain = kind === 'sleep' ? numIn(cfg.sleepEnergyGain, 20, 0, 50) : 0;
      moodDelta = Math.round(moodGain * factor * 10) / 10;
      energyDelta = Math.round(energyGain * factor * 10) / 10;
      reason = force
        ? (kind === 'sleep' ? '被叫醒（提前结束睡觉）' : '被叫醒（提前结束摸鱼）')
        : (kind === 'sleep' ? '睡了一觉' : '摸鱼了一会儿');
    }

    const next = applyMoodEvent(state, {
      moodDelta,
      energyDelta,
      reason
    }, {
      now,
      baseline: this.baseline(),
      halfLifeHours: this.#halfLife(),
      energyDrainPerHour: this.#energyDrain(),
      energyFatigueRampHours: this.#fatigueRamp(),
      historyLimit: this.#historyLimit(),
      dailyKeepDays: this.#dailyKeepDays(),
      bypassLimits: true
    });
    next.rest = null;
    // 睡醒后连续清醒时间重新计时（打盹也算睡过）；摸鱼不重置。
    if (kind === 'sleep') next.lastSleepAt = now;
    this.state = next;
    this.loaded = true;
    try {
      writeMoodState(next, { dataDir: this.dataDir });
    } catch (error) {
      this.log(`[mood] 休息结算写入失败（内存值继续可用）：${error?.message ?? error}`);
    }
    return { finished: true, kind, forced: force, snapshot: this.snapshot() };
  }

  /** 管理员强制叫醒/结束摸鱼。 */
  wakeFromRest() {
    return this.finishDueRest({ force: true });
  }

  observeIgnored(chatKey = '') {
    // 私聊里对话自然结束很常见，不按“被无视”扣分；只统计群聊。
    if (!String(chatKey).startsWith('group:')) return null;
    return this.#apply({ moodDelta: -1.2, energyDelta: -0.8, reason: '发言后没人接', chatKey });
  }

  reset() {
    if (!this.enabled()) return null;
    this.energySamples = [];
    this.lastShadowLogAt = 0;
    const current = this.#current();
    const next = resetMoodState(current, {
      now: this.now(),
      baseline: this.baseline(),
      halfLifeHours: this.#halfLife(),
      energyDrainPerHour: this.#energyDrain(),
      energyFatigueRampHours: this.#fatigueRamp(),
      historyLimit: this.#historyLimit(),
      dailyKeepDays: this.#dailyKeepDays()
    });
    this.state = next;
    this.loaded = true;
    try {
      writeMoodState(next, { dataDir: this.dataDir });
    } catch (error) {
      this.log(`[mood] 重置写入失败（内存值继续可用）：${error?.message ?? error}`);
    }
    return this.snapshot();
  }

  /** 回复概率/主动概率的乘数：精力 0 → 0.8，50 → 1.0，100 → 1.2（默认影响 0.2）。 */
  frequencyFactor() {
    if (!this.enabled()) return 1;
    const energy = this.#decisionEnergy();
    const norm = (energy - 50) / 50;
    let factor = numIn(1 + this.#frequencyInfluence() * norm, 1, 0.6, 1.4);
    // 摸鱼是软暂停：仍然会看消息，但只选择性回一些；睡觉时通常没有运行，不影响这里。
    if (this.slacking()) {
      factor *= numIn(this.#restConfig().slackReplyFactor, 0.35, 0.05, 1);
    }
    return numIn(factor, 1, 0.05, 1.4);
  }

  /** 注意力层最低置信度：精力低时要求更确定，精力高时略微放宽。 */
  attentionMinConfidence(base = 0.55) {
    const fallback = numIn(base, 0.55, 0.2, 0.9);
    if (!this.enabled()) return fallback;
    const energy = this.#decisionEnergy();
    const slackBias = this.slacking() ? 0.15 : 0;
    return numIn(
      fallback + (0.5 - energy / 100) * this.#frequencyInfluence() + slackBias,
      fallback,
      0.2,
      0.9
    );
  }

  proactiveProbability(base = 0) {
    const value = numIn(base, 0, 0, 1);
    if (!this.enabled()) return value;
    if (this.resting()) return 0;
    return numIn(value * this.frequencyFactor(), value, 0, 1);
  }

  /** 主动间隔：精力高时略缩短，精力低时略拉长。 */
  proactiveIntervalFactor() {
    if (!this.enabled()) return 1;
    const energy = this.#decisionEnergy();
    const norm = (energy - 50) / 50;
    return numIn(1 - this.#frequencyInfluence() * norm * 0.5, 1, 0.75, 1.25);
  }

  followUpEnergyOk() {
    if (!this.enabled()) return true;
    if (this.resting()) return false;
    if (this.#energyActive()) {
      const observed = this.#tickEnergyShadow(this.now());
      const min = numIn(this.#energyConfig().decision?.followUpMinEobs, 0.25, 0, 1);
      const eobs = Number(observed?.Eobs);
      if (Number.isFinite(eobs)) return eobs >= min;
    }
    const min = numIn(this.config().followUpMinEnergy, 25, 0, 100);
    return this.#current().energy >= min;
  }

  /** 控制台用：最近变化，去掉 actorId/chatKey 等内部字段。 */
  recentHistory(limit = 50) {
    if (!this.enabled()) return [];
    return this.#current().history
      .slice(-Math.max(1, Math.round(Number(limit) || 50)))
      .reverse()
      .map(({ at, moodDelta, energyDelta, mood, energy, reason }) => ({
        at, moodDelta, energyDelta, mood, energy, reason
      }));
  }

  /** 控制台用：最近几天汇总，日期升序。 */
  recentDays(limit = 7) {
    if (!this.enabled()) return [];
    const keep = Math.max(1, Math.round(Number(limit) || 7));
    return Object.values(this.#current().daily)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-keep);
  }

  /** 仅供测试/诊断：不衰减的原始状态副本。 */
  rawState() {
    return structuredClone(this.#load());
  }
}

export { defaultMoodState };
