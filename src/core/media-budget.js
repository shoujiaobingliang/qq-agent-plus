// 媒体处理的内存闸门与并发闸门（2026-10-26 事故复盘）。
//
// 背景：这台 1.6GB 的机器上，QQ 的 mmap 工作集本来就贴着页缓存上限。Agent 只要
// 瞬时分掉一百多 MB（96MB 视频缓冲、200MB 音频缓冲、或 base64 副本），内核就会
// 回收 QQ 的映射页；QQ 再访问时缺页读盘，进入持续几十秒到几十分钟的读盘抖动。
//
// 两道闸门：
//   1. 处理前看 MemAvailable，低于阈值直接拒绝，不在已经吃紧时再制造一次尖峰；
//   2. 全局媒体信号量 = 1，同一时刻只允许一个下载/ffmpeg/base64，避免并发叠加。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 低于这个可用内存就不再做媒体处理（留出内核回收与其它进程的余量）。 */
export const MEDIA_MIN_AVAILABLE_BYTES = 96 * 1024 * 1024;

/**
 * 当前可用内存（字节）。Linux 用 /proc/meminfo 的 MemAvailable（含可回收页缓存），
 * 比 os.freemem() 更接近"还能分配多少"；读不到时退回 os.freemem()，再不行返回 null。
 */
export function memoryAvailableBytes() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
    if (match) return Number(match[1]) * 1024;
  } catch { /* 非 Linux / 受限环境 */ }
  try { return os.freemem(); } catch { return null; }
}

/**
 * 处理媒体前检查内存余量；不够就抛 code=MEDIA_MEMORY_LOW 的人话错误。
 * availableBytes 可注入（测试用）；生产不传。
 */
export function assertMediaMemory(needBytes = 0, { availableBytes = memoryAvailableBytes() } = {}) {
  if (availableBytes === null || availableBytes === undefined) return;
  const need = Math.max(0, Number(needBytes) || 0);
  // 双份余量：下载缓冲之外还要留 base64/请求体副本的空间；上限压到 128MB，
  // 避免"need 很大就把门槛抬到永远不够"（真正的硬保护是流式落盘，这里只拒绝已经很低时开工）。
  const floor = Math.max(MEDIA_MIN_AVAILABLE_BYTES, Math.min(need * 2, 128 * 1024 * 1024));
  if (Number(availableBytes) < floor) {
    const error = new Error(
      `服务器内存紧张（可用 ${Math.round(Number(availableBytes) / 1024 / 1024)}MB），`
      + '暂时无法处理图片/视频/音频，请稍后再试'
    );
    error.code = 'MEDIA_MEMORY_LOW';
    throw error;
  }
}

let chain = Promise.resolve();

/**
 * 全局媒体串行闸门：同一时刻只跑一个下载/ffmpeg/base64。
 * 返回任务本身的 Promise；任务失败不会卡住后续任务。
 */
export function withMediaSlot(task) {
  if (typeof task !== 'function') throw new TypeError('withMediaSlot(task) 需要函数');
  const run = chain.then(task, task);
  chain = run.then(() => {}, () => {});
  return run;
}

const MEDIA_TMP_PREFIXES = ['qq-media-', 'qq-ffmpeg-', 'qq-ffprobe-', 'qa-audio-', 'qa-asr-'];

/**
 * 清掉媒体处理留下的临时目录。正常路径都在 finally 里删，这里只兜
 * SIGKILL/OOM 打断后留下的残骸（每个可能是几十 MB 的输入文件）。
 * 默认只删 1 小时前的，避免误删正在进行的任务。
 */
export function cleanupStaleMediaTempDirs({ tmpDir = os.tmpdir(), maxAgeMs = 3600000, now = Date.now() } = {}) {
  let names = [];
  try { names = fs.readdirSync(tmpDir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!MEDIA_TMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const full = path.join(tmpDir, name);
    try {
      const stat = fs.statSync(full);
      if (now - Number(stat.mtimeMs) < maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch { /* 权限/占用：下次启动再试 */ }
  }
  return removed;
}
