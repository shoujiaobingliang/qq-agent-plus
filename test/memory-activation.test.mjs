// 记忆激活打分与候选排序。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activationScore,
  contextMatchScore,
  normalizeActivationWeights,
  rankCandidates
} from '../src/memory/memory-activation.js';

const DAY = 86400000;
const now = 1_000 * DAY;

test('没有 embedding 时 similarity 权重并给 lexical，总和为 1', () => {
  const w = normalizeActivationWeights({}, { hasEmbedding: false });
  assert.equal(w.similarity, 0);
  assert.ok(w.lexical > 0.5);
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('情境匹配：当事人相关 0.5、被提及 0.3、话题词 0.3、同会话 0.2，封顶 1', () => {
  const entry = { subjectUserId: '10001', keywords: ['开黑'], chatKey: 'group:1' };
  assert.equal(contextMatchScore(entry, { chatKey: 'group:1', relevantUserIds: ['10001'], topicText: '周六开黑吗' }), 1);
  assert.equal(contextMatchScore(entry, { chatKey: 'group:2', relevantUserIds: [], mentionedUserIds: ['10001'] }), 0.3);
  assert.equal(contextMatchScore({ keywords: ['开黑'] }, { topicText: '开黑' }), 0.3);
  assert.equal(contextMatchScore({ chatKey: 'group:1' }, { chatKey: 'group:1' }), 0.2);
});

test('激活分数：更重要、更近、更常用的条目得分更高', () => {
  const context = { chatKey: 'group:1', relevantUserIds: ['10001'] };
  const strong = activationScore({
    importance: 5, lastSeenAt: now - DAY, seenCount: 10, subjectUserId: '10001'
  }, { lexical: 0.8, context, now });
  const weak = activationScore({
    importance: 1, lastSeenAt: now - 60 * DAY, seenCount: 1, subjectUserId: ''
  }, { lexical: 0.1, context, now });
  assert.ok(strong.score > weak.score);
  const partsSum = Object.values(strong.parts).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(partsSum - strong.score) < 1e-3);
});

test('rankCandidates 去重、过滤阈值、排序并限量', () => {
  const entries = [
    { id: 1, importance: 5, lastSeenAt: now, seenCount: 12, keywords: ['开黑'] },
    { id: 1, importance: 1, lastSeenAt: now, seenCount: 1 },
    { id: 2, importance: 1, lastSeenAt: now - 100 * DAY, seenCount: 1 },
    { id: 3, importance: 4, lastSeenAt: now, seenCount: 3 }
  ];
  const ranked = rankCandidates(entries, {
    lexicalOf: (entry) => (entry.id === 1 ? 0.9 : 0.2),
    context: { chatKey: 'group:1', topicText: '开黑' },
    minScore: 0.1,
    limit: 2,
    now
  });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, 1);
  assert.ok(ranked[0].activationScore >= ranked[1].activationScore);
});

test('低于阈值不返回', () => {
  const ranked = rankCandidates([{ id: 1, importance: 1, lastSeenAt: now - 365 * DAY, seenCount: 1 }], {
    lexicalOf: () => 0,
    minScore: 0.9,
    now
  });
  assert.equal(ranked.length, 0);
});
