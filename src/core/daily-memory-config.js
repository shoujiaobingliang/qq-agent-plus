// 每日长期记忆的默认值与归一化。纯函数、零依赖，供 config-legacy 与存储/调度共用。
import path from 'node:path';

export const DEFAULT_DAILY_MEMORY_CONFIG = Object.freeze({
  enabled: false,                 // 总开关：默认关，避免未预期模型费用
  time: '04:10',
  startupCatchup: true,
  maxCatchupDays: 2,
  minMessages: 2,
  maxChats: 20,
  maxMessagesPerChat: 300,
  maxScanMessagesPerChat: 2000,
  maxCharsPerChat: 8000,
  abstractMaxChars: 120,
  contentMaxChars: 500,
  summaryOverviewChars: 200,
  summaryMaxChars: 1200,
  maxEntriesPerChat: 30,
  maxExistingForDedup: 60,
  minConfidence: 0.4,
  maxInjectChars: 2000,
  eventInjectDays: 7,
  injectConvention: 20,
  injectDecision: 10,
  injectFact: 10,
  injectEvent: 5,
  injectPersonFact: 2,
  injectPersonPreference: 2,
  retentionDays: 180,
  eventRetentionDays: 30,
  includeProactiveRuns: false,
  maxAttempts: 3,
  deferMinutes: 30,
  useChatModel: true,
  provider: '',
  model: '',

  human: {
    enabled: true,                // 总开关关闭时本段不生效；打开后使用激活召回
    verbatimMinImportance: 4,
    gistDetailDays: 30,
    transientMaxDays: 7,
    tauBaseDays: 14,
    tauRecallDays: 7,
    recallBoost: 0.15,
    observeBoost: 0.10,
    fadeThreshold: 0.15,
    activationMin: 0.25,
    maxCandidates: 200,
    maxRecall: 8,
    maxInjectGist: 5,
    uncertaintyLabel: true,
    privacy: {
      minClassificationConfidence: 0.6,
      allowKnowledgeAcrossChats: true,
      personUsableWhenAbsent: false,
      reviewLowConfidence: true,
      disclosureGuard: false
    },
    embedding: {
      enabled: false,
      provider: '',
      model: '',
      dim: 0,
      abstractOnly: true
    }
  }
});

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const clampInteger = (value, min, max, fallback) => Math.round(clampNumber(value, min, max, fallback));
const clampBool = (value, fallback) => (value === undefined ? fallback : value === true);
const clampString = (value, max, fallback = '') => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : fallback;
};
const validTime = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
};

function normalizeHuman(raw, defaults) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const privacy = value.privacy && typeof value.privacy === 'object' && !Array.isArray(value.privacy)
    ? value.privacy
    : {};
  const embedding = value.embedding && typeof value.embedding === 'object' && !Array.isArray(value.embedding)
    ? value.embedding
    : {};
  return {
    enabled: clampBool(value.enabled, defaults.enabled),
    verbatimMinImportance: clampInteger(value.verbatimMinImportance, 1, 5, defaults.verbatimMinImportance),
    gistDetailDays: clampInteger(value.gistDetailDays, 0, 365, defaults.gistDetailDays),
    transientMaxDays: clampInteger(value.transientMaxDays, 1, 30, defaults.transientMaxDays),
    tauBaseDays: clampNumber(value.tauBaseDays, 1, 180, defaults.tauBaseDays),
    tauRecallDays: clampNumber(value.tauRecallDays, 1, 180, defaults.tauRecallDays),
    recallBoost: clampNumber(value.recallBoost, 0, 1, defaults.recallBoost),
    observeBoost: clampNumber(value.observeBoost, 0, 1, defaults.observeBoost),
    fadeThreshold: clampNumber(value.fadeThreshold, 0.01, 0.9, defaults.fadeThreshold),
    activationMin: clampNumber(value.activationMin, 0, 1, defaults.activationMin),
    maxCandidates: clampInteger(value.maxCandidates, 10, 500, defaults.maxCandidates),
    maxRecall: clampInteger(value.maxRecall, 1, 20, defaults.maxRecall),
    maxInjectGist: clampInteger(value.maxInjectGist, 0, 10, defaults.maxInjectGist),
    uncertaintyLabel: clampBool(value.uncertaintyLabel, defaults.uncertaintyLabel),
    privacy: {
      minClassificationConfidence: clampNumber(privacy.minClassificationConfidence, 0.3, 0.95,
        defaults.privacy.minClassificationConfidence),
      allowKnowledgeAcrossChats: clampBool(privacy.allowKnowledgeAcrossChats,
        defaults.privacy.allowKnowledgeAcrossChats),
      personUsableWhenAbsent: clampBool(privacy.personUsableWhenAbsent,
        defaults.privacy.personUsableWhenAbsent),
      reviewLowConfidence: clampBool(privacy.reviewLowConfidence, defaults.privacy.reviewLowConfidence),
      disclosureGuard: clampBool(privacy.disclosureGuard, defaults.privacy.disclosureGuard)
    },
    embedding: {
      enabled: clampBool(embedding.enabled, defaults.embedding.enabled),
      provider: clampString(embedding.provider, 64, defaults.embedding.provider),
      model: clampString(embedding.model, 120, defaults.embedding.model),
      dim: clampInteger(embedding.dim, 0, 8192, defaults.embedding.dim),
      abstractOnly: embedding.abstractOnly !== false
    }
  };
}

/** 深合并到默认值并夹取；坏形状一律回落默认，不抛错。 */
export function normalizeDailyMemoryConfig(raw = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaults = DEFAULT_DAILY_MEMORY_CONFIG;
  return {
    enabled: clampBool(value.enabled, defaults.enabled),
    time: validTime(value.time) ? String(value.time).trim() : defaults.time,
    startupCatchup: clampBool(value.startupCatchup, defaults.startupCatchup),
    maxCatchupDays: clampInteger(value.maxCatchupDays, 0, 14, defaults.maxCatchupDays),
    minMessages: clampInteger(value.minMessages, 1, 100, defaults.minMessages),
    maxChats: clampInteger(value.maxChats, 1, 100, defaults.maxChats),
    maxMessagesPerChat: clampInteger(value.maxMessagesPerChat, 10, 2000, defaults.maxMessagesPerChat),
    maxScanMessagesPerChat: clampInteger(value.maxScanMessagesPerChat, 10, 20000, defaults.maxScanMessagesPerChat),
    maxCharsPerChat: clampInteger(value.maxCharsPerChat, 500, 100000, defaults.maxCharsPerChat),
    abstractMaxChars: clampInteger(value.abstractMaxChars, 20, 500, defaults.abstractMaxChars),
    contentMaxChars: clampInteger(value.contentMaxChars, 50, 2000, defaults.contentMaxChars),
    summaryOverviewChars: clampInteger(value.summaryOverviewChars, 20, 1000, defaults.summaryOverviewChars),
    summaryMaxChars: clampInteger(value.summaryMaxChars, 100, 8000, defaults.summaryMaxChars),
    maxEntriesPerChat: clampInteger(value.maxEntriesPerChat, 1, 200, defaults.maxEntriesPerChat),
    maxExistingForDedup: clampInteger(value.maxExistingForDedup, 1, 200, defaults.maxExistingForDedup),
    minConfidence: clampNumber(value.minConfidence, 0, 1, defaults.minConfidence),
    maxInjectChars: clampInteger(value.maxInjectChars, 200, 12000, defaults.maxInjectChars),
    eventInjectDays: clampInteger(value.eventInjectDays, 1, 90, defaults.eventInjectDays),
    injectConvention: clampInteger(value.injectConvention, 0, 100, defaults.injectConvention),
    injectDecision: clampInteger(value.injectDecision, 0, 100, defaults.injectDecision),
    injectFact: clampInteger(value.injectFact, 0, 100, defaults.injectFact),
    injectEvent: clampInteger(value.injectEvent, 0, 100, defaults.injectEvent),
    injectPersonFact: clampInteger(value.injectPersonFact, 0, 20, defaults.injectPersonFact),
    injectPersonPreference: clampInteger(value.injectPersonPreference, 0, 20, defaults.injectPersonPreference),
    retentionDays: clampInteger(value.retentionDays, 7, 3650, defaults.retentionDays),
    eventRetentionDays: clampInteger(value.eventRetentionDays, 1, 365, defaults.eventRetentionDays),
    includeProactiveRuns: clampBool(value.includeProactiveRuns, defaults.includeProactiveRuns),
    maxAttempts: clampInteger(value.maxAttempts, 1, 10, defaults.maxAttempts),
    deferMinutes: clampInteger(value.deferMinutes, 1, 1440, defaults.deferMinutes),
    useChatModel: clampBool(value.useChatModel, defaults.useChatModel),
    provider: clampString(value.provider, 64, defaults.provider),
    model: clampString(value.model, 120, defaults.model),
    human: normalizeHuman(value.human, defaults.human)
  };
}

/** 数据库路径：独立文件，避免动 messages.sqlite 与现有备份链路。 */
export function dailyMemoryDatabasePath(dataDir) {
  return path.join(String(dataDir || '.'), 'memory', 'daily-memory.sqlite');
}
