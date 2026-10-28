// 每日长期记忆的控制台接线冒烟：真实 createApp + observe 模式 + 死 OneBot，不发模型请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dm-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄占用 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('每日长期记忆 API：status/entries/chats/run 在 observe 模式下可用且不写库', async (t) => {
  const port = await freePort();
  const token = 'dm-api-test-token-0123456789';
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token };
  cfg.runtime = { ...cfg.runtime, mode: 'observe', paused: false };
  cfg.onebot = { ...cfg.onebot, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' };
  cfg.dailyMemory = {
    ...cfg.dailyMemory,
    enabled: true,
    startupCatchup: false,
    human: { ...cfg.dailyMemory.human, enabled: true }
  };
  updateConfig(cfg);

  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  const base = `http://127.0.0.1:${port}`;
  const get = async (pathname) => {
    const res = await fetch(`${base}${pathname}`, {
      headers: { 'x-console-token': token }
    });
    return { status: res.status, body: await res.json() };
  };
  const post = async (pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify(body || {})
    });
    return { status: res.status, body: await res.json() };
  };

  const status = await get('/api/daily-memory/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.enabled, true);
  assert.ok(Array.isArray(status.body.jobs));

  const entries = await get('/api/daily-memory/entries?chatKey=group:1&status=active');
  assert.equal(entries.status, 200);
  assert.deepEqual(entries.body.entries, []);

  const chats = await get('/api/daily-memory/chats');
  assert.equal(chats.status, 200);
  assert.deepEqual(chats.body.chats, []);

  const run = await post('/api/daily-memory/run', { chatKey: 'group:1', force: true });
  assert.equal(run.status, 200);
  assert.equal(run.body.results[0].status, 'skipped');
  assert.match(run.body.results[0].reason, /observe|paused/);
});
