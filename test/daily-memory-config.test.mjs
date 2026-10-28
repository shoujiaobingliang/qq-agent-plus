// 每日记忆配置默认值与归一化。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_DAILY_MEMORY_CONFIG,
  dailyMemoryDatabasePath,
  normalizeDailyMemoryConfig
} from '../src/core/daily-memory-config.js';

test('默认关闭，human 子段有完整默认值', () => {
  assert.equal(DEFAULT_DAILY_MEMORY_CONFIG.enabled, false);
  assert.equal(DEFAULT_DAILY_MEMORY_CONFIG.human.enabled, true);
  assert.equal(DEFAULT_DAILY_MEMORY_CONFIG.human.privacy.allowKnowledgeAcrossChats, true);
});

test('归一化夹取数值、时间与布尔', () => {
  const cfg = normalizeDailyMemoryConfig({
    time: '99:99',
    maxChats: 9999,
    minConfidence: 5,
    human: {
      gistDetailDays: -1,
      tauBaseDays: 999,
      privacy: { minClassificationConfidence: 9, allowKnowledgeAcrossChats: false }
    }
  });
  assert.equal(cfg.time, '04:10');
  assert.equal(cfg.maxChats, 100);
  assert.equal(cfg.minConfidence, 1);
  assert.equal(cfg.human.gistDetailDays, 0);
  assert.equal(cfg.human.tauBaseDays, 180);
  assert.equal(cfg.human.privacy.minClassificationConfidence, 0.95);
  assert.equal(cfg.human.privacy.allowKnowledgeAcrossChats, false);
});

test('坏形状回落默认，不抛错', () => {
  const cfg = normalizeDailyMemoryConfig({ human: 'bad', time: null });
  assert.equal(cfg.human.enabled, true);
  assert.equal(cfg.time, '04:10');
});

test('数据库路径固定在 memory/ 下', () => {
  assert.match(dailyMemoryDatabasePath('/data'), /memory[\\/]daily-memory\.sqlite$/);
});
