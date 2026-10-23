import assert from 'node:assert/strict';
import { test } from 'node:test';

const { buildImpressionPromptBlock } = await import('../src/llm/impression-prompt.js');
const { VicePersona } = await import('../src/llm/vice-persona.js');

const cfg = { lowThreshold: 30, highThreshold: 80 };

test('印象提示词：低分冷淡/怼，高分愿意分享，副人格可用时给出工具提示', () => {
  const block = buildImpressionPromptBlock({
    scores: [
      { userId: '1', name: '阿三', score: 8 },
      { userId: '2', name: '小李', score: 92 }
    ],
    cfg,
    vice: { eligible: true, userId: '1', name: '阿三', score: 8 }
  });
  assert.match(block, /阿三：8\/100/);
  assert.match(block, /已读不回/);
  assert.match(block, /小李：92\/100/);
  assert.match(block, /主动分享/);
  assert.match(block, /vice_persona/);
  assert.match(block, /不攻击外貌\/身份\/家人/);
});

test('印象提示词：没有低/高分时不输出', () => {
  assert.equal(buildImpressionPromptBlock({ scores: [{ score: 50, name: 'A' }], cfg }), '');
});

test('副人格会话：先喂人设，再按需送上下文并保留会话', async () => {
  const seen = [];
  const complete = async ({ messages }) => {
    seen.push(messages);
    return { message: { content: `回复${seen.length}` } };
  };
  const actor = new VicePersona({
    roleText: '你是嘴臭贴吧姐姐',
    complete,
    maxHistoryMessages: 6
  });
  assert.match(actor.messages[0].content, /安全边界/);
  assert.match(actor.messages[1].content, /嘴臭贴吧姐姐/);

  const first = await actor.reply('A：你真菜');
  assert.equal(first.text, '回复1');
  assert.match(seen[0].at(-1).content, /A：你真菜/);

  const second = await actor.reply('A：急了急了');
  assert.equal(second.text, '回复2');
  assert.ok(seen[1].length > seen[0].length, '第二轮带着上一轮会话');
  assert.ok(actor.messages.length <= 3 + 6);

  actor.reset();
  assert.equal(actor.messages.length, 3);
});
