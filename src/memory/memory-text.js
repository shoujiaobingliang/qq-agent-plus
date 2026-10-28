// 记忆检索的文本工具：中文 bigram、FTS 影子文本、精确去重口径。
// 纯函数、零依赖，方便单测，也避免把分词逻辑散进存储层。
//
// 为什么不用 FTS5 默认的 unicode61：它按空白/标点切词，整段中文会变成一个 token，
// 两字词（“暗号”“开黑”）根本命中不了。这里在应用层生成重叠 bigram，再用空格连接，
// 让 unicode61 只负责按空格切分；查询侧用同样的 bigram + OR 匹配。

/** 用于检索/比较的规范化：NFKC、折叠空白、小写（只影响拉丁字母）。 */
export function normalizeForSearch(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 用于 content_hash 的规范化：NFKC + 折叠空白 + trim。
 * 不转小写、不删标点 —— 暗号可能区分大小写/标点（与 daily-memory.md 同口径）。
 */
export function normalizeForHash(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** 比较“是不是同一句话”时用：去掉空白、标点、符号，并小写。 */
export function compactForCompare(value) {
  return normalizeForSearch(value).replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 生成检索 token：中文按重叠 bigram，拉丁/数字按整词。
 * 保留重复项（FTS5 会据此计算词频），不要在函数里做 Set 去重。
 */
export function tokenizeForSearch(value) {
  const text = normalizeForSearch(value);
  const runs = text.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) || [];
  const tokens = [];
  for (const run of runs) {
    if (/^\p{Script=Han}+$/u.test(run)) {
      if (run.length === 1) tokens.push(run);
      else for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
    } else {
      tokens.push(run);
    }
  }
  return tokens;
}

/** 写入 FTS 的影子文本：abstract + content + keywords 的 bigram/词元，空格连接。 */
export function buildSearchText({ abstract = '', content = '', keywords = [] } = {}) {
  const kws = Array.isArray(keywords) ? keywords.map(String) : [];
  return tokenizeForSearch([abstract, content, ...kws].filter(Boolean).join(' ')).join(' ');
}

/**
 * FTS5 MATCH 查询串：每个 token 加双引号、用 OR 连接。
 * token 只可能是汉字/拉丁/数字，不含 FTS 语法字符，因此不需要额外转义。
 */
export function buildMatchQuery(value) {
  const tokens = [...new Set(tokenizeForSearch(value))];
  return tokens.map((token) => `"${token}"`).join(' OR ');
}

/** 关键词是否出现在查询文本里（用于 contextMatch；中文用子串，拉丁用整词）。 */
export function keywordMatchesQuery(keyword, query) {
  const kw = normalizeForSearch(keyword);
  const q = normalizeForSearch(query);
  if (!kw || !q) return false;
  if (/[\p{Script=Han}]/u.test(kw)) return q.includes(kw);
  return new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(q);
}
