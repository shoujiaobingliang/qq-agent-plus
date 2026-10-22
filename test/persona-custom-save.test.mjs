// 编辑自定义角色卡：保存时写回卡库里的同一张卡，不新增“额外的自定义卡”。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { customPersonaCardsPatch } = await import('../ui/pages/persona-custom.js');

const cards = [
  { name: '内置复制', text: '旧正文', behaviorProfile: 'legacy', customRules: '旧规则' },
  { name: '另一张', text: '另一张正文', behaviorProfile: 'grounded' }
];

test('custom_x：写回同一张卡，保留名称并更新正文/档位/附加规则', () => {
  const next = customPersonaCardsPatch(cards, 'custom_0', {
    text: '新正文',
    customRules: '新规则',
    behaviorProfile: 'grounded'
  });
  assert.ok(Array.isArray(next));
  assert.equal(next.length, 2, '不新增卡');
  assert.equal(next[0].name, '内置复制', '名称不变');
  assert.equal(next[0].text, '新正文');
  assert.equal(next[0].behaviorProfile, 'grounded');
  assert.equal(next[0].customRules, '新规则');
  assert.equal(next[1], cards[1], '其他卡原样保留');
  assert.equal(cards[0].text, '旧正文', '不修改传入数组');
});

test('附加规则清空：卡上的旧规则一并删掉', () => {
  const next = customPersonaCardsPatch(cards, 'custom_0', {
    text: '新正文',
    customRules: '   ',
    behaviorProfile: 'legacy'
  });
  assert.equal('customRules' in next[0], false);
});

test('不是自定义卡 / 索引不存在 / 正文为空：返回 null，不误写卡', () => {
  assert.equal(customPersonaCardsPatch(cards, 'xiaojingyu', { text: 'x' }), null);
  assert.equal(customPersonaCardsPatch(cards, '', { text: 'x' }), null);
  assert.equal(customPersonaCardsPatch(cards, 'custom_9', { text: 'x' }), null);
  assert.equal(customPersonaCardsPatch(cards, 'custom_0', { text: '   ' }), null);
  assert.equal(customPersonaCardsPatch(null, 'custom_0', { text: 'x' }), null);
});
