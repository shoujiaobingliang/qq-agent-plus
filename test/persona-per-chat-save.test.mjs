// 按群人设保存语义的行为用例（纯函数，不搭 DOM）。
//
// 换卡时哪些字段该清、哪些该留，靠字符串断言测不出来：上一轮实现就是"看起来删了 roleText"
// 但漏了 templateId，导致选了自定义卡仍用旧内置卡的正文。这里逐序列钉住。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { buildPerChatPatch, perChatOptions } = await import('../ui/pages/persona-per-chat.js');

const templates = [
  ['xiaojingyu', { name: '小鲸鱼', text: '鲸鱼正文', behaviorProfile: 'legacy', builtin: true }],
  ['tsundere_loli', { name: '傲娇萝莉', text: '傲娇正文', behaviorProfile: 'legacy', builtin: true }],
  ['custom_0', {
    name: '自定义A', text: '自定义A正文', behaviorProfile: 'grounded', customRules: 'A 的规则', builtin: false
  }],
  ['custom_1', {
    name: '自定义B', text: '自定义B正文', behaviorProfile: 'legacy', builtin: false
  }]
];

const save = (value, current = {}, key = 'group:123') => buildPerChatPatch([{ key, value }], current, templates);

test('内置卡 → 自定义卡：旧 templateId 必须清掉（否则卡文件正文会盖住自定义正文）', () => {
  const out = save('custom:custom_0', { 'group:123': { templateId: 'tsundere_loli' } });
  assert.deepEqual(out['group:123'], { roleText: '自定义A正文', behaviorProfile: 'grounded', customRules: 'A 的规则' });
});

test('自定义卡 → 内置卡：正文/档位/卡自带规则都要清掉，档位由新卡决定', () => {
  const out = save('builtin:tsundere_loli', {
    'group:123': { roleText: '自定义A正文', behaviorProfile: 'grounded', customRules: 'A 的规则' }
  });
  assert.deepEqual(out['group:123'], { templateId: 'tsundere_loli' });
});

test('内置卡 A → 内置卡 B：显式档位/规则随卡切换，实例级偏好（名字/参与度）保留', () => {
  const out = save('builtin:xiaojingyu', {
    'group:123': { templateId: 'tsundere_loli', behaviorProfile: 'grounded', customRules: '旧规则', botName: '猫猫', participation: 'high' }
  });
  assert.deepEqual(out['group:123'], { botName: '猫猫', participation: 'high', templateId: 'xiaojingyu' });
});

test('改回跟随全局：整条删除', () => {
  assert.deepEqual(save('', { 'group:123': { templateId: 'tsundere_loli' } }), {});
});

test('同卡重复保存：不带旧 changedAt（时间戳由服务端维护）', () => {
  const out = save('builtin:tsundere_loli', { 'group:123': { templateId: 'tsundere_loli', changedAt: 111 } });
  assert.deepEqual(out['group:123'], { templateId: 'tsundere_loli' });
});

test('同一张内置卡重复保存：该群手改的规则与显式档位不能被删掉', () => {
  const old = {
    templateId: 'tsundere_loli',
    behaviorProfile: 'grounded',
    customRules: '这个群人比较正经，少开玩笑',
    botName: '猫猫'
  };
  assert.deepEqual(save('builtin:tsundere_loli', { 'group:123': old }), { 'group:123': old });
});

test('同一张自定义卡重复保存：手改的附加规则保留', () => {
  const old = {
    roleText: '自定义A正文',
    behaviorProfile: 'grounded',
    customRules: '本群只聊技术',
    participation: 'low'
  };
  assert.deepEqual(save('custom:custom_0', { 'group:123': old }), { 'group:123': old });
});

test('换到另一张自定义卡：旧卡的手改规则随旧卡一起清掉', () => {
  const out = save('custom:custom_1', {
    'group:123': { roleText: '自定义A正文', behaviorProfile: 'grounded', customRules: 'A 的旧规则' }
  });
  assert.deepEqual(out['group:123'], { roleText: '自定义B正文', behaviorProfile: 'legacy' });
});

test('只有实例级字段的旧条目：给「保持」项，保存时原样保留', () => {
  const entry = { participation: 'low', botName: '阿猫' };
  const options = perChatOptions(entry, templates);
  assert.match(options, /value="keep" selected/, '界面表达不了就必须提供保持项');
  assert.equal(perChatOptions(undefined, templates).includes('value="keep"'), false, '没有覆盖时不该出现保持项');
  assert.deepEqual(save('keep', { 'group:123': entry }), { 'group:123': entry });
});

test('未知卡 id 与对不上任何卡的自定义正文：给「保持」项，不被静默清掉', () => {
  assert.match(perChatOptions({ templateId: 'gone' }, templates), /value="keep" selected/);
  assert.match(perChatOptions({ roleText: '手写正文' }, templates), /value="keep" selected/);
  assert.deepEqual(save('keep', { 'group:123': { templateId: 'gone' } }), { 'group:123': { templateId: 'gone' } });
});

test('非法 chatKey 不写入；同一个 key 只保留最后一行', () => {
  const out = buildPerChatPatch([
    { key: 'group:abc', value: 'builtin:tsundere_loli' },
    { key: 'group:123', value: 'builtin:tsundere_loli' },
    { key: 'group:123', value: 'builtin:xiaojingyu' }
  ], {}, templates);
  assert.deepEqual(out, { 'group:123': { templateId: 'xiaojingyu' } });
});
