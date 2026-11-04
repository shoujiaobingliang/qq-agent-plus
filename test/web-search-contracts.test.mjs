// 五个搜索 provider 的**契约测试**（zhipu / bocha / baidu / deepseek / bing）。
//
// 为什么补这一组：issue #38 的秘塔 bug（地址 + 请求体 + 响应路径三处都错）之所以能潜伏到用户
// 报障，是因为它**一条用例都没有** —— 而 tavily / doubao 有契约测试，所以它们的形状一直是对的。
// 这里按同一口径把剩下的补齐：地址、请求体字段名与类型、响应路径、以及"200 里带错误码"的形态
// （zhipu 401、bocha code≠200、qianfan code/error_code、bing 命中验证页）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-search-contracts-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
for (const key of ['ZHIPU_API_KEY', 'BOCHA_API_KEY', 'BAIDU_SEARCH_API_KEY', 'DEEPSEEK_API_KEY']) delete process.env[key];
// 端口避开 Linux/Windows 临时端口段，和别的 web-search 用例并行不冲突
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ server: { port: 22501, host: '127.0.0.1' } }));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { zhipuSearch, bochaSearch, baiduSearch, deepSeekSearch, bingSearch } = await import('../src/llm/web-search.js');

const setWebSearch = (patch) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch = { ...cfg.webSearch, ...patch };
  updateConfig(cfg);
};
const stub = (responder) => {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    return responder(calls.length, calls[calls.length - 1]);
  };
  return calls;
};

test('智谱：{search_engine, search_query, count} → search_result[]（title/link/content）', async () => {
  setWebSearch({ provider: 'zhipu', zhipu: { apiKey: 'zk', engine: 'search_pro', count: 12 } });
  const calls = stub(() => ({
    ok: true,
    json: async () => ({ search_result: [
      { title: 'T', link: 'https://a.example/', content: '摘要' },
      { title: '', link: 'https://b.example/', content: '' }
    ] })
  }));
  const r = await zhipuSearch('q');
  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/web_search');
  assert.equal(calls[0].headers.authorization, 'Bearer zk');
  assert.deepEqual(calls[0].body, { search_engine: 'search_pro', search_query: 'q', count: 12 });
  assert.equal(r.results[0].title, 'T');
  assert.equal(r.results[0].url, 'https://a.example/');
  assert.equal(r.results[0].snippet, '摘要');
  assert.equal(r.results[1].title, '（无标题）', '空标题要兜底');
  // 200 + 空数组 = 没搜到，不是失败
  stub(() => ({ ok: true, json: async () => ({ search_result: [] }) }));
  assert.deepEqual((await zhipuSearch('q')).results, []);
});

test('博查：{query, count, freshness, summary} → data.webPages.value[]（name/url/snippet）', async () => {
  setWebSearch({ provider: 'bocha', bocha: { apiKey: 'bk', count: 5 } });
  const calls = stub(() => ({
    ok: true,
    json: async () => ({ code: 200, data: { webPages: { value: [
      { name: '标题', url: 'https://a.example/', snippet: '摘' },
      { name: '只有 summary', url: 'https://b.example/', summary: '摘要兜底' },
      { name: '无链接' }
    ] } } })
  }));
  const r = await bochaSearch('q');
  assert.equal(calls[0].url, 'https://api.bochaai.com/v1/web-search');
  assert.deepEqual(calls[0].body, { query: 'q', count: 5, freshness: 'noLimit', summary: false });
  assert.deepEqual(r.results.map((x) => x.url), ['https://a.example/', 'https://b.example/'], '无 url 的丢掉');
  assert.equal(r.results[1].snippet, '摘要兜底');

  // code≠200 是错误（HTTP 仍是 200）
  stub(() => ({ ok: true, json: async () => ({ code: 403, message: '额度用完' }) }));
  await assert.rejects(() => bochaSearch('q'), /额度用完/);
  // code=200 + 空网页数组 = 没搜到
  stub(() => ({ ok: true, json: async () => ({ code: 200, data: { webPages: { value: [] } } }) }));
  assert.deepEqual((await bochaSearch('q')).results, []);
});

test('百度千帆：{messages, search_source, resource_type_filter} → references[]；code/error_code 两种错误字段都认', async () => {
  setWebSearch({ provider: 'baidu', baidu: { apiKey: 'bak', count: 8 } });
  const calls = stub(() => ({
    ok: true,
    json: async () => ({ references: [{ title: 'T', url: 'https://a.example/', content: '内容' }] })
  }));
  const r = await baiduSearch('q');
  assert.equal(calls[0].url, 'https://qianfan.baidubce.com/v2/ai_search/web_search');
  assert.equal(calls[0].headers.authorization, 'Bearer bak');
  assert.deepEqual(calls[0].body, {
    messages: [{ role: 'user', content: 'q' }],
    search_source: 'baidu_search_v2',
    resource_type_filter: [{ type: 'web', top_k: 8 }]
  });
  assert.equal(r.results[0].snippet, '内容');

  stub(() => ({ ok: true, json: async () => ({ code: 216003, message: '鉴权失败' }) }));
  await assert.rejects(() => baiduSearch('q'), /216003/);
  stub(() => ({ ok: true, json: async () => ({ error_code: 17, error_msg: '日额度超限' }) }));
  await assert.rejects(() => baiduSearch('q'), /17/);
  // 空 references = 没搜到
  stub(() => ({ ok: true, json: async () => ({ references: [] }) }));
  assert.deepEqual((await baiduSearch('q')).results, []);
});

test('DeepSeek：Search API（POST /v1/tools/search）→ results[]（title/url/summary）', async () => {
  setWebSearch({ provider: 'deepseek', deepseek: { apiKey: 'dk', count: 8 } });
  const calls = stub(() => ({
    ok: true,
    json: async () => ({ results: [
      { title: 'T', url: 'https://a.example/', snippet: '短摘要', summary: '长摘要' },
      { title: '', url: 'https://b.example/', snippet: '只有短摘要' },
      { title: '没有链接', snippet: '应被过滤' }
    ] })
  }));
  const r = await deepSeekSearch('q');
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(calls[0].headers.authorization, 'Bearer dk');
  // Search 接口没有 model 参数；need_content 默认 false（summary 已够模型读）
  assert.deepEqual(calls[0].body, { query: 'q', count: 8, need_content: false });
  assert.deepEqual(r.results.map((x) => x.url), ['https://a.example/', 'https://b.example/']);
  assert.equal(r.results[0].snippet, '长摘要', '优先用 summary（给模型读的长摘要）');
  assert.equal(r.results[1].snippet, '只有短摘要');
  assert.equal(r.results[1].title, '（无标题）');

  // 搜索正常但没匹配：官方文档明确"返回空数组" = 搜到 0 条，照常返回空结果，
  // 由工具层告诉模型"没搜到，换个关键词"（不是"搜索失败"）
  stub(() => ({ ok: true, json: async () => ({ results: [] }) }));
  const empty = await deepSeekSearch('q');
  assert.deepEqual(empty.results, []);

  // OpenAI 兼容错误体：把 error.message 提出来（402 余额不足是常见故障）
  stub(() => ({
    ok: false,
    status: 402,
    text: async () => JSON.stringify({ error: { message: 'Insufficient balance', param: null, code: 'invalid_request_error' } })
  }));
  await assert.rejects(() => deepSeekSearch('q'), /402.*Insufficient balance/);
});

test('DeepSeek：旧 Responses API 地址会被迁移到 Search 接口', async () => {
  const { migrateDeepSeekSearchBaseUrl } = await import('../src/core/config-legacy.js');
  const migrated = migrateDeepSeekSearchBaseUrl({
    deepseek: { apiKey: 'k', baseUrl: 'https://api.deepseek.com/responses', model: 'deepseek-v4-flash' }
  });
  assert.equal(migrated.deepseek.baseUrl, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(migrated.deepseek.model, undefined, 'Search 接口没有 model 参数，迁移时去掉');
  assert.equal(migrated.deepseek.apiKey, 'k', 'Key 原样保留');
  // 用户自填的代理地址不动
  const custom = migrateDeepSeekSearchBaseUrl({ deepseek: { baseUrl: 'https://my-proxy.example/deepseek' } });
  assert.equal(custom.deepseek.baseUrl, 'https://my-proxy.example/deepseek');
  assert.deepEqual(migrateDeepSeekSearchBaseUrl(undefined), undefined);
  assert.deepEqual(migrateDeepSeekSearchBaseUrl({}), {});
});

test('Bing：HTML 解析出 b_algo 块；命中验证页（0 块）要抛错而不是给空列表', async () => {
  setWebSearch({ provider: 'bing', searchUrl: 'https://cn.bing.com/search', maxResults: 3 });
  const html = '<ol><li class="b_algo"><h2><a href="https://a.example/">标题 A</a></h2><p>摘要 A</p></li>'
    + '<li class="b_algo"><h2><a href="https://b.example/">标题 B</a></h2><p>摘要 B</p></li>'
    + '<li class="b_algo"><h2><a href="https://c.example/">标题 C</a></h2><p>摘要 C</p></li>'
    + '<li class="b_algo"><h2><a href="https://d.example/">标题 D</a></h2><p>摘要 D</p></li></ol>';
  const calls = stub(() => ({ ok: true, text: async () => html }));
  const r = await bingSearch('测试');
  assert.match(calls[0].url, /^https:\/\/cn\.bing\.com\/search\?q=/);
  assert.equal(r.results.length, 3, 'maxResults 截断');
  assert.deepEqual(r.results.map((x) => x.url), ['https://a.example/', 'https://b.example/', 'https://c.example/']);

  stub(() => ({ ok: true, text: async () => '<html><body>请完成验证</body></html>' }));
  await assert.rejects(() => bingSearch('x'), /没有返回可解析的结果/);
});

test('Tavily：provider=tavily 真的走 Tavily（此前静默退回 Bing）', async () => {
  // 设置页把 Tavily 列为可选、Key 也有独立入口；dispatch 漏了它时 webSearch 会一路落到
  // Bing，用户以为在用自己的 Key，实际没有（2026-10-17 审查 P2）
  setWebSearch({ provider: 'tavily', tavily: { apiKey: 'tv-key', count: 3 } });
  const calls = stub(() => ({
    ok: true,
    status: 200,
    json: async () => ({ results: [{ title: '结果', url: 'https://example.com/a', content: '摘要' }] })
  }));
  const { webSearch } = await import('../src/llm/web-search.js');
  const result = await webSearch('测试查询');
  assert.match(calls[0].url, /api\.tavily\.com\/search/, '必须打到 Tavily，而不是 Bing');
  assert.equal(calls[0].headers.authorization, 'Bearer tv-key', 'Key 要带上');
  assert.deepEqual(result.results, [{ title: '结果', url: 'https://example.com/a', snippet: '摘要' }]);
});
