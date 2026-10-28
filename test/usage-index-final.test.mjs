// 定稿会话（status 离开 running/waiting）的用量只从 SQLite 索引取：
// 不再 stat、不再打开文件。这是控制台重复 IO 的主要来源，用例把行为钉死。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-usage-final-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

const sessionsDir = path.join(root, 'sessions');

/** 写一份会话留档（形状与 src/core/sessions.js 落盘的一致）。 */
function writeSession(name, { status, model, prompt }) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const startedAt = Date.now() - 60_000;
  const file = path.join(sessionsDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({
    id: name,
    chatKey: 'group:1',
    status,
    startedAt,
    endedAt: status === 'done' ? startedAt + 1000 : null,
    model,
    messages: [{
      raw: {
        model,
        created: Math.floor(startedAt / 1000),
        usage: { prompt_tokens: prompt, completion_tokens: 0 }
      }
    }]
  }));
  return file;
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function bootApp() {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort();
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
    cfg.runtime.mode = 'observe';
    cfg.allow = { ...(cfg.allow || {}), groups: ['1'], private: [] };
    cfg.onebot = { ...(cfg.onebot || {}), wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', accessToken: '' };
    cfg.api = {
      ...(cfg.api || {}),
      baseUrl: '',
      apiKey: '',
      model: 'deepseek-flash',
      useOfficialPrice: true,
      priceRemoteUrl: 'none'
    };
    updateConfig(cfg);
    const app = createApp({ log: () => {} });
    try {
      const bound = await app.start();
      const get = async (route) => {
        const res = await fetch(`http://127.0.0.1:${bound}${route}`);
        return { status: res.status, body: await res.json().catch(() => ({})) };
      };
      return { app, get };
    } catch (error) {
      lastError = error;
      await app.stop().catch(() => {});
      if (!/EADDRINUSE/.test(String(error?.message ?? '')) && error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError;
}

test('定稿会话只从索引取数：不再 stat / 打开文件', async (t) => {
  writeSession('s-done', { status: 'done', model: 'model-done', prompt: 2_000_000 });

  const { app, get } = await bootApp();
  // 启动时 running/waiting 会被回收成 aborted（进程刚起来不可能有真会话），
  // 所以运行中的留档要在 boot 之后再写，才能保持未定稿状态。
  writeSession('s-running', { status: 'running', model: 'model-run', prompt: 1_000_000 });
  writeSession('s-waiting', { status: 'waiting', model: 'model-wait', prompt: 500_000 });

  const realStat = fs.statSync;
  const realRead = fs.readFileSync;
  const statHits = [];
  const readHits = [];
  fs.statSync = function (p, ...rest) {
    statHits.push(String(p));
    return realStat.call(this, p, ...rest);
  };
  fs.readFileSync = function (p, ...rest) {
    readHits.push(String(p));
    return realRead.call(this, p, ...rest);
  };
  t.after(async () => {
    fs.statSync = realStat;
    fs.readFileSync = realRead;
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 冷索引：三个文件都要 stat + 读，用量完整。
  const warm = await get('/api/usage/stats?range=today');
  assert.equal(warm.status, 200);
  assert.equal(warm.body.totals.promptTokens, 3_500_000);

  statHits.length = 0;
  readHits.length = 0;

  // 改写定稿文件（正常生命周期不会发生）：索引已定稿，不应再被 stat/读取。
  writeSession('s-done', { status: 'done', model: 'model-done', prompt: 9_000_000 });

  // 换窗口触发重新收集。
  const bd = await get('/api/usage/breakdown?range=7&dim=chat&key=group:1&by=model');
  assert.equal(bd.status, 200);
  assert.equal(bd.body.totals.promptTokens, 3_500_000, '定稿会话的用量来自索引，不能丢也不能重复算');

  const sessionStats = statHits
    .filter((p) => p.startsWith(sessionsDir))
    .map((p) => path.basename(p))
    .sort();
  const sessionReads = readHits.filter((p) => p.startsWith(sessionsDir));
  assert.deepEqual(sessionStats, ['s-running.json', 's-waiting.json'], '只对未定稿会话 stat');
  assert.deepEqual(sessionReads, [], '索引命中后不应再读会话文件');
});
