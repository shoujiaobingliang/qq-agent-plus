// 安全抓取层（完整移植自原版 safe-fetch + mcp-web-search-safe 的 SSRF 防护）。
//
// - 仅 http/https；禁止 URL 内嵌凭据；
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
// - 域名先做 DNS 解析并检查全部解析结果；解析后固定到已校验的 IP 发请求（防 DNS rebinding）；
// - 手动跟随重定向，每一跳重新校验；
// - 响应体限量读取，避免超大响应拖垮进程。
//
// 例外开关：security.allowPrivateImageHosts = true 时，图片下载跳过内网检查
// （仅供本地测试/自建图床使用，默认关闭）。
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { getConfig } from '../core/config.js';

const dnsLookup = dns.promises.lookup;

// ── IP 判定 ─────────────────────────────────────────────────────────────

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1 等）。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

// ── 主机名校验（含 DNS） ────────────────────────────────────────────────

async function lookupWithTimeout(hostname) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => clearTimeout(timer));
}

async function resolveSafeHost(hostname, { allowPrivate = false } = {}) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (!allowPrivate && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'))) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (!allowPrivate && isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isPrivateIp(address)) throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

/** 校验 URL 的 scheme 与主机（DNS 级）。返回 { url, ip }。 */
export async function validateFetchUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname, { allowPrivate });
  return { url, ip };
}

// ── 受限请求 ────────────────────────────────────────────────────────────

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

export function readBounded(res, maxBytes, asText) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const chunks = [];
    let total = 0;
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (asText) text += decoder.write(chunk);
      else chunks.push(chunk);
      // 只用字节数判断是否超限。**必须是 > 不能是 >=**：正好等于上限的响应是完整的，
      // 用 >= 会在读满那一刻就 destroy 并把它误标成 truncated（2026-10-09 审查）。
      //
      // truncated 标记由**读取路径**如实带出（不再让调用方拿 body 长度反推）：截断后的
      // 正文长度可能恰好等于上限（英文页截到 50000 字节就是），反推会漏标。
      if (total > maxBytes) {
        try { res.destroy(); } catch { /* ignore */ }
        finish(resolve, {
          truncated: true,
          body: asText ? sliceByCodePoints(text, maxBytes) : Buffer.concat(chunks).subarray(0, maxBytes)
        });
      }
    });
    res.on('end', () => {
      if (!settled) {
        if (asText) {
          text += decoder.end();
          // 自然读尽 = 没被截断（走到这里 total 必 ≤ maxBytes，slice 只是防御）
          finish(resolve, { truncated: false, body: sliceByCodePoints(text, maxBytes) });
        } else {
          finish(resolve, { truncated: false, body: Buffer.concat(chunks) });
        }
      }
    });
    res.on('error', (err) => finish(reject, err));
  });
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
function requestOnce(url, ip, { asBinary = false, maxBytes = 50000, signal } = {}) {  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9'
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      signal,
      timeout: 20000
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        // 不要 resume() 排空响应体：它不计入 maxBytes，恶意目标可以一直吐数据把连接占住
        res.destroy();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBounded(res, maxBytes, !asBinary)
        .then(({ body, truncated }) => resolve({ statusCode, body, truncated, contentType: String(res.headers['content-type'] || '') }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

const MAX_REDIRECTS = 5;

/**
 * 抓取网页文本（默认 ≤50000 字符），SSRF 全防护（不做内网例外）。
 * `maxBytes` 只给"结构化文件"用（插件索引随条目增多会长过网页那份上限）；
 * 网页抓取保持默认值，避免把整页塞进上下文。
 */
export async function safeFetch(urlString, { maxBytes = 50000, signal } = {}) {
  const cap = Math.max(1, Math.floor(Number(maxBytes) || 50000));
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // signal 用于"整次抓取的总截止时间"：默认的 timeout 是**空闲超时**，对端每隔十几秒吐一个
    // 字节就能把连接一直吊着（慢速攻击面，2026-10-17 审查 P3）
    const result = await requestOnce(url, ip, { asBinary: false, maxBytes: cap, signal });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    // truncated 由读取路径给出（"真的被截断"）：不能再拿长度反推 —— 截断后的正文可能
    // 恰好等于 50000 字节，反推会把它当成完整内容交给模型（2026-10-09 审查）。
    return { url: url.toString(), statusCode: result.statusCode, truncated: Boolean(result.truncated), body };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 下载二进制（图片，≤maxBytes 字节），返回 { buffer, contentType }。 */
export async function safeFetchBinary(urlString, maxBytes = 12 * 1024 * 1024, signal) {
  const allowPrivate = getConfig().security?.allowPrivateImageHosts === true;
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    signal?.throwIfAborted();
    const result = await requestOnce(url, ip, { asBinary: true, maxBytes: maxBytes + 1, signal });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      continue;
    }
    if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
    if (result.truncated || result.body.length > maxBytes) throw new Error(`响应体超过 ${maxBytes} 字节限制`);
    return { buffer: result.body, contentType: result.contentType };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 单次请求：把响应体**边读边写**到 targetPath，绝不把整包读进 Node 内存。
 *
 * 背景（2026-10-26 事故复盘）：safeFetchBinary 用 Buffer.concat 收完整包，96MB 视频
 * 的峰值是 ~192MB（chunks + concat），200MB 音频接近 400MB。这台 1.6GB 的机器上，
 * 一次这样的分配就会触发内核回收页缓存，把 QQ 的 mmap 页踢出去，进入读盘抖动。
 * 这里改成流式落盘：内存里只留当前 chunk，体积上限靠 total 计数和 content-length 双保险。
 */
function requestOnceToFile(url, ip, { maxBytes, signal, targetPath } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    let settled = false;
    let out = null;
    let total = 0;
    let onAbort = null;

    const detach = () => {
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      }
    };
    const cleanupFile = () => {
      const unlink = () => {
        try { fs.rmSync(targetPath, { force: true }); } catch { /* ignore */ }
      };
      // Windows 上打开中的文件删不掉：等写流 close 之后再做 unlink
      if (out && !out.closed) {
        out.once('close', unlink);
        try { out.destroy(); } catch { unlink(); }
      } else {
        unlink();
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      detach();
      cleanupFile();
      reject(error);
    };

    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
        accept: 'image/avif,image/webp,image/*,video/*,audio/*,*/*',
        'accept-encoding': 'identity',
        'accept-language': 'zh-CN,zh;q=0.9'
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      signal,
      timeout: 20000
    }, (res) => {
      const statusCode = res.statusCode || 0;
      const contentType = String(res.headers['content-type'] || '');
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.destroy();
        if (!settled) {
          settled = true;
          detach();
          resolve({ statusCode, redirect: String(res.headers.location || '') });
        }
        return;
      }
      if (statusCode !== 200) {
        res.destroy();
        if (!settled) {
          settled = true;
          detach();
          resolve({ statusCode, contentType });
        }
        return;
      }
      // content-length 先判：能提前拒绝就不创建文件
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        // 先判失败再 destroy：否则 close/aborted 会抢先报成"连接中断"，掩盖真正的超限原因
        fail(new Error(`响应体超过 ${maxBytes} 字节限制`));
        res.destroy();
        return;
      }
      try {
        out = fs.createWriteStream(targetPath, { mode: 0o600 });
      } catch (error) {
        fail(error);
        return;
      }
      out.on('error', fail);
      out.on('finish', () => {
        if (settled) return;
        settled = true;
        detach();
        resolve({ statusCode, contentType, bytes: total });
      });
      // 同时在 data 上计数（pipe 内部也监听 data，两者都能收到 chunk）：
      // 一旦超限立即断开，绝不把剩余数据继续写进磁盘。
      res.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          // 同上：先结算超限错误，再断流
          fail(new Error(`响应体超过 ${maxBytes} 字节限制`));
          try { res.unpipe(out); } catch { /* ignore */ }
          try { res.destroy(); } catch { /* ignore */ }
        }
      });
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('响应连接中断')));
      res.on('close', () => {
        // 没读完就关（对端重置/超时）不能把半截文件当成完整下载
        if (!res.complete) fail(new Error('响应连接中断'));
      });
      res.pipe(out);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', fail);
    if (signal) {
      onAbort = () => req.destroy(signal.reason ?? new Error('已中止'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

/**
 * 流式下载二进制到文件（图片/视频/音频专用），返回 { file, contentType, bytes }。
 * SSRF/重定向口径与 safeFetchBinary 完全一致，只是不再把整包留在内存里。
 * 超限时抛与 safeFetchBinary 相同的文案（`响应体超过 N 字节限制`），
 * 调用方现有的超限识别逻辑（OVERSIZE_LIMIT_RE）不用改。
 */
export async function safeFetchToFile(urlString, maxBytes, targetPath, signal) {
  const cap = Math.max(1, Math.floor(Number(maxBytes) || 1));
  const allowPrivate = getConfig().security?.allowPrivateImageHosts === true;
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    signal?.throwIfAborted();
    const result = await requestOnceToFile(url, ip, { maxBytes: cap, signal, targetPath });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location：${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      continue;
    }
    if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
    return { file: targetPath, contentType: result.contentType, bytes: result.bytes };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 图片地址校验（供 send_sticker / 图片下载使用）。
 * 默认内网地址一律拒绝；security.allowPrivateImageHosts=true 时放行（仅本地测试/自建图床）。
 */
export async function validateImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('图片地址不合法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 图片地址');
  if (getConfig().security?.allowPrivateImageHosts === true) return url.toString();
  const { url: safeUrl } = await validateFetchUrl(url.toString());
  return safeUrl.toString();
}

/**
 * 通用「必须是公网 http(s) 地址」校验 —— 给**不经过 safe-fetch 抓取**、而是把地址
 * 原文交给协议端（OneBot）去下载的工具用。
 *
 * 为什么必须有这一层：safe-fetch 只管自己发出的请求。`send_group_file` / `set_my_avatar` /
 * `read_image_text` / `upload_to_group_album` 这类工具是把 `file`/`image` 参数原样交给协议端
 * 的 API，由协议端去取 —— 该请求完全在我们的网络层之外，safe-fetch 的内网/SSRF 防护一点也
 * 盖不到。而协议端（Docker 容器）是能顺着 docker bridge 访问宿主的，于是「模型被群消息里的
 * 提示词注入 → 调用工具时给一个内网地址」就成了一条现成的 SSRF + 数据外带通道（把内网响应
 * 当文件发进群）。2026-10-09 全面审查发现。
 *
 * 与 validateImageUrl 分开而不是复用它：这个的报错文案必须是通用的（不是「图片地址」），
 * 否则用户发文件失败时看到一句“图片地址不合法”会一头雾水。
 *
 * 内网例外沿用同一个开关（security.allowPrivateImageHosts，默认关）：本地测试/自建图床
 * 靠它放行，生产默认是 fail-closed 的。
 *
 * **为什么是同步的、而且不做 DNS**（2026-10-09 审查里踩过一次才定下来）：
 * 一开始这层复用了 validateFetchUrl（带 DNS 解析）。实测有两个问题：
 *   ① 它把每一次工具调用（读图/换头像/发文件/传相册）都绑到了“我们这边 DNS 可用”上，
 *      离线或内网部署下这些功能全部直接失败（test/sim-group-tools 当场变红就是这个原因）；
 *   ② 它并不能真的防 DNS rebinding —— 地址最终是**协议端**去解析的，我们解析到的 IP
 *      约束不了它的解析结果。多花一次网络往返，买到的安全感是假的。
 * 字面量检查零成本、零依赖，且能拦住实际攻击 payload 的绝大多数（提示词注入里几乎只会写
 * 127.0.0.1 / 169.254.169.254 / 10.x / 172.17.0.1 / localhost 这类字面量）。
 *
 * **已知未防护（明说，别当成漏洞又"修"回去）**：域名解析到内网（如
 * `http://169.254.169.254.nip.io/…`）这层拦不住 —— 地址最终由协议端解析，我们解析到的 IP
 * 约束不了它的结果。要闭合这条路只能改成"我们自己用 safeFetchBinary 取回、再把 base64
 * 交给协议端"（本地文件已经是这个模式），那是一次功能改造而不是加几行校验（2026-10-09 审查）。
 */
export function assertPublicUrlLiteral(raw, { label = '地址' } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error(`${label}不合法`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`只允许 http(s) 的${label}`);
  if (url.username || url.password) throw new Error(`${label}不能包含凭据`);
  if (getConfig().security?.allowPrivateImageHosts === true) return url.toString();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // isPrivateIp 对非 IP 的字面量（普通域名）返回 false，只有真的是 IP 时才判内网
  if (isPrivateIp(host)) throw new Error(`${label}指向内网或本机，已拒绝`);
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')
    || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error(`${label}指向内网或本机，已拒绝`);
  }
  return url.toString();
}
