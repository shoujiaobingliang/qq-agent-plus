// 自定义插件索引来源：解析用户输入、探测可用性、生成可落盘的来源列表。
//
// 为什么要单独一层：`plugins.indexUrls` 一直支持多条索引，但入口只有手改 config.json。
// 控制台要允许用户自己加市场，就必须在**保存之前**确认"这个地址真的是一份本机能读的索引"——
// 否则用户会得到一个永远空着的来源，还以为是市场坏了。
//
// 两种输入形态：
//   · 完整索引地址（https://example.com/index.json）→ 原样使用；
//   · GitHub 仓库地址（https://github.com/owner/repo）→ 按约定探测
//     `plugins/index.json`，再退回仓库根目录的 `index.json`（与官方索引仓库同一种布局）。
//
// 这里只认 http(s) 且交给调用方注入的 fetchText（控制台传 safeFetch）：本模块自己不联网，
// SSRF / 体积 / 超时守卫都在安全抓取那一层，用例才能用假抓取把正反例钉死。
import { fetchPluginIndex } from './install.js';

/** 自定义来源上限：来源越多，每次打开市场要并发拉取的地址越多，失败面也越大。 */
export const MAX_CUSTOM_INDEX_SOURCES = 8;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 60;

function sourceError(message, code = 'E_INDEX_SOURCE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanName(name, fallback = '') {
  const text = Array.from(String(name ?? ''))
    // 控制字符（含换行）不能进配置：它会把日志与界面排版一起打乱。
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return text || String(fallback || '').slice(0, MAX_NAME_LENGTH);
}

/**
 * 归一化用户填的地址。
 * - 允许省略协议：`github.com/owner/repo` → `https://github.com/owner/repo`（和浏览器地址栏一致）；
 * - 只收 http(s)，拒绝带用户名/密码的地址（会被原样写进配置与日志）；
 * - 去掉 hash（它不会发给服务器，留着只会让去重误判）。
 */
export function normalizeSourceUrl(raw) {
  let text = String(raw ?? '').trim();
  if (!text) throw sourceError('来源地址不能为空', 'E_SOURCE_URL');
  if (text.length > MAX_URL_LENGTH) {
    throw sourceError(`来源地址不能超过 ${MAX_URL_LENGTH} 个字符`, 'E_SOURCE_URL');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|$)/i.test(text)) text = `https://${text}`;
    else throw sourceError('来源地址要以 http:// 或 https:// 开头', 'E_SOURCE_URL');
  }
  let url;
  try { url = new URL(text); } catch { throw sourceError('来源地址不是合法 URL', 'E_SOURCE_URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw sourceError('来源地址只支持 http(s)', 'E_SOURCE_URL');
  }
  if (url.username || url.password) {
    throw sourceError('来源地址不能带用户名或密码', 'E_SOURCE_URL');
  }
  url.hash = '';
  const normalized = url.toString();
  if (normalized.length > MAX_URL_LENGTH) {
    throw sourceError(`来源地址不能超过 ${MAX_URL_LENGTH} 个字符`, 'E_SOURCE_URL');
  }
  return normalized;
}

/** 识别 `github.com/owner/repo`（只认这种最简形态；`/tree/...` 之类按普通地址处理）。 */
export function githubRepoOf(normalizedUrl) {
  let url;
  try { url = new URL(normalizedUrl); } catch { return null; }
  if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/**
 * 输入 → 真正要抓取的候选地址（按优先级）。
 * GitHub 仓库先试 `plugins/index.json`（官方索引仓库的布局），再试根目录 `index.json`。
 */
export function sourceUrlCandidates(raw) {
  const url = normalizeSourceUrl(raw);
  const repo = githubRepoOf(url);
  if (!repo) return { url, kind: 'index', repo: '', candidates: [url] };
  const base = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD`;
  return {
    url,
    kind: 'repo',
    repo: `${repo.owner}/${repo.repo}`,
    candidates: [`${base}/plugins/index.json`, `${base}/index.json`]
  };
}

function fallbackName(spec, candidate) {
  if (spec.repo) return spec.repo;
  try {
    const url = new URL(candidate);
    return `${url.hostname}${url.pathname}`.slice(0, MAX_NAME_LENGTH);
  } catch {
    return String(candidate || '').slice(0, MAX_NAME_LENGTH);
  }
}

/** 校验并归一化用户提交的整份来源列表（字符串或 { url, name } 都认）。 */
export function normalizeSourceInputs(inputs) {
  if (!Array.isArray(inputs)) throw sourceError('来源列表必须是数组', 'E_SOURCE_LIST');
  if (inputs.length > MAX_CUSTOM_INDEX_SOURCES) {
    throw sourceError(`最多只能添加 ${MAX_CUSTOM_INDEX_SOURCES} 个自定义来源`, 'E_SOURCE_LIST');
  }
  const out = [];
  const seen = new Set();
  inputs.forEach((item, index) => {
    const rawUrl = typeof item === 'string' ? item : item?.url;
    const rawName = typeof item === 'string' ? '' : item?.name;
    if (rawUrl === undefined || rawUrl === null) {
      throw sourceError(`第 ${index + 1} 个来源缺少地址`, 'E_SOURCE_URL');
    }
    const url = normalizeSourceUrl(rawUrl);
    if (seen.has(url)) return;   // 同一条地址重复提交时静默去重，不因为用户贴了两遍就整体失败
    seen.add(url);
    out.push({ url, name: cleanName(rawName, '') });
  });
  if (inputs.length && !out.length) throw sourceError('没有有效的来源地址', 'E_SOURCE_LIST');
  return out;
}

/**
 * 探测单个来源：必须真的拉到一份能解析出 `plugins` 数组的索引，才算可用。
 * 返回落盘需要的形状（url 是最终命中的地址；name 缺省时按仓库名/主机名补）。
 */
export async function probeIndexSource({
  input, name = '', fetchText, log = () => {}, hostVersion = ''
} = {}) {
  const spec = sourceUrlCandidates(input);
  const errors = [];
  for (const candidate of spec.candidates) {
    try {
      const result = await fetchPluginIndex({
        url: candidate,
        name: cleanName(name, fallbackName(spec, candidate)),
        fetchText,
        log,
        hostVersion
      });
      return {
        url: candidate,
        name: cleanName(name, fallbackName(spec, candidate)),
        repo: spec.repo,
        count: Array.isArray(result?.entries) ? result.entries.length : 0,
        skipped: Array.isArray(result?.skipped) ? result.skipped.length : 0
      };
    } catch (error) {
      errors.push(`${candidate}：${String(error?.message ?? error)}`);
    }
  }
  throw sourceError(`索引来源不可用：${errors.join('；')}`, 'E_SOURCE_UNREACHABLE');
}

/**
 * 批量探测并返回可落盘的来源列表。**原子语义**：任一来源不可用就整体失败，
 * 调用方不应该把半份列表写进配置（否则用户点一次保存，旧来源没了、新来源还是坏的）。
 */
export async function resolveIndexSources({
  inputs, fetchText, log = () => {}, hostVersion = ''
} = {}) {
  const normalized = normalizeSourceInputs(inputs);
  const settled = await Promise.all(normalized.map(async (item) => {
    try {
      return { ok: true, source: await probeIndexSource({ input: item.url, name: item.name, fetchText, log, hostVersion }) };
    } catch (error) {
      return {
        ok: false,
        name: cleanName(item.name, item.url),
        error: String(error?.message ?? error)
      };
    }
  }));
  const failed = settled.filter((item) => !item.ok);
  if (failed.length) {
    const error = sourceError(
      `自定义来源校验失败：${failed.map((item) => `${item.name}（${item.error}）`).join('；')}`,
      'E_SOURCE_INVALID'
    );
    error.sources = failed.map(({ name, error: message }) => ({ name, error: message }));
    throw error;
  }
  const seen = new Set();
  const sources = [];
  for (const item of settled) {
    const source = item.source;
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push({
      url: source.url,
      name: source.name,
      ...(source.repo ? { repo: source.repo } : {})
    });
  }
  return sources;
}
