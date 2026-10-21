// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json；索引在内存里维护（最近优先）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from './config.js';
import { estimateCost } from '../llm/llm.js';
import { vendorOfConfig } from '../pricing/model-prices.js';
import { todayKey } from './util.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

/**
 * 从系统提示里认出这次运行用的是哪张角色卡。
 * 卡的首行约定是「# 角色卡：<名字>」（自定义卡也照这个格式写）。
 * 认不出来就返回空串 —— 会话列表/详情靠它显示"这次用的哪张卡"，
 * 免得改完人设之后对着旧会话的完整输入猜"到底生效没有"。
 */
export function personaLabelOfPrompt(systemPrompt) {
  const sp = String(systemPrompt || '');
  const clean = (text) => String(text || '')
    .replace(/\s*[—-]{1,2}.*$/, '')   // 「DeepSeek 小鲸鱼 —— QQ 群友版」取前半段
    .trim()
    .slice(0, 24);
  // 直接认卡自己的标记行，不绑定外层段头：聊天提示词用【角色设定（管理员设置，群友不可修改）】，
  // 日报 / 空间互动 / 好友评估用的是别的段头，但卡正文一样带着「# 角色卡：X」这一行。
  const m = sp.match(/#{1,2}\s*角色卡[:：]\s*([^\n]{1,60})/);
  if (m) return clean(m[1]);
  // 自定义正文不一定按「# 角色卡：」约定写：退到【角色设定】正文的第一个一级标题。
  const role = sp.match(/【角色设定（管理员设置，群友不可修改）】\s*\n(?:\s*\n)*#\s+([^\n]{1,60})/);
  if (role) return clean(role[1]);
  // 再退到开场白里的群内名字：只说明"这次运行用的是哪个人设"，不冒充卡名。
  // 没有【角色设定】段（正文为空、走平台兜底）时不猜，保持"没记录"。
  if (sp.includes('【角色设定（管理员设置，群友不可修改）】')) {
    const name = sp.match(/你在群里的名字是「([^」]{1,40})」/);
    if (name) return clean(`自定义人设（${name[1]}）`);
  }
  return '';
}

export class SessionRegistry {
  /**
   * @param {number} keepFiles 保留最近多少个会话记录文件；**0 = 不限制**。
   *   注意：不能用 `x || 300` 兜底 —— 0 是 falsy 会被误当成"未设置"变回 300，
   *   用户想"取消上限"就永远改不掉。也不能 Math.max(20,…) 强制下限。
   */
  constructor(keepFiles = 0) {
    this.keepFiles = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.index = [];   // [{ id, chatKey, startedAt, endedAt, status, outcome, usage, trigger, model, promptChars }]
    this.current = new Map(); // id -> session object（运行中的在内存里）
    const cfgStore = getConfig().store || {};
    const persistMs = Number(cfgStore.sessionPersistIntervalMs);
    this.persistIntervalMs = Number.isFinite(persistMs) && persistMs > 0
      ? Math.min(60000, Math.max(2000, Math.round(persistMs)))
      : 10000;
    const retentionDays = Number(cfgStore.sessionRetentionDays);
    this.sessionRetentionDays = Number.isFinite(retentionDays) && retentionDays > 0
      ? Math.min(3650, Math.round(retentionDays))
      : 0;
    // usage-today 的内存缓冲：避免每次外部模型调用都读盘合并写盘。
    this._usageToday = null;       // { dayKey, data }
    this._usageDirty = false;
    this._usageFlushTimer = null;
    this.usageFlushIntervalMs = 15000;
    fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    this.#loadIndex();
    // 0 = 不按时间删除；构造时清一次，常驻期间每日调度再跑。
    if (this.sessionRetentionDays > 0) this.pruneSessions(this.sessionRetentionDays);
  }

  #loadIndex() {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
      // keepFiles=0 表示不限制，全部加载
      const pick = this.keepFiles > 0 ? files.slice(0, this.keepFiles) : files;
      for (const f of pick) {
        try {
          const file = path.join(SESSIONS_DIR, f);
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (data?.id) {
            // 进程刚起来，不可能有任何会话真的在跑：盘上残留的 running/waiting 只可能来自
            // 硬崩溃（SIGTERM 优雅退出会由 abortAll 收成 aborted/error）。不回收的话控制台
            // 一直显示"运行中"、开机自动跟随还会选中它并持续轮询一个永不变化的详情
            // （daily-moments / qzone-interactions / identity-store 都做了同样的启动回收；
            // 2026-09-29 审查 P2）。文件一并改回，否则列表说 aborted、详情（读文件）说 running。
            if (data.status === 'running' || data.status === 'waiting') {
              data.status = 'aborted';
              data.waitUntil = null;
              // endedAt 也要补：控制台的详情头用它区分"· 结束"与"· 进行中"，
              // 只改 status 会出现"中止徽标 + 进行中"同屏矛盾（2026-09-29 审查 P2）。
              data.endedAt = data.endedAt ?? Date.now();
              this.#rewriteSessionFile(file, data);
            }
            this.index.push(this.#summary(data));
          }
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录还没建 */ }
  }

  /**
   * 只改写会话文件本身（原子替换 + 0600）。
   * 不走 #persist：它会在"非运行态"时累加今日用量，而启动回收不是一次真实运行，
   * 每重启一次就把这轮用量重复记一次。
   */
  #rewriteSessionFile(file, session) {
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
      fs.writeFileSync(tmp, JSON.stringify(session, null, 1), { encoding: 'utf8', mode: 0o600, flush: true });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } catch (error) {
      console.error('[sessions] 回收崩溃残留的运行状态失败:', error?.message ?? error);
    }
  }

  #summary(s) {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // waiting | running | done | noreply | error | aborted
      waitUntil: s.waitUntil ?? null,
      activity: s.activity ?? '',
      webSearchCount: s.webSearchCount ?? 0,
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      model: s.model ?? '',
      vendor: s.vendor ?? '',
      trigger: s.triggerSummary ?? '',
      triggerKind: s.triggerKind ?? '',
      triggerReason: s.triggerReason ?? s.contextReason ?? '',
      contextTier: s.contextTier ?? null,
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0,
      conversationMode: s.conversationMode ?? 'legacy',
      threadId: s.threadId ?? null,
      threadState: s.threadState ?? null,
      threadOpenedAt: s.threadOpenedAt ?? 0,
      threadIdleDeadline: s.threadIdleDeadline ?? 0,
      threadHardDeadline: s.threadHardDeadline ?? 0,
      threadResumeArmedUntil: s.threadResumeArmedUntil ?? 0,
      threadExpiresAt: s.threadExpiresAt ?? 0,
      threadCloseReason: s.threadCloseReason ?? '',
      promptLayout: s.promptLayout ?? '',
      persona: personaLabelOfPrompt(s.systemPrompt),
      lifecycleContinuation: s.lifecycleContinuation === true,
      callUsage: s.callUsage ?? []
    };
  }

  create({ chatKey, trigger, triggerSummary, status = 'running', waitUntil = null }) {
    const session = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status,
      waitUntil,
      trigger,                                 // 'message' | 'proactive'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      triggerKind: '',
      triggerReason: '',
      systemPrompt: '',
      userPrompt: '',
      promptChars: 0,
      injectedMessages: [],
      injectedMessageChars: 0,
      inputMessages: [],
      inputTools: [],
      inputRequestOptions: {},
      inputRound: 0,
      inputPayloadChars: 0,
      inputHasOmittedImages: false,
      model: '',
      rounds: 0,
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
    };
    this.current.set(session.id, session);
    this.#persist(session);
    this.index.unshift(this.#summary(session));
    if (this.keepFiles > 0) this.index = this.index.slice(0, this.keepFiles);
    return session;
  }

  get(id) {
    if (this.current.has(id)) {
      const s = this.current.get(id);
      return structuredClone(s);
    }
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 不克隆的读取：**只用于"读出来马上序列化"的热路径**（如 SSE 广播）。
   * 运行中的会话每次 session-update 都要走一次，get() 的 structuredClone
   * 会把整个会话（含每轮 raw 响应）全量复制一遍 —— 纯序列化用不到这份拷贝。
   * ⚠️ 返回的是活对象，调用方绝对不能改它；要改请用 get()。
   */
  peek(id) {
    if (this.current.has(id)) return this.current.get(id);
    try {
      return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
    } catch {
      return null;
    }
  }

  update(id) {
    const s = this.current.get(id);
    if (s) {
      this.#persistThrottled(s);
      const idx = this.index.findIndex((e) => e.id === id);
      if (idx >= 0) this.index[idx] = this.#summary(s);
    }
    return s ?? null;
  }

  /** 设置运行中的活动状态（思考/调用工具）并广播。 */
  setActivity(id, activity) {
    const s = this.current.get(id);
    if (!s) return null;
    s.activity = String(activity ?? '');
    this.update(id);
    return s;
  }

  finish(id, status) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // 节流时间戳随会话结束清理，防止 map 无限增长
    this.#persist(s);
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx >= 0) this.index[idx] = this.#summary(s);
    // 清理超出保留数的旧文件：与 pruneSessions 同一保护口径 —— 正在跑/等待中的会话不删
    //（长线程会话可能是最"旧"的文件，运行到一半被删会让本轮记录与用量消失），
    // 删掉的同步从内存索引收缩，避免"列表里点开却是空文件"（2026-10-12 审查）。
    try {
      if (this.keepFiles > 0) {
        const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
        if (files.length > this.keepFiles) {
          const dropped = new Set();
          for (const f of files.slice(0, files.length - this.keepFiles)) {
            const file = path.join(SESSIONS_DIR, f);
            try {
              const data = JSON.parse(fs.readFileSync(file, 'utf8'));
              if (data?.status === 'running' || data?.status === 'waiting') continue;
              fs.unlinkSync(file);
              dropped.add(String(data?.id ?? f.replace(/\.json$/, '')));
            } catch { /* 坏文件不动（与 pruneSessions 同） */ }
          }
          if (dropped.size) this.index = this.index.filter((e) => !dropped.has(String(e.id)));
        }
      }
    } catch { /* ignore */ }
    return s;
  }

  /**
   * 会话留档保留期（2026-10-10 审查）：默认 90 天（与运行台账 pruneRuns 同口径）。
   * 之前只有 keepFiles>0 才会清、默认 0 = 永不清理 —— 连跑数月就是无界增长（磁盘 +
   * 启动时全量读进内存的 index）。构造时清一次，常驻期间由每日保留期调度
   * （retentionPruneTargets）复用同一方法。正在跑/等待中的会话不删。
   * @returns {{ removed: number, kept: number }}
   */
  pruneSessions(retentionDays = 90) {
    const raw = Number(retentionDays);
    // 0/非法 = 不按时间删除（与 store.messageRetentionDays 同口径）
    if (!Number.isFinite(raw) || raw <= 0) return { removed: 0, kept: this.index.length };
    const days = Math.min(3650, Math.max(1, Math.round(raw)));
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    let files = [];
    try {
      files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    } catch {
      return { removed, kept: 0 };
    }
    const keptIds = new Set();
    for (const f of files) {
      const file = path.join(SESSIONS_DIR, f);
      // 文件名就是会话 id（sessionFile 的口径）；先按 mtime 预筛：最近写过的文件不可能
      // "结束于保留期之前"，不必解析 —— 把每日调度的同步读取量压到只剩旧文件（P3-1）。
      // （启动回收重写过的新 mtime 文件，会在 mtime 老化后的下一轮被清。）
      const id = f.replace(/\.json$/, '');
      try {
        if (fs.statSync(file).mtimeMs >= cutoff) {
          keptIds.add(id);
          continue;
        }
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data?.id) continue;
        keptIds.add(String(data.id));
        // 正在跑/等待中的不能删（硬崩溃残留会由启动回收改成 aborted，下次就按时间判了）；
        // 其余按"结束时间（缺了用开始时间）"判旧。
        const active = data.status === 'running' || data.status === 'waiting';
        const ended = Number(data.endedAt) || Number(data.startedAt) || 0;
        if (!active && ended && ended < cutoff) {
          fs.rmSync(file, { force: true });
          removed += 1;
          keptIds.delete(String(data.id));
        }
      } catch { /* 坏文件不动（loadIndex 本来也跳过它） */ }
    }
    // 内存索引同步收缩（index 只在启动全量读入，不跟着删一样无界）
    if (removed > 0) this.index = this.index.filter((e) => keptIds.has(String(e.id)));
    return { removed, kept: keptIds.size };
  }

  /**
   * 彻底丢弃一个会话：从内存索引移除 + 删掉磁盘文件，**不留"中止"记录**。
   *
   * 用途：档位判定"这次不响应"时，连"等待中"会话都不该出现在会话页
   * （否则用户会看到一堆等半天最后变"中止"的条目，还以为出错了）。
   * 与 finish(id,'aborted') 的区别：finish 是"开始了但没成"，会留下痕迹；
   * 这个是"压根没开始"，干净消失。
   *
   * ⚠️ 只用于从未真正运行过的会话（status='waiting'）。
   *    已经跑过并消耗了 token 的会话要走 finish，别用这个抹掉用量记录。
   */
  discard(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 已运行过的不允许丢弃（会抹掉用量/成本记录，导致对不上账）
    if (s && s.status !== 'waiting') return false;
    this.current.delete(id);
    // 与 finish() 同款：节流时间戳要随会话一起清（2026-10-04 全面复审 P3）。
    // 丢弃不写文件、也不进 index，_lastPersistAt 就成了唯一没人回收的按会话键 ——
    // 反复丢弃 waiting 会话（预算降级、时间窗、block 都会走这条路）就只涨不消
    //（实测 50 次丢弃后 Map size = 50，无界）。
    this._lastPersistAt?.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    try {
      const f = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* ignore */ }
    return this.index.length < before;
  }

  listSummaries(limit = 100) {
    return this.index.slice(0, limit);
  }

  #emptyUsageDay(dayKey) {
    return {
      dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      cachedTokens: 0, runs: 0, webSearchCount: 0, estimatedYuan: 0, unpricedRuns: 0
    };
  }

  #readUsageFile(dayKey) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (parsed?.dayKey === dayKey) return { ...this.#emptyUsageDay(dayKey), ...parsed };
    } catch { /* 无记录 */ }
    return this.#emptyUsageDay(dayKey);
  }

  #readUsageToday(dayKey) {
    if (this._usageToday?.dayKey === dayKey) return this._usageToday.data;
    // 跨天：先把前一天还没落盘的增量写掉，再切到新的一天
    if (this._usageDirty) this.#flushUsageToday();
    this._usageToday = { dayKey, data: this.#readUsageFile(dayKey) };
    return this._usageToday.data;
  }

  #scheduleUsageFlush() {
    if (this._usageFlushTimer) return;
    this._usageFlushTimer = setTimeout(() => this.#flushUsageToday(), this.usageFlushIntervalMs);
    this._usageFlushTimer.unref?.();
  }

  #flushUsageToday() {
    if (this._usageFlushTimer) {
      clearTimeout(this._usageFlushTimer);
      this._usageFlushTimer = null;
    }
    if (!this._usageDirty || !this._usageToday) return;
    const data = this._usageToday.data;
    const tmp = path.join(DATA_DIR, `usage-today.json.${process.pid}.tmp`);
    try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, path.join(DATA_DIR, 'usage-today.json'));
      this._usageDirty = false;
    } catch (error) {
      console.error('[sessions] 用量落盘失败:', error?.message ?? error);
    }
  }

  /** 停服/退出前把内存里的用量增量落盘。 */
  flushUsage() {
    this.#flushUsageToday();
  }

  /** 今日 token 统计（含运行中的）。 */
  todayUsage(dayKey) {
    const currentDay = todayKey(Date.now());
    const data = dayKey === currentDay
      ? this.#readUsageToday(dayKey)
      : this.#readUsageFile(dayKey);
    let promptTokens = Number(data.promptTokens) || 0;
    let completionTokens = Number(data.completionTokens) || 0;
    let totalTokens = Number(data.totalTokens) || 0;
    let cachedTokens = Number(data.cachedTokens) || 0;
    let webSearchCount = Number(data.webSearchCount) || 0;
    const runs = Number(data.runs) || 0;
    let estimatedYuan = Number(data.estimatedYuan) || 0;
    let unpricedRuns = Number(data.unpricedRuns) || 0;
    // 加上运行中的
    for (const s of this.current.values()) {
      promptTokens += s.usage.promptTokens;
      completionTokens += s.usage.completionTokens;
      totalTokens += s.usage.totalTokens;
      cachedTokens += Number(s.usage.cachedTokens) || 0;
      webSearchCount += Number(s.webSearchCount) || 0;
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, cachedTokens, runs, webSearchCount, estimatedYuan, unpricedRuns };
  }

  /** 在会话结束时累加今日用量。 */
  #bumpTodayUsage(s) {
    // 2026-10-06 复审 P3：waiting 会话被 finish 成 aborted（预算 block、并发满、无未读等
    // 早退路径）时 0 token、0 发送 —— 与启动回收"不是一次真实运行就不计"的口径对齐
    //（启动回收为此专门写了不 bump 的 #rewriteSessionFile），这类会话不计 runs，
    // 否则预算 block 期间每条进群消息都虚增一次"运行次数"。
    if (!(Number(s.usage?.totalTokens) > 0) && !(s.sent?.length > 0)) return;
    // 按"结束时刻"归属。用 startedAt 的话，跨零点的会话会把它的数字按开始那天算，发现文件
    // 是另一天就把新一天已累计的量重置成 0；之后当天的会话又因 dayKey 不匹配一直少算。
    this.#mergeTodayUsage({
      promptTokens: Number(s.usage?.promptTokens) || 0,
      completionTokens: Number(s.usage?.completionTokens) || 0,
      totalTokens: Number(s.usage?.totalTokens) || 0,
      cachedTokens: Number(s.usage?.cachedTokens) || 0,
      runs: 1,
      webSearchCount: Number(s.webSearchCount) || 0
    }, { model: s.model, vendor: s.vendor });
  }

  /**
   * 非会话类模型调用（记忆整理、群日报等）计入今日台账：这些调用照样花钱，此前完全没有账
   * —— 控制台"今日花费"与预算判定都偏乐观（2026-10-07 复审 P3）。
   * 与 #bumpTodayUsage 共用同一份文件与估价口径，但不计 runs（不是一次会话运行）。
   */
  recordExternalUsage(usage, { model = '', vendor = '' } = {}) {
    const totalTokens = Number(usage?.totalTokens) || 0;
    if (!(totalTokens > 0)) return;
    this.#mergeTodayUsage({
      promptTokens: Number(usage.promptTokens) || 0,
      completionTokens: Number(usage.completionTokens) || 0,
      totalTokens,
      cachedTokens: Number(usage.cachedTokens) || 0,
      runs: 0,
      webSearchCount: 0
    }, { model, vendor });
  }

  /** 把一份用量增量并进今天的汇总（内存累加 + 15 秒批量落盘）。 */
  #mergeTodayUsage(delta, { model = '', vendor = '' } = {}) {
    const dayKey = todayKey(Date.now());
    const data = this.#readUsageToday(dayKey);
    data.promptTokens += delta.promptTokens;
    data.completionTokens += delta.completionTokens;
    data.totalTokens += delta.totalTokens;
    data.cachedTokens = (data.cachedTokens || 0) + delta.cachedTokens;
    data.runs += delta.runs;
    data.webSearchCount = (data.webSearchCount || 0) + delta.webSearchCount;
    // 估算金额（改进方案 #8/J.3）：按实际模型估价；价格缺失记 0 并计 unpricedRuns
    // —— budgetStatus 会把它暴露给控制台，防"没价＝永远不超限"的静默失效。
    try {
      const cfgNow = getConfig();
      const est = estimateCost({ ...delta }, {
        model: model || cfgNow.api?.model,
        at: Date.now(),
        // 调用方记录过 vendor（兜底模型接管后记实际渠道）就优先用它；
        // 拿当前配置倒推历史是错的（vendorOfConfig 注释同款约定）。
        vendor: vendor || vendorOfConfig(cfgNow)
      });
      const cost = Number(est?.cost) || 0;
      data.estimatedYuan = (Number(data.estimatedYuan) || 0) + cost;
      if (delta.totalTokens > 0 && !(cost > 0)) data.unpricedRuns = (Number(data.unpricedRuns) || 0) + 1;
    } catch { /* 估价失败不影响用量累加（最坏情况＝这项当天少算） */ }
    this._usageDirty = true;
    this.#scheduleUsageFlush();
  }

  /**
   * 运行中会话的落盘节流：每个会话 2 秒内最多写一次盘。
   *
   * 曾经 update() 每次都 #persist —— activity 翻转（每轮 2 次）、每个工具调用
   * 都会同步 writeFileSync 整个会话 JSON（含提示词与所有消息，越跑越大）。
   * 同步写盘阻塞 event loop，排在后面的 SSE 广播/HTTP 响应全被拖慢。
   *
   * 可靠性：finish() 仍走 #persist 直接落最终态，所以留档完整性不变；
   * 代价是进程崩溃时最多丢 2 秒的运行中进度（索引摘要不受影响，在内存里）。
   */
  #persistThrottled(s) {
    const now = Date.now();
    this._lastPersistAt ||= new Map();
    const last = this._lastPersistAt.get(s.id) || 0;
    if (now - last < this.persistIntervalMs) return;
    this._lastPersistAt.set(s.id, now);
    this.#persist(s);
  }

  #persist(s) {
    try {
      // 会话 JSON 含完整聊天记录、系统提示词与逐轮模型输入输出：目录 0700 / 文件 0600，
      // 与 config.json 的口径一致（原来不带 mode，权限正确性全靠 data/ 恰好是 0700）。
      // rename 后显式 chmod：btrfs 上 writeFileSync 的 mode 会丢失（Issue #11）。
      fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
      const tmp = `${sessionFile(s.id)}.${process.pid}.tmp`;
      try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, sessionFile(s.id));
      // 高温路径不再 chmod：tmp 以 0600 创建，rename 保留权限；服务单元 UMask=0077 兜底。
      // 每次写盘多做一次元数据 syscall 会明显抬高云盘 IOPS。
      if (s.status !== 'running' && s.status !== 'waiting') this.#bumpTodayUsage(s);
    } catch (error) {
      console.error('[sessions] 持久化失败:', error?.message ?? error);
    }
  }
}

function triggerEntriesToText(trigger) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}
