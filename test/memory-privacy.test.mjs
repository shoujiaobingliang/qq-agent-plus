// 记忆隐私：作用域归一化、规则拦截、可用范围/可披露性、召回硬过滤。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decidePrivacy,
  detectPersonalIdentifiers,
  detectSecretSignals,
  disclosureLabel,
  isRecallVisible,
  normalizePrivacyConfig
} from '../src/memory/memory-privacy.js';

const context = { chatKey: 'group:1', relevantUserIds: ['10001'], mentionedUserIds: [] };

test('规则层：凭据/明确私密标记/手机号 → secret', () => {
  for (const text of [
    '我的登录密码是 abc123',
    'API_KEY 是 sk-abcdefghijklmnop',
    '别告诉别人，我这周不去',
    '我手机号 13800138000'
  ]) {
    assert.ok(detectSecretSignals(text).length > 0, text);
    const record = decidePrivacy({ abstract: text, kind: 'fact', guess: { scope_guess: 'knowledge', confidence: 0.95 } });
    assert.equal(record.privacyScope, 'secret');
    assert.equal(record.usableIn, 'source');
    assert.equal(record.disclosable, false);
  }
});

test('群暗号/群密码不按凭据拦截：没有初判时默认只在本群可用', () => {
  const record = decidePrivacy({ abstract: '本群暗号是菠萝', kind: 'convention' });
  assert.equal(record.privacyScope, 'chat');
  assert.equal(record.usableIn, 'chat');
  assert.equal(record.disclosable, false);
});

test('私聊学到的通用知识：knowledge / global / 可披露', () => {
  const record = decidePrivacy({
    abstract: '农在游戏语境里指王者荣耀',
    kind: 'fact',
    guess: { scope_guess: 'knowledge', confidence: 0.9, reason: '游戏语境黑话，无人名' }
  });
  assert.equal(record.privacyScope, 'knowledge');
  assert.equal(record.usableIn, 'global');
  assert.equal(record.disclosable, true);
  assert.equal(record.classificationConfidence, 0.9);
});

test('knowledge 含个人标识 → 降为 person；没有 subject 则 secret', () => {
  const noSubject = decidePrivacy({
    abstract: '小明的QQ是10001，他常打王者',
    kind: 'fact',
    guess: { scope_guess: 'knowledge', confidence: 0.9 }
  });
  assert.equal(noSubject.privacyScope, 'secret');

  const withSubject = decidePrivacy({
    abstract: '小明的QQ是10001，他常打王者',
    kind: 'person_fact',
    subjectUserId: '10001',
    guess: { scope_guess: 'knowledge', confidence: 0.9, subject_user_id: '10001' }
  });
  assert.equal(withSubject.privacyScope, 'person');
  assert.equal(withSubject.subjectUserId, '10001');
  assert.equal(withSubject.disclosable, false);
});

test('person 必须有有效 subject_user_id，否则 secret', () => {
  const record = decidePrivacy({
    abstract: '小明对花生过敏',
    kind: 'person_fact',
    guess: { scope_guess: 'person', confidence: 0.9 }
  });
  assert.equal(record.privacyScope, 'secret');
});

test('低置信度 → secret，即使模型说 knowledge', () => {
  const record = decidePrivacy({
    abstract: '农指王者荣耀',
    kind: 'fact',
    guess: { scope_guess: 'knowledge', confidence: 0.2 }
  });
  assert.equal(record.privacyScope, 'secret');
});

test('“别告诉别人”即使模型判 knowledge 也强制 secret', () => {
  const record = decidePrivacy({
    abstract: '别告诉别人，农在这个群里指王者荣耀',
    kind: 'fact',
    guess: { scope_guess: 'knowledge', confidence: 0.99 }
  });
  assert.equal(record.privacyScope, 'secret');
});

test('detectPersonalIdentifiers 能识别手机号/邮箱/QQ', () => {
  assert.deepEqual([...new Set(detectPersonalIdentifiers('电话 13800138000 邮箱 a@b.com QQ 10001'))].sort(),
    ['email', 'phone', 'qq-or-account']);
});

test('normalizePrivacyConfig 夹取并给默认值', () => {
  assert.deepEqual(normalizePrivacyConfig({ minClassificationConfidence: 9 }), {
    minClassificationConfidence: 0.95,
    allowKnowledgeAcrossChats: true,
    personUsableWhenAbsent: false,
    visibilityMode: 'global',
    hidePrivateInGroup: false
  });
});

test('召回硬过滤：私聊 knowledge 可在群聊用，secret 不行', () => {
  const knowledge = {
    chatKey: 'private:10001', privacyScope: 'knowledge', usableIn: 'global', disclosable: true, status: 'active'
  };
  const secret = {
    chatKey: 'private:10001', privacyScope: 'secret', usableIn: 'source', disclosable: false, status: 'active'
  };
  assert.equal(isRecallVisible(knowledge, context), true);
  assert.equal(isRecallVisible(secret, context), false);
});

test('召回硬过滤：chat 只在来源群，person 只在当事人相关时', () => {
  const chatA = { chatKey: 'group:1', privacyScope: 'chat', usableIn: 'chat', status: 'active' };
  assert.equal(isRecallVisible(chatA, { chatKey: 'group:1' }), true);
  assert.equal(isRecallVisible(chatA, { chatKey: 'group:2' }), false);

  const person = {
    chatKey: 'private:10001', privacyScope: 'person', usableIn: 'person',
    subjectUserId: '10001', status: 'active'
  };
  assert.equal(isRecallVisible(person, context), true);
  assert.equal(isRecallVisible(person, { chatKey: 'group:2', relevantUserIds: [] }), false);
  assert.equal(isRecallVisible(person, { chatKey: 'group:2', relevantUserIds: [], mentionedUserIds: ['10001'] }), false);
  assert.equal(isRecallVisible(person, { chatKey: 'group:2', relevantUserIds: [], mentionedUserIds: ['10001'] }, {
    privacy: { personUsableWhenAbsent: true }
  }), true);
});

test('召回硬过滤：旧 visibility 作为全局下限', () => {
  const knowledge = {
    chatKey: 'private:10001', privacyScope: 'knowledge', usableIn: 'global', status: 'active'
  };
  assert.equal(isRecallVisible(knowledge, context, { visibility: { hidePrivateInGroup: true } }), false);
  assert.equal(isRecallVisible(knowledge, context, { visibility: { mode: 'perChat' } }), false);
  assert.equal(isRecallVisible(knowledge, context, {
    privacy: { allowKnowledgeAcrossChats: false }
  }), false);
});

test('disclosureLabel：knowledge 不标，其它标“只用不说”，secret 标仅本会话', () => {
  assert.equal(disclosureLabel({ privacyScope: 'knowledge', disclosable: true }), '');
  assert.equal(disclosureLabel({ privacyScope: 'person', disclosable: false }), '（只用不说）');
  assert.equal(disclosureLabel({ privacyScope: 'secret', disclosable: false }), '（仅本会话）');
});
