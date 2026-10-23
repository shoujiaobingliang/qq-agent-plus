import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  normalizeVicePersonaId,
  primaryPersonaSet,
  resolveVicePersona,
  vicePersonaCards
} = await import('../src/llm/vice-personas.js');

const base = {
  persona: {
    roleText: '主人格正文',
    templateId: '',
    vicePersonaId: 'tieba',
    vicePersonas: [{ id: 'tieba', name: 'tieba', roleText: '' }]
  }
};

test('主人格未设置时不允许副人格', () => {
  assert.equal(primaryPersonaSet({ persona: { roleText: '', templateId: '' } }), false);
  assert.equal(resolveVicePersona({ ...base, persona: { ...base.persona, roleText: '', templateId: '' } }), null);
});

test('默认副人格卡是空白 tieba；旧毒舌/嘴臭映射到 tieba', () => {
  assert.equal(normalizeVicePersonaId('毒舌'), 'tieba');
  assert.equal(normalizeVicePersonaId('duzui'), 'tieba');
  assert.equal(normalizeVicePersonaId('toxic'), 'tieba');
  const card = resolveVicePersona(base);
  assert.equal(card.id, 'tieba');
  assert.equal(card.roleText, '', '默认是空白卡，内容由管理员补充');
});

test('主人设指针指向自定义副人格卡', () => {
  const custom = {
    persona: {
      ...base.persona,
      vicePersonaId: 'custom',
      vicePersonas: [
        { id: 'tieba', name: 'tieba', roleText: '' },
        { id: 'custom', name: '自定义姐姐', roleText: '你是一个自定义副人格' }
      ]
    }
  };
  const card = resolveVicePersona(custom);
  assert.equal(card.id, 'custom');
  assert.equal(card.name, '自定义姐姐');
  assert.equal(card.roleText, '你是一个自定义副人格');
});

test('副人格卡列表包含默认 tieba 与自定义卡', () => {
  const cards = vicePersonaCards({
    persona: {
      vicePersonas: [
        { id: 'custom', name: '自定义', roleText: '正文' },
        { id: 'tieba', name: '重复', roleText: '应当被跳过' }
      ]
    }
  });
  assert.deepEqual(cards.map((card) => card.id), ['custom', 'tieba']);
});
