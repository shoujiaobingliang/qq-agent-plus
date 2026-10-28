// 记忆隐私判定：作用域（knowledge/chat/person/secret）+ 可用范围 + 可披露性。
//
// 设计要点（见 docs/requirements/human-like-memory.md §2.4 / §4.3）：
//   - 隐私由**内容**决定，不按“来自私聊/群聊”一刀切；
//   - 模型只给初判，最终值由这里的规则归一化；
//   - 默认保守：低置信度、缺字段、判不准一律 secret；
//   - usable_in（能用在哪）与 disclosable（能不能说出来）是两件事。
export const PRIVACY_SCOPES = Object.freeze(['knowledge', 'chat', 'person', 'secret']);
export const USABLE_IN = Object.freeze(['global', 'chat', 'person', 'source']);
export const SENSITIVITY_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const PRIVACY_RANK = Object.freeze({ knowledge: 0, chat: 1, person: 2, secret: 3 });

export const DEFAULT_PRIVACY_CONFIG = Object.freeze({
  minClassificationConfidence: 0.6,
  allowKnowledgeAcrossChats: true,
  personUsableWhenAbsent: false,
  visibilityMode: 'global',
  hidePrivateInGroup: false
});

const clamp01 = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};
const clean = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const validUid = (value) => /^\d{1,15}$/.test(String(value ?? '').trim());

// 规则层只拦“无论上下文如何都不该外传”的形态。中文语境里的“密码”不在此列：
// 群暗号/群密码属于 chat 作用域，是允许记录的；这里只拦账号/支付/登录类密码。
const SECRET_RULES = [
  { re: /(?:api[_\s-]?key|secret[_\s-]?key|access[_\s-]?token|bearer\s+[a-z0-9._-]{8,})/i, reason: '凭据形态' },
  { re: /(?:sk-[a-z0-9]{10,}|ghp_[a-z0-9]{20,}|AKIA[0-9A-Z]{16})/i, reason: '凭据形态' },
  { re: /(?:登录密码|支付密码|账号密码|账户密码|password|passwd|验证码|动态码)/i, reason: '账号/验证码' },
  { re: /(?:别告诉|不要告诉|别外传|别在群里说|只跟你说|这是秘密|要保密|保密啊|私下说)/, reason: '明确私密标记' },
  { re: /(?:身份证|银行卡|信用卡|社保卡|护照号|车牌号)/, reason: '证件/财务信息' },
  { re: /(?:做手术|住院|化疗|抑郁症|艾滋病|流产|家暴|离婚)/, reason: '健康/家庭敏感信息' },
  { re: /1[3-9]\d{9}/, reason: '手机号' },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, reason: '邮箱' },
  { re: /(?:^|[^\d])\d{17}[\dXx](?:[^\d]|$)/, reason: '身份证号' }
];

const IDENTIFIER_RULES = [
  { re: /1[3-9]\d{9}/, kind: 'phone' },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, kind: 'email' },
  { re: /(?:^|[^\d])\d{17}[\dXx](?:[^\d]|$)/, kind: 'id-card' },
  { re: /(?:^|[^\d])\d{5,15}(?:[^\d]|$)/, kind: 'qq-or-account' },
  { re: /(?:住在|家住|地址是|收货地址|在.{0,8}上班)/, kind: 'address' }
];

/** 规则层：命中即 secret。返回原因数组（空数组表示未命中）。 */
export function detectSecretSignals(text) {
  const value = String(text ?? '');
  if (!value.trim()) return [];
  return SECRET_RULES.filter((rule) => rule.re.test(value)).map((rule) => rule.reason);
}

/** 文本里是否有可定位到具体个人的标识（用于阻止 knowledge 跨群）。 */
export function detectPersonalIdentifiers(text) {
  const value = String(text ?? '');
  if (!value.trim()) return [];
  return IDENTIFIER_RULES.filter((rule) => rule.re.test(value)).map((rule) => rule.kind);
}

export function hasPersonalIdentifier(text) {
  return detectPersonalIdentifiers(text).length > 0;
}

function normalizeScope(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (PRIVACY_SCOPES.includes(raw)) return raw;
  if (['world', 'general', 'global', 'public', 'language', 'slang'].includes(raw)) return 'knowledge';
  if (['group', 'chat', 'channel'].includes(raw)) return 'chat';
  if (['people', 'user', 'personal', 'relationship'].includes(raw)) return 'person';
  if (['private', 'confidential', 'hidden'].includes(raw)) return 'secret';
  return '';
}

export function usableInForScope(scope) {
  if (scope === 'knowledge') return 'global';
  if (scope === 'person') return 'person';
  if (scope === 'secret') return 'source';
  return 'chat';
}

export function scopeForUsableIn(usableIn) {
  if (usableIn === 'global') return 'knowledge';
  if (usableIn === 'person') return 'person';
  if (usableIn === 'source') return 'secret';
  return 'chat';
}

/** 按 kind 的保守默认：默认不跨群；只有模型明确判 knowledge 才允许 global。 */
function fallbackScopeForKind(kind) {
  const k = String(kind ?? '');
  if (k === 'person_fact' || k === 'person_preference') return 'person';
  return 'chat';
}

function defaultSensitivity(scope) {
  if (scope === 'secret') return 'high';
  if (scope === 'person') return 'medium';
  return 'low';
}

export function normalizePrivacyConfig(raw = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    minClassificationConfidence: Math.min(0.95, Math.max(0.3,
      Number.isFinite(Number(value.minClassificationConfidence))
        ? Number(value.minClassificationConfidence)
        : DEFAULT_PRIVACY_CONFIG.minClassificationConfidence)),
    allowKnowledgeAcrossChats: value.allowKnowledgeAcrossChats !== false,
    personUsableWhenAbsent: value.personUsableWhenAbsent === true,
    visibilityMode: value.visibilityMode === 'perChat' ? 'perChat' : 'global',
    hidePrivateInGroup: value.hidePrivateInGroup === true
  };
}

function privacyRecord({
  scope, usableIn = usableInForScope(scope), disclosable = scope === 'knowledge',
  subjectUserId = '', sensitivity = defaultSensitivity(scope),
  confidence = 1, classifiedBy = 'rule', reason = ''
}) {
  return {
    privacyScope: scope,
    usableIn,
    disclosable: disclosable === true,
    subjectUserId: scope === 'person' ? String(subjectUserId || '') : '',
    sensitivity: SENSITIVITY_LEVELS.includes(sensitivity) ? sensitivity : defaultSensitivity(scope),
    classificationConfidence: clamp01(confidence, 0),
    classifiedBy,
    privacyReason: clean(reason)
  };
}

function secretRecord(reason, { classifiedBy = 'rule', confidence = 1 } = {}) {
  return privacyRecord({
    scope: 'secret',
    usableIn: 'source',
    disclosable: false,
    sensitivity: 'high',
    confidence,
    classifiedBy,
    reason
  });
}

/**
 * 最终隐私判定。
 *
 * @param {object} input
 * @param {string} input.abstract  记忆摘要（必填）
 * @param {string} [input.content] 细节（gist 可空）
 * @param {string} [input.kind]    convention/decision/fact/event/person_fact/person_preference
 * @param {string} [input.subjectUserId] 关于谁（person 作用域）
 * @param {object} [input.guess]   模型初判：{ scope_guess|scope, subject_user_id, sensitivity, confidence, reason }
 * @param {object} [input.config]  归一化前的 privacy 配置
 */
export function decidePrivacy({
  abstract = '', content = '', kind = '', subjectUserId = '', guess = null, config = {}
} = {}) {
  const cfg = normalizePrivacyConfig(config);
  const text = `${abstract}\n${content}`.trim();

  // 第一层：确定性拦截，连模型初判都不看
  const secretReasons = detectSecretSignals(text);
  if (secretReasons.length) return secretRecord(secretReasons[0]);

  const g = guess && typeof guess === 'object' && !Array.isArray(guess) ? guess : null;
  const guessedScope = normalizeScope(g?.scope_guess ?? g?.scope);
  const explicitGuess = Boolean(g && guessedScope);
  let scope;
  let confidence;
  let classifiedBy;
  let reason;

  if (explicitGuess) {
    confidence = clamp01(g.confidence, 0);
    // 第二层：低置信度/判不准 → 最严格
    if (confidence < cfg.minClassificationConfidence) {
      return secretRecord(`隐私初判置信度不足（${confidence}）`, {
        classifiedBy: 'model',
        confidence
      });
    }
    scope = guessedScope;
    classifiedBy = 'model';
    reason = clean(g.reason) || `模型初判 ${scope}`;
  } else {
    // 没有初判时按 kind 给保守默认：都停留在会话内，不会跨群
    scope = fallbackScopeForKind(kind);
    confidence = 1;
    classifiedBy = 'rule';
    reason = `未提供隐私初判，按 ${kind || '未知类型'} 默认 ${scope}`;
  }

  // 第三层：规则归一化
  const identifiers = detectPersonalIdentifiers(text);
  if (scope === 'knowledge' && identifiers.length) {
    scope = 'person';
    reason = `${reason}；含个人标识（${identifiers.join('/')}），降为 person`;
  }

  if (scope === 'person') {
    const uid = String(subjectUserId || g?.subject_user_id || '').trim();
    if (!validUid(uid)) {
      return secretRecord(`${reason}；person 缺少有效 subject_user_id`, {
        classifiedBy,
        confidence
      });
    }
    return privacyRecord({
      scope: 'person',
      usableIn: 'person',
      disclosable: false,
      subjectUserId: uid,
      sensitivity: SENSITIVITY_LEVELS.includes(g?.sensitivity) ? g.sensitivity : 'medium',
      confidence,
      classifiedBy,
      reason
    });
  }

  if (scope === 'secret') {
    return privacyRecord({
      scope: 'secret',
      usableIn: 'source',
      disclosable: false,
      sensitivity: 'high',
      confidence,
      classifiedBy,
      reason
    });
  }

  const isKnowledge = scope === 'knowledge';
  return privacyRecord({
    scope: isKnowledge ? 'knowledge' : 'chat',
    usableIn: isKnowledge ? 'global' : 'chat',
    disclosable: isKnowledge,
    sensitivity: SENSITIVITY_LEVELS.includes(g?.sensitivity)
      ? g.sensitivity
      : defaultSensitivity(scope),
    confidence,
    classifiedBy,
    reason
  });
}

/**
 * 召回层硬过滤（与 SQL 口径一致，供单测/内存路径复用）。
 * context: { chatKey, relevantUserIds, mentionedUserIds }
 * options: { privacy, visibility }；visibility 来自旧的 memory.visibility。
 */
export function isRecallVisible(entry, context = {}, { privacy = {}, visibility = {} } = {}) {
  if (!entry) return false;
  if (entry.status && entry.status !== 'active') return false;
  const cfg = normalizePrivacyConfig({
    ...privacy,
    visibilityMode: visibility.mode ?? privacy.visibilityMode,
    hidePrivateInGroup: visibility.hidePrivateInGroup ?? privacy.hidePrivateInGroup
  });
  const entryChat = String(entry.chatKey ?? entry.sourceChatKey ?? '');
  const currentChat = String(context.chatKey ?? '');
  const scope = PRIVACY_SCOPES.includes(entry.privacyScope)
    ? entry.privacyScope
    : scopeForUsableIn(entry.usableIn);
  const usableIn = USABLE_IN.includes(entry.usableIn)
    ? entry.usableIn
    : usableInForScope(scope);

  // 旧配置作为全局下限：只能收得更紧
  if (cfg.visibilityMode === 'perChat' && entryChat !== currentChat) return false;
  if (cfg.hidePrivateInGroup
    && currentChat.startsWith('group:')
    && entryChat.startsWith('private:')) return false;
  if (!cfg.allowKnowledgeAcrossChats
    && usableIn === 'global'
    && entryChat.startsWith('private:')
    && entryChat !== currentChat) return false;

  if (usableIn === 'global') return scope !== 'secret';
  if (usableIn === 'chat' || usableIn === 'source') return entryChat === currentChat;
  if (usableIn === 'person') {
    const subject = String(entry.subjectUserId || entry.userId || '');
    if (!subject) return false;
    const relevant = new Set((context.relevantUserIds || []).map(String));
    if (relevant.has(subject)) return true;
    if (!cfg.personUsableWhenAbsent) return false;
    return (context.mentionedUserIds || []).map(String).includes(subject);
  }
  return false;
}

/** 提示词里的可见性说明：disclosable=false 的条目“能用不能说”。 */
export function disclosureLabel(entry) {
  if (!entry) return '';
  if (entry.disclosable === true && (entry.privacyScope || '') === 'knowledge') return '';
  if (entry.privacyScope === 'secret') return '（仅本会话）';
  return '（只用不说）';
}

export function privacyRank(scope) {
  return PRIVACY_RANK[scope] ?? PRIVACY_RANK.secret;
}

/**
 * 合并/替代时不允许自动放宽隐私：只在 new 更严格时采用 new，否则保留 old。
 * 管理员手动改作用域走存储层的单独入口，不经过这里。
 */
export function stricterPrivacy(oldEntry = {}, nextEntry = {}) {
  if (!oldEntry?.privacyScope) return nextEntry;
  if (!nextEntry?.privacyScope) return oldEntry;
  return privacyRank(nextEntry.privacyScope) > privacyRank(oldEntry.privacyScope)
    ? nextEntry
    : oldEntry;
}
