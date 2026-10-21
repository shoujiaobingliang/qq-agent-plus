// 降低云盘 IOPS + 7 天保留期：
//   · 消息/线程 transcript 按时间清理，未处理消息不删；
//   · usage-today 内存累加、批量落盘；
//   · 新配置项默认值与 UI 接线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-io-retention-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { DEFAULT_CONFIG, setRuntimeConfig, updateConfig, getConfig } = await import('../src/core/config.js');
const { todayKey } = await import('../src/core/util.js');

test('pruneMessagesBefore：只删已处理旧消息，未处理消息保留', (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'store-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => store.close());
  const old = Date.now() - 8 * 24 * 3600 * 1000;
  store.appendIncoming('group:1', { mid: 1, ts: old, text: '旧消息', senderId: 'u1', senderName: '甲' });
  store.markAllRead('group:1');
  store.appendIncoming('group:1', { mid: 2, ts: old, text: '未处理旧消息', senderId: 'u1', senderName: '甲' });
  store.appendIncoming('group:1', { mid: 3, ts: Date.now(), text: '新消息', senderId: 'u1', senderName: '甲' });

  const cleared = store.pruneMessagesBefore(Date.now() - 7 * 24 * 3600 * 1000);
  assert.equal(cleared.messages, 1, '只删已读的 8 天前消息');
  assert.equal(store.findByMid('group:1', 2)?.text, '未处理旧消息', 'pending 不能被静默删除');
  assert.equal(store.findByMid('group:1', 3)?.text, '新消息');
  assert.deepEqual(store.pruneMessagesBefore(0), { messages: 0, threadTurns: 0, threadCheckpoints: 0, threads: 0 });
});

test('pruneMessagesBefore：活跃线程 transcript 不删，已关闭线程的旧数据会清', (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'store-thread-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => store.close());
  const old = Date.now() - 8 * 24 * 3600 * 1000;
  const active = store.upsertConversationThread('group:1', { topic: '活跃' });
  store.db.prepare(
    'INSERT INTO thread_turns (thread_id, chat_key, run_id, sequence, message_json, created_at) VALUES (?,?,?,?,?,?)'
  ).run(active.threadId, 'group:1', 'run-a', 1, '{}', old);
  const closed = store.upsertConversationThread('group:2', { topic: '已关闭' });
  store.closeConversationThread('group:2', 'test');
  // closeConversationThread 会清掉该线程当前的 turns；为了验证 prune 的保留期，
  // 直接补一条“关闭后遗留”的旧 turn。
  store.db.prepare(
    'INSERT INTO thread_turns (thread_id, chat_key, run_id, sequence, message_json, created_at) VALUES (?,?,?,?,?,?)'
  ).run(closed.threadId, 'group:2', 'run-b', 1, '{}', old);
  store.db.prepare('UPDATE thread_turns SET created_at=? WHERE chat_key=?').run(old, 'group:1');
  store.db.prepare('UPDATE conversation_threads SET updated_at=? WHERE chat_key=?').run(old, 'group:2');

  const cleared = store.pruneMessagesBefore(Date.now() - 7 * 24 * 3600 * 1000);
  assert.equal(cleared.threadTurns, 1, '只删已关闭线程的旧 transcript');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM thread_turns WHERE chat_key='group:1'").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM thread_turns WHERE chat_key='group:2'").get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM conversation_threads WHERE chat_key='group:2'").get().n, 0);
});

test('usage-today：内存累加 + flushUsage 落盘，不再每次调用读盘写盘', (t) => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const sessions = new SessionRegistry();
  t.after(() => sessions.flushUsage());
  const file = path.join(root, 'usage-today.json');
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  sessions.recordExternalUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }, { model: 'm' });
  assert.equal(sessions.todayUsage(todayKey()).totalTokens, 15, '立即可读');
  assert.equal(fs.existsSync(file), false, '15 秒批量落盘前不应写盘');
  sessions.flushUsage();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.totalTokens, 15);
});

test('存储保留期默认值与夹取；UI/部署接线在位', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.admin = { ...(cfg.admin || {}), ownerUin: '100000001' };
  cfg.allow = { ...(cfg.allow || {}), private: ['100000001'] };
  setRuntimeConfig(cfg);
  updateConfig({
    store: {
      messageRetentionDays: -1,
      sessionRetentionDays: 99999,
      sessionPersistIntervalMs: 1,
      sqliteSynchronous: 'FULL'
    }
  });
  const next = getConfig();
  assert.equal(next.store.messageRetentionDays, 0);
  assert.equal(next.store.sessionRetentionDays, 3650);
  assert.equal(next.store.sessionPersistIntervalMs, 2000);
  assert.equal(next.store.sqliteSynchronous, 'FULL');

  const chatUi = fs.readFileSync(path.join(process.cwd(), 'ui/pages/chat.js'), 'utf8');
  for (const id of ['cfg-message-retention', 'cfg-session-retention', 'cfg-session-persist-ms', 'cfg-sqlite-synchronous']) {
    assert.ok(chatUi.includes(`id="${id}"`), `缺少控件 ${id}`);
  }
  const compose = fs.readFileSync(path.join(process.cwd(), 'deploy-all.sh'), 'utf8');
  assert.ok(compose.includes('max-size: "20m"'), 'SnowLuma 容器日志要轮转');
});
