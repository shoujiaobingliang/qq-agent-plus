// 人设初始化回复（persona intro）的持久化缓存。
//
// 背景（2026-10-22 用户反馈）：人设应当单独作为一轮对话，模型对这一轮的回复要发给管理员；
// 之后才进入群聊多轮。人设回复按 personaPrompt（+渠道/模型）哈希缓存，只在人设变化时重新生成，
// 不放进每轮聊天请求，避免每次运行都多打一次模型、也避免它和工具消息混在一起。
//
// 文件放在 DATA_DIR 下，随数据目录保留，不会被版本更新覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE_NAME = 'persona-intros.json';
const MAX_ENTRIES = 50;

export function personaIntroFile(dataDir = DATA_DIR) {
  return path.join(dataDir, FILE_NAME);
}

function readAll(dataDir) {
  try {
    let text = fs.readFileSync(personaIntroFile(dataDir), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 缓存损坏不能影响聊天：当作空缓存，下一次生成时覆盖。
    return {};
  }
}

function writeAll(value, dataDir) {
  const file = personaIntroFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function prune(value) {
  const entries = Object.entries(value)
    .filter(([, item]) => item && typeof item === 'object')
    .sort((a, b) => Number(b[1].createdAt || 0) - Number(a[1].createdAt || 0));
  if (entries.length <= MAX_ENTRIES) return value;
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

export function getPersonaIntro(hash, { dataDir = DATA_DIR } = {}) {
  const key = String(hash || '').trim();
  if (!key) return null;
  const value = readAll(dataDir)[key];
  return value && typeof value === 'object' ? value : null;
}

export function savePersonaIntro(hash, patch = {}, { dataDir = DATA_DIR, now = Date.now() } = {}) {
  const key = String(hash || '').trim();
  if (!key) return null;
  const all = readAll(dataDir);
  const previous = all[key] && typeof all[key] === 'object' ? all[key] : {};
  all[key] = {
    ...previous,
    ...patch,
    updatedAt: new Date(now).toISOString()
  };
  writeAll(prune(all), dataDir);
  return all[key];
}
