import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  activityFromSamples,
  advanceEnergy,
  defaultEnergyState,
  migrateLegacyEnergy,
  observeEnergy,
  phaseFor,
  thinkingTokensForSample,
  tickEnergy
} = await import('../src/core/energy-model.js');

// 全部用本地时间构造，避免测试机时区不同导致相位漂移。
const local = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0).getTime();
const H = 60 * 60 * 1000;

test('昼夜相位：16:00 为 0，04:00 为 π', () => {
  assert.ok(Math.abs(phaseFor(local(23, 16))) < 1e-9);
  assert.ok(Math.abs(phaseFor(local(23, 4)) - Math.PI) < 1e-9);
  assert.ok(Math.abs(phaseFor(local(23, 22)) - Math.PI / 2) < 1e-9);
});

test('观测层：E_obs 随昼夜与睡眠压力变化', () => {
  const day = defaultEnergyState({ now: local(23, 16), E: 0.5, S: 0 });
  const night = defaultEnergyState({ now: local(23, 4), E: 0.5, S: 0 });
  assert.ok(observeEnergy(day).Eobs > observeEnergy(night).Eobs, '16:00 比 04:00 高');

  const tired = defaultEnergyState({ now: local(23, 16), E: 1, S: 1 });
  assert.ok(observeEnergy(tired).Eobs < 0.9, '高睡眠压力会压低观测精力');
  assert.equal(observeEnergy(tired).energy, Math.round(observeEnergy(tired).Eobs * 100));
});

test('动力学：睡觉恢复，清醒只减不增', () => {
  const start = defaultEnergyState({ now: local(23, 16), E: 0.2, S: 0.5 });
  const slept = advanceEnergy(start, {
    now: local(24, 0),
    sleeping: true,
    params: { maxStepMinutes: 1 }
  });
  assert.ok(slept.E > 0.95, `睡 8h 应接近满精力，实际 ${slept.E}`);
  assert.ok(slept.S < 0.05, `睡 8h 后睡眠压力应接近 0，实际 ${slept.S}`);

  const idle = defaultEnergyState({ now: local(23, 16), E: 0.5, S: 0 });
  const idleLater = advanceEnergy(idle, { now: local(23, 23), activity: 0 });
  assert.equal(idleLater.E, 0.5, '清醒空闲不会自动回精力');

  const busy = advanceEnergy(defaultEnergyState({ now: local(23, 16), E: 0.8, S: 0 }), {
    now: local(24, 8),
    activity: 0.5,
    params: { maxStepMinutes: 5 }
  });
  assert.ok(busy.E < 0.8, '活动会消耗精力');
  assert.ok(busy.S > 0.8, '活动会累积睡眠压力');
});

test('动力学：睡觉时 activity 被强制为 0', () => {
  const state = defaultEnergyState({ now: local(23, 16), E: 0.4, S: 0.6 });
  const a0 = tickEnergy(state, { now: local(23, 17), dtMinutes: 60, activity: 0, sleeping: true });
  const a1 = tickEnergy(state, { now: local(23, 17), dtMinutes: 60, activity: 1, sleeping: true });
  assert.equal(a1.E, a0.E);
  assert.equal(a1.S, a0.S);
});

test('长时间推进稳定：不越界、不出现 NaN', () => {
  const state = defaultEnergyState({ now: local(23, 7), E: 0.7, S: 0.2 });
  const later = advanceEnergy(state, {
    now: local(25, 7),
    activity: 0.7,
    params: { maxStepMinutes: 60 }
  });
  assert.ok(Number.isFinite(later.E));
  assert.ok(Number.isFinite(later.S));
  assert.ok(later.E >= 0.02 && later.E <= 1);
  assert.ok(later.S >= 0 && later.S <= 1);
});

test('旧状态迁移：energy/lastSleepAt → E/S', () => {
  const now = local(23, 16);
  const migrated = migrateLegacyEnergy({ energy: 55, lastSleepAt: now - 8 * H, now });
  assert.equal(migrated.E, 0.55);
  assert.equal(migrated.S, 0.5, 'max(1-E, 8/16)');
  assert.ok(Math.abs(migrated.phase) < 1e-9);

  const full = migrateLegacyEnergy({ energy: 100, lastSleepAt: now, now });
  assert.equal(full.E, 1);
  assert.equal(full.S, 0);
});

test('思考 Token：reasoning → completion → 内容长度', () => {
  assert.equal(thinkingTokensForSample({ reasoningTokens: 4000, completionTokens: 5000 }), 4000);
  assert.equal(thinkingTokensForSample({ completionTokens: 1200 }), 1200);
  assert.equal(thinkingTokensForSample({ reasoningChars: 3000 }), 2000);
  assert.equal(
    thinkingTokensForSample({ completionTokens: 99999, params: { activity: { maxTokensPerCall: 20000 } } }),
    20000
  );
});

test('活动强度：思考为主，会话/工具兜底，按窗口过滤', () => {
  const now = local(23, 16);
  const samples = [
    { at: now, kind: 'thinking', tokens: 2000, purpose: 'chat' },
    { at: now, kind: 'session' },
    { at: now, kind: 'tool' },
    { at: now - 11 * 60 * 1000, kind: 'thinking', tokens: 9000, purpose: 'chat' }
  ];
  const a = activityFromSamples(samples, { now, previousActivity: 0 });
  assert.ok(a.activity > 0.2 && a.activity < 0.3, `activity=${a.activity}`);
  assert.equal(a.tokens, 2000, '窗口外样本不算');
  assert.equal(a.aSession, 1);
  assert.ok(a.aTool > 0 && a.aTool < 0.05);

  const background = activityFromSamples(
    [{ at: now, kind: 'thinking', tokens: 5000, purpose: 'judge' }],
    { now }
  );
  assert.equal(background.activity, 0, '后台调用默认不计');
});
