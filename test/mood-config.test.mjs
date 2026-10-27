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
  assert.equal(mood.energyDrainPerHour, 1);
  assert.equal(mood.energyFatigueRampHours, 12);
  assert.equal(mood.judge.enabled, true);
  assert.equal(mood.judge.maxCallsPerDay, 100);
  assert.equal(mood.rest.enabled, true);
  assert.equal(mood.rest.sleepMinutes, 90);
  assert.equal(mood.rest.slackReplyFactor, 0.35);
  assert.deepEqual(mood.rest.schedule, {
    enabled: true,
    sleepAt: '23:30',
    wakeAt: '07:30',
    allowStayUp: true
  });
  assert.equal(mood.energyModel.enabled, true);
  assert.equal(mood.energyModel.shadow, true);
  assert.equal(mood.energyModel.activity.fullTokensPerMinute, 2000);
  assert.deepEqual(mood.energyModel.activity.includePurposes, ['chat', 'reply-correction']);
  assert.deepEqual(mood.energyModel.decision, {
    followUpMinEobs: 0.25,
    restSuggestS: 0.75,
    scheduledFullSleepRatio: 0.99
  });
});

test('updateConfig 把坏值夹回安全区间，显式关闭会保留', () => {
  const cfg = updateConfig({
    mood: {
      enabled: false,
      baseline: { mood: 999, energy: -5 },
      frequencyInfluence: 9,
      toneInfluence: -1,
      decayHalfLifeHours: 0,
      energyDrainPerHour: 999,
      energyFatigueRampHours: 999,
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
        slackReplyFactor: 9,
        schedule: {
          enabled: false,
          sleepAt: '25:99',
          wakeAt: '07:30',
          allowStayUp: false
        }
      },
      energyModel: {
        enabled: false,
        shadow: false,
        kr: 999,
        beta: -1,
        activity: { wThink: 9, fullTokensPerMinute: 0, includePurposes: ['x', ''] },
        decision: { followUpMinEobs: 9, restSuggestS: -1, scheduledFullSleepRatio: 0 }
      }
    }
  });
  assert.equal(cfg.mood.enabled, false);
  assert.deepEqual(cfg.mood.baseline, { mood: 100, energy: 0 });
  assert.equal(cfg.mood.frequencyInfluence, 0.5);
  assert.equal(cfg.mood.toneInfluence, 0);
  assert.equal(cfg.mood.decayHalfLifeHours, 1);
  assert.equal(cfg.mood.energyDrainPerHour, 10);
  assert.equal(cfg.mood.energyFatigueRampHours, 72);
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
  assert.equal(cfg.mood.rest.schedule.enabled, false);
  assert.equal(cfg.mood.rest.schedule.sleepAt, '23:30');
  assert.equal(cfg.mood.rest.schedule.wakeAt, '07:30');
  assert.equal(cfg.mood.rest.schedule.allowStayUp, false);
  assert.equal(cfg.mood.energyModel.enabled, false);
  assert.equal(cfg.mood.energyModel.shadow, false);
  assert.equal(cfg.mood.energyModel.kr, 1);
  assert.equal(cfg.mood.energyModel.beta, 0);
  assert.equal(cfg.mood.energyModel.activity.wThink, 1);
  assert.equal(cfg.mood.energyModel.activity.fullTokensPerMinute, 1);
  assert.deepEqual(cfg.mood.energyModel.activity.includePurposes, ['x']);
  assert.deepEqual(cfg.mood.energyModel.decision, {
    followUpMinEobs: 1,
    restSuggestS: 0,
    scheduledFullSleepRatio: 0.5
  });
  assert.equal(getConfig().mood.enabled, false);
});

test('作息时间相同（0 长度窗口）回退默认值', () => {
  const cfg = updateConfig({
    mood: {
      rest: {
        schedule: { sleepAt: '23:30', wakeAt: '23:30' }
      }
    }
  });
  assert.equal(cfg.mood.rest.schedule.sleepAt, '23:30');
  assert.equal(cfg.mood.rest.schedule.wakeAt, '07:30');
});
