// 豆包搜索 provider 测试（Issue #6 ②）：请求契约、结果解析、错误形态、配置脱敏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-doubao-search-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
delete process.env.DOUBAO_SEARCH_API_KEY;
// 隔离端口：app.start() 不接收参数，实际绑定 config.server.port（默认 3210）。
// 与 usage-e2e.mjs 同一修复——宿主机跑着生产实例时（服务器部署形态的常态），
// 不写隔离端口整条 npm test 会在本文件被 EADDRINUSE 打断。
// 端口选 22496：在 Linux（32768-60999）与 Windows（49152-65535）的临时端口
// 范围之外，避免生产实例的出站连接恰好占用同端口导致 EADDRINUSE。
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  server: { port: 22496, host: '127.0.0.1' }
}));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');

const withKey = () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch = { ...cfg.webSearch, provider: 'doubao', doubao: { ...(cfg.webSearch?.doubao || {}), apiKey: 'test-key-123' } };
  updateConfig(cfg);
};
const withoutKey = () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch = { ...cfg.webSearch, provider: 'doubao', doubao: { ...(cfg.webSearch?.doubao || {}), apiKey: '' } };
  updateConfig(cfg);
};

test('doubaoSearch：请求体 PascalCase + Bearer 认证 + Result.WebResults 解析', async () => {
  withKey();
  let captured = null;
  globalThis.fetch = async (url, opts = {}) => {
    captured = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({ Result: { WebResults: [
        { Title: '标题 A', Url: 'https://example.com/a', Summary: '摘要 A' },
        { Title: '无链接条目', Summary: '应被过滤' }
      ] } })
    };
  };
  const { doubaoSearch } = await import('../src/llm/web-search.js');
  const r = await doubaoSearch('豆包测试');
  assert.equal(captured.url, 'https://open.feedcoopapi.com/search_api/web_search');
  assert.equal(captured.headers.authorization, 'Bearer test-key-123');
  assert.deepEqual(captured.body, { Query: '豆包测试', SearchType: 'web', Count: 6, NeedContent: true });
  assert.equal(r.query, '豆包测试');
  assert.equal(r.results.length, 1, '无 Url 的条目应被过滤');
  assert.deepEqual(r.results[0], { title: '标题 A', url: 'https://example.com/a', snippet: '摘要 A' });
});

test('doubaoSearch：未配置 Key 时明确报错', async () => {
  withoutKey();
  delete process.env.DOUBAO_SEARCH_API_KEY;
  const { doubaoSearch } = await import('../src/llm/web-search.js');
  await assert.rejects(() => doubaoSearch('x'), /未配置 API Key/);
});

test('doubaoSearch：Key 回退环境变量 DOUBAO_SEARCH_API_KEY', async () => {
  withoutKey();
  process.env.DOUBAO_SEARCH_API_KEY = 'env-key-456';
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ Result: { WebResults: [{ Title: 'T', Url: 'https://e', Summary: 'S' }] } }) });
  const { doubaoSearch } = await import('../src/llm/web-search.js');
  const r = await doubaoSearch('env');
  assert.equal(r.results[0].url, 'https://e');
  delete process.env.DOUBAO_SEARCH_API_KEY;
});

test('doubaoSearch：HTTP 错误带状态码与响应片段', async () => {
  withKey();
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'invalid key' });
  const { doubaoSearch } = await import('../src/llm/web-search.js');
  await assert.rejects(() => doubaoSearch('x'), /豆包搜索 HTTP 401：invalid key/);
});

test('doubaoSearch：HTTP 200 + ResponseMetadata.Error 时抛出真实错误码与信息（Issue #8）', async () => {
  withKey();
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ResponseMetadata: { Error: { CodeN: 700901, Code: 'invalid_api_key', Message: 'invalid api key' } }, Result: null })
  });
  const { doubaoSearch } = await import('../src/llm/web-search.js');
  await assert.rejects(() => doubaoSearch('x'), /豆包搜索失败（invalid_api_key）：invalid api key/);
  // CodeN 缺失时回退 Code，两者都缺时给"未知错误码"
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ResponseMetadata: { Error: { Message: 'boom' } } }) });
  await assert.rejects(() => doubaoSearch('x'), /豆包搜索失败（未知错误码）：boom/);
});

test('doubaoSearch：空结果正常返回空列表（200 + 空数组 = 没搜到，不是失败）', async () => {
  withKey();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ Result: { WebResults: [] } }) });
  const { doubaoSearch } = await import('../src/llm/web-search.js');
  assert.deepEqual((await doubaoSearch('x')).results, []);
});

test('webSearch() 路由：provider=doubao 走豆包', async () => {
  withKey();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ Result: { WebResults: [{ Title: 'T', Url: 'https://route', Summary: 'S' }] } }) });
  const { webSearch } = await import('../src/llm/web-search.js');
  const r = await webSearch('路由测试');
  assert.equal(r.results[0].url, 'https://route');
});

test('/api/config 不泄露 webSearch.doubao.apiKey 明文（脱敏走通用 SECRET_KEY_PATTERN）', async () => {
  withKey();
  // 前面几个用例的 updateConfig 会把整个 DEFAULT_CONFIG 克隆写回配置，把隔离端口
  // 覆盖回 3210——启动前再钉一次（否则宿主机跑着生产实例时这里必然 EADDRINUSE）。
  updateConfig({ server: { port: 22496, host: '127.0.0.1' } });
  const { createApp } = await import('../src/console/app.js');
  const app = createApp({ log: () => {} });
  const port = await app.start();
  try {
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/config' }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    assert.ok(!body.includes('test-key-123'), '/api/config 泄露了豆包明文 Key');
    assert.match(body, /"hasApiKey":true/, '应保留 doubao 的 hasApiKey 布尔标记');
  } finally {
    await app.stop();
  }
});

after(() => { try { globalThis.fetch = undefined; } catch { /* 恢复默认 */ } });
