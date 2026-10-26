import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mood-prompt-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const { buildMoodPromptBlock } = await import('../src/llm/mood-prompt.js');
const { buildMomentSystemPrompt } = await import('../src/llm/moment-prompt.js');
const { buildQzoneInteractionPrompt } = await import('../src/llm/qzone-interaction-prompt.js');
const { resolveContextTier } = await import('../src/llm/prompt.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

const snapshot = {
  enabled: true,
  mood: 62,
  energy: 48,
  moodLabel: '开心',
  energyLabel: '正常',
  toneInfluence: 0.6
};

test('聊天心情块：数值、语气建议与不泄露要求', () => {
  const block = buildMoodPromptBlock(snapshot, { context: 'chat' });
  assert.match(block, /【当前心情】/);
  assert.match(block, /心情 62\/100（开心）/);
  assert.match(block, /精力 48\/100（正常）/);
  assert.match(block, /不要向用户报分数或提及心情系统/);
  assert.match(block, /不改变角色设定/);
});

test('关闭/语气影响为 0 时不输出', () => {
  assert.equal(buildMoodPromptBlock(null), '');
  assert.equal(buildMoodPromptBlock({ ...snapshot, enabled: false }), '');
  assert.equal(buildMoodPromptBlock({ ...snapshot, toneInfluence: 0 }), '');
});

test('每日说说/空间互动使用短块，且不向读者报分数', () => {
  for (const context of ['moment', 'qzone']) {
    const block = buildMoodPromptBlock(snapshot, { context });
    assert.match(block, /【当前心情】/);
    assert.match(block, /不要向读者报分数/);
    assert.doesNotMatch(block, /主动性：/);
  }
  assert.match(buildMomentSystemPrompt({ roleText: '人设' }, { mood: snapshot }), /【当前心情】/);
  assert.match(buildQzoneInteractionPrompt({ roleText: '人设' }, { mood: snapshot }), /【当前心情】/);
});

test('作息建议：窗口内提示睡觉，但保留熬夜选择', () => {
  const schedule = { sleepAt: '23:30', wakeAt: '07:30', active: true, suggestsSleep: true };
  const block = buildMoodPromptBlock({ ...snapshot, schedule }, { context: 'chat' });
  assert.match(block, /【作息建议】/);
  assert.match(block, /建议睡觉/);
  assert.match(block, /可以继续熬夜/);
  assert.match(block, /send_message/);
  assert.match(block, /take_break\(kind="sleep"\)/);

  const hidden = buildMoodPromptBlock(
    { ...snapshot, schedule: { ...schedule, suggestsSleep: false } },
    { context: 'chat' }
  );
  assert.doesNotMatch(hidden, /【作息建议】/);
});

test('精力系数只作用于概率档，不影响必回的 @', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.messageTypes.expandForward = true;
  setRuntimeConfig(cfg);

  const entries = [{ text: '随便聊聊', mentionsSelf: false }];
  const base = resolveContextTier({ triggerEntries: entries, cfg: { randomPercent: 50, keywords: [] }, roll: 45 });
  assert.equal(base.shouldRespond, true, '50% 档 roll=45 应命中');
  const low = resolveContextTier({
    triggerEntries: entries, cfg: { randomPercent: 50, keywords: [] }, roll: 45, probabilityMultiplier: 0.8
  });
  assert.equal(low.shouldRespond, false, '50% × 0.8 = 40%，roll=45 不命中');

  const at = resolveContextTier({
    triggerEntries: [{ text: '', mentionsSelf: true }],
    cfg: { randomPercent: 0, keywords: [] },
    roll: 99,
    probabilityMultiplier: 0.5
  });
  assert.equal(at.tier, 1);
  assert.equal(at.shouldRespond, true, '@ 必回不受精力影响');
});
