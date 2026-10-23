import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-impression-config-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const { DEFAULT_CONFIG, getConfig, updateConfig } = await import('../src/core/config.js');

test('印象分配置默认值', () => {
  const imp = DEFAULT_CONFIG.impression;
  assert.equal(imp.enabled, true);
  assert.equal(imp.baseline, 50);
  assert.equal(imp.lowThreshold, 30);
  assert.equal(imp.highThreshold, 80);
  assert.equal(imp.vice.enabled, true);
  assert.equal(imp.vice.maxChance, 0.7);
});

test('副人格卡在 persona 区域：默认 tieba 空白卡，旧毒舌映射到 tieba', () => {
  const cfg = updateConfig({
    persona: {
      vicePersonaId: '毒舌',
      vicePersonas: [{ id: 'custom', name: '自定义', roleText: '你是一个自定义副人格' }]
    }
  });
  assert.equal(cfg.persona.vicePersonaId, 'tieba');
  const ids = cfg.persona.vicePersonas.map((card) => card.id);
  assert.ok(ids.includes('tieba'));
  assert.ok(ids.includes('custom'));
  assert.equal(cfg.persona.vicePersonas.find((card) => card.id === 'tieba').roleText, '');
});

test('印象分配置夹紧并保证 hostile <= low <= high', () => {
  const cfg = updateConfig({
    impression: {
      enabled: false,
      lowThreshold: 90,
      hostileThreshold: 80,
      highThreshold: 10,
      decayHalfLifeDays: 0,
      lowReplyFactor: 9,
      highShareInfluence: -1,
      vice: {
        baseChance: 2,
        maxChance: 0.1,
        burstDelta: -99,
        burstBelow: 999,
        cooldownMinutes: 0,
        maxContextChars: 1,
        maxHistoryMessages: 1
      }
    }
  });
  assert.equal(cfg.impression.enabled, false);
  assert.equal(cfg.impression.lowThreshold, 90);
  assert.equal(cfg.impression.hostileThreshold, 80);
  assert.equal(cfg.impression.highThreshold, 90);
  assert.equal(cfg.impression.decayHalfLifeDays, 1);
  assert.equal(cfg.impression.lowReplyFactor, 0.8);
  assert.equal(cfg.impression.highShareInfluence, 0);
  assert.equal(cfg.impression.vice.baseChance, 1);
  assert.equal(cfg.impression.vice.maxChance, 1);
  assert.equal(cfg.impression.vice.burstDelta, -10);
  assert.equal(cfg.impression.vice.burstBelow, 100);
  assert.equal(cfg.impression.vice.cooldownMinutes, 1);
  assert.equal(cfg.impression.vice.maxContextChars, 200);
  assert.equal(cfg.impression.vice.maxHistoryMessages, 2);
  assert.equal(getConfig().impression.enabled, false);
});
