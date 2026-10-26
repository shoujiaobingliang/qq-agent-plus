import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-time-control-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { chatCompletion, chatCompletionWithRetry } = await import('../src/llm/llm.js');
const { canRun } = await import('../src/core/access.js');
const { withTimeScope, watchTimeWindow } = await import('../src/core/time-gate.js');
const { testModelChat } = await import('../src/core/providers.js');
const { detectModelVision } = await import('../src/llm/vision-scan.js');
const { deepSeekSearch, customSearch } = await import('../src/llm/web-search.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(t, mode = 'legacy') {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.allow.private = ['2'];
  cfg.api.model = 'mock';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.memory.consolidateEnabled = false;
  cfg.sticker.enabled = false;
  // 这组用例数的是“时间门控放行了几次模型调用”；心情评审是异步的第二次请求，
  // 关掉它，否则断言会受评审完成时机影响（与 replyGuard 同一口径）。
  cfg.mood.judge.enabled = false;
  // 这组用例数的是"时间门控放行了几次模型调用"：关掉「该回没发」的补救，
  // 否则私聊里只回正文的桩会多出一次纠正调用（该行为由 test/reply-guard.test.mjs 覆盖）
  cfg.conversation.replyGuardEnabled = false;
  cfg.conversation.mode = mode;
  cfg.wakeDelayMs = 100;
  cfg.wakeDelayMinMs = 100;
  cfg.wakeDelayMaxMs = 100;
  cfg.timeControl = {
    enabled: true, schedule: { mode: 'custom', windows: [] }, overrides: {}
  };
  setRuntimeConfig(cfg);
  const app = createApp({ log: () => {} });
  app.onebot.selfInfo = { user_id: 888, nickname: 'bot' };
  app.onebot.getGroupMemberInfo = async () => ({ nickname: 'member' });
  app.onebot.getGroupInfo = async () => ({ group_name: 'test' });
  let calls = 0;
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    bodies.push(options?.body);
    return Response.json({
      choices: [{ message: { content: 'Done' } }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
    });
  };
  t.after(async () => { await app.stop(); globalThis.fetch = original; });
  const receive = (mid, privateChat = false) => app.onebot.onEvent({
    post_type: 'message', message_type: privateChat ? 'private' : 'group',
    ...(privateChat ? {} : { group_id: 1 }), user_id: privateChat ? 2 : 42,
    message_id: mid, sender: { user_id: privateChat ? 2 : 42, nickname: 'member' },
    time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: `message ${mid}` } }]
  });
  return { cfg, app, receive, calls: () => calls, bodies };
}

for (const mode of ['legacy', 'threaded', 'lifecycle']) {
  test(`${mode}: inactive messages and pokes are archived without AI or catch-up`, async (t) => {
    const { cfg, app, receive, calls } = fixture(t, mode);
    const before = app.sessions.listSummaries(100000).length;
    await receive(`${mode}-group`);
    await receive(`${mode}-private`, true);
    await app.onebot.onEvent({
      post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
      group_id: 1, user_id: 42, target_id: 888
    });
    assert.equal(app.store.findByMid('group:1', `${mode}-group`).state, 'acked');
    assert.equal(app.store.findByMid('private:2', `${mode}-private`).state, 'acked');
    assert.equal(app.store.unreadCount('group:1'), 0);
    assert.equal(app.orchestrator.forceWake('group:1'), false);
    await app.orchestrator.wake('group:1', { proactive: true });
    await assert.rejects(app.orchestrator.consolidateMemoryForChat('group:1'), { code: 'TIME_CONTROL_INACTIVE' });
    await assert.rejects(app.dailyMoments.runNow({ publish: false }), { code: 'TIME_CONTROL_INACTIVE' });
    await assert.rejects(app.sender.sendTextBatch('group:1', ['must not send']), /非活跃/);
    assert.equal(app.sessions.listSummaries(100000).length, before);
    assert.equal(calls(), 0);

    setRuntimeConfig({ ...cfg, timeControl: { ...cfg.timeControl, enabled: false } });
    await app.orchestrator.wake('group:1');
    assert.equal(calls(), 0, 'archived inactive messages must not trigger a catch-up');
    await receive(`${mode}-active`);
    await app.orchestrator.wake('group:1');
    assert.equal(calls(), 1);
    assert.ok(app.store.recent('group:1', { readOnly: true }).some((m) => m.mid === `${mode}-group`));
  });
}

test('per-chat override enables only its own AI requests, including tool scopes', async (t) => {
  const { cfg, app, receive, calls } = fixture(t);
  cfg.timeControl.overrides['private:2'] = { mode: 'always', windows: [] };
  setRuntimeConfig(cfg);
  await receive('override-group');
  await receive('override-private', true);
  assert.equal(canRun('group:1'), false);
  assert.equal(canRun('private:2'), true);
  await app.orchestrator.wake('private:2');
  assert.equal(calls(), 1);
  await assert.rejects(chatCompletion({ messages: [] }), { code: 'TIME_CONTROL_INACTIVE' });
  await withTimeScope('private:2', () => chatCompletion({ messages: [] }));
  assert.equal(calls(), 2);
});

test('inputs received while inactive remain record-only across an ingestion queue boundary', async (t) => {
  const { cfg, app, receive, calls } = fixture(t);
  const queued = receive('queued-while-inactive');
  setRuntimeConfig({ ...cfg, timeControl: { ...cfg.timeControl, enabled: false } });
  await queued;
  await app.orchestrator.wake('group:1');
  assert.equal(app.store.findByMid('group:1', 'queued-while-inactive').state, 'acked');
  assert.equal(calls(), 0);
});

test('master-off sends the same model payload as an absent time-control config', async (t) => {
  const { cfg, bodies } = fixture(t);
  const options = { messages: [{ role: 'user', content: 'same request' }], temperature: 0.2 };
  const legacy = { ...cfg };
  delete legacy.timeControl;
  setRuntimeConfig(legacy);
  await chatCompletion(options);
  setRuntimeConfig({ ...cfg, timeControl: {
    ...cfg.timeControl, enabled: false,
    overrides: { 'group:1': { mode: 'custom', windows: [] } }
  } });
  await withTimeScope('group:1', () => chatCompletion(options));
  assert.equal(bodies[0], bodies[1]);
});

test('global non-active hours do not block admin connectivity tests; model/vision/search still blocked', async (t) => {
  const { calls } = fixture(t);
  // 管理员在控制台主动点的「测试连通性」是诊断动作：非活跃时段也要能验证 Key/地址
  //（2026-10-20 反馈：测试连接被时间控制拦下）。它不该被时间门控拒绝。
  const probe = await testModelChat({ baseUrl: 'https://model.invalid', model: 'mock' });
  assert.equal(probe.ok, true, '连通性测试应真的发出请求');
  assert.equal(calls(), 1);
  // 控制台「测试连通性」（/api/test/api 走 chatCompletion）同样不受时间控制
  const diag = await chatCompletion({
    messages: [{ role: 'user', content: 'ping' }],
    ignoreTimeControl: true
  });
  assert.equal(diag.message.content, 'Done');
  assert.equal(calls(), 2);
  await assert.rejects(detectModelVision({ baseUrl: 'https://model.invalid', model: 'mock' }), { code: 'TIME_CONTROL_INACTIVE' });
  await assert.rejects(deepSeekSearch('must not search'), { code: 'TIME_CONTROL_INACTIVE' });
  await assert.rejects(customSearch('must not search'), { code: 'TIME_CONTROL_INACTIVE' });
  await assert.rejects(chatCompletionWithRetry({ messages: [] }), { code: 'TIME_CONTROL_INACTIVE' });
  assert.equal(calls(), 2, '被时间门控挡下的调用不该发出请求');
});

test('daily summary excludes inactive source conversations even when globally active', async (t) => {
  const { cfg, app, calls } = fixture(t);
  cfg.timeControl.schedule = { mode: 'always', windows: [] };
  cfg.timeControl.overrides['group:1'] = { mode: 'custom', windows: [] };
  setRuntimeConfig(cfg);
  const result = await app.dailyMoments.runNow({ publish: false });
  assert.equal(result.record.groupCount, 0);
  assert.equal(calls(), 0);
});

test('daily scheduler defers an inactive due time without creating a model session', async (t) => {
  const { cfg, app, calls } = fixture(t);
  const now = Date.parse('2026-09-14T01:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  cfg.timeControl.schedule = { mode: 'deepseek-offpeak', windows: [] };
  cfg.dailyMoments.enabled = true;
  cfg.dailyMoments.hour = 9;
  cfg.dailyMoments.minute = 0;
  setRuntimeConfig(cfg);
  const before = app.dailyMoments.status().records.length;
  app.dailyMoments.start();
  t.mock.timers.tick(15000);
  await Promise.resolve();
  assert.equal(app.dailyMoments.status().records.length, before);
  assert.equal(app.dailyMoments.status().nextRunAt, Date.parse('2026-09-14T04:00:00Z') + 1);
  assert.equal(calls(), 0);
  app.dailyMoments.stop();
});

test('enabling time control cancels an in-flight request and prevents retry', async (t) => {
  const { cfg, app } = fixture(t);
  setRuntimeConfig({ ...cfg, timeControl: { ...cfg.timeControl, enabled: false } });
  app.store.appendIncoming('group:1', { mid: 'in-flight', text: 'test', senderId: '42' });
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  let calls = 0;
  globalThis.fetch = async (_url, { signal }) => {
    calls++;
    ready();
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    );
  };
  const running = app.orchestrator.wake('group:1');
  await started;
  setRuntimeConfig(cfg);
  await running;
  assert.equal(calls, 1);
  assert.equal(app.store.findByMid('group:1', 'in-flight').state, 'acked');
  assert.equal(app.store.getChatMeta('group:1').held, 0);
  assert.equal(app.orchestrator.runningChats.size, 0);
});

test('non-active boundary retires waiting input but preserves uncertain delivery', async (t) => {
  const { cfg, app, receive, calls } = fixture(t);
  setRuntimeConfig({ ...cfg, timeControl: { ...cfg.timeControl, enabled: false } });
  await receive('waiting');
  assert.equal(app.orchestrator.pendingWake.size, 1);
  const lease = app.store.claimUnread('group:1');
  const intent = app.store.beginSend('group:1', lease.id, { text: 'unknown' });
  app.store.finishSend(intent, { error: 'connection lost' });
  app.store.failLease(lease.id, 'uncertain');
  await receive('pending-before-close');
  setRuntimeConfig(cfg);
  assert.equal(app.orchestrator.pendingWake.size, 0);
  assert.equal(app.store.findByMid('group:1', 'pending-before-close').state, 'acked');
  assert.equal(app.store.findByMid('group:1', 'waiting').state, 'held');
  assert.equal(calls(), 0);
});

test('watcher fires exactly at closing boundary and disabled rules do not fire', (t) => {
  const now = Date.parse('2026-09-14T00:59:59Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.timeControl.enabled = true;
  setRuntimeConfig(cfg);
  const stopped = [];
  const release = watchTimeWindow((error) => stopped.push(error), 'group:1');
  t.after(release);
  t.mock.timers.tick(999);
  assert.equal(stopped.length, 0);
  t.mock.timers.tick(1);
  assert.equal(stopped[0]?.code, 'TIME_CONTROL_INACTIVE');
  setRuntimeConfig({ ...cfg, timeControl: { ...cfg.timeControl, enabled: false } });
  const releaseOff = watchTimeWindow(() => assert.fail('disabled watcher fired'), 'group:1');
  t.after(releaseOff);
  t.mock.timers.tick(3600000);
});

test('config validation and override removal preserve the master-off default', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  assert.equal(getConfig().timeControl.enabled, false);
  updateConfig({ timeControl: { overrides: { 'group:1': { mode: 'always' } } } });
  assert.equal(getConfig().timeControl.overrides['group:1'].mode, 'always');
  updateConfig({ timeControl: { overrides: { __replace__: {} } } });
  assert.deepEqual(getConfig().timeControl.overrides, {});
  assert.throws(() => updateConfig({ timeControl: { schedule: { mode: 'typo' } } }));
  assert.equal(getConfig().timeControl.schedule.mode, 'deepseek-offpeak');
});
