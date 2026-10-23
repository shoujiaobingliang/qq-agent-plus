import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mood-config-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const { DEFAULT_CONFIG, getConfig, updateConfig } = await import('../src/core/config.js');

test('心情配置有默认值', () => {
  const mood = DEFAULT_CONFIG.mood;
  assert.equal(mood.enabled, true);
  assert.deepEqual(mood.baseline, { mood: 55, energy: 55 });
  assert.equal(mood.frequencyInfluence, 0.2);
  assert.equal(mood.toneInfluence, 0.6);
  assert.equal(mood.decayHalfLifeHours, 12);
  assert.equal(mood.judge.enabled, true);
  assert.equal(mood.judge.maxCallsPerDay, 100);
  assert.equal(mood.rest.enabled, true);
  assert.equal(mood.rest.sleepMinutes, 90);
  assert.equal(mood.rest.slackReplyFactor, 0.35);
});

test('updateConfig 把坏值夹回安全区间，显式关闭会保留', () => {
  const cfg = updateConfig({
    mood: {
      enabled: false,
      baseline: { mood: 999, energy: -5 },
      frequencyInfluence: 9,
      toneInfluence: -1,
      decayHalfLifeHours: 0,
      followUpMinEnergy: 999,
      historyLimit: 1,
      dailyKeepDays: 1,
      judge: {
        enabled: false,
        maxCallsPerDay: 99999,
        timeoutMs: 1,
        maxInputChars: 1
      },
      rest: {
        enabled: false,
        sleepMinutes: 1,
        slackMinutes: 999,
        sleepMoodGain: 999,
        slackReplyFactor: 9
      }
    }
  });
  assert.equal(cfg.mood.enabled, false);
  assert.deepEqual(cfg.mood.baseline, { mood: 100, energy: 0 });
  assert.equal(cfg.mood.frequencyInfluence, 0.5);
  assert.equal(cfg.mood.toneInfluence, 0);
  assert.equal(cfg.mood.decayHalfLifeHours, 1);
  assert.equal(cfg.mood.followUpMinEnergy, 100);
  assert.equal(cfg.mood.historyLimit, 20);
  assert.equal(cfg.mood.dailyKeepDays, 7);
  assert.equal(cfg.mood.judge.enabled, false);
  assert.equal(cfg.mood.judge.maxCallsPerDay, 1000);
  assert.equal(cfg.mood.judge.timeoutMs, 500);
  assert.equal(cfg.mood.judge.maxInputChars, 1000);
  assert.equal(cfg.mood.rest.enabled, false);
  assert.equal(cfg.mood.rest.sleepMinutes, 30);
  assert.equal(cfg.mood.rest.slackMinutes, 60);
  assert.equal(cfg.mood.rest.sleepMoodGain, 50);
  assert.equal(cfg.mood.rest.slackReplyFactor, 1);
  assert.equal(getConfig().mood.enabled, false);
});
