import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mood-state-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const {
  applyMoodEvent,
  decayMood,
  defaultMoodState,
  energyBand,
  moodBand,
  moodFile,
  moodSnapshot,
  readMoodState,
  resetMoodState,
  writeMoodState
} = await import('../src/core/mood-state.js');

const T0 = Date.parse('2026-10-23T04:00:00Z'); // 上海 12:00
const baseline = { mood: 55, energy: 55 };

test('默认状态与心情/精力档位', () => {
  const state = defaultMoodState(T0, baseline);
  assert.equal(state.mood, 55);
  assert.equal(state.energy, 55);
  assert.equal(state.lastDecayAt, T0);
  assert.deepEqual(state.history, []);
  assert.equal(moodBand(10), '很低落');
  assert.equal(moodBand(50), '平静');
  assert.equal(moodBand(90), '很开心');
  assert.equal(energyBand(10), '疲惫');
  assert.equal(energyBand(50), '正常');
  assert.equal(energyBand(90), '亢奋');
});

test('单次事件写入 history 与当日汇总，值被夹在 0-100', () => {
  let state = defaultMoodState(T0, baseline);
  state = applyMoodEvent(state, { moodDelta: -3, energyDelta: -1, reason: '被骂', actorId: '42' }, {
    now: T0, baseline
  });
  assert.equal(state.mood, 52);
  assert.equal(state.energy, 54);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].reason, '被骂');
  const day = Object.keys(state.daily)[0];
  assert.equal(state.daily[day].events, 1);
  assert.equal(state.daily[day].startMood, 55);
  assert.equal(state.daily[day].endMood, 52);

  // 单次最多 ±5
  state = applyMoodEvent(state, { moodDelta: 999, energyDelta: 999, reason: '夸' }, { now: T0 + 1000, baseline });
  assert.equal(state.mood, 57);
  assert.equal(state.energy, 59);
});

test('每小时全局上限 12、单用户上限 6', () => {
  let state = defaultMoodState(T0, baseline);
  // 三个不同用户各 +5：全局到 12 为止（第三个只加 2）
  for (const actor of ['a', 'b', 'c']) {
    state = applyMoodEvent(state, { moodDelta: 5, reason: '夸', actorId: actor }, { now: T0, baseline });
  }
  assert.equal(state.mood, 67);
  // 同一用户再来：该用户已 +5，最多再 +1
  state = applyMoodEvent(state, { moodDelta: 5, reason: '夸', actorId: 'a' }, { now: T0, baseline });
  assert.equal(state.mood, 67, '全局小时上限已到，不再增加');
});

test('单用户每小时上限 6', () => {
  let state = defaultMoodState(T0, baseline);
  state = applyMoodEvent(state, { moodDelta: 5, reason: '夸', actorId: 'a' }, { now: T0, baseline });
  state = applyMoodEvent(state, { moodDelta: 5, reason: '夸', actorId: 'a' }, { now: T0 + 1000, baseline });
  assert.equal(state.mood, 61, '5 + 1');
});

test('心情按半衰期回归；精力按每小时消耗单向下降', () => {
  const state = { ...defaultMoodState(T0, baseline), mood: 100, energy: 55 };
  const decayed = decayMood(state, {
    now: T0 + 12 * 3600 * 1000,
    baseline,
    halfLifeHours: 12,
    energyDrainPerHour: 1
  });
  assert.equal(decayed.mood, 77.5);
  assert.equal(decayed.energy, 43, '12 小时消耗 12 点，不向基线回升');

  // 低于基线时也只能继续下降，不能像旧版那样回到 55。
  const low = { ...defaultMoodState(T0, baseline), mood: 55, energy: 10 };
  const drained = decayMood(low, {
    now: T0 + 2 * 3600 * 1000,
    baseline,
    halfLifeHours: 12,
    energyDrainPerHour: 1
  });
  assert.equal(drained.energy, 8);
});

test('连续清醒越久精力掉得越快（疲劳累积）', () => {
  const state = { ...defaultMoodState(T0, baseline), mood: 55, energy: 55 };
  const opts = {
    baseline,
    halfLifeHours: 12,
    energyDrainPerHour: 1,
    energyFatigueRampHours: 12
  };
  const at12 = decayMood(state, { ...opts, now: T0 + 12 * 3600 * 1000 });
  // 0–12h：速率从 1 线性升到 2，积分 = 12 + 12²/(2×12) = 18
  assert.equal(at12.energy, 37);

  const at24 = decayMood(state, { ...opts, now: T0 + 24 * 3600 * 1000 });
  // 0–24h：速率从 1 升到 3，积分 = 24 + 24²/(2×12) = 48
  assert.equal(at24.energy, 7);
  assert.ok(at24.energy < at12.energy - (55 - at12.energy), '后 12 小时掉得比前 12 小时更多');
});

test('睡觉期间不扣精力', () => {
  const state = {
    ...defaultMoodState(T0, baseline),
    energy: 40,
    rest: { kind: 'sleep', startedAt: T0, until: T0 + 8 * 3600 * 1000, reason: '睡' }
  };
  const decayed = decayMood(state, {
    now: T0 + 4 * 3600 * 1000,
    baseline,
    halfLifeHours: 12,
    energyDrainPerHour: 1
  });
  assert.equal(decayed.energy, 40);
});

test('跨天 daily：前一天补 end，新一天从当前值起算', () => {
  let state = defaultMoodState(T0, baseline);
  state = applyMoodEvent(state, { moodDelta: 3, reason: '夸' }, { now: T0, baseline });
  const nextDay = T0 + 24 * 3600 * 1000;
  state = applyMoodEvent(state, { moodDelta: 2, reason: '夸' }, { now: nextDay, baseline });
  const days = Object.keys(state.daily).sort();
  assert.equal(days.length, 2);
  assert.equal(state.daily[days[0]].endMood, 58, '前一天结束值保留最后一次事件后的值');
  assert.equal(state.daily[days[1]].startMood, 55.8, '新一天从衰减后的当前值起算');
  assert.equal(state.daily[days[1]].endMood, 57.8);
});

test('history/daily 裁剪', () => {
  let state = defaultMoodState(T0, baseline);
  for (let i = 0; i < 5; i += 1) {
    state = applyMoodEvent(state, { moodDelta: 0.5, reason: `e${i}`, actorId: `u${i}` }, {
      now: T0 + i * 1000, baseline, historyLimit: 2
    });
  }
  assert.equal(state.history.length, 2);
  assert.equal(state.history.at(-1).reason, 'e4');
});

test('重置回到基线并留一条 history', () => {
  let state = { ...defaultMoodState(T0, baseline), mood: 20, energy: 90 };
  state = resetMoodState(state, { now: T0, baseline });
  assert.equal(state.mood, 55);
  assert.equal(state.energy, 55);
  assert.equal(state.history.at(-1).reason, '手动重置');
  assert.equal(state.lastChange.reason, '手动重置');
});

test('快照带标签、今天汇总与惰性衰减', () => {
  const state = { ...defaultMoodState(T0, baseline), mood: 80, energy: 70 };
  const snap = moodSnapshot(state, { now: T0, baseline, halfLifeHours: 12 });
  assert.equal(snap.mood, 80);
  assert.equal(snap.moodLabel, '很开心');
  assert.equal(snap.energyLabel, '有活力');
  assert.equal(snap.label, '很开心 · 有活力');
  assert.equal(snap.today, null);
  assert.equal(snap.rest, null);
});

test('快照带休息状态与剩余分钟；到期后 active=false', () => {
  const state = {
    ...defaultMoodState(T0, baseline),
    rest: { kind: 'sleep', startedAt: T0, until: T0 + 90 * 60000, reason: '累了' }
  };
  const active = moodSnapshot(state, { now: T0 + 30 * 60000, baseline });
  assert.equal(active.rest.kind, 'sleep');
  assert.equal(active.rest.active, true);
  assert.equal(active.rest.remainingMinutes, 60);
  const expired = moodSnapshot(state, { now: T0 + 91 * 60000, baseline });
  assert.equal(expired.rest.active, false);
  assert.equal(expired.rest.remainingMinutes, 0);
});

test('持久化：写入后可读、损坏文件改名留档', () => {
  const dir = fs.mkdtempSync(path.join(root, 'store-'));
  const state = { ...defaultMoodState(T0, baseline), mood: 60, energy: 40 };
  writeMoodState(state, { dataDir: dir });
  const loaded = readMoodState({ dataDir: dir, now: T0, baseline });
  assert.equal(loaded.mood, 60);
  assert.equal(loaded.energy, 40);

  fs.writeFileSync(moodFile(dir), '{broken');
  const fallback = readMoodState({ dataDir: dir, now: T0, baseline });
  assert.equal(fallback.mood, 55);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('mood.json.broken-')));
});

test('文件权限 0600（win32 跳过）', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(root, 'perm-'));
  writeMoodState(defaultMoodState(T0, baseline), { dataDir: dir });
  const mode = fs.statSync(moodFile(dir)).mode & 0o777;
  assert.equal(mode, 0o600);
});
