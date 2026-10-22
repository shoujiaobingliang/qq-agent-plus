// 「编辑自定义卡」的纯逻辑：把当前草稿写回卡库里的同一张卡，而不是新增一张。
//
// 背景（2026-10-22 用户反馈）：选一张自定义卡、改正文/附加规则/交流策略后保存，
// 以前只更新了 persona.roleText，卡片本身没变；界面于是认为"正文与卡不一致"，
// 再点新建就会多出一张卡。这里只负责生成新的 customPersonas 数组，DOM/保存流程
// 由 settings-save.js 调用。
const CUSTOM_ID_RE = /^custom_(\d+)$/;

/**
 * @param cards 现有 customPersonas 数组
 * @param cardId 当前草稿来自哪张卡（custom_0 / 内置 id / 空）
 * @param {{ text: string, customRules?: string, behaviorProfile?: string }} draft
 * @returns {Array|null} 更新后的数组；不是自定义卡、索引不存在、正文为空时返回 null
 */
function customPersonaCardsPatch(cards, cardId, draft = {}) {
  const match = CUSTOM_ID_RE.exec(String(cardId || ''));
  if (!match) return null;
  const index = Number(match[1]);
  const list = Array.isArray(cards) ? cards : [];
  const existing = list[index];
  if (!existing || typeof existing !== 'object') return null;
  const text = String(draft.text ?? '').trim();
  if (!text) return null;   // 不让一次误清空把卡正文写没；空正文仍可按自定义人设保存
  const next = {
    ...existing,
    text,
    behaviorProfile: String(draft.behaviorProfile || existing.behaviorProfile || 'legacy')
  };
  const customRules = String(draft.customRules ?? '').trim();
  if (customRules) next.customRules = customRules;
  else delete next.customRules;
  const copy = [...list];
  copy[index] = next;
  return copy;
}

export { customPersonaCardsPatch };
