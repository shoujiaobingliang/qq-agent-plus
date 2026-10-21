// 连续消息：同一个人把一句话拆成几条发时，提示词要标出「接上条」，
// 让模型先合并理解整体意思，而不是只接最后一条/其中一条。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-fragmented-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { buildPastState, buildTriggerBlock, buildSystemPrompt } = await import('../src/llm/prompt.js');

setRuntimeConfig(structuredClone(DEFAULT_CONFIG));

const messages = [
  { id: 1, mid: 1, ts: 1_000_000, senderId: 'u1', senderName: '甲', text: '我今天' },
  { id: 2, mid: 2, ts: 1_005_000, senderId: 'u1', senderName: '甲', text: '去喝酒了' },
  { id: 3, mid: 3, ts: 1_010_000, senderId: 'u1', senderName: '甲', text: '你呢' },
  { id: 4, mid: 4, ts: 1_015_000, senderId: 'u2', senderName: '乙', text: '哈哈' },
  // 同一人，但距离上一条超过 90 秒：不标接上条
  { id: 5, mid: 5, ts: 1_015_000 + 95_000, senderId: 'u2', senderName: '乙', text: '隔了很久' }
];

test('过去状态：同一人短时间连续消息标「接上条」，换人或超时不标', () => {
  const store = { recent: () => structuredClone(messages) };
  const { text } = buildPastState(store, 'group:1', { limit: 10 });
  const line = (needle) => text.split('\n').find((row) => row.includes(needle));
  assert.ok(line('去喝酒了')?.includes('（接上条）'), '同一人第二条要标接上条');
  assert.ok(line('你呢')?.includes('（接上条）'), '同一人第三条要标接上条');
  assert.ok(!line('哈哈')?.includes('（接上条）'), '换了人要断开');
  assert.ok(!line('隔了很久')?.includes('（接上条）'), '超过窗口不标');
});

test('本次唤醒：同样标「接上条」并保留标签', () => {
  const block = buildTriggerBlock(structuredClone(messages), {
    kind: 'group', selfNickname: '机器人', selfId: '999'
  });
  assert.ok(block.includes('去喝酒了（接上条）') || /甲（接上条）：去喝酒了/.test(block));
  assert.ok(/乙：哈哈/.test(block));
});

test('系统提示包含连续消息合并规则', () => {
  const prompt = buildSystemPrompt({ persona: DEFAULT_CONFIG.persona });
  assert.ok(prompt.includes('【连续消息：先合并理解再回】'));
  assert.ok(prompt.includes('先合并理解整体意思'));
});
