// 每日长期记忆存储：schema、去重、merge/supersede、隐私召回、巩固衰减。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-daily-memory-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用 */ } });

const { DailyMemoryStore } = await import('../src/memory/daily-memory-store.js');

const DAY = 86400000;
let clock = 1_700_000_000_000;
const now = () => clock;
const file = path.join(dataDir, 'memory', 'daily-memory.sqlite');

function makeStore(overrides = {}) {
  return new DailyMemoryStore({
    file,
    now,
    config: {
      memory: { visibility: { mode: 'global', hidePrivateInGroup: false } },
      dailyMemory: {
        enabled: true,
        minConfidence: 0.3,
        human: {
          enabled: true,
          gistDetailDays: 30,
          transientMaxDays: 7,
          tauBaseDays: 14,
          ...overrides
        }
      }
    }
  });
}

let store;
before(() => { store = makeStore(); });
after(() => { store?.close(); });

test('applyExtraction：创建约定/知识/人物事实/秘密，并按 privacy 过滤', () => {
  const result = {
    entries: [
      {
        operation: 'create', kind: 'convention', subject: '暗号',
        abstract: '本群暗号是菠萝', content: '以后说菠萝就是开黑邀请',
        importance: 5, confidence: 0.95,
        privacy: { scope_guess: 'chat', confidence: 0.9, reason: '群内约定' }
      },
      {
        operation: 'create', kind: 'fact', subject: '农',
        abstract: '农在游戏语境里指王者荣耀', content: '群友讨论时提到农就是王者荣耀',
        importance: 3, confidence: 0.9,
        privacy: { scope_guess: 'knowledge', confidence: 0.9, reason: '游戏黑话' }
      },
      {
        operation: 'create', kind: 'person_fact', subject: '过敏',
        abstract: '小明对花生过敏', content: '10001 说他对花生过敏',
        importance: 4, confidence: 0.9, userId: '10001',
        privacy: { scope_guess: 'person', subject_user_id: '10001', confidence: 0.9 }
      },
      {
        operation: 'create', kind: 'fact', subject: '秘密',
        abstract: '别告诉别人，我下周做手术', content: '10001 私聊说的',
        importance: 3, confidence: 0.9, userId: '10001',
        privacy: { scope_guess: 'knowledge', confidence: 0.9 }
      }
    ]
  };
  const counts = store.applyExtraction('private:10001', result, { sourceDate: '2026-10-01', now: clock });
  assert.equal(counts.created, 4);
  const entries = store.listEntries({ chatKey: 'private:10001', limit: 20 });
  assert.equal(entries.length, 4);
  const bySubject = Object.fromEntries(entries.map((entry) => [entry.subject, entry]));
  assert.equal(bySubject['暗号'].fidelity, 'verbatim');
  assert.equal(bySubject['暗号'].privacyScope, 'chat');
  assert.equal(bySubject['农'].privacyScope, 'knowledge');
  assert.equal(bySubject['农'].usableIn, 'global');
  assert.equal(bySubject['过敏'].privacyScope, 'person');
  assert.equal(bySubject['秘密'].privacyScope, 'secret');
});

test('召回：群聊能用 knowledge，不能看 secret；person 只在当事人相关时召回', () => {
  const groupRecall = store.recall({
    chatKey: 'group:1', relevantUserIds: [], query: '农 王者荣耀', record: false
  });
  assert.ok(groupRecall.some((entry) => entry.subject === '农'));
  assert.ok(!groupRecall.some((entry) => entry.subject === '秘密'));

  const personOff = store.recall({ chatKey: 'group:1', relevantUserIds: [], query: '花生', record: false });
  assert.ok(!personOff.some((entry) => entry.subject === '过敏'));

  const personOn = store.recall({
    chatKey: 'group:1', relevantUserIds: ['10001'], query: '花生', record: false
  });
  assert.ok(personOn.some((entry) => entry.subject === '过敏'));
});

test('群聊召回包含本群固定约定，但不包含其他群的约定', () => {
  store.applyExtraction('group:1', {
    entries: [{
      operation: 'create', kind: 'convention', subject: '开黑',
      abstract: '本群周六开黑', importance: 4, confidence: 0.9,
      privacy: { scope_guess: 'chat', confidence: 0.9 }
    }]
  }, { sourceDate: '2026-10-01', now: clock });
  const inGroup = store.recall({ chatKey: 'group:1', query: '', record: false });
  assert.ok(inGroup.some((entry) => entry.abstract.includes('周六开黑')));
  const otherGroup = store.recall({ chatKey: 'group:2', query: '', record: false });
  assert.ok(!otherGroup.some((entry) => entry.abstract.includes('周六开黑')));
});

test('重复 create 只 touch，不新增行；seenCount 增加', () => {
  const item = {
    operation: 'create', kind: 'fact', subject: '重复测试',
    abstract: '这是一条重复测试', content: '', importance: 3, confidence: 0.9,
    privacy: { scope_guess: 'chat', confidence: 0.9 }
  };
  store.applyExtraction('group:1', { entries: [item] }, { sourceDate: '2026-10-01', now: clock });
  const once = store.listEntries({ chatKey: 'group:1', limit: 50 });
  store.applyExtraction('group:1', { entries: [item] }, { sourceDate: '2026-10-01', now: clock });
  const twice = store.listEntries({ chatKey: 'group:1', limit: 50 });
  assert.equal(twice.length, once.length);
  const hit = twice.find((entry) => entry.subject === '重复测试');
  assert.equal(hit.seenCount, 2);
});

test('supersede：旧条目不再召回，新值生效，版本历史保留', () => {
  const old = store.listEntries({ chatKey: 'group:1', kind: 'convention', limit: 10 })
    .find((entry) => entry.subject === '开黑');
  assert.ok(old);
  const counts = store.applyExtraction('group:1', {
    entries: [{
      operation: 'supersede', targetId: old.id, kind: 'convention', subject: '开黑',
      abstract: '本群周日开黑', importance: 5, confidence: 0.95,
      privacy: { scope_guess: 'chat', confidence: 0.9 }
    }]
  }, { sourceDate: '2026-10-02', now: clock });
  assert.equal(counts.superseded, 1);
  const recalled = store.recall({ chatKey: 'group:1', query: '开黑', record: false });
  assert.ok(recalled.some((entry) => entry.abstract.includes('周日开黑')));
  assert.ok(!recalled.some((entry) => entry.abstract.includes('周六开黑')));
  const oldRow = store.listEntries({ chatKey: 'group:1', status: 'superseded', limit: 10 })
    .find((entry) => entry.id === old.id);
  assert.ok(oldRow);
});

test('合并不能把 secret 自动放宽为 knowledge', () => {
  const secret = store.listEntries({ chatKey: 'private:10001', privacyScope: 'secret', limit: 10 })
    .find((entry) => entry.subject === '秘密');
  assert.ok(secret);
  store.applyExtraction('private:10001', {
    entries: [{
      operation: 'merge', targetId: secret.id, kind: 'fact', subject: '秘密',
      abstract: '别告诉别人，我下周做手术，已经安排好了', importance: 4, confidence: 0.9,
      privacy: { scope_guess: 'knowledge', confidence: 0.95 }
    }]
  }, { sourceDate: '2026-10-02', now: clock });
  const merged = store.listEntries({ chatKey: 'private:10001', privacyScope: 'secret', limit: 10 })
    .find((entry) => entry.id === secret.id);
  assert.ok(merged);
  assert.equal(merged.privacyScope, 'secret');
  assert.equal(merged.version, 2);
});

test('巩固：gist 细节到期清空，transient 到期淡出，verbatim 保留', () => {
  clock += 31 * DAY;
  const beforeConvention = store.listEntries({ chatKey: 'group:1', kind: 'convention', limit: 10 })
    .find((entry) => entry.abstract.includes('周日开黑'));
  const counts = store.consolidate({ now: clock });
  assert.ok(counts.detailFaded >= 1);
  const convention = store.listEntries({ chatKey: 'group:1', kind: 'convention', limit: 10 })
    .find((entry) => entry.id === beforeConvention.id);
  assert.equal(convention.fidelity, 'verbatim');
  assert.ok(convention.content.length > 0, 'verbatim 的 content 不应被清空');

  const faded = store.listEntries({ chatKey: 'group:1', status: 'faded', limit: 20 });
  assert.ok(faded.length >= 0);
});

test('formatForPrompt：固定约定 + 模糊/只用不说标记', () => {
  const text = store.formatForPrompt('group:1', {
    relevantUserIds: ['10001'], query: '开黑 花生', now: clock
  });
  assert.match(text, /【长期记忆】/);
  assert.match(text, /约定：/);
  assert.match(text, /模糊|只用不说/);
});

test('listVersions 能查到 supersede 前的版本', () => {
  const old = store.listEntries({ chatKey: 'group:1', status: 'superseded', limit: 10 })[0];
  assert.ok(old);
  const versions = store.listVersions(old.id);
  assert.ok(versions.length >= 1);
  assert.ok(versions[0].abstract);
});

test('pin / privacy / forget / listChats / recall log', () => {
  const entry = store.listEntries({ chatKey: 'group:1', status: '', limit: 50 })
    .find((item) => item.subject === '重复测试');
  assert.ok(entry);

  const pinned = store.pinEntry(entry.id);
  assert.equal(pinned.fidelity, 'verbatim');
  assert.ok(pinned.content.length > 0);

  assert.throws(
    () => store.setEntryPrivacy(entry.id, { privacyScope: 'person' }),
    /subjectUserId/
  );
  const adjusted = store.setEntryPrivacy(entry.id, {
    privacyScope: 'person', subjectUserId: '10001', reason: '管理员调整'
  });
  assert.equal(adjusted.privacyScope, 'person');
  assert.equal(adjusted.usableIn, 'person');
  assert.equal(adjusted.disclosable, false);
  assert.equal(adjusted.classifiedBy, 'manual');

  const chats = store.listChats();
  assert.ok(chats.some((chat) => chat.chatKey === 'group:1' && chat.total >= 1));
  assert.ok(Array.isArray(store.listRecallLog({ limit: 10 })));

  assert.equal(store.forgetEntry(entry.id), true);
  assert.equal(store.getEntry(entry.id).status, 'deleted');
  assert.ok(!store.listEntries({ chatKey: 'group:1', status: 'active', limit: 50 })
    .some((item) => item.id === entry.id));
});

test('lookup：按关键词查摘要，默认不返回 content', () => {
  const found = store.lookup({
    chatKey: 'group:1', query: '开黑', relevantUserIds: [], record: false
  });
  assert.ok(found.some((entry) => entry.subject === '开黑'));
  assert.ok(found.every((entry) => entry.content === ''));

  const person = store.lookup({
    chatKey: 'group:1', query: '花生', userId: '10001', relevantUserIds: ['10001'], record: false
  });
  assert.ok(person.some((entry) => entry.subject === '过敏'));

  const withContent = store.lookup({
    chatKey: 'group:1', query: '花生', userId: '10001', relevantUserIds: ['10001'],
    includeContent: true, record: false
  });
  assert.ok(withContent.every((entry) => entry.content === '' || entry.fidelity !== 'gist'));
});

test('stats 能给出状态/保真度/隐私分布', () => {
  const stats = store.stats();
  assert.ok(stats.total >= 4);
  assert.ok(stats.active >= 1);
  assert.ok(stats.byFidelity.verbatim >= 1);
  assert.ok(stats.byPrivacy.knowledge >= 1);
});

test('pruneRetention 物理删除超过保留期的软删除条目', () => {
  const deleted = store.listEntries({ status: 'deleted', limit: 10 })[0];
  assert.ok(deleted);
  clock += 200 * DAY;
  const result = store.pruneRetention({ now: clock, retentionDays: 180 });
  assert.ok(result.entries >= 1);
  assert.equal(store.getEntry(deleted.id), null);
});

test('数据库关闭后 formatForPrompt 返回空串而不是把异常抛进聊天', () => {
  const isolated = makeStore();
  isolated.close();
  assert.equal(isolated.formatForPrompt('group:1'), '');
});
