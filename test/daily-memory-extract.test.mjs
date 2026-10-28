// 每日记忆抽取：消息抽样、提示词、模型输出校验。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildExistingForDedup,
  buildExtractionPrompt,
  parseExtractionResult,
  renderTranscriptMessage,
  selectTranscriptMessages
} from '../src/memory/daily-memory-extract.js';

const base = 1_700_000_000_000;
function message(id, text, extra = {}) {
  return {
    id,
    ts: base + id * 60_000,
    senderId: '10001',
    senderName: '小明',
    text,
    self: false,
    eventKind: 'message',
    ...extra
  };
}

test('renderTranscriptMessage：带 #id、时间、显示名与正文', () => {
  const line = renderTranscriptMessage(message(7, '本群暗号是菠萝'));
  assert.match(line, /^#7 \[\d{2}-\d{2} \d{2}:\d{2}\] 小明\(10001\): 本群暗号是菠萝$/);
  assert.equal(renderTranscriptMessage(message(8, '   ')), '');
});

test('selectTranscriptMessages：保留最近一半，优先保留含约定的老消息', () => {
  const list = [
    message(1, '闲聊一'), message(2, '以后记住暗号是菠萝'), message(3, '闲聊二'),
    message(4, '闲聊三'), message(5, '闲聊四'), message(6, '闲聊五'),
    message(7, '闲聊六'), message(8, '闲聊七')
  ];
  const selected = selectTranscriptMessages(list, { maxMessages: 4, maxChars: 10000 });
  const ids = selected.messages.map((item) => item.id);
  assert.deepEqual(ids, [1, 2, 7, 8]);
  assert.equal(selected.omitted, 4);
});

test('buildExistingForDedup 截断并只保留去重需要的字段', () => {
  const existing = buildExistingForDedup([
    { id: 3, kind: 'convention', subject: '暗号', abstract: '群暗号是菠萝', content: 'x' },
    { id: 4, kind: 'fact', subject: '农', abstract: '农指王者荣耀' }
  ], 1);
  assert.deepEqual(existing, [{ id: 3, kind: 'convention', subject: '暗号', abstract: '群暗号是菠萝' }]);
});

test('buildExtractionPrompt 包含已有记忆与聊天记录', () => {
  const messages = [message(1, '本群暗号是菠萝'), message(2, '周六开黑')];
  const prompt = buildExtractionPrompt({
    chatKey: 'group:1', chatName: '测试群', day: '2026-10-01', messages,
    existing: [{ id: 9, kind: 'convention', subject: '暗号', abstract: '群暗号是菠萝' }]
  });
  assert.equal(prompt.length, 2);
  assert.match(prompt[0].content, /长期记忆抽取器/);
  assert.match(prompt[1].content, /id=9 \[convention\] 暗号: 群暗号是菠萝/);
  assert.match(prompt[1].content, /#1 .*本群暗号是菠萝/);
});

test('parseExtractionResult：合法条目通过，delete/skip/坏 kind/低置信度/未知 target 丢弃', () => {
  const raw = JSON.stringify({
    summary: { overview: '群里定了暗号', summary: '- 约定：暗号菠萝' },
    entries: [
      {
        operation: 'create', scope: 'chat', kind: 'convention', subject: '暗号',
        abstract: '群暗号是菠萝', content: '以后说菠萝就是开黑邀请', importance: 5,
        confidence: 0.95, keywords: ['暗号', '菠萝'], evidence_message_ids: [1, 999]
      },
      { operation: 'delete', kind: 'fact', subject: 'x', abstract: '删除我' },
      { operation: 'skip', kind: 'fact', subject: 'x', abstract: '跳过' },
      { operation: 'create', kind: 'unknown', subject: 'x', abstract: '坏类型' },
      { operation: 'create', kind: 'fact', subject: 'x', abstract: '低置信度', confidence: 0.1 },
      { operation: 'merge', targetId: 404, kind: 'fact', subject: 'x', abstract: '目标不存在' },
      {
        operation: 'create', scope: 'person', kind: 'person_fact', subject: '过敏',
        abstract: '小明对花生过敏', importance: 4, confidence: 0.9, userId: '10001'
      }
    ]
  });
  const result = parseExtractionResult(raw, {
    messageIds: [1, 2], existing: [{ id: 9 }], config: { minConfidence: 0.4 }
  });
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].abstract, '群暗号是菠萝');
  assert.deepEqual(result.entries[0].evidence_message_ids, ['1']);
  assert.equal(result.entries[1].scope, 'person');
  assert.equal(result.entries[1].userId, '10001');
  assert.ok(result.rejected.length >= 3);
});

test('parseExtractionResult：支持围栏 JSON 与尾逗号修复', () => {
  const raw = '```json\n{"summary":{"overview":"x"},"entries":[{"operation":"create","kind":"fact","subject":"农","abstract":"农指王者荣耀",},]}\n```';
  const result = parseExtractionResult(raw, { config: { minConfidence: 0.4 } });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].subject, '农');
});

test('parseExtractionResult：person 缺少 userId 被丢弃，隐私初判缺省按 kind 保守回落', () => {
  const raw = JSON.stringify({
    entries: [
      { operation: 'create', scope: 'person', kind: 'person_fact', subject: '生日', abstract: '5 月 20 日', confidence: 0.9 },
      { operation: 'create', scope: 'chat', kind: 'fact', subject: '农', abstract: '农指王者荣耀', confidence: 0.9 }
    ]
  });
  const result = parseExtractionResult(raw);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].privacy.scope_guess, 'chat');
});

test('parseExtractionResult：同批次重复只留一条', () => {
  const raw = JSON.stringify({
    entries: [
      { operation: 'create', kind: 'fact', subject: '农', abstract: '农指王者荣耀', confidence: 0.9 },
      { operation: 'create', kind: 'fact', subject: '农', abstract: '农指王者荣耀', confidence: 0.9 }
    ]
  });
  const result = parseExtractionResult(raw);
  assert.equal(result.entries.length, 1);
  assert.equal(result.rejected.at(-1).reason, '同批次重复');
});
