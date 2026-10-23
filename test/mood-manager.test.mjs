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

test('模型评审：按模型给的分值变化，reason 归一为单行', () => {
  configure();
  const { manager } = make();
  const snap = manager.applyJudge({ moodDelta: 2, energyDelta: 0.5, reason: '被夸\n很开心' });
  assert.equal(snap.mood, 57);
  assert.equal(snap.energy, 55.5);
  assert.equal(manager.recentHistory(1)[0].reason, '被夸 很开心');

  const neg = manager.applyJudge({ moodDelta: -3, energyDelta: -1, reason: '被骂' });
  assert.equal(neg.mood, 54);
  assert.equal(neg.energy, 54.5);
});

test('模型评审：单次最多 ±5，reason 只留一行且限长', () => {
  configure();
  const { manager } = make();
  const snap = manager.applyJudge({ moodDelta: 99, energyDelta: -99, reason: 'x'.repeat(120) });
  assert.equal(snap.mood, 60);
  assert.equal(snap.energy, 50);
  assert.ok(manager.recentHistory(1)[0].reason.length <= 60);
});

test('成功回复加精力；群聊被无视扣分，私聊不扣', () => {
  configure();
  const { manager } = make();
  const replied = manager.observeReplied();
  assert.equal(replied.energy, 55.4);

  const ignored = manager.observeIgnored('group:1');
  assert.equal(ignored.mood, 53.8);
  assert.equal(ignored.energy, 54.6);
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

test('摸鱼：软暂停，回复系数降低、不主动开话题，结束后小幅恢复', () => {
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
  assert.equal(done.snapshot.energy, 28);
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
