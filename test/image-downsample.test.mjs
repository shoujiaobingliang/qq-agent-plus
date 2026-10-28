// 超大图片兜底链路测试（Issue #6）。
// ffmpeg 是可选依赖：涉及真实降采样的断言必须兼容"装了/没装 ffmpeg"两种环境，
// 只钉住与 ffmpeg 无关的确定性部分（超限识别、非图片内容不上 ffmpeg、错误形态）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-downsample-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { OVERSIZE_LIMIT_RE, fetchOversizedImageAsJpeg, resolveFfmpeg, visionSlicePlan, convertImageFileToVisionJpegs } = await import('../src/tools/image-downsample.js');

const cfg = structuredClone(DEFAULT_CONFIG);
// safe-fetch 默认拒绝内网地址；测试服务就起在 127.0.0.1，显式放行（仅本测试进程的临时配置）
cfg.security = { ...cfg.security, allowPrivateImageHosts: true };
updateConfig(cfg);

let server;
let port = 0;
let requestCount = 0;
let mode = 'plain-huge';

before(async () => {
  server = http.createServer((req, res) => {
    requestCount += 1;
    if (mode === 'plain-huge') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(Buffer.alloc(13 * 1024 * 1024, 0x20));
    } else {
      // 13MB 的伪 PNG（内容非法，真 ffmpeg 也解不了——用于断言错误形态而非降采样产物）
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.alloc(13 * 1024 * 1024, 0x01));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

const url = () => `http://127.0.0.1:${port}/img`;

test('OVERSIZE_LIMIT_RE 精确匹配 safe-fetch 的超限报错形态，不误伤其他错误', () => {
  assert.equal(OVERSIZE_LIMIT_RE.test('响应体超过 12582912 字节限制'), true);
  assert.equal(OVERSIZE_LIMIT_RE.test('响应体超过12字节限制'), true);
  assert.equal(OVERSIZE_LIMIT_RE.test('HTTP 404'), false);
  assert.equal(OVERSIZE_LIMIT_RE.test('只允许 http(s) 图片地址'), false);
  assert.equal(OVERSIZE_LIMIT_RE.test('SSRF 拦截：内网地址'), false);
});

test('非图片内容超限：抛回原始超限错误，不会拿去喂 ffmpeg', async () => {
  mode = 'plain-huge';
  requestCount = 0;
  const original = new Error('响应体超过 13631488 字节限制');
  await assert.rejects(
    () => fetchOversizedImageAsJpeg(url(), original),
    (error) => {
      // 两种合法形态：ffmpeg 缺失（原始错误 + 安装指引）或有 ffmpeg 但二次拉取仍非图片（原样抛回）
      assert.match(error.message, /响应体超过 13631488 字节限制/);
      if (requestCount >= 1) assert.equal(error, original, '二次拉取仍非图片时必须原样抛回原始错误');
      return true;
    }
  );
  // 本函数自身只发一次请求（放宽重拉）；首次 12MiB 拉取发生在调用方 downloadImageAsDataUrl
  assert.ok(requestCount <= 1, `请求数应 ≤1，实际 ${requestCount}`);
});

test('image/* 超限：交给 ffmpeg 链路，错误形态按环境二选一（未安装 / 降采样失败）', async () => {
  mode = 'png-huge';
  requestCount = 0;
  const hasFfmpeg = await resolveFfmpeg() !== null;
  await assert.rejects(
    () => fetchOversizedImageAsJpeg(url(), new Error('响应体超过 13631488 字节限制')),
    (error) => {
      assert.match(error.message, /未安装 ffmpeg|ffmpeg 降采样失败|ffmpeg 启动失败/);
      return true;
    }
  );
  if (hasFfmpeg) {
    assert.equal(requestCount, 1, '装了 ffmpeg 就应发起放宽重拉');
  } else {
    assert.equal(requestCount, 0, '未装 ffmpeg 时不应发起任何请求');
  }
});

test('未装 ffmpeg 的分支：在"没有 ffmpeg"的子进程里验证（CI 装了 ffmpeg 也测得到）', async () => {
  // 上面那条用例按环境二选一断言，CI（装了 ffmpeg）永远只走"有 ffmpeg"那一支；
  // 这里用 PATH 里没有 ffmpeg 的子进程把"未安装"那一支钉死（2026-09-26 审查）。
  mode = 'png-huge';
  requestCount = 0;
  const mod = pathToFileURL(path.resolve('src/tools/image-downsample.js')).href;
  const script = `
    const { fetchOversizedImageAsJpeg } = await import(${JSON.stringify(mod)});
    try {
      await fetchOversizedImageAsJpeg(process.argv[1], new Error('响应体超过 13631488 字节限制'));
      console.error('SHOULD_HAVE_REJECTED');
      process.exit(4);
    } catch (error) {
      if (!/未安装 ffmpeg/.test(String(error?.message || ''))) { console.error('UNEXPECTED:' + error?.message); process.exit(5); }
      console.log('NO_FFMPEG_OK');
    }
  `;
  const empty = path.join(os.tmpdir(), 'qq-no-ffmpeg-path2');
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script, url()], {
    env: { ...process.env, PATH: empty, Path: empty, QQ_AGENT_DATA_DIR: dataDir },
    encoding: 'utf8'
  });
  assert.equal(res.status, 0, `子进程应以"未安装 ffmpeg"拒绝：${res.stderr || res.stdout}`);
  assert.match(res.stdout, /NO_FFMPEG_OK/);
  assert.equal(requestCount, 0, '未装 ffmpeg 时不该发起任何重拉请求');
});

test('非超限错误原样抛回，不做任何重拉', async () => {
  mode = 'plain-huge';
  requestCount = 0;
  const original = new Error('HTTP 404');
  await assert.rejects(
    () => fetchOversizedImageAsJpeg(url(), original),
    (error) => error === original
  );
  assert.equal(requestCount, 0, '非超限错误不应触发任何网络请求');
});

test('resolveFfmpeg 探测结果在进程内保持一致（缓存语义）', async () => {
  const first = await resolveFfmpeg();
  const second = await resolveFfmpeg();
  assert.equal(first, second);
  assert.ok(first === null || typeof first === 'string');
});

test('visionSlicePlan：普通图不切，长图切成有界高度，超长图段数封顶后整体缩小', () => {
  assert.deepEqual(visionSlicePlan(800, 800), {
    pieces: 1, scaleW: 800, pieceHeight: 800, width: 800, height: 800
  });
  // 1080 宽的长截图：旧实现完全没缩，现在切成 3 段 × 4000 高
  const tall = visionSlicePlan(1080, 12000);
  assert.equal(tall.pieces, 3);
  assert.equal(tall.scaleW, 1080);
  assert.equal(tall.pieceHeight, 4000);
  // 宽图先压到 2048 再切，单段缩放后仍 ≤4096
  const wide = visionSlicePlan(3000, 20000);
  assert.equal(wide.pieces, 4);
  assert.equal(wide.scaleW, 2048);
  assert.ok(wide.pieceHeight * wide.scaleW / wide.width <= 4096, '单段缩放后高度应 ≤4096');
  // 极长图：段数封顶 4，只能整体再缩，单段高度仍需有界
  const extreme = visionSlicePlan(1080, 60000);
  assert.equal(extreme.pieces, 4);
  assert.ok(extreme.pieceHeight * extreme.scaleW / extreme.width <= 4096, '封顶后单段高度也应 ≤4096');
  assert.equal(visionSlicePlan(0, 100), null);
  assert.equal(visionSlicePlan(100, 0), null);
});

/** 用 ffmpeg 生成一张纯色长图（异步 spawn：Windows 上 spawnSync 偶发 EBUSY）。 */
async function makeTallPng(width, height) {
  const out = path.join(dataDir, `tall-${width}x${height}.png`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ok = await new Promise((resolve) => {
      let child;
      try {
        child = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', `color=c=gray:s=${width}x${height}`,
          '-frames:v', '1', '-y', out
        ], { windowsHide: true, stdio: 'ignore' });
      } catch {
        resolve(false);
        return;
      }
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
    if (ok) return out;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

test('convertImageFileToVisionJpegs：长图产出多张 JPEG（装了 ffmpeg 才断言）', async () => {
  if (await resolveFfmpeg() === null) return;
  const file = await makeTallPng(400, 6000);
  assert.ok(file, 'ffmpeg 应能生成测试长图');
  const jpegs = await convertImageFileToVisionJpegs(file, 'image/png');
  assert.equal(jpegs?.length, 2, '400×6000 应切成 2 段');
  for (const jpeg of jpegs) {
    assert.equal(jpeg[0], 0xff);
    assert.equal(jpeg[1], 0xd8);
  }
});

test('convertImageFileToVisionJpegs：普通图片仍只产出 1 张（装了 ffmpeg 才断言）', async () => {
  if (await resolveFfmpeg() === null) return;
  const file = await makeTallPng(400, 800);
  assert.ok(file, 'ffmpeg 应能生成测试图片');
  const jpegs = await convertImageFileToVisionJpegs(file, 'image/png');
  assert.equal(jpegs?.length, 1);
});
