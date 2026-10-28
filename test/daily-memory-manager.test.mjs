// 每日记忆调度：单飞、幂等、失败不阻塞、启动补跑。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-daily-manager-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用 */ } });

const { DailyMemoryStore } = await import('../src/memory/daily-memory-store.js');
const { DailyMemoryManager } = await import('../src/features/daily-memory.js');

const DAY = '2026-10-01';
const dayStart = Date.parse(`${DAY}T00:00:00+08:00`);
const clock = dayStart + 12 * 3600000;
const file = path.join(dataDir, 'memory', 'daily-memory.sqlite');

function makeConfig(overrides = {}) {
  return {
    runtime: { mode: 'active', paused: false },
    allowAllWhenEmpty: true,
    allow: { groups: [], private: [] },
    deny: { groups: [], private: [] },
    memory: { visibility: { mode: 'global', hidePrivateInGroup: false } },
    dailyMemory: {
      enabled: true,
      minMessages: 1,
      minConfidence: 0.3,
      startupCatchup: false,
      human: { enabled: true },
      ...overrides
    }
  };
}

function messageStore(messagesByChat = {}) {
  return {
    listChats: () => Object.keys(messagesByChat),
    recentBetween: (chatKey, since, until, { limit = 2000 } = {}) => (messagesByChat[chatKey] || [])
      .filter((message) => message.ts >= since && message.ts < until)
      .slice(-limit)
  };
}

function msg(id, text, ts = dayStart + 3600000 + id * 1000) {
  return { id, ts, senderId: '10001', senderName: '小明', text, self: false, eventKind: 'message' };
}

const validResult = JSON.stringify({
  summary: { overview: '群里定了暗号', summary: '- 约定：暗号菠萝' },
  entries: [{
    operation: 'create', scope: 'chat', kind: 'convention', subject: '暗号',
    abstract: '群暗号是菠萝', content: '以后说菠萝就是开黑邀请', importance: 5,
    confidence: 0.95, evidence_message_ids: [1],
    privacy: { scope_guess: 'chat', confidence: 0.9 }
  }]
});

function makeManager({ cfg = makeConfig(), messages = { 'group:1': [msg(1, '本群暗号是菠萝')] }, complete, sessions = null } = {}) {
  const store = new DailyMemoryStore({
    file, now: () => clock,
    config: { memory: cfg.memory, dailyMemory: cfg.dailyMemory }
  });
  const manager = new DailyMemoryManager({
    store,
    messageStore: messageStore(messages),
    sessions,
    config: () => cfg,
    now: () => clock,
    log: () => {},
    complete: complete || (async () => ({ text: validResult, usage: { total_tokens: 10 }, model: 'fake' })),
    resolveChatName: () => '测试群'
  });
  return { store, manager };
}

let last;
after(() => last?.store?.close());

test('runOnce：抽取、写入、done 幂等', async () => {
  last = makeManager();
  const first = await last.manager.runOnce({ day: DAY });
  assert.equal(first.results[0].status, 'done');
  assert.equal(first.results[0].created, 1);
  assert.ok(last.store.listEntries({ chatKey: 'group:1', limit: 10 }).some((entry) => entry.abstract.includes('菠萝')));
  assert.equal(last.store.getJob('group:1', DAY).status, 'done');

  const second = await last.manager.runOnce({ day: DAY });
  assert.equal(second.results[0].status, 'skipped');

  const forced = await last.manager.runOnce({ day: DAY, force: true });
  assert.equal(forced.results[0].status, 'done');
  const count = last.store.listEntries({ chatKey: 'group:1', limit: 10 }).length;
  assert.equal(count, 1, '重跑不能产生重复条目');
});

test('消息不足 minMessages → empty，不调模型', async () => {
  let called = 0;
  const { store, manager } = makeManager({
    cfg: makeConfig({ minMessages: 5 }),
    messages: { 'group:1': [msg(1, '只有一条')] },
    complete: async () => { called += 1; return { text: validResult }; }
  });
  const result = await manager.runOnce({ day: DAY, force: true });
  assert.equal(result.results[0].status, 'empty');
  assert.equal(called, 0);
  assert.equal(store.getJob('group:1', DAY).status, 'empty');
  store.close();
});

test('模型失败 → failed，不抛出整轮', async () => {
  const { store, manager } = makeManager({
    complete: async () => { throw new Error('模型挂了'); }
  });
  const result = await manager.runOnce({ day: DAY, force: true });
  assert.equal(result.results[0].status, 'failed');
  const job = store.getJob('group:1', DAY);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /模型挂了/);
  store.close();
});

test('总开关关闭时默认跳过；force 可手动跑', async () => {
  const { store, manager } = makeManager({
    cfg: makeConfig({ enabled: false })
  });
  assert.deepEqual(await manager.runOnce({ day: DAY }), { skipped: 'disabled' });
  const forced = await manager.runOnce({ day: DAY, force: true });
  assert.equal(forced.results[0].status, 'done');
  store.close();
});

test('非白名单会话不参与整日运行', async () => {
  const cfg = makeConfig();
  cfg.allowAllWhenEmpty = false;
  cfg.allow = { groups: [], private: [] };
  const { store, manager } = makeManager({
    cfg,
    messages: { 'group:1': [msg(1, '本群暗号是菠萝')] }
  });
  const result = await manager.runOnce({ day: DAY });
  assert.deepEqual(result.results, []);
  store.close();
});

test('observe/暂停模式下即使手动指定会话也不写库', async () => {
  const cfg = makeConfig();
  cfg.runtime = { mode: 'observe', paused: false };
  const { store, manager } = makeManager({
    cfg,
    messages: { 'group:99': [msg(1, '本群暗号是菠萝')] }
  });
  const result = await manager.runOnce({ day: DAY, chatKey: 'group:99', force: true });
  assert.equal(result.results[0].status, 'skipped');
  assert.equal(store.getJob('group:99', DAY), null);
  store.close();
});

test('预算 block 时跳过整轮，degrade 时最多处理 3 个会话', async () => {
  const cfg = makeConfig();
  cfg.api = { budget: { enabled: true, dailyYuan: 1, onExceed: 'block', notify: false } };
  const blocked = makeManager({
    cfg,
    sessions: { todayUsage: () => ({ estimatedYuan: 2 }) }
  });
  assert.deepEqual(await blocked.manager.runOnce({ day: DAY }), { skipped: 'budget' });
  blocked.store.close();

  const degradeCfg = makeConfig();
  degradeCfg.api = { budget: { enabled: true, dailyYuan: 1, onExceed: 'degrade', notify: false } };
  const messages = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`group:${n}`, [msg(n, `暗号${n}`)]]));
  const degraded = makeManager({
    cfg: degradeCfg,
    messages,
    sessions: { todayUsage: () => ({ estimatedYuan: 2 }) }
  });
  const result = await degraded.manager.runOnce({ day: DAY });
  assert.equal(result.results.length, 3);
  degraded.store.close();
});
