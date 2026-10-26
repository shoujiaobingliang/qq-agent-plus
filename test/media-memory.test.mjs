// 媒体内存防线（2026-10-26 复盘）：流式落盘 + 内存闸门 + 全局串行。
// 背景：96MB 视频/200MB 音频的大缓冲会把 1.6GB 机器的页缓存打穿，连带 QQ 的
// mmap 工作集反复缺页读盘。这里钉住"下载不再整包进内存"和两道闸门的语义。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-media-mem-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.security = { ...cfg.security, allowPrivateImageHosts: true };   // 测试服务在 127.0.0.1
updateConfig(cfg);

const { safeFetchToFile } = await import('../src/llm/safe-fetch.js');
const { assertMediaMemory, withMediaSlot, memoryAvailableBytes, cleanupStaleMediaTempDirs } = await import('../src/core/media-budget.js');

let server;
let port = 0;
let mode = 'small';

before(async () => {
  server = http.createServer((req, res) => {
    if (mode === 'small') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.alloc(64 * 1024, 0x41));
      return;
    }
    if (mode === 'declared') {
      // 声明 3MB、实际只写 10 字节：content-length 预检必须拦下
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 3 * 1024 * 1024 });
      res.end(Buffer.alloc(10));
      return;
    }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(Buffer.alloc(2 * 1024 * 1024, 0x42));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

const url = () => `http://127.0.0.1:${port}/file`;

test('safeFetchToFile：字节完整落盘，返回 contentType 与字节数', async () => {
  mode = 'small';
  const file = path.join(dataDir, 'small.bin');
  const out = await safeFetchToFile(url(), 1024 * 1024, file);
  assert.equal(out.file, file);
  assert.equal(out.contentType, 'image/png');
  assert.equal(out.bytes, 64 * 1024);
  assert.equal(fs.statSync(file).size, 64 * 1024);
  assert.equal(fs.readFileSync(file)[0], 0x41);
  fs.rmSync(file, { force: true });
});

test('safeFetchToFile：超过上限立即中断，不留下半截文件', async () => {
  mode = 'large';
  const file = path.join(dataDir, 'too-big.bin');
  await assert.rejects(
    () => safeFetchToFile(url(), 1024, file),
    /响应体超过 1024 字节限制/
  );
  // unlink 在写流 close 之后异步执行，等一个 tick
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(file), false, '超限后不能留下半截临时文件');
});

test('safeFetchToFile：content-length 预检超限时连文件都不创建', async () => {
  mode = 'declared';
  const file = path.join(dataDir, 'declared.bin');
  await assert.rejects(
    () => safeFetchToFile(url(), 1024, file),
    /响应体超过 1024 字节限制/
  );
  assert.equal(fs.existsSync(file), false);
});

test('assertMediaMemory：余量不足时拒绝，余量充足时放行', () => {
  const MB = 1024 * 1024;
  assert.throws(
    () => assertMediaMemory(0, { availableBytes: 80 * MB }),
    /内存紧张/
  );
  assert.doesNotThrow(() => assertMediaMemory(0, { availableBytes: 512 * MB }));
  // 大媒体（如音频）会把门槛抬到 128MB：100MB 可用时拒绝，200MB 时放行
  assert.throws(
    () => assertMediaMemory(64 * MB, { availableBytes: 100 * MB }),
    /内存紧张/
  );
  assert.doesNotThrow(() => assertMediaMemory(64 * MB, { availableBytes: 200 * MB }));
});

test('memoryAvailableBytes：能返回一个正数（Linux 用 MemAvailable，其它平台退回 freemem）', () => {
  const available = memoryAvailableBytes();
  assert.ok(available === null || available > 0, `期望正数或 null，实际 ${available}`);
});

test('withMediaSlot：同一时刻只跑一个媒体任务', async () => {
  const events = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.all([
    withMediaSlot(async () => {
      events.push('a-start');
      await sleep(30);
      events.push('a-end');
    }),
    withMediaSlot(async () => {
      events.push('b-start');
      events.push('b-end');
    })
  ]);
  assert.deepEqual(events, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('withMediaSlot：前一个任务失败不会卡住后续任务', async () => {
  await assert.rejects(() => withMediaSlot(async () => { throw new Error('boom'); }), /boom/);
  const result = await withMediaSlot(async () => 'ok');
  assert.equal(result, 'ok');
});

test('cleanupStaleMediaTempDirs：只删过期的媒体临时目录，不碰正在进行的/无关目录', () => {
  const oldDir = fs.mkdtempSync(path.join(dataDir, 'qq-media-'));
  const newDir = fs.mkdtempSync(path.join(dataDir, 'qq-ffmpeg-'));
  const other = fs.mkdtempSync(path.join(dataDir, 'unrelated-'));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(oldDir, old, old);
  const removed = cleanupStaleMediaTempDirs({ tmpDir: dataDir, maxAgeMs: 60 * 60 * 1000 });
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(newDir), true, '新鲜目录不能被删');
  assert.equal(fs.existsSync(other), true, '无关目录不能被删');
  for (const dir of [newDir, other]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
