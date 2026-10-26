import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mood-manager-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const { MoodManager } = await import('../src/core/mood-manager.js');
const { defaultMoodState, writeMoodState } = await import('../src/core/mood-state.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

const T0 = Date.parse('2026-10-23T04:00:00Z');
const baseline = { mood: 55, energy: 55 };

function configure(mood = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.mood = {
    ...cfg.mood,
    ...mood,
    baseline: { ...cfg.mood.baseline, ...(mood.baseline || {}) }
  };
  setRuntimeConfig(cfg);
  return cfg;
}

function make(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'm-'));
  const manager = new MoodManager({ dataDir: dir, now: () => T0, ...overrides });
  return { dir, manager };
}

test('模型评审：按模型给的分值变化，reason 归一为单行；精力不接受正数', () => {
  configure();
  const { manager } = make();
  const snap = manager.applyJudge({ moodDelta: 2, energyDelta: 0.5, reason: '被夸\n很开心' });
  assert.equal(snap.mood, 57);
  assert.equal(snap.energy, 55, '评审不能把精力加回来');
  assert.equal(manager.recentHistory(1)[0].reason, '被夸 很开心');

  const neg = manager.applyJudge({ moodDelta: -3, energyDelta: -1, reason: '被骂' });
  assert.equal(neg.mood, 54);
  assert.equal(neg.energy, 54);
});

test('模型评审：单次最多 ±5，reason 只留一行且限长', () => {
  configure();
  const { manager } = make();
  const snap = manager.applyJudge({ moodDelta: 99, energyDelta: -99, reason: 'x'.repeat(120) });
  assert.equal(snap.mood, 60);
  assert.equal(snap.energy, 50);
  assert.ok(manager.recentHistory(1)[0].reason.length <= 60);
});

test('群聊被无视扣分，私聊不扣；发言本身不再加精力', () => {
  configure();
  const { manager } = make();
  assert.equal(typeof manager.observeReplied, 'undefined', '成功回复不再加精力');

  const ignored = manager.observeIgnored('group:1');
  assert.equal(ignored.mood, 53.8);
  assert.equal(ignored.energy, 54.2);
  assert.equal(manager.observeIgnored('private:42'), null, '私聊不算被无视');
});

test('关闭时完全不读写，系数恒为 1', () => {
  configure({ enabled: false });
  const { dir, manager } = make();
  assert.equal(manager.applyJudge({ moodDelta: 2, energyDelta: 1, reason: '夸' }), null);
  assert.equal(manager.frequencyFactor(), 1);
  assert.equal(manager.proactiveProbability(0.5), 0.5);
  assert.equal(manager.followUpEnergyOk(), true);
  assert.equal(manager.promptSnapshot(), null);
  assert.deepEqual(manager.recentHistory(), []);
  assert.equal(fs.existsSync(path.join(dir, 'mood.json')), false);
});

test('精力高低影响频率系数与注意力阈值', () => {
  configure();
  const { dir } = make();
  writeMoodState({ ...defaultMoodState(T0, baseline), mood: 55, energy: 100 }, { dataDir: dir });
  const high = new MoodManager({ dataDir: dir, now: () => T0 });
  assert.equal(high.frequencyFactor(), 1.2);
  assert.equal(high.proactiveProbability(0.5), 0.6);
  assert.ok(high.attentionMinConfidence(0.55) < 0.55);

  writeMoodState({ ...defaultMoodState(T0, baseline), mood: 55, energy: 0 }, { dataDir: dir });
  const low = new MoodManager({ dataDir: dir, now: () => T0 });
  assert.equal(low.frequencyFactor(), 0.8);
  assert.equal(low.proactiveProbability(0.5), 0.4);
  assert.ok(low.attentionMinConfidence(0.55) > 0.55);
  assert.equal(low.followUpEnergyOk(), false);
});

test('重置回到基线并写历史', () => {
  configure();
  const { manager } = make();
  manager.applyJudge({ moodDelta: -3, energyDelta: -1, reason: '被骂' });
  const snap = manager.reset();
  assert.equal(snap.mood, 55);
  assert.equal(snap.energy, 55);
  assert.equal(manager.recentHistory(1)[0].reason, '手动重置');
});

test('睡觉：低状态才允许，自然醒来全额恢复，休息期间主动概率为 0', () => {
  configure({ baseline: { mood: 30, energy: 20 } });
  const dir = fs.mkdtempSync(path.join(root, 'rest-'));
  let now = T0;
  const manager = new MoodManager({ dataDir: dir, now: () => now });

  const started = manager.startRest({ kind: 'sleep', reason: '累了' });
  assert.equal(started.rest.kind, 'sleep');
  assert.equal(started.rest.active, true);
  assert.equal(manager.sleeping(), true);
  assert.equal(manager.proactiveProbability(0.5), 0);

  now += 90 * 60 * 1000;
  const done = manager.finishDueRest();
  assert.equal(done.finished, true);
  assert.equal(done.kind, 'sleep');
  assert.equal(done.snapshot.rest, null);
  assert.equal(done.snapshot.mood, 42);
  assert.equal(done.snapshot.energy, 40);
  assert.equal(manager.sleeping(), false);
});

test('连续清醒越久精力掉得越快；睡醒后重新计时', () => {
  configure();
  const dir = fs.mkdtempSync(path.join(root, 'fatigue-'));
  let now = T0;
  const manager = new MoodManager({ dataDir: dir, now: () => now });
  assert.equal(manager.snapshot().energy, 55, '先让状态在 T0 落定');

  now += 12 * 3600 * 1000;
  assert.equal(manager.snapshot().energy, 37, '前 12 小时消耗 18');
  now += 12 * 3600 * 1000;
  assert.equal(manager.snapshot().energy, 7, '后 12 小时消耗 30，明显加速');

  // 睡一觉后连续清醒时间清零：接下来 12 小时按基础速率重新累积。
  manager.startRest({ kind: 'sleep', reason: '太累了' });
  now += 90 * 60 * 1000;
  const woke = manager.finishDueRest();
  assert.equal(woke.finished, true);
  assert.equal(woke.snapshot.energy, 27, '手动睡 90 分钟恢复 20');
  now += 12 * 3600 * 1000;
  assert.equal(manager.snapshot().energy, 9, '睡醒后重新从基础速率开始');
});

test('作息睡觉：关闭 schedule 时不返回窗口、不自动睡', () => {
  configure({ rest: { schedule: { enabled: false } } });
  const { manager } = make();
  assert.equal(manager.scheduledSleepWindow(), null);
  assert.equal(manager.startScheduledSleep({ windowStart: T0, windowEnd: T0 + 8 * 3600 * 1000 }), null);
});

test('P1 shadow：noteThinking 进入 energyModel，但不改旧 energy 字段', () => {
  configure();
  const dir = fs.mkdtempSync(path.join(root, 'energy-shadow-'));
  let now = T0;
  const manager = new MoodManager({ dataDir: dir, now: () => now });
  const before = manager.snapshot();
  assert.ok(before.energyModel, '默认生成 shadow 快照');
  assert.ok(before.energyModel.E > 0);
  const legacyEnergy = before.energy;

  manager.noteThinking({ at: now, completionTokens: 4000, purpose: 'chat' });
  now += 30 * 1000;
  const after = manager.snapshot();
  assert.ok(after.energyModel.activity > 0, '思考 Token 进入活动强度');
  assert.equal(after.energy, legacyEnergy, 'shadow 不改旧 energy 字段');
});

test('P1 shadow：旧 mood.json 迁移并在下一次写入落盘', () => {
  configure();
  const dir = fs.mkdtempSync(path.join(root, 'energy-migrate-'));
  writeMoodState({
    ...defaultMoodState(T0, baseline),
    energy: 40,
    lastSleepAt: T0 - 8 * 3600 * 1000
  }, { dataDir: dir });

  const manager = new MoodManager({ dataDir: dir, now: () => T0 });
  const snap = manager.snapshot();
  assert.equal(snap.energyModel.E, 0.4);
  assert.ok(snap.energyModel.S >= 0.5, '8 小时清醒 → S≥0.5');

  manager.applyJudge({ moodDelta: 1, energyDelta: 0, reason: '测试' });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'mood.json'), 'utf8'));
  assert.ok(saved.energyModel, '下一次写盘带上 energyModel');
  assert.equal(saved.energyModel.E, 0.4);
});

test('P1 shadow：睡觉期间 E 恢复，结算后继续推进', () => {
  configure({ baseline: { mood: 30, energy: 20 } });
  const dir = fs.mkdtempSync(path.join(root, 'energy-shadow-sleep-'));
  let now = T0;
  const manager = new MoodManager({ dataDir: dir, now: () => now });
  const start = manager.snapshot().energyModel;

  manager.startRest({ kind: 'sleep', reason: '累了' });
  now += 45 * 60 * 1000;
  const during = manager.snapshot();
  assert.ok(during.energyModel.E > start.E, '睡觉期间 shadow E 上升');

  now += 45 * 60 * 1000;
  const done = manager.finishDueRest();
  assert.equal(done.finished, true);
  assert.ok(manager.snapshot().energyModel.E > during.energyModel.E);
});

test('作息建议：窗口内只提示，不自动进入 rest', () => {
  configure({
    rest: { schedule: { enabled: true, sleepAt: '11:30', wakeAt: '13:30', allowStayUp: true } }
  });
  const dir = fs.mkdtempSync(path.join(root, 'schedule-suggest-'));
  const now = new Date(2026, 9, 23, 12, 0, 0, 0).getTime();
  const manager = new MoodManager({ dataDir: dir, now: () => now });
  const snap = manager.snapshot();
  assert.equal(snap.schedule.active, true);
  assert.equal(snap.schedule.suggestsSleep, true);
  assert.equal(manager.resting(), false, '到点不自动睡、不拦截消息');
});

test('作息窗口内主动睡：绕过低状态门槛，默认睡到起床时间', () => {
  configure({
    baseline: { mood: 80, energy: 80 },
    rest: { schedule: { enabled: true, sleepAt: '11:30', wakeAt: '13:30', allowStayUp: true } }
  });
  const dir = fs.mkdtempSync(path.join(root, 'schedule-rest-'));
  let now = new Date(2026, 9, 23, 11, 30, 0, 0).getTime();
  const manager = new MoodManager({ dataDir: dir, now: () => now });
  const started = manager.startRest({ kind: 'sleep', reason: '到点了' });
  assert.ok(started, '状态很好也允许主动睡');
  assert.equal(started.rest.kind, 'sleep');
  assert.equal(started.rest.scheduled, true);

  now = new Date(2026, 9, 23, 13, 30, 0, 0).getTime();
  const done = manager.finishDueRest();
  assert.equal(done.finished, true);
  assert.equal(done.snapshot.energy, 100, '睡满窗口恢复到 100');
});

test('作息睡觉：睡满整晚精力恢复到 100，心情按比例恢复', () => {
  configure({ baseline: { mood: 30, energy: 20 } });
  const dir = fs.mkdtempSync(path.join(root, 'schedule-full-'));
  let now = T0;
  const manager = new MoodManager({ dataDir: dir, now: () => now });
  const started = manager.startScheduledSleep({
    windowStart: T0,
    windowEnd: T0 + 8 * 3600 * 1000,
    reason: '按作息'
  });
  assert.equal(started.rest.kind, 'sleep');
  assert.equal(started.rest.scheduled, true);

  now += 8 * 3600 * 1000;
  const done = manager.finishDueRest();
  assert.equal(done.finished, true);
  assert.equal(done.snapshot.energy, 100);
  assert.equal(done.snapshot.mood, 42);
});

test('作息睡觉：晚睡按实际睡眠比例恢复', () => {
  configure({ baseline: { mood: 30, energy: 20 } });
  const dir = fs.mkdtempSync(path.join(root, 'schedule-late-'));
  let now = T0 + 4 * 3600 * 1000;
  const manager = new MoodManager({ dataDir: dir, now: () => now });
  manager.startScheduledSleep({
    windowStart: T0,
    windowEnd: T0 + 8 * 3600 * 1000,
    reason: '熬夜后睡'
  });

  now += 4 * 3600 * 1000; // 只睡了整晚的一半
  const done = manager.finishDueRest();
  assert.equal(done.finished, true);
  assert.equal(done.snapshot.energy, 60, '20 + (100-20) × 0.5');
  assert.equal(done.snapshot.mood, 36, '30 + 12 × 0.5');
});

test('摸鱼：软暂停，回复系数降低、不主动开话题，只恢复心情', () => {
  configure({ baseline: { mood: 30, energy: 20 } });
  const dir = fs.mkdtempSync(path.join(root, 'slack-'));
  let now = T0;
  const manager = new MoodManager({ dataDir: dir, now: () => now });

  const started = manager.startRest({ kind: 'slack', reason: '摸鱼' });
  assert.equal(started.rest.kind, 'slack');
  assert.equal(manager.slacking(), true);
  assert.equal(manager.sleeping(), false);
  assert.ok(manager.frequencyFactor() < 0.5, '摸鱼时回复概率明显降低');
  assert.equal(manager.proactiveProbability(0.5), 0);
  assert.equal(manager.followUpEnergyOk(), false);

  now += 30 * 60 * 1000;
  const done = manager.finishDueRest();
  assert.equal(done.finished, true);
  assert.equal(done.snapshot.mood, 36);
  assert.equal(done.snapshot.energy, 19.5, '摸鱼不恢复精力，只按时间消耗');
});

test('状态还好时不允许休息；强制叫醒按比例恢复', () => {
  configure();
  const { manager } = make();
  assert.equal(manager.startRest({ kind: 'sleep' }), null, '55/55 还不需要休息');

  configure({ baseline: { mood: 30, energy: 20 } });
  const dir = fs.mkdtempSync(path.join(root, 'force-'));
  let now = T0;
  const low = new MoodManager({ dataDir: dir, now: () => now });
  low.startRest({ kind: 'sleep' });
  now += 30 * 60 * 1000;   // 只睡了 1/3
  const done = low.wakeFromRest();
  assert.equal(done.finished, true);
  assert.equal(done.forced, true);
  assert.equal(done.snapshot.mood, 34);
  assert.equal(done.snapshot.energy, 26.7);
});
