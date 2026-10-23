// 心情运行时封装：把纯状态模块接到配置、持久化与判定系数上。
//
// 设计取舍：
//   · 不额外起定时器 —— 快照/应用时惰性衰减，重启与长时间空闲都不会多算；
//   · 快照只读不写 —— 控制台 15 秒轮询不会制造磁盘写；
//   · 任何写失败只记日志、保留内存状态，不影响聊天主流程；
//   · 关闭时不读不写，所有系数恒为 1，行为完全回到现状。
import { DATA_DIR, getConfig } from './config.js';
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
    this.log = typeof log === 'function' ? log : () => {};
    this.state = null;
    this.loaded = false;
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

  /** 当前值（已做惰性衰减），不写盘。 */
  #current() {
    return decayMood(this.#load(), {
      now: this.now(),
      baseline: this.baseline(),
      halfLifeHours: this.#halfLife()
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
      halfLifeHours: this.#halfLife()
    });
    return {
      ...snap,
      toneInfluence: this.#toneInfluence(),
      restEnabled: this.restEnabled()
    };
  }

  /** 提示词只读快照：关闭或语气影响为 0 时返回 null（调用方不注入任何文本）。 */
  promptSnapshot() {
    if (!this.enabled() || this.#toneInfluence() <= 0) return null;
    return this.snapshot();
  }

  #apply(event, { bypassLimits = false } = {}) {
    if (!this.enabled()) return null;
    const current = this.#current();
    const next = applyMoodEvent(current, event, {
      now: this.now(),
      baseline: this.baseline(),
      halfLifeHours: this.#halfLife(),
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

  observeReplied() {
    return this.#apply({ moodDelta: 0, energyDelta: 0.4, reason: '成功发出回复' });
  }

  /**
   * 模型评审结果：只接受夹紧后的 delta；reason 只留一行，避免把整段用户原文带进状态文件。
   */
  applyJudge({ moodDelta = 0, energyDelta = 0, reason = '' } = {}) {
    if (!this.enabled()) return null;
    const text = String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || '模型判断';
    return this.#apply({ moodDelta, energyDelta, reason: text });
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
   * 开始休息。只有心情或精力低于阈值时才允许（防止模型随手偷懒）。
   * 返回快照；不可休息（未启用/已休息/状态还很好）返回 null。
   */
  startRest({ kind = 'sleep', minutes, reason = '' } = {}) {
    if (!this.restEnabled()) return null;
    if (this.restStatus()?.active) return null;
    // 上一次休息已经到期但 ticker 还没结算：先结算，避免把上一次的恢复量吞掉。
    if (this.#current().rest) this.finishDueRest();
    const state = this.#current();
    const cfg = this.#restConfig();
    const maxMood = numIn(cfg.maxMoodForRest, 45, 0, 100);
    const maxEnergy = numIn(cfg.maxEnergyForRest, 40, 0, 100);
    if (Number(state.mood) > maxMood && Number(state.energy) > maxEnergy) return null;
    const safeKind = kind === 'slack' ? 'slack' : 'sleep';
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

  /**
   * 结算到期的休息。自然结束给全额恢复；被管理员提前叫醒按已休息比例给部分恢复。
   * 返回 `{ finished, kind?, snapshot?, forced? }`；没有到期休息时 `{ finished:false }`。
   */
  finishDueRest({ force = false } = {}) {
    if (!this.enabled()) return { finished: false };
    const state = this.#current();
    const rest = state.rest;
    if (!rest) return { finished: false };
    const now = this.now();
    if (!force && rest.until > now) return { finished: false };
    const cfg = this.#restConfig();
    const kind = rest.kind === 'slack' ? 'slack' : 'sleep';
    const total = Math.max(1, rest.until - rest.startedAt);
    const fraction = Math.min(1, Math.max(0, (now - rest.startedAt) / total));
    const factor = force ? Math.max(0.25, fraction) : 1;
    const moodGain = kind === 'sleep'
      ? numIn(cfg.sleepMoodGain, 12, 0, 50)
      : numIn(cfg.slackMoodGain, 6, 0, 50);
    const energyGain = kind === 'sleep'
      ? numIn(cfg.sleepEnergyGain, 20, 0, 50)
      : numIn(cfg.slackEnergyGain, 8, 0, 50);
    const reason = force
      ? (kind === 'sleep' ? '被叫醒（提前结束睡觉）' : '被叫醒（提前结束摸鱼）')
      : (kind === 'sleep' ? '睡了一觉' : '摸鱼了一会儿');
    const next = applyMoodEvent(state, {
      moodDelta: Math.round(moodGain * factor * 10) / 10,
      energyDelta: Math.round(energyGain * factor * 10) / 10,
      reason
    }, {
      now,
      baseline: this.baseline(),
      halfLifeHours: this.#halfLife(),
      historyLimit: this.#historyLimit(),
      dailyKeepDays: this.#dailyKeepDays(),
      bypassLimits: true
    });
    next.rest = null;
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
    const current = this.#current();
    const next = resetMoodState(current, {
      now: this.now(),
      baseline: this.baseline(),
      halfLifeHours: this.#halfLife(),
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
    const energy = this.#current().energy;
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
    const energy = this.#current().energy;
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
    const energy = this.#current().energy;
    const norm = (energy - 50) / 50;
    return numIn(1 - this.#frequencyInfluence() * norm * 0.5, 1, 0.75, 1.25);
  }

  followUpEnergyOk() {
    if (!this.enabled()) return true;
    if (this.resting()) return false;
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
