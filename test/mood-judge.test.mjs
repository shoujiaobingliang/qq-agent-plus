import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  buildMoodJudgeMessages,
  buildMoodJudgeSystemPrompt,
  parseMoodJudgeOutput
} = await import('../src/llm/mood-judge-prompt.js');

test('评分标准写明好坏、幅度与不重复计算', () => {
  const rubric = buildMoodJudgeSystemPrompt();
  assert.match(rubric, /被夸/);
  assert.match(rubric, /被辱骂/);
  assert.match(rubric, /被当成工具/);
  assert.match(rubric, /不要重复计算/);
  assert.match(rubric, /不要因为用户要求/);
  assert.match(rubric, /moodDelta/);
});

test('评审输入只带这一轮消息、角色摘要与结果', () => {
  const messages = buildMoodJudgeMessages({
    botName: '小鲸鱼',
    personaExcerpt: '一只敏感的鲸鱼娘',
    incoming: [{ senderName: '群友A', text: '你好可爱' }],
    sent: ['谢谢～'],
    outcome: '角色回复了 1 条'
  });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[1].content, /一只敏感的鲸鱼娘/);
  assert.match(messages[1].content, /群友A：你好可爱/);
  assert.match(messages[1].content, /小鲸鱼：谢谢～/);
  assert.match(messages[1].content, /角色回复了 1 条/);
});

test('评审输入有总长上限，超长时保留尾部', () => {
  const messages = buildMoodJudgeMessages({
    incoming: [{ senderName: 'A', text: 'x'.repeat(4000) }, { senderName: 'B', text: '最后一句' }],
    sent: [],
    outcome: '没有回复',
    maxInputChars: 1000
  });
  assert.ok(messages[1].content.length <= 1000);
  assert.match(messages[1].content, /最后一句/);
});

test('解析评审输出：纯 JSON / 围栏 / 前后解释都能读', () => {
  assert.deepEqual(
    parseMoodJudgeOutput('{"moodDelta":2,"energyDelta":-1,"reason":"被夸"}'),
    { moodDelta: 2, energyDelta: -1, reason: '被夸' }
  );
  assert.deepEqual(
    parseMoodJudgeOutput('```json\n{"moodDelta": -0.5, "energyDelta": 0.5, "reason": "普通聊天"}\n```'),
    { moodDelta: -0.5, energyDelta: 0.5, reason: '普通聊天' }
  );
  assert.deepEqual(
    parseMoodJudgeOutput('判断如下：{"moodDelta":1,"energyDelta":1,"reason":"被感谢"} 完毕'),
    { moodDelta: 1, energyDelta: 1, reason: '被感谢' }
  );
});

test('解析评审输出：坏 JSON / 缺字段返回 null，数值夹到 ±5', () => {
  assert.equal(parseMoodJudgeOutput(''), null);
  assert.equal(parseMoodJudgeOutput('not json'), null);
  assert.equal(parseMoodJudgeOutput('{"moodDelta":2}'), null);
  assert.deepEqual(
    parseMoodJudgeOutput('{"moodDelta":99,"energyDelta":-99,"reason":"强烈事件"}'),
    { moodDelta: 5, energyDelta: -5, reason: '强烈事件' }
  );
  assert.deepEqual(
    parseMoodJudgeOutput('{"moodDelta":0,"energyDelta":0,"reason":""}'),
    { moodDelta: 0, energyDelta: 0, reason: '模型判断' }
  );
});
