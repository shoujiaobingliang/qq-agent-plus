// 联网搜索（移植自原版 bingSearch）：Bing 中文搜索，无需 API key。
// 搜索请求本身用普通 fetch（搜索 URL 是管理端配置的可信地址，只需清洗查询词）；
// 对外抓取网页正文一律走 safe-fetch（web_fetch 工具）。
import { getConfig } from '../core/config.js';
import { safeFetch } from './safe-fetch.js';
import { assertTimeAllowed, withTimeWindow } from '../core/time-gate.js';
import { readJsonBounded, readTextBounded } from '../core/http-body.js';

// 各上游响应体量上限（防畸形/超大响应把常驻进程读爆，只设超时挡不住这一点）。
// 搜索 API 返回的是结构化短文本，2 MiB 已远超正常结果；Bing 抓的是 HTML 结果页，1 MiB 足够。
const SEARCH_JSON_MAX_BYTES = 2 * 1024 * 1024;
const BING_HTML_MAX_BYTES = 1024 * 1024;

// provider 的 JSON 解析：只有 JSON 语法错误才转成「无法解析」；超限、超时、连接中断一律原样抛出 ——
// 它们对外含义不同，把"读正文时超时"伪装成"返回的 JSON 坏了"会让排障方向完全跑偏
//（慢供应商在响应头之后超时是常见故障，2026-10-17 审查 P3）。
function readSearchJson(res, message) {
  return readJsonBounded(res, SEARCH_JSON_MAX_BYTES).catch((error) => {
    if (error?.code === 'BODY_TOO_LARGE') throw error;
    if (error instanceof SyntaxError) throw new Error(message);
    throw error;
  });
}

/** 查询词清洗：去 CQ 码、控制字符、超长截断。 */
export function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 聚合搜索：并发跑多个 provider，结果按来源标注合并去重。
 * config.webSearch.aggregate.sources = ['doubao','bing','baidu',...]（按优先级排序），
 * 任一源失败不影响整体；全部失败才抛错。
 * # ponytail: 简单并发+URL去重；排名融合（RRF）等结果多了再加。
 */
export async function aggregateSearch(query) {
  const cfg = getConfig().webSearch?.aggregate ?? {};
  const sources = (Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : ['doubao', 'bing'])
    .map(String).slice(0, 4);
  const perSource = Math.max(2, Math.min(6, Number(cfg.count) || 4));
  const settled = await Promise.allSettled(sources.map(async (name) => {
    const fn = { doubao: doubaoSearch, bing: bingSearch, baidu: baiduSearch, zhipu: zhipuSearch, bocha: bochaSearch, metaso: metasoSearch, tavily: tavilySearch }[name];
    if (!fn) throw new Error(`未知搜索源: ${name}`);
    const r = await fn(query);
    return { source: name, results: (r.results || []).slice(0, perSource) };
  }));
  const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (!ok.length) {
    const errs = settled.map((s) => `${s.reason?.message ?? s.reason}`).join('；');
    throw new Error(`聚合搜索全部源失败：${errs.slice(0, 300)}`);
  }
  // 合并去重：URL 优先级 = 源顺序（前面的源排名更高）；同一 URL 只保留第一次出现
  const seen = new Set();
  const results = [];
  for (const { source, results: items } of ok) {
    for (const item of items) {
      const url = String(item?.url || '').replace(/[#?].*$/, '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push({ ...item, source });
    }
  }
  return { query, results, sources: ok.map((o) => o.source), failed: sources.filter((s) => !ok.some((o) => o.source === s)) };
}

/** Bing 搜索（解析 b_algo 结果块）。searchUrl 可在配置中替换（测试/换引擎）。 */
export async function bingSearch(query) {
  const cfg = getConfig().webSearch ?? {};
  const searchUrl = String(cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const url = new URL(searchUrl);
  url.searchParams.set('q', query);
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = await readTextBounded(res, BING_HTML_MAX_BYTES);
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= maxResults) break;
  }
  // Bing 是 HTML 抓取，命中验证页/同意页/改版 DOM 时这里会是空数组——
  // 不抛错的话模型只看到一个空列表，容易转而编造内容（Issue #9）。
  // 结构化 API（智谱/博查/豆包等）相反：200 + 空数组就是"没搜到"，照常返回空结果。
  if (!results.length) throw new Error('Bing 搜索没有返回可解析的结果（可能命中验证页或页面结构变化，可换个搜索提供方）');
  return { query, results };
}

/** 给工具用的统一入口：搜索 + 紧凑序列化。 */
export async function webSearch(query) {
  assertTimeAllowed();
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  const cfg = getConfig().webSearch ?? {};
  const provider = String(cfg.provider || 'bing').toLowerCase();
  if (provider === 'aggregate') return aggregateSearch(clean);
  if (provider === 'deepseek') return deepSeekSearch(clean);
  if (provider === 'zhipu') return zhipuSearch(clean);
  if (provider === 'bocha') return bochaSearch(clean);
  if (provider === 'baidu') return baiduSearch(clean);
  if (provider === 'metaso') return metasoSearch(clean);
  if (provider === 'doubao') return doubaoSearch(clean);
  // Tavily 在设置页是可选项、Key 也有独立入口；漏掉这条分发会让它静默退回 Bing，
  // 用户以为在用自己的 Key，实际没有（2026-10-17 审查 P2）
  if (provider === 'tavily') return tavilySearch(clean);
  // 自定义：'custom'（旧单槽位）或 'custom:<id>'（设置页添加的多个之一）
  if (provider === 'custom' || provider.startsWith('custom:')) {
    return customSearch(clean, provider);
  }
  return bingSearch(clean);
}

/**
 * DeepSeek Search API（自研搜索引擎，结构化网页结果）。
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/search
 *
 * 2026-11 起改走独立 Search 接口 `POST /v1/tools/search`：旧的 Responses API
 * （`tools: [{type:'web_search'}]`）返回的是模型基于搜索生成的整段回答，URL/标题/摘要
 * 全是黑盒 —— web_search 拿不到来源链接，web_fetch 也就接不上。新接口直接给
 * `{ results: [{ title, url, snippet, summary, content, ... }] }`，与其他 provider 同口径。
 * 支持 site: / -site: / after: / lang: 等搜索语法（梗站回退的 site: 查询也能用）。
 */
export function deepSeekSearch(query) {
  return withTimeWindow((signal) => deepSeekSearchRequest(query, signal));
}

async function deepSeekSearchRequest(query, signal) {
  const cfg = getConfig().webSearch?.deepseek ?? {};
  const apiKey = String(cfg.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) throw new Error('DeepSeek 搜索需要 API Key（设置里填，或环境变量 DEEPSEEK_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://api.deepseek.com/v1/tools/search').replace(/\/+$/, '');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 6));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      count,
      need_content: cfg.needContent === true
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))])
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    // 错误体是 OpenAI 兼容格式 { error: { message, code } }；把 message 提出来更好排障
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error?.message) detail = String(parsed.error.message).slice(0, 300);
    } catch { /* 非 JSON 错误体就用原文 */ }
    throw new Error(`DeepSeek 搜索 HTTP ${res.status}：${detail}`);
  }
  const data = await readSearchJson(res, 'DeepSeek 搜索返回了无法解析的 JSON');
  const arr = Array.isArray(data?.results) ? data.results : [];
  const results = arr
    .filter((r) => r?.url)
    .map((r) => ({
      title: String(r.title ?? '').trim() || '（无标题）',
      url: String(r.url),
      // summary（600~800 字）是给模型读的，比 snippet（100~200 字、给前端展示）信息量大
      snippet: String(r.summary ?? r.snippet ?? r.content ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  // 200 + 空数组 = 搜到了 0 条（官方文档："搜索正常结束但没有匹配结果时，返回空数组"）。
  // 结构化接口与 Bing 那类 HTML 抓取不同：后者空数组意味着验证页/改版，必须抛错。
  return { query, results };
}

/** 抓取网页正文（走 safe-fetch 的 SSRF 全防护）。 */
export async function webFetch(url) {
  const result = await safeFetch(url);
  return result;
}

/** 智谱 Web Search API（结构化结果：标题/链接/摘要/网站名/日期）。 */
export async function zhipuSearch(query) {
  const cfg = getConfig().webSearch?.zhipu ?? {};
  const apiKey = String(cfg.apiKey || process.env.ZHIPU_API_KEY || '').trim();
  if (!apiKey) throw new Error('智谱搜索需要 API Key（设置里填，或环境变量 ZHIPU_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/web_search').replace(/\/+$/, '');
  const engine = String(cfg.engine || 'search_std');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ search_engine: engine, search_query: query, count }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`智谱搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '智谱搜索返回了无法解析的 JSON');
  const arr = Array.isArray(data?.search_result) ? data.search_result : [];
  const results = arr
    .filter((r) => r?.link || r?.url)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.link ?? r.url ?? ''),
      snippet: String(r.content ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  return { query, results };
}

/** 博查 Web Search API（国内中文优化，网页结果在 data.webPages.value）。 */
export async function bochaSearch(query) {
  const cfg = getConfig().webSearch?.bocha ?? {};
  const apiKey = String(cfg.apiKey || process.env.BOCHA_API_KEY || '').trim();
  if (!apiKey) throw new Error('博查搜索需要 API Key（设置里填，或环境变量 BOCHA_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://api.bochaai.com/v1/web-search').replace(/\/+$/, '');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ query, count, freshness: 'noLimit', summary: false }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`博查搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '博查搜索返回了无法解析的 JSON');
  if (data?.code && Number(data.code) !== 200) {
    throw new Error(`博查搜索 API 错误（code ${data.code}）：${data.message || data.msg || '未知'}`);
  }
  const arr = Array.isArray(data?.data?.webPages?.value) ? data.data.webPages.value : [];
  const results = arr
    .filter((r) => r?.url)
    .map((r) => ({
      title: String(r.name ?? r.title ?? '').trim() || '（无标题）',
      url: String(r.url ?? ''),
      snippet: String(r.snippet ?? r.summary ?? r.content ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  return { query, results };
}

/** 百度千帆 AI Search（web_search，返回 references）。 */
export async function baiduSearch(query) {
  const cfg = getConfig().webSearch?.baidu ?? {};
  const apiKey = String(cfg.apiKey || process.env.BAIDU_SEARCH_API_KEY || '').trim();
  if (!apiKey) throw new Error('百度搜索需要 API Key（设置里填，或环境变量 BAIDU_SEARCH_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://qianfan.baidubce.com/v2/ai_search/web_search').replace(/\/+$/, '');
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: query }],
      search_source: 'baidu_search_v2',
      resource_type_filter: [{ type: 'web', top_k: topK }]
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`百度搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '百度搜索返回了无法解析的 JSON');
  // 千帆的错误字段有两种写法（`error_code` 与 `code`）—— 只认前一种时会把它当成功、
  // 最后报成"没有有效结果"，把真实原因盖掉（与秘塔那类 200+错误体同型）
  if (data?.error_code && Number(data.error_code) !== 0) {
    throw new Error(`百度搜索 API 错误（code ${data.error_code}）：${data.error_msg || data.message || '未知'}`);
  }
  if (data?.code && Number(data.code) !== 200 && Number(data.code) !== 0) {
    throw new Error(`百度搜索 API 错误（code ${data.code}）：${data.message || '未知'}`);
  }
  const arr = Array.isArray(data?.references) ? data.references : [];
  const results = arr
    .filter((r) => r?.url || r?.link)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  return { query, results };
}

/**
 * 秘塔 AI 搜索（metaso.cn，每天 100 次免费）。
 *
 * 官方接口是 `POST /api/v1/search`（issue #38 报的就是这个）：原来的实现三处都不对 ——
 * 地址写成 `/api/open/v1/search`（404）、请求体用 `{ query, top_k }`（官方是 `q` + `scope` + `size`）、
 * 响应读 `results|data|sources`（官方是 `webpages[]`）。三处任一错都拿不到结果，所以它其实从未成功过。
 * 契约（2026-10-17 对照官方 playground 与两个公开实现核对）：
 *   请求 { q, scope: 'webpage', size, includeSummary, includeRawContent, conciseSnippet }
 *   响应 { webpages: [{ title, link|url, snippet|summary }] }；出错时 HTTP 仍是 200，body 里是 { errCode, errMsg }。
 */
export async function metasoSearch(query) {
  const cfg = getConfig().webSearch?.metaso ?? {};
  const apiKey = String(cfg.apiKey || process.env.METASO_API_KEY || '').trim();
  const endpoint = String(cfg.baseUrl || 'https://metaso.cn/api/v1/search').replace(/\/+$/, '');
  // size 是**数字**，官方上限 50（写字符串会被拒）
  const size = Math.min(50, Math.max(1, Number(cfg.count) || 6));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      q: query,
      scope: 'webpage',
      size,
      includeSummary: false,
      includeRawContent: false,
      conciseSnippet: false
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`秘塔搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '秘塔搜索返回了无法解析的 JSON');
  // 官方出错时 HTTP 也是 200：body 里带 errCode/errMsg（例如密钥无效是 2005）。空结果现在按
  // "没搜到"正常返回，所以这些错误码是**唯一**能区分"Key 错了/额度用完"的信号，必须认。
  const errCode = Number(data?.errCode);
  if (Number.isFinite(errCode) && errCode !== 0 && errCode !== 200) {
    throw new Error(`秘塔搜索返回错误（${errCode}）：${String(data?.errMsg || data?.message || '未说明原因').slice(0, 200)}`);
  }
  const arr = Array.isArray(data?.webpages) ? data.webpages
    : Array.isArray(data?.documents) ? data.documents
    : Array.isArray(data?.results) ? data.results
    : [];
  const results = arr
    .filter((r) => r?.link || r?.url)
    .map((r) => ({
      title: String(r.title ?? '').trim() || '（无标题）',
      url: String(r.link ?? r.url ?? ''),
      snippet: String(r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  return { query, results };
}

/**
 * 豆包搜索（火山引擎 Agent Plan 订阅自带的联网搜索服务，2026-06 起替代原联网
 * 搜索 Beta；每月免费额度，无需单独付费 API Key）。Key 可直接复用 Agent Plan 的，
 * 也可用环境变量 DOUBAO_SEARCH_API_KEY。
 * 接口特点：请求体字段 PascalCase（Query / SearchType / Count / NeedContent），
 * 响应解析 Result.WebResults[]（Title / Url / Summary）。
 */
export async function doubaoSearch(query) {
  const cfg = getConfig().webSearch?.doubao ?? {};
  const apiKey = String(cfg.apiKey || process.env.DOUBAO_SEARCH_API_KEY || '').trim();
  if (!apiKey) throw new Error('豆包搜索未配置 API Key（火山 Agent Plan 搜索服务 Key，或环境变量 DOUBAO_SEARCH_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://open.feedcoopapi.com/search_api/web_search').replace(/\/+$/, '');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      Query: query,
      SearchType: 'web',
      Count: Math.min(10, Math.max(1, Number(cfg.count) || 6)),
      NeedContent: true
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`豆包搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '豆包搜索返回了无法解析的 JSON');
  // 火山这套接口失败时也返回 HTTP 200，错误信息在 ResponseMetadata.Error 里、
  // Result 为 null（Issue #8）：invalid_api_key / 10403 服务未开通 / 10406 10412
  // 额度用尽 / 700429 QPS 超限——处置方式完全不同，必须把真实错误抛出来。
  const apiError = data?.ResponseMetadata?.Error;
  if (apiError) {
    const code = String(apiError.Code ?? apiError.CodeN ?? '未知错误码');
    const message = String(apiError.Message ?? '').trim() || '无错误信息';
    throw new Error(`豆包搜索失败（${code}）：${message}`);
  }
  const arr = Array.isArray(data?.Result?.WebResults) ? data.Result.WebResults : [];
  const results = arr
    .filter((r) => r?.Url || r?.url)
    .map((r) => ({
      title: String(r.Title ?? r.title ?? '').trim() || '（无标题）',
      url: String(r.Url ?? r.url ?? ''),
      snippet: String(r.Summary ?? r.summary ?? r.Content ?? r.content ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  return { query, results };
}

/**
 * 解析自定义搜索配置。
 * providerId 形如 'custom:abc123' 时从 webSearch.providers 数组里取对应项；
 * 否则退回旧的单槽位 webSearch.custom（兼容早期配置）。
 */
function resolveCustomConfig(providerId = null) {
  const ws = getConfig().webSearch ?? {};
  if (providerId && String(providerId).startsWith('custom:')) {
    const id = String(providerId).slice('custom:'.length);
    const found = (Array.isArray(ws.providers) ? ws.providers : []).find((p) => String(p?.id) === id);
    if (found) return found;
    // 列表里找不到 → 回退单槽位，避免配置丢失后完全搜不了
  }
  return ws.custom ?? {};
}

/**
 * 用户自定义的搜索服务（provider = 'custom' 或 'custom:<id>'）。
 *
 * 两种类型：
 *   - 'openai'：POST 一个 JSON 搜索接口。为兼容各家实现，会尝试多种常见请求体字段
 *     （query / q / messages）与响应结构（results / data / sources / references / webPages）。
 *     适合 SearXNG、Tavily、自建聚合搜索等。
 *   - 'bing'：GET 一个搜索页并用 b_algo 块解析（兼容 Bing 结果格式的引擎，如部分 SearXNG 实例）。
 */
export function customSearch(query, providerId = null) {
  return withTimeWindow((signal) => customSearchRequest(query, providerId, signal));
}

async function customSearchRequest(query, providerId, signal) {
  const cfg = resolveCustomConfig(providerId);
  const type = String(cfg.type || 'openai').toLowerCase();

  if (type === 'bing') {
    return bingSearchWithUrl(query, String(cfg.baseUrl || ''));
  }

  const endpoint = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!endpoint) throw new Error('自定义搜索未配置接口地址（设置 → 模型 API → 搜索提供方 → 自定义）');
  const apiKey = String(cfg.apiKey || '').trim();
  const model = String(cfg.model || '').trim();
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  // 兼容多种请求体：优先 query / q，带 model 时额外附上 messages（Responses API 风格）
  const body = { query, q: query, top_k: topK, count: topK };
  if (model) {
    body.model = model;
    body.messages = [{ role: 'user', content: query }];
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))])
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`自定义搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, '自定义搜索返回了无法解析的 JSON');

  // 兜住各家字段名
  const arr = Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.sources) ? data.sources
    : Array.isArray(data?.references) ? data.references
    : Array.isArray(data?.webPages?.value) ? data.webPages.value
    : Array.isArray(data) ? data
    : [];

  const results = arr
    .filter((r) => r && (r.url || r.link))
    .map((r) => ({
      title: String(r.title ?? r.name ?? r.headline ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? r.body ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) {
    throw new Error('自定义搜索没有返回可识别的结果（请检查接口返回是否包含 results/data/sources 等数组，或改用 bing 类型抓页面）');
  }
  return { query, results };
}

/** 用指定 URL 跑一次 Bing 结果的 HTML 解析（供自定义 bing 类型复用）。 */
async function bingSearchWithUrl(query, searchUrl) {
  const cfg = getConfig().webSearch ?? {};
  const url = String(searchUrl || cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const target = new URL(url);
  target.searchParams.set('q', query);
  const res = await fetch(target, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`自定义搜索（bing 类型）HTTP ${res.status}`);
  const html = await readTextBounded(res, BING_HTML_MAX_BYTES);
  const results = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= maxResults) break;
  }
  if (!results.length) throw new Error('自定义搜索（bing 类型）没有解析到结果，请确认该引擎返回 b_algo 结构');
  return { query, results };
}

/**
 * Tavily 搜索（tavily.com，专为 LLM 设计的搜索 API，免费档 1000 次/月）。
 * POST https://api.tavily.com/search { api_key, query, max_results } 或 Bearer 头。
 * 响应 results[]: { title, url, content, score }。
 */
export async function tavilySearch(query) {
  const cfg = getConfig().webSearch?.tavily ?? {};
  const apiKey = String(cfg.apiKey || process.env.TAVILY_API_KEY || '').trim();
  if (!apiKey) throw new Error('Tavily 未配置 API Key（config.webSearch.tavily.apiKey 或环境变量 TAVILY_API_KEY）');
  const res = await fetch(String(cfg.baseUrl || 'https://api.tavily.com/search'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      max_results: Math.min(10, Math.max(1, Number(cfg.count) || 5)),
      search_depth: String(cfg.searchDepth || 'basic')
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await readTextBounded(res, SEARCH_JSON_MAX_BYTES).catch(() => '');
    throw new Error(`Tavily HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await readSearchJson(res, 'Tavily 返回了无法解析的 JSON');
  const arr = Array.isArray(data?.results) ? data.results : [];
  const results = arr
    .filter((r) => r?.url)
    .map((r) => ({
      title: String(r.title ?? '').trim() || '（无标题）',
      url: String(r.url),
      snippet: String(r.content ?? '').trim()
    }));
  return { query, results };
}
