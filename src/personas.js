import { readFileSync } from 'node:fs';

export function normalizeBehaviorProfile(value) {
  const profile = value ?? 'legacy';
  if (!['legacy', 'grounded'].includes(profile)) throw new Error('Invalid persona behavior profile');
  return profile;
}

// 人设模板库：**角色卡正文的唯一来源是 roles/ 目录**，一张卡一个 markdown 文件，
// 这里只做登记（id → 文件 / 显示名 / 语气档位），不再把正文内联进代码。
//
//   roles/xiaojingyu.md              默认人设：DeepSeek 小鲸鱼。
//   roles/tsundere-loli.md           傲娇萝莉（鲸鱼娘 token 卡）。
// 其余旧卡已下线；新增卡时正文只写在 roles/ 下，用真实工具名。

//
// 用相对模块 URL 读取，不依赖启动工作目录；部署时必须带上 roles/（完整同步会包含）。
const readRole = (file) => readFileSync(new URL(`../roles/${file}`, import.meta.url), 'utf8').trim();

export const PERSONAS = {
  xiaojingyu: {
    name: '小鲸鱼（默认）',
    behaviorProfile: 'legacy',
    text: readRole('xiaojingyu.md')
  },
  tsundere_loli: {
    name: '傲娇萝莉',
    behaviorProfile: 'legacy',
    text: readRole('tsundere-loli.md')
  }
};

/** 旧卡 id → 新卡 id：老配置里绑着损友的实例自动落到傲娇萝莉。 */
export const LEGACY_PERSONA_ALIASES = Object.freeze({
  duzui_sunyou: 'tsundere_loli'
});

/** 内置卡 id 列表（控制台与校验用）。 */
export const PERSONA_TEMPLATE_IDS = Object.keys(PERSONAS);

/** 按 id 取内置卡（兼容旧 id：损友 → 傲娇萝莉）；不是内置 id（自定义卡、空值）返回 null。 */
export function builtinPersonaTemplate(id) {
  const raw = String(id ?? '').trim();
  const key = LEGACY_PERSONA_ALIASES[raw] || raw;
  return Object.prototype.hasOwnProperty.call(PERSONAS, key) ? PERSONAS[key] : null;
}

/**
 * 按会话解析出生效的人设：全局 `persona` + `personaPerChat[chatKey]` 覆盖。
 *
 * 覆盖字段都是"决定口吻"的那几项；没写的继承全局。指定了内置卡（templateId）时，
 * 正文与档位以卡为准（否则会出现"新卡的正文 + 全局的旧档"这种混合体）；
 * 卡 id 认不出来时回落全局正文，避免整个提示词被换空。
 *
 * 纯函数：不读写磁盘，调用方（编排器）每轮按 chatKey 取一次即可。
 */
export function resolvePersona(cfg, chatKey) {
  const base = cfg?.persona && typeof cfg.persona === 'object' ? cfg.persona : {};
  const key = String(chatKey || '');
  const overlay = key && cfg?.personaPerChat && typeof cfg.personaPerChat === 'object'
    ? cfg.personaPerChat[key]
    : null;
  if (!overlay || typeof overlay !== 'object') return base;
  const merged = { ...base, ...overlay };
  const templateId = String(overlay.templateId || '').trim();
  if (templateId) {
    const template = builtinPersonaTemplate(templateId);
    if (template) {
      merged.roleText = template.text;
      if (overlay.behaviorProfile === undefined) merged.behaviorProfile = template.behaviorProfile || 'legacy';
    } else {
      merged.roleText = base.roleText;
    }
  }
  return merged;
}

/**
 * 内置卡绑定：只要实例还绑着内置卡（persona.templateId），就按 roles/*.md 的正文刷新副本。
 *
 * 背景：实例里存的是角色正文的**副本**（persona.roleText）。卡文件改了副本不会自己更新，
 * 以前必须在控制台重选一次卡才生效，"改完卡没生效"因此被反复当成 bug 报上来。
 * 现在的约定：卡文件是唯一来源 —— 控制台选卡时把模板 id 一起存下来
 * （手写正文或选自定义卡会清空 id），载入配置时发现正文与文件不一致就按文件刷新。
 *
 * 只刷正文，不碰 behaviorProfile：档位（legacy / grounded）是实例自己的行为开关，
 * 在控制台选卡时一起设置；这里悄悄改掉会让"只改档位"的调用被卡文件顶回去。
 *
 * 认不出的 id（老版本删掉/改过名的卡、外部手写进来的值）会被清成未绑定 ——
 * 否则实例会一直挂着一个永远不会生效的 id，控制台里也看不出为什么正文不跟着卡走。
 *
 * @returns {{id: string, name: string} | null} 发生刷新时返回卡信息，否则 null。
 */
export function applyPersonaTemplate(cfg) {
  const persona = cfg?.persona;
  if (!persona || typeof persona !== 'object') return null;
  const rawId = persona.templateId === undefined || persona.templateId === null
    ? ''
    : String(persona.templateId).trim();
  const resolvedId = LEGACY_PERSONA_ALIASES[rawId] || rawId;
  const template = builtinPersonaTemplate(resolvedId);
  if (!template) {
    if (rawId) persona.templateId = '';
    return null;
  }
  // 旧 id 绑定的实例顺手迁移到新 id，避免控制台一直显示旧卡名。
  if (resolvedId !== rawId) persona.templateId = resolvedId;
  const nextText = String(template.text).trim();
  if (String(persona.roleText || '').trim() === nextText) return null;
  persona.roleText = nextText;
  return { id: resolvedId, name: template.name };
}

/**
 * 按群人设里的卡 id 校验：认不出的 id 清掉（运行时回落全局正文），
 * 免得实例一直挂着一个永远不会生效的绑定。
 */
export function applyPersonaPerChatTemplates(cfg) {
  const perChat = cfg?.personaPerChat;
  if (!perChat || typeof perChat !== 'object') return;
  for (const [key, entry] of Object.entries(perChat)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.templateId || '').trim();
    if (!id) continue;
    const resolvedId = LEGACY_PERSONA_ALIASES[id] || id;
    if (!builtinPersonaTemplate(resolvedId)) {
      delete entry.templateId;
      // 只看"还有没有别的白名单字段"，别自己再列一遍 —— 漏掉 participation /
      // behaviorProfile 会把用户单独设过的偏好一起删掉（2026-10-18 审查 P2）
      if (!Object.keys(entry).length) delete perChat[key];
    } else if (resolvedId !== id) {
      entry.templateId = resolvedId;
    }
  }
}
