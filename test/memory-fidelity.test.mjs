// 记忆保真度与强度衰减。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideFidelity,
  initialStrength,
  isTransientExpired,
  shouldFade,
  shouldFadeDetail,
  strengthAfterDecay,
  strengthenOnObserve,
  strengthenOnRecall,
  tauDaysFor
} from '../src/memory/memory-fidelity.js';

const DAY = 86400000;

test('保真度：约定/决定强制 verbatim，低重要度事件 transient，其余 gist', () => {
  assert.equal(decideFidelity({ kind: 'convention', importance: 1 }), 'verbatim');
  assert.equal(decideFidelity({ kind: 'decision', importance: 2 }), 'verbatim');
  assert.equal(decideFidelity({ kind: 'person_fact', importance: 4 }), 'verbatim');
  assert.equal(decideFidelity({ kind: 'event', importance: 2 }), 'transient');
  assert.equal(decideFidelity({ kind: 'event', importance: 3 }), 'gist');
  assert.equal(decideFidelity({ kind: 'fact', importance: 1 }), 'gist');
});

test('初始强度随重要度上升，verbatim 更强、transient 更弱', () => {
  assert.ok(initialStrength({ importance: 5 }) > initialStrength({ importance: 1 }));
  assert.ok(initialStrength({ importance: 3, fidelity: 'verbatim' })
    > initialStrength({ importance: 3, fidelity: 'gist' }));
  assert.ok(initialStrength({ importance: 3, fidelity: 'transient' })
    < initialStrength({ importance: 3, fidelity: 'gist' }));
});

test('重要度越高衰减越慢，verbatim 近似不衰减', () => {
  assert.ok(tauDaysFor({ importance: 5 }) > tauDaysFor({ importance: 1 }));
  assert.ok(tauDaysFor({ importance: 3, fidelity: 'verbatim' })
    >= 10 * tauDaysFor({ importance: 3, fidelity: 'gist' }));

  const gist = strengthAfterDecay({ strength: 1, importance: 2, fidelity: 'gist', lastActiveAt: 1000, now: 1000 + 30 * DAY });
  const verbatim = strengthAfterDecay({ strength: 1, importance: 2, fidelity: 'verbatim', lastActiveAt: 1000, now: 1000 + 30 * DAY });
  assert.ok(gist < 0.5);
  assert.ok(verbatim > 0.7);
});

test('召回/再观察提升强度，并有上限', () => {
  assert.ok(strengthenOnRecall(1, { boost: 0.15 }) > 1);
  assert.equal(strengthenOnRecall(1.95, { boost: 0.15, maxStrength: 2 }), 2);
  assert.ok(strengthenOnObserve(1, { boost: 0.1 }) > 1);
});

test('淡出：verbatim 永不自动淡出', () => {
  assert.equal(shouldFade({ strength: 0.01, fidelity: 'verbatim' }), false);
  assert.equal(shouldFade({ strength: 0.01, fidelity: 'gist' }), true);
  assert.equal(shouldFade({ strength: 0.5, fidelity: 'gist' }), false);
});

test('gist 细节到期淡出，verbatim 不淡出', () => {
  const old = 1000;
  const now = old + 31 * DAY;
  assert.equal(shouldFadeDetail({ fidelity: 'gist', updatedAt: old, now }), true);
  assert.equal(shouldFadeDetail({ fidelity: 'gist', updatedAt: old, now, gistDetailDays: 60 }), false);
  assert.equal(shouldFadeDetail({ fidelity: 'gist', updatedAt: old, now, detailFadedAt: old + DAY }), false);
  assert.equal(shouldFadeDetail({ fidelity: 'verbatim', updatedAt: old, now }), false);
});

test('transient 到期判断', () => {
  assert.equal(isTransientExpired({ fidelity: 'transient', expiresAt: 100, now: 101 }), true);
  assert.equal(isTransientExpired({ fidelity: 'transient', expiresAt: 200, now: 101 }), false);
  assert.equal(isTransientExpired({ fidelity: 'gist', expiresAt: 100, now: 101 }), false);
});
