// 每日长期记忆调度：每天固定时刻抽取前一天的重要记忆，写入 daily-memory.sqlite。
// 结构参照 features/group-digest.js：单飞、可重配、启动补跑、失败不阻塞聊天。
import { getConfig } from '../core/config.js';
import { chatAllowed } from '../core/access.js';
import { normalizeDailyMemoryConfig } from '../core/daily-memory-config.js';
import { todayKey } from '../core/util.js';
import { nextAtFromHHMM } from '../core/reminders.js';
import { addUsage, emptyUsage } from '../llm/llm.js';
import { budgetStatus } from '../core/budget.js';
import { currentProviders } from '../core/providers.js';
import { completeMemoryExtraction } from '../llm/memory-chat.js';
import {
  buildExistingForDedup,
  buildExtractionPrompt,
  parseExtractionResult
} from '../memory/daily-memory-extract.js';

const DAY_MS = 86400000;
const VALID_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function dayWindow(day) {
  if (!VALID_DAY.test(String(day || ''))) return null;
  const start = Date.parse(`${day}T00:00:00+08:00`);
  return Number.isFinite(start) ? { start, end: start + DAY_MS } : null;
}

export class DailyMemoryManager {
  constructor({
    store,
    messageStore,
    sessions = null,
    log = console.log,
    now = () => Date.now(),
    config = getConfig,
    complete = completeMemoryExtraction,
    resolveChatName = () => ''
  } = {}) {
    this.store = store;
    this.messageStore = messageStore;
    this.sessions = sessions;
    this.log = log;
    this.now = now;
    this.configFn = config;
    this.complete = complete;
    this.resolveChatName = resolveChatName;
    this.timer = null;
    this.running = false;
    this.abortController = null;
    this.lastRun = null;
    this.nextRunAt = 0;
  }

  #cfg() {
    return normalizeDailyMemoryConfig(this.configFn()?.dailyMemory || {});
  }

  start() {
    this.stop();
    const cfg = this.#cfg();
    if (!cfg.enabled) return;
    if (cfg.startupCatchup && cfg.maxCatchupDays > 0) {
      const days = [];
      for (let i = 1; i <= cfg.maxCatchupDays; i += 1) {
        days.push(todayKey(this.now() - i * DAY_MS));
      }
      Promise.resolve()
        .then(async () => {
          for (const day of days.reverse()) await this.runOnce({ day, source: 'catchup' });
        })
        .catch((error) => this.log('[daily-memory] 启动补跑失败:', error?.message ?? error));
    }
    this.#schedule();
  }

  reconfigure() {
    this.stop();
    this.store.reconfigure?.(this.configFn());
    this.start();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = 0;
    this.abort();
  }

  abort() {
    if (this.abortController) {
      try { this.abortController.abort(); } catch { /* 已中止 */ }
    }
    this.abortController = null;
  }

  #schedule() {
    const cfg = this.#cfg();
    if (!cfg.enabled) return;
    const at = nextAtFromHHMM(cfg.time, this.now());
    if (at === null) return;
    this.nextRunAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runOnce({ source: 'schedule' })
        .catch((error) => this.log('[daily-memory] 定时执行失败:', error?.message ?? error))
        .finally(() => this.#schedule());
    }, Math.max(1000, at - this.now()));
    this.timer.unref?.();
  }

  status() {
    const cfg = this.#cfg();
    return {
      enabled: cfg.enabled,
      time: cfg.time,
      running: this.running,
      nextRunAt: this.nextRunAt,
      lastRun: this.lastRun,
      jobs: this.store.listJobs({ limit: 20 }),
      stats: this.store.stats()
    };
  }

  #candidateChats(cfg, window) {
    const root = this.configFn();
    if (root?.runtime?.mode !== 'active' || root?.runtime?.paused) return [];
    const chats = typeof this.messageStore?.listChats === 'function'
      ? this.messageStore.listChats()
      : [];
    return chats
      .map(String)
      .filter((chatKey) => /^(group|private):\d+$/.test(chatKey))
      .filter((chatKey) => chatAllowed(chatKey, root))
      .filter((chatKey) => {
        try {
          return this.messageStore.recentBetween(chatKey, window.start, window.end, { limit: 1 }).length > 0;
        } catch {
          return false;
        }
      })
      .slice(0, cfg.maxChats);
  }

  #overrides(cfg) {
    if (cfg.useChatModel !== false) return null;
    const provider = currentProviders().find((item) => item.id === cfg.provider);
    if (!provider?.baseURL || !provider?.apiKey || !cfg.model) {
      throw new Error('每日记忆专用模型未配置：请在设置 → 记忆里选择提供商与模型');
    }
    return {
      baseUrl: provider.baseURL,
      apiKey: provider.apiKey,
      model: cfg.model,
      timeoutMs: 180000
    };
  }

  async #runChat(chatKey, day, window, cfg, { force = false } = {}) {
    const job = this.store.getJob(chatKey, day);
    if (!force && (job?.status === 'done' || job?.status === 'empty')) {
      return { chatKey, status: 'skipped', reason: 'already done' };
    }
    const rawMessages = typeof this.messageStore?.recentBetween === 'function'
      ? this.messageStore.recentBetween(chatKey, window.start, window.end, {
        limit: cfg.maxScanMessagesPerChat
      })
      : [];
    const messages = (Array.isArray(rawMessages) ? rawMessages : [])
      .filter((message) => message && String(message.eventKind || 'message') !== 'game-secret')
      .filter((message) => String(message.text || '').trim());
    const now = this.now();
    if (messages.length < cfg.minMessages) {
      this.store.setJob(chatKey, day, {
        status: 'empty', messagesRead: messages.length, startedAt: now, finishedAt: now
      });
      return { chatKey, status: 'empty', messagesRead: messages.length };
    }

    this.store.setJob(chatKey, day, {
      status: 'running',
      attempts: (job?.attempts || 0) + 1,
      startedAt: now,
      error: ''
    });
    try {
      const existingRows = this.store.listEntries({
        chatKey, status: 'active', limit: cfg.maxExistingForDedup
      });
      const existing = buildExistingForDedup(existingRows, cfg.maxExistingForDedup);
      const prompt = buildExtractionPrompt({
        chatKey,
        chatName: this.resolveChatName(chatKey),
        day,
        messages,
        existing,
        maxMessages: cfg.maxMessagesPerChat,
        maxChars: cfg.maxCharsPerChat,
        maxScan: cfg.maxScanMessagesPerChat
      });
      const result = await this.complete({
        messages: prompt,
        signal: this.abortController?.signal || null,
        overrides: this.#overrides(cfg)
      });
      const parsed = parseExtractionResult(result?.text || '', {
        messageIds: messages.map((message) => message.id),
        existing,
        config: cfg
      });
      const counts = this.store.applyExtraction(chatKey, parsed, { sourceDate: day, now: this.now() });
      const usage = emptyUsage();
      addUsage(usage, result?.usage || {});
      usage.calls = 1;
      this.sessions?.recordExternalUsage?.(usage, { model: result?.model || '' });
      this.store.setJob(chatKey, day, {
        status: 'done',
        messagesRead: messages.length,
        entriesCreated: counts.created,
        entriesMerged: counts.merged,
        entriesSuperseded: counts.superseded,
        model: result?.model || '',
        usage,
        finishedAt: this.now()
      });
      return {
        chatKey, status: 'done', messagesRead: messages.length, ...counts,
        rejected: parsed.rejected.length
      };
    } catch (error) {
      const aborted = this.abortController?.signal?.aborted === true || error?.name === 'AbortError';
      this.store.setJob(chatKey, day, {
        status: aborted ? 'interrupted' : 'failed',
        error: String(error?.message ?? error).slice(0, 300),
        finishedAt: this.now()
      });
      return {
        chatKey, status: aborted ? 'interrupted' : 'failed',
        error: String(error?.message ?? error)
      };
    }
  }

  /**
   * 跑一天/一个会话。chatKey 为空时跑所有白名单内、当天有消息的会话。
   * force=true 时即使 job 已完成也重跑（upsert 不产生重复）。
   */
  async runOnce({ day, chatKey = '', force = false, source = 'manual' } = {}) {
    if (this.running) return { skipped: 'running' };
    const cfg = this.#cfg();
    if (!cfg.enabled && !force) return { skipped: 'disabled' };
    const budget = budgetStatus(
      this.configFn(),
      this.sessions?.todayUsage?.(todayKey(this.now())) || {}
    );
    if (budget.exceeded && budget.onExceed === 'block') {
      return { skipped: 'budget' };
    }
    const runCfg = budget.exceeded && budget.onExceed === 'degrade'
      ? { ...cfg, maxChats: Math.min(cfg.maxChats, 3) }
      : cfg;
    const targetDay = String(day || todayKey(this.now() - DAY_MS));
    const window = dayWindow(targetDay);
    if (!window) throw new Error(`日期格式非法：${targetDay}`);
    const root = this.configFn();
    const blocked = !root || root.runtime?.mode !== 'active' || root.runtime?.paused === true;
    if (chatKey) {
      if (blocked) {
        return {
          day: targetDay, source,
          results: [{ chatKey: String(chatKey), status: 'skipped', reason: 'observe/paused' }]
        };
      }
      if (!chatAllowed(String(chatKey), root)) {
        return {
          day: targetDay, source,
          results: [{ chatKey: String(chatKey), status: 'skipped', reason: 'chat not allowed' }]
        };
      }
    }
    const chats = chatKey
      ? [String(chatKey)]
      : this.#candidateChats(runCfg, window);
    if (!chats.length) return { day: targetDay, source, results: [] };

    this.running = true;
    this.abortController = new AbortController();
    const results = [];
    try {
      for (const key of chats) {
        if (this.abortController?.signal?.aborted) break;
        results.push(await this.#runChat(key, targetDay, window, runCfg, { force }));
      }
      if (!chatKey) {
        try { this.store.pruneRetention?.({ now: this.now() }); } catch { /* 清理失败不影响抽取结果 */ }
      }
    } finally {
      this.running = false;
      this.abortController = null;
    }
    this.lastRun = { day: targetDay, at: this.now(), source, results };
    return { day: targetDay, source, results };
  }
}

export default DailyMemoryManager;
