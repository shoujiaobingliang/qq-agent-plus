// 控制台"前端构建戳"：/api/status 带上它，前端轮询发现它变了就提示"控制台已更新，点此刷新"。
//
// 单独成模块是为了**能测**：它原来写在 app.js 里（那个文件一万多行、没法单独跑），而它的正确性
// 直接决定"只同步 ui/、不重启服务"这条路成不成立 —— 戳要是漏算了某个文件，已打开的页面就永远
// 收不到刷新提示，用户拿着旧 JS 对着新 CSS 跑。
import fs from 'node:fs';
import path from 'node:path';

// 生产环境默认缓存 30 秒：/api/status 每 15 秒轮询一次，没必要每次都递归 stat 全部前端文件。
// 测试/诊断可以传 ttlMs: 0 强制现算（默认就是 0，保持原有逐次计算语义）。
const STAMP_CACHE = new Map();
const STAMP_CACHE_MAX = 8;

/**
 * 按 ui/ 目录下**所有前端资源**的体积 + 修改时间算一份戳（递归，只认 js/mjs/css/html/svg）。
 *
 * 为什么不写死文件名清单：原来那份清单只有 6 个文件，漏掉了 `ui/pages/*.js` 与 `ui/core/*.js`
 * —— 而它们才是改得最勤的（2026-10-16 改的正是 pages/plugins.js，戳不变 → 刷新提示永远不出现）。
 * 代价是每个请求几十次 statSync；生产调用方用 ttlMs=30000 把它压到最多每 30 秒一次。
 *
 * @param uiDir 目标目录（默认由调用方传入真实 ui/；测试传临时目录）
 * @param {{ ttlMs?: number }} options ttlMs>0 时缓存结果；0 = 每次现算（测试默认）
 */
export function uiBuildStamp(uiDir, { ttlMs = 0 } = {}) {
  const key = path.resolve(String(uiDir || ''));
  const ttl = Math.max(0, Number(ttlMs) || 0);
  if (ttl > 0) {
    const hit = STAMP_CACHE.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
  }
  const files = [];
  const walk = (dir) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of list) {
      if (item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (/\.(?:js|mjs|css|html|svg)$/i.test(item.name)) files.push(full);
    }
  };
  walk(uiDir);
  // 排序保证戳的形状稳定（readdir 的顺序不保证一致，否则同样内容会算出不同的戳）
  const value = files.sort().map((full) => {
    const rel = path.relative(uiDir, full).split(path.sep).join('/');
    try {
      const s = fs.statSync(full);
      return `${rel}:${s.size}:${Math.round(s.mtimeMs)}`;
    } catch { return `${rel}:missing`; }
  }).join('|');
  if (ttl > 0) {
    STAMP_CACHE.set(key, { at: Date.now(), value });
    if (STAMP_CACHE.size > STAMP_CACHE_MAX) {
      const oldest = STAMP_CACHE.keys().next().value;
      if (oldest !== undefined) STAMP_CACHE.delete(oldest);
    }
  }
  return value;
}
