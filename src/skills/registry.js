// 技能（skill）加载层。
//
// 技能是给模型看的操作手册：内置的 QQ 操作技能由 src/llm/prompt.js 按当前配置
// 生成（保留工具开关的一致性），管理员也可以在 DATA_DIR/skills/<name>/SKILL.md
// 添加自己的技能。DATA_DIR 不会被自动更新覆盖；仓库根目录的 skills/ 只放说明，
// 因为部署时根目录会被 rsync --delete 同步。
//
// 安全边界：这里只读“技能目录下的 SKILL.md”，不接受任意路径；目录项必须是普通
// 文件、不能是符号链接；用户技能是管理员内容，不是群友内容，因此不进
// sanitizeUserText 的清洗链路。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from '../core/config.js';

export const SKILL_MAX_CHARS = 12000;
export const MAX_SKILLS = 64;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_NAME = 'SKILL.md';
const DESCRIPTION_MAX = 200;

/** 生成式内置技能占用这些名字；磁盘技能不能覆盖，避免运行协议被替换。 */
export const RESERVED_SKILL_NAMES = new Set([
  'qq-core',
  'qq-scene',
  'qq-runtime'
]);

export function validateSkillName(value) {
  const name = String(value ?? '').trim();
  if (!SKILL_NAME_RE.test(name)) return null;
  if (RESERVED_SKILL_NAMES.has(name)) return null;
  return name;
}

function cleanLine(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
  )) return text.slice(1, -1);
  return text;
}

function splitFrontmatter(raw) {
  let text = String(raw ?? '');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { front: {}, body: text };
  const front = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!item) continue;
    front[item[1].toLowerCase()] = unquote(item[2]);
  }
  return { front, body: text.slice(match[0].length) };
}

/**
 * 解析一份 SKILL.md。出错时返回 { error }，由扫描层跳过而不是中断整次请求。
 * frontmatter 只认 name / description / always，未写 name 时用目录名。
 */
export function parseSkillMarkdown(raw, {
  fallbackName = '',
  source = 'builtin',
  filePath = '',
  maxChars = SKILL_MAX_CHARS
} = {}) {
  const { front, body } = splitFrontmatter(raw);
  const name = validateSkillName(front.name || fallbackName);
  if (!name) return { error: `技能名无效或属于保留名：${JSON.stringify(front.name || fallbackName)}` };
  if (front.name && fallbackName && front.name !== fallbackName) {
    return { error: `frontmatter 的 name 必须与目录名一致（${front.name} != ${fallbackName}）` };
  }
  const content = String(body ?? '').trim();
  if (!content) return { error: '技能正文为空' };
  const description = cleanLine(front.description, DESCRIPTION_MAX) || name;
  return {
    skill: {
      name,
      description,
      always: /^(true|1|yes)$/i.test(String(front.always ?? '').trim()),
      content: content.slice(0, maxChars),
      source,
      filePath
    }
  };
}

function listSkillDirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
    .sort();
}

function fileSignature(stat) {
  return `${stat.size}:${stat.mtimeMs}`;
}

function scanRoot(root, source, cache, errors) {
  const out = [];
  for (const dirName of listSkillDirs(root)) {
    if (RESERVED_SKILL_NAMES.has(dirName)) continue;
    const dir = path.join(root, dirName);
    const file = path.join(dir, FILE_NAME);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    // 符号链接/目录/设备文件一律跳过；技能必须是可以直接读的普通文件。
    if (!stat.isFile()) continue;
    let real;
    try {
      real = fs.realpathSync(file);
    } catch {
      continue;
    }
    const rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      errors.push(`${dirName}: SKILL.md 解析到技能目录之外，已跳过`);
      continue;
    }
    const signature = fileSignature(stat);
    const cached = cache.get(file);
    if (cached && cached.signature === signature) {
      out.push(cached.skill);
      continue;
    }
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      errors.push(`${dirName}: 读取失败（${error?.message ?? error}）`);
      continue;
    }
    const parsed = parseSkillMarkdown(raw, {
      fallbackName: dirName,
      source,
      filePath: file
    });
    if (parsed.error) {
      errors.push(`${dirName}: ${parsed.error}`);
      continue;
    }
    cache.set(file, { signature, skill: parsed.skill });
    out.push(parsed.skill);
  }
  return out;
}

/**
 * 技能注册表。默认同时扫描内置目录与用户目录；同名时用户目录覆盖内置目录。
 * 生成式技能不在这里，由 prompt.js 合并（保留名不允许磁盘覆盖）。
 */
export function createSkillRegistry({
  builtinRoot = path.join(ROOT, 'skills'),
  userRoot = path.join(DATA_DIR, 'skills'),
  maxChars = SKILL_MAX_CHARS
} = {}) {
  const cache = new Map();
  const roots = { builtinRoot, userRoot };

  function load({ force = false } = {}) {
    if (force) cache.clear();
    const errors = [];
    const byName = new Map();
    for (const skill of scanRoot(builtinRoot, 'builtin', cache, errors)) {
      if (maxChars && skill.content.length > maxChars) skill.content = skill.content.slice(0, maxChars);
      byName.set(skill.name, skill);
    }
    for (const skill of scanRoot(userRoot, 'user', cache, errors)) {
      if (maxChars && skill.content.length > maxChars) skill.content = skill.content.slice(0, maxChars);
      byName.set(skill.name, skill);
    }
    let skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (skills.length > MAX_SKILLS) {
      errors.push(`技能数量超过上限 ${MAX_SKILLS}，已忽略多余项`);
      skills = skills.slice(0, MAX_SKILLS);
    }
    return { skills, errors };
  }

  return {
    roots,
    load,
    list(options) {
      return load(options).skills.map(({ name, description, always, source }) => ({
        name, description, always, source
      }));
    },
    get(name, options) {
      const key = String(name ?? '').trim();
      if (!SKILL_NAME_RE.test(key)) return null;
      return load(options).skills.find((skill) => skill.name === key) || null;
    },
    invalidate() { cache.clear(); }
  };
}

let defaultRegistry = null;

export function getDefaultSkillRegistry() {
  if (!defaultRegistry) defaultRegistry = createSkillRegistry();
  return defaultRegistry;
}

export function listSkills(options) {
  return getDefaultSkillRegistry().list(options);
}

export function getSkill(name, options) {
  return getDefaultSkillRegistry().get(name, options);
}

/** 测试用：丢掉单例，避免临时 DATA_DIR 之间串缓存。 */
export function clearSkillCacheForTest() {
  defaultRegistry = null;
}
