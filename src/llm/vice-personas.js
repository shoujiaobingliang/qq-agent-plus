// 副人格：主人设上的一个指针 + 人设区域里的副人格卡库。
//
// 主、副人设是两套独立角色，但都属于「当前人设」这一块：主人设用
// `persona.vicePersonaId` 指向副人格卡；调用时 subagent 只拿副人格卡正文 +
// 选中上下文，不拿主人设正文，发送仍由主模型完成。
//
// 默认卡 id 是 tieba，部署时是一张空白卡（正文由管理员补充）；旧“毒舌/嘴臭”统一映射到 tieba。
export const DEFAULT_VICE_PERSONA_ID = 'tieba';
const MAX_CARDS = 20;
const MAX_ROLE = 6000;

const ALIASES = new Map([
  ['tieba', 'tieba'],
  ['toxic', 'tieba'],
  ['duzui', 'tieba'],
  ['duzui_sunyou', 'tieba'],
  ['毒舌', 'tieba'],
  ['毒舌老哥', 'tieba'],
  ['嘴臭', 'tieba'],
  ['嘴臭贴吧姐姐', 'tieba'],
  ['贴吧姐姐', 'tieba'],
  ['贴吧老哥', 'tieba']
]);

export function normalizeVicePersonaId(value) {
  const raw = String(value ?? '').trim();
  const key = raw.toLowerCase();
  if (ALIASES.has(key)) return ALIASES.get(key);
  if (/毒舌|嘴臭|贴吧/.test(raw)) return 'tieba';
  return key || DEFAULT_VICE_PERSONA_ID;
}

/** 主人格是否已设置：全局有正文/绑定内置卡，或任一会话覆盖了人设都算。 */
export function primaryPersonaSet(cfg = {}) {
  const persona = cfg?.persona || {};
  if (String(persona.roleText || '').trim() || String(persona.templateId || '').trim()) return true;
  const perChat = cfg?.personaPerChat;
  if (!perChat || typeof perChat !== 'object' || Array.isArray(perChat)) return false;
  return Object.values(perChat).some((item) => (
    item && typeof item === 'object'
    && (String(item.roleText || '').trim() || String(item.templateId || '').trim())
  ));
}

function normalizeCards(value = []) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = String(item.id || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(item.name || id).trim().slice(0, 40) || id,
      roleText: String(item.roleText || '').slice(0, MAX_ROLE)
    });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

/** 人设区域里的副人格卡列表；永远包含默认 tieba（空白卡）。 */
export function vicePersonaCards(cfg = {}) {
  const cards = normalizeCards(cfg?.persona?.vicePersonas);
  if (!cards.some((card) => card.id === 'tieba')) {
    cards.unshift({ id: 'tieba', name: 'tieba', roleText: '' });
  }
  return cards;
}

/**
 * 解析主人设指向的副人格卡。返回 null 表示主人格未设置。
 * 卡正文可以为空（默认空白卡），是否允许触发由调用方再判断正文非空。
 */
export function resolveVicePersona(cfg = {}) {
  if (!primaryPersonaSet(cfg)) return null;
  const id = normalizeVicePersonaId(cfg?.persona?.vicePersonaId || DEFAULT_VICE_PERSONA_ID);
  const cards = vicePersonaCards(cfg);
  return cards.find((card) => card.id === id) || cards.find((card) => card.id === 'tieba') || {
    id: 'tieba', name: 'tieba', roleText: ''
  };
}
