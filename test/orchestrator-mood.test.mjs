import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-orchestrator-mood-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const { Orchestrator, followUpPlan } = await import('../src/core/orchestrator.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

const snapshot = {
  enabled: true,
  mood: 60,
  energy: 50,
  moodLabel: '开心',
  energyLabel: '正常',
  label: '开心 · 正常',
  lastChange: null
};

function makeRunner({ sleeping = false } = {}) {
  const events = [];
  const mood = {
    enabled: () => true,
    sleeping: () => sleeping,
    slacking: () => false,
    resting: () => sleeping,
    applyJudge: (decision) => ({ ...snapshot, lastChange: decision }),
    observeIgnored: () => null,
    observeReplied: () => null,
    reset: () => snapshot,
    snapshot: () => snapshot,
    promptSnapshot: () => snapshot,
    frequencyFactor: () => 1,
    attentionMinConfidence: (base) => base,
    proactiveProbability: (base) => base,
    proactiveIntervalFactor: () => 1,
    followUpEnergyOk: () => true
  };
  const runner = new Orchestrator({
    store: {},
    memory: {},
    stickers: {},
    sender: {},
    sessions: {},
    onebot: { selfId: '999', selfNickname: 'bot', connected: false },
    emit: (type, payload) => events.push({ type, payload }),
    mood
  });
  return { runner, events };
}

test('statusSummary 带出心情快照；resetMood 广播', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  setRuntimeConfig(cfg);
  const { runner, events } = makeRunner();
  assert.deepEqual(runner.statusSummary().mood, snapshot);
  assert.deepEqual(runner.resetMood(), snapshot);
  assert.ok(events.some((event) => event.type === 'mood-update'));
});

test('补话：精力低于阈值时不安排', () => {
  const low = followUpPlan({ sentCount: 1, unread: 0, energy: 10, minEnergy: 25 });
  assert.equal(low.schedule, false);
  assert.equal(low.reason, '精力不足');
  const ok = followUpPlan({ sentCount: 1, unread: 0, energy: 50, minEnergy: 25 });
  assert.equal(ok.schedule, true);
});

test('睡觉期间不建唤醒', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  setRuntimeConfig(cfg);
  const { runner } = makeRunner({ sleeping: true });
  let scheduled = 0;
  runner.scheduleWake = () => { scheduled += 1; };
  runner.onIncoming('group:1');
  assert.equal(scheduled, 0, '睡觉时 onIncoming 不应排唤醒');
});
