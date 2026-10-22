// 自动更新目标仓库的默认值（fork 场景）。
//
// 旧版本把默认仓库写死成上游 `sakurawwwxh/qq-agent-plus.git`；从 fork 部署时，
// 更新检查会去拉上游，fork 自己的修改永远等不到。这里按“当前部署来源”解析：
//   1. QQ_AGENT_REPOSITORY（部署脚本显式传入）
//   2. 安装目录 .deployment.json 的 repository
//   3. 当前 checkout 的 git origin
//   4. package.json repository.url
//   5. 最后才回落到上游
// 结果按 root 缓存；解析失败（没有 git、没有 .deployment.json）不影响启动。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const LEGACY_DEFAULT_UPDATE_REPOSITORY = 'https://github.com/sakurawwwxh/qq-agent-plus.git';

const GITHUB_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;
const cache = new Map();

/** 把 git@ / ssh:// / git+https 形态统一成 https://github.com/<owner>/<repo>.git。 */
export function normalizeUpdateRepository(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  text = text.replace(/^git\+/, '');
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i.exec(text);
  if (scp) return `https://github.com/${scp[1]}/${scp[2]}.git`;
  const ssh = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i.exec(text);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}.git`;
  const https = GITHUB_RE.exec(text);
  if (https) return `https://github.com/${https[1]}/${https[2]}.git`;
  return '';
}

function deploymentRepository(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.deployment.json'), 'utf8');
    const data = JSON.parse(raw);
    return normalizeUpdateRepository(data?.repository);
  } catch {
    return '';
  }
}

function gitOrigin(root) {
  // 非 git 安装（tar 包/系统包）不做 git 调用：Windows 上 git 找不到仓库时会扫父目录，
  // 每次启动白等 2 秒。worktree 的 .git 是文件，existsSync 同样成立。
  if (!fs.existsSync(path.join(root, '.git'))) return '';
  try {
    const out = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return normalizeUpdateRepository(out);
  } catch {
    return '';
  }
}

function packageRepository(root) {
  try {
    const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const data = JSON.parse(raw);
    const url = typeof data?.repository === 'string' ? data.repository : data?.repository?.url;
    return normalizeUpdateRepository(url);
  } catch {
    return '';
  }
}

/**
 * 解析当前部署对应的 GitHub 仓库。结果按 root 缓存；`refresh` 供测试/排障重算。
 * 永远返回一个合法的 GitHub HTTPS 地址（最后回落到上游）。
 */
export function defaultUpdateRepository({ root, env = process.env, refresh = false } = {}) {
  const base = path.resolve(String(root || '.'));
  if (!refresh && cache.has(base)) return cache.get(base);
  const candidates = [
    env?.QQ_AGENT_REPOSITORY,
    deploymentRepository(base),
    gitOrigin(base),
    packageRepository(base),
    LEGACY_DEFAULT_UPDATE_REPOSITORY
  ];
  const value = candidates.map(normalizeUpdateRepository).find(Boolean)
    || LEGACY_DEFAULT_UPDATE_REPOSITORY;
  cache.set(base, value);
  return value;
}

/** 测试用：清掉按 root 的缓存。 */
export function clearUpdateRepositoryCacheForTest() {
  cache.clear();
}
