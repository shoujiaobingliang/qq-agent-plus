import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-impression-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const { GlobalPersonMemoryStore } = await import('../src/memory/global-person-memory-store.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

const T0 = Date.parse('2026-10-23T04:00:00Z');

function configure(overrides = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.impression = {
    ...cfg.impression,
    ...overrides,
    vice: { ...cfg.impression.vice, ...(overrides.vice || {}) }
  };
  setRuntimeConfig(cfg);
  return cfg;
}

test('印象分：默认基线、单次夹紧、历史与持久化', () => {
  configure();
  const store = new GlobalPersonMemoryStore();
  store.append('group:1', '123', '阿三', '爱玩梗');
  assert.equal(store.impressionOf('123', { now: T0 }).score, 50);

  const low = store.adjustImpression('123', { delta: -9, reason: '骂人', chatKey: 'group:1', now: T0 });
  assert.equal(low.score, 45, '单次最多 -5');
  assert.equal(low.history.at(-1).delta, -5);
  assert.equal(low.history.at(-1).reason, '骂人');

  const reloaded = new GlobalPersonMemoryStore();
  assert.equal(reloaded.impressionOf('123', { now: T0 }).score, 45, '重启后从人物文件恢复');
});

test('印象分：按半衰期回归基线；整理/改印象不重置分数', () => {
  configure();
  const store = new GlobalPersonMemoryStore();
  store.append('group:1', '456', '阿四', '爱玩梗');
  store.adjustImpression('456', { delta: -5, reason: '骂人', chatKey: 'group:1', now: T0 });
  const later = T0 + 14 * 86400000;
  assert.ok(store.impressionOf('456', { now: later }).score > 45, '14 天后向基线回升');

  const replaced = store.replace('group:1', '456', '阿四', ['新的印象']);
  assert.equal(replaced.impressionScore, 45, '整理改写不能把印象分冲回默认');
  assert.equal(replaced.impressionHistory.length, 1);
});

test('群印象系数与低印象回复系数', () => {
  configure();
  const store = new GlobalPersonMemoryStore();
  store.append('group:1', '789', '阿五', '爱玩梗');
  for (let i = 0; i < 6; i += 1) {
    store.adjustImpression('789', { delta: -5, reason: '吵架', chatKey: 'group:1', now: T0 + i * 1000 });
  }
  const score = store.impressionOf('789', { now: T0 + 6000 }).score;
  assert.ok(score < 30);
  assert.ok(store.impressionFactorForChat('group:1', { now: T0 + 6000 }) < 1);
  assert.ok(store.replyFactorForUserIds(['789'], { now: T0 + 6000 }) < 1);
  assert.equal(store.replyFactorForUserIds(['999'], { now: T0 + 6000 }), 1, '不认识的人按基线，不额外惩罚');
});

test('副人格冷却', () => {
  configure();
  const store = new GlobalPersonMemoryStore();
  assert.equal(store.viceCooldownOk('123', 30, T0), true);
  store.markViceTriggered('123', { now: T0 });
  assert.equal(store.viceCooldownOk('123', 30, T0 + 60000), false);
  assert.equal(store.viceCooldownOk('123', 30, T0 + 31 * 60000), true);
});
