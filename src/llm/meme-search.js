// 梗来源检索：萌娘百科等「梗站」的定向查询。
//
// 只在普通搜索的结果代回原句仍读不通时由模型显式触发；默认源、超时、结果数
// 都在 webSearch.memes 下配置。梗站自身也可能错/过时/带攻击性，所以这里只返回
// 原始短摘要，不作为权威结论；写入库时统一进 candidate。
//
// 萌娘百科的 MediaWiki API 对未授权调用直接返回 `action-notallowed`
// （2026-10-22 实测），所以默认走 Special:搜索 的 HTML 结果页；
// API 类型保留给自建/已授权 wiki，失败时也会回退到 HTML 搜索页。
import { parse as parseHtml } from 'node-html-parser';
import { getConfig } from '../core/config.js';
import { normalizeTerm } from '../core/slang-store.js';
import { safeFetch } from './safe-fetch.js';
import { sanitizeQuery, webSearch } from './web-search.js';

const DEFAULT_SITES = [
  {
    name: '萌娘百科',
    type: 'mediawiki-html',
    apiUrl: 'https://mzh.moegirl.org.cn/api.php',
    articleUrl: 'https://mzh.moegirl.org.cn/',
    searchUrl: 'https://mzh.moegirl.org.cn/index.php?title=Special:搜索&fulltext=1'
  }
];

const MAX_BYTES = 1024 * 1024;

function decodeHtml(value) {
  return String(value ?? '')
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

function memeConfig() {
  const cfg = getConfig().webSearch?.memes ?? {};
  const sites = Array.isArray(cfg.sites) && cfg.sites.length ? cfg.sites : DEFAULT_SITES;
  return {
    enabled: cfg.enabled !== false,
    sites,
    maxResults: Math.min(8, Math.max(1, Number(cfg.maxResults) || 4)),
    timeoutMs: Math.min(30000, Math.max(3000, Number(cfg.timeoutMs) || 12000)),
    webFallback: cfg.webFallback !== false
  };
}

/** 解析 MediaWiki `list=search` 响应（导出给测试；梗站返回结构变化时先在这里兜）。 */
export function parseMediaWikiResults(data, site, maxResults = 4) {
  const items = Array.isArray(data?.query?.search) ? data.query.search : [];
  const base = String(site?.articleUrl || site?.apiUrl || '').trim();
  return items
    .map((item) => {
      const title = decodeHtml(item?.title);
      if (!title) return null;
      return {
        title,
        url: base ? `${base.replace(/\/+$/, '')}/${encodeURIComponent(title.replace(/ /g, '_'))}` : '',
        snippet: decodeHtml(item?.snippet),
        source: String(site?.name || 'meme').toLowerCase().replace(/\s+/g, '-')
      };
    })
    .filter(Boolean)
    .slice(0, maxResults);
}

async function searchMediaWiki(site, term, { maxResults, timeoutMs }) {
  const endpoint = String(site.apiUrl || '').trim();
  if (!endpoint) throw new Error(`${site.name || '梗站'}缺少 apiUrl`);
  const url = new URL(endpoint);
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', term);
  url.searchParams.set('srlimit', String(maxResults));
  url.searchParams.set('srprop', 'snippet|titlesnippet');
  url.searchParams.set('format', 'json');
  url.searchParams.set('utf8', '1');
  const res = await safeFetch(url.toString(), {
    maxBytes: MAX_BYTES,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error('返回了无法解析的 JSON');
  }
  // 萌娘百科等站点对未授权 API 返回 200 + error（action-notallowed），
  // 不能当成"0 条结果"静默吞掉，否则调用方会以为是词条不存在。
  if (data?.error) throw new Error(`API 拒绝：${data.error.info || data.error.code || '未知错误'}`);
  return parseMediaWikiResults(data, site, maxResults);
}

/** 解析 MediaWiki Special:搜索 的结果页（`.mw-search-result`）。 */
export function parseMediaWikiHtml(html, site, maxResults = 4) {
  const root = parseHtml(String(html || ''));
  const base = String(site?.articleUrl || site?.searchUrl || '').trim();
  const source = String(site?.name || 'meme').toLowerCase().replace(/\s+/g, '-');
  const results = [];
  for (const item of root.querySelectorAll('.mw-search-result')) {
    const link = item.querySelector('.mw-search-result-heading a') || item.querySelector('a');
    const title = String(link?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const href = String(link?.getAttribute('href') || '');
    let url = '';
    try {
      url = href ? new URL(href, base || site?.searchUrl || undefined).toString() : '';
    } catch { url = ''; }
    const snippet = String(item.querySelector('.searchresult')?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    results.push({ title, url, snippet, source });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function searchMediaWikiHtml(site, term, { maxResults, timeoutMs }) {
  const configured = String(site.searchUrl || '').trim();
  const article = String(site.articleUrl || '').trim();
  const base = configured || (article ? `${article.replace(/\/+$/, '')}/index.php?title=Special:搜索&fulltext=1` : '');
  if (!base) throw new Error(`${site.name || '梗站'}缺少 searchUrl`);
  const url = new URL(base);
  url.searchParams.set('search', term);
  url.searchParams.set('fulltext', '1');
  const res = await safeFetch(url.toString(), {
    maxBytes: MAX_BYTES,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  return parseMediaWikiHtml(res.body, site, maxResults);
}

function normalizeForMatch(value) {
  // 站内搜索结果摘要可能很长；不要用 normalizeTerm（按词条截断到 80 字），
  // 否则词出现在后半段会被误判成"无关条目"。
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function mentionsKey(text, key) {
  if (!key) return false;
  const normalized = normalizeForMatch(text);
  // 站内搜索的高亮标签可能把词拆开；去掉空白再比一次。
  return normalized.includes(key) || normalized.replace(/\s+/g, '').includes(key.replace(/\s+/g, ''));
}

/** 词条命中的排前面：站内搜索常返回"名字里带某个字"的无关条目。 */
function rankResults(results, term, maxResults) {
  const key = normalizeTerm(term);
  const scored = results.map((item, index) => {
    const title = normalizeForMatch(item?.title);
    const text = normalizeForMatch(`${item?.title || ''} ${item?.snippet || ''}`);
    const score = title === key ? 2 : (mentionsKey(text, key) ? 1 : 0);
    return { item, score, index };
  });
  // 一条都不命中词条 = 这个源其实没搜到（MediaWiki 站内搜索会返回大量
  // "名字里带同一个字"的无关页面）。交给上层回退，别把无关条目喂给模型。
  const matched = scored.filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const out = [];
  const seen = new Set();
  for (const { item } of matched) {
    const dedupe = `${item?.url || ''}|${item?.title || ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(item);
    if (out.length >= maxResults) break;
  }
  return out;
}

function fallbackHosts(sites) {
  const hosts = [];
  for (const site of sites) {
    for (const raw of [site.apiUrl, site.articleUrl, site.searchUrl]) {
      try {
        const host = new URL(String(raw || '')).hostname;
        if (host && !hosts.includes(host)) hosts.push(host);
      } catch { /* ignore */ }
    }
  }
  if (!hosts.length) hosts.push('mzh.moegirl.org.cn');
  return hosts.slice(0, 2);
}

async function webFallback(term, sites, { maxResults, webSearchFn }) {
  const hosts = fallbackHosts(sites);
  const query = `site:${hosts[0]} ${term}`;
  const result = await webSearchFn(query);
  const results = (result?.results || []).map((item) => ({
    title: String(item?.title || ''),
    url: String(item?.url || ''),
    snippet: String(item?.snippet || ''),
    source: 'web'
  }));
  // 有的搜索供应商不认 site: 操作符，会混进"某个字相同"的无关结果；
  // 按词条命中排序，至少让模型先看到相关的。
  return rankResults(results, term, maxResults);
}

async function searchSite(site, term, cfg) {
  const type = String(site?.type || (site?.searchUrl ? 'mediawiki-html' : 'mediawiki')).toLowerCase();
  if (type === 'mediawiki-html') return searchMediaWikiHtml(site, term, cfg);
  if (type !== 'mediawiki') throw new Error(`未知梗站类型：${type}`);
  try {
    return await searchMediaWiki(site, term, cfg);
  } catch (error) {
    // 未授权 API / 改版：有搜索页就回退 HTML；没有就把原始错误交给上层。
    if (!site?.searchUrl && !site?.articleUrl) throw error;
    try {
      return await searchMediaWikiHtml(site, term, cfg);
    } catch {
      throw error;
    }
  }
}

/**
 * 查询配置的梗站。配置的源全部失败/无结果时，若 webFallback 开着，
 * 再用普通搜索加 site: 限定回退一次（梗站 API 常被 Cloudflare 挡）。
 */
export async function searchMemeSources(term, { webSearchFn = webSearch } = {}) {
  const cfg = memeConfig();
  if (!cfg.enabled) throw new Error('梗来源检索已在设置中关闭');
  const clean = sanitizeQuery(term);
  if (!clean) throw new Error('梗词为空');

  const settled = await Promise.allSettled(cfg.sites.slice(0, 3).map((site) =>
    searchSite(site, clean, cfg)));
  const results = [];
  const errors = [];
  for (const item of settled) {
    if (item.status === 'fulfilled') results.push(...item.value);
    else errors.push(String(item.reason?.message ?? item.reason));
  }
  const unique = rankResults(results, clean, cfg.maxResults);
  if (unique.length) return { term: clean, results: unique, errors };

  if (cfg.webFallback && getConfig().webSearch?.enabled !== false) {
    try {
      const fallback = await webFallback(clean, cfg.sites, {
        maxResults: cfg.maxResults,
        webSearchFn
      });
      if (fallback.length) return { term: clean, results: fallback, errors, viaWeb: true };
    } catch (error) {
      errors.push(`普通搜索回退失败：${error?.message ?? error}`);
    }
  }
  throw new Error(`梗来源没有返回结果${errors.length ? `：${errors.join('；').slice(0, 300)}` : ''}`);
}
