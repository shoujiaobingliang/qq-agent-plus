import assert from 'node:assert/strict';
import { test } from 'node:test';

const { viceChance, viceEligible, impressionBand } = await import('../src/core/impression-vice.js');

const cfg = {
  lowThreshold: 30,
  hostileThreshold: 15,
  highThreshold: 80,
  vice: { baseChance: 0.12, maxChance: 0.7 }
};

test('副人格概率从低阈值开始梯度上升', () => {
  assert.equal(viceChance(30, cfg), 0);
  assert.ok(viceChance(29, cfg) > 0);
  assert.ok(viceChance(15, cfg) > viceChance(25, cfg));
  assert.ok(viceChance(0, cfg) >= viceChance(10, cfg));
  assert.ok(viceChance(0, cfg) <= 0.7);
});

test('爆点直接通过；冷却期内一律不通过', () => {
  assert.equal(viceEligible({ score: 10, cfg, burst: true, random: () => 1 }), true);
  assert.equal(viceEligible({ score: 10, cfg, cooldownOk: false, random: () => 0 }), false);
  assert.equal(viceEligible({ score: 10, cfg, random: () => 1 }), false);
  assert.equal(viceEligible({ score: 10, cfg, random: () => 0 }), true);
});

test('印象档位', () => {
  assert.equal(impressionBand(5, cfg), '很差');
  assert.equal(impressionBand(20, cfg), '偏低');
  assert.equal(impressionBand(50, cfg), '正常');
  assert.equal(impressionBand(90, cfg), '很好');
});
