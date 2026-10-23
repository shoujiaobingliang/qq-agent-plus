// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';

// after：原实现跑完再触发副作用钩子。包在**外层**而不是插进函数体里 —— 这几个渲染函数都有
// `if (!box) return;` 之类的提前返回，插进体内会让钩子在那种路径下不触发，而改写全局时是触发的。

import {
  closeModelModal, currentThinkingRaw, modelModalShell, renderThinkingSeg, thinkingStops
} from '../app.js';
import { api } from './api.js';
import {
  CHAT_MSG_MORE, CHAT_MSG_PAGE, LOADING_REVEAL_MS, SESSION_PAGE, THINKING_PURPOSES
} from './constants.js';
import { $, esc } from './dom.js';
import {
  normalizeAsrMax, normalizeStickerCollectMax, normalizeStickerMax, onebotIssueText, onebotStatusLineHtml, uiServiceOfUrl
} from './format.js';
import { QARegistry } from './registry.js';
import { scheduleSideNav } from './side-nav.js';
import { loadingLogs, loadingStatus, pendingSessionDetail, state } from './state.js';
import { appendChatMessageRows, loadChats, updateChatMessagesBody } from '../pages/chat.js';
import { renderSessionDetail, renderSessionList } from '../pages/sessions.js';
function afterRender(name, impl, args) {
  const result = impl(...args);
  QARegistry.after(name, args);
  return result;
}

function graduatedFeatureState(c = state.config || {}) {
  return {
    identity: c.identityPilot?.graduated === true,
    // 「好友管理」页承载入站好友申请的审批（该功能不受退役影响），导航入口
    // 不随 friendProposal 的退役隐藏——只隐藏会把入站审批一起藏掉。
    slang: c.slangPilot?.graduated === true,
    incidents: c.incidentPilot?.graduated === true
  };
}

function syncGraduatedFeatureNavigation(c = state.config || {}) {
  const features = graduatedFeatureState(c);
  for (const [feature, visible] of Object.entries(features)) {
    const tab = $(`[data-feature-nav="${feature}"]`);
    if (tab) tab.classList.toggle('hidden', !visible);
  }
  // 显隐会改导航的行高/项数 → 侧栏那个"会滑动的选中块"必须重新对位，
  // 否则高亮会停在错的那一行上（首屏这里就会跑一次：被门控的页签在 init 之后才收起）。
  scheduleSideNav(document);
}

/**
 * 关对话框：先挂 `.closing` 播一段退场动画（150ms：整层淡出 + 卡片微收 + 糊一下），
 * 动画结束再调用原生 close()。
 * 为什么需要它：原生 `dialog.close()` 是瞬间生效的 —— 元素立即变成 display:none，
 * 退场动画根本没有机会播。所以"关"这件事必须由 JS 分两步做。
 * 兜底计时器：万一动画没跑（用户开了"关闭全部动效"、或者 `animationend` 因为节点被别处
 * 移除而没触发），200ms 后无条件 close() —— 一个关不掉的对话框比没有动画严重得多。
 */
function closeDialog(dialog) {
  if (!dialog || typeof dialog.close !== 'function') return;
  if (!dialog.open) return;
  if (dialog.dataset.closing === '1') return;
  dialog.dataset.closing = '1';
  dialog.classList.add('closing');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    dialog.classList.remove('closing');
    delete dialog.dataset.closing;
    if (dialog.open) dialog.close();
  };
  dialog.addEventListener('animationend', (e) => { if (e.target === dialog) finish(); });
  setTimeout(finish, 200);
}

function askForConfirmation(message) {
  return new Promise((resolve) => {
    let settled = false;
    const overlay = modelModalShell({
      head: '确认操作',
      body: `<div style="white-space:pre-wrap">${esc(message)}</div>`,
      foot: '<button type="button" class="btn" data-confirm-cancel>取消</button>'
        + '<button type="button" class="btn btn-danger" data-confirm-accept>确认</button>',
      danger: true
    });
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      closeModelModal(overlay);
      resolve(confirmed);
    };
    overlay.querySelector('[data-confirm-cancel]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-confirm-accept]').addEventListener('click', () => finish(true));
    overlay.querySelector('.model-modal-close').addEventListener('click', () => finish(false));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(false);
    });
    overlay.querySelector('[data-confirm-cancel]').focus();
  });
}

function setLoadingStatus(text) {
  state.bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = state.bootLogs.slice(-12).join('\n');
}

function revealLoading() {
  if (state.appReady || state.loadingRevealed) return;
  if (!document.getElementById('loading-overlay')) return;
  state.loadingRevealed = true;
  document.documentElement.classList.remove('boot-silent');
  document.documentElement.classList.add('boot-show');
}

function revealLoadingIfSlow() {
  if (state.loadingRevealTimer) clearTimeout(state.loadingRevealTimer);
  state.loadingRevealTimer = setTimeout(revealLoading, LOADING_REVEAL_MS);
}

function hideLoading() {
  state.appReady = true;
  if (state.loadingRevealTimer) clearTimeout(state.loadingRevealTimer);
  try { clearTimeout(window.__bootRevealFallback); } catch { /* 忽略 */ }
  document.documentElement.classList.remove('boot-show');
  const el = document.getElementById('loading-overlay');
  if (!el) return;
  if (!state.loadingRevealed) { el.remove(); return; }   // 从没显示过，直接摘掉
  setTimeout(() => el.remove(), 260);              // 等淡出动画
}

async function pollUntilReady() {
  const startedAt = Date.now();
  try {
    const status = await api('/api/status');
    if (!status.onebot?.connected) {
      // 首屏就卡在这儿的多半是协议端没起来，把原因直接写出来，别让人对着"正在连接"干等
      const why = onebotIssueText(status.onebot, { withRaw: false });
      setLoadingStatus(why ? `OneBot 还没连上：${why}` : '正在连接外部 OneBot 服务…');
    } else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('启动超时。请检查服务日志和 OneBot WS/HTTP 配置。');
      return false;
    }
    return false;
  }
}

// 列表按 key 做增量更新：已存在且内容未变的行，保持同一个 DOM 节点。
// 为什么需要它：以前列表是 box.innerHTML = rows.map(...) 整列重建，每次刷新
// （15 秒一次 + 推送）都会把每一行销毁重建——行上的悬停/选中态、正在跑的动画、
// 内部滚动位置全被重置，看起来就是"列表闪来闪去"。这里按 key 对齐：
//   · key 相同且 HTML 相同 → 复用原节点（什么都不做）
//   · key 相同但 HTML 变了 → 只替换这一行
//   · key 不存在 → 插入新节点；多余的 key → 删除
/**
 * 列表行退场动画的等待时长（ms）—— 必须与 ui/style.css 里 `@keyframes rowOut` 那条
 * `var(--dur-slow)`（260ms）一致：这里等的就是那条动画。改一处必须改两处。
 */
const LEAVE_MS = 260;

/** 取消一行的退场（它在新一轮列表里又出现了，不能让它到点被删掉）。 */
function cancelLeave(node) {
  const view = node.ownerDocument?.defaultView;
  if (node.__leaveTimer) {
    (view?.clearTimeout || clearTimeout).call(view, node.__leaveTimer);
    node.__leaveTimer = null;
  }
  node.__leaving = false;
  node.classList.remove('leaving');
  node.style.removeProperty('--leave-h');
  node.style.removeProperty('height');
}

function patchKeyedList(container, entries, keyAttr = 'data-key', { exit = false } = {}) {
  if (!container) return;
  // 比较用的规范化：把"由本地 ticker 维护"的倒计时文本抹掉，
  // 否则每次刷新都判定成"行变了"，整行重建（倒计时还会闪回旧值）。
  const VOLATILE = /(<(?:span|strong)[^>]*data-(?:until|deadline)="[^"]*"[^>]*>)[\s\S]*?(<\/(?:span|strong)>)/g;
  const norm = (html) => String(html).replace(VOLATILE, '$1$2');
  const existing = new Map();
  for (const node of Array.from(container.children)) {
    const key = node.getAttribute && node.getAttribute(keyAttr);
    if (key) existing.set(key, node);
  }
  const makeNode = (html, key) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html).trim();
    const node = tpl.content.firstElementChild;
    if (!node) return null;
    node.setAttribute(keyAttr, key);
    node.__renderedHtml = html;
    node.__cmp = norm(html);
    return node;
  };
  const seen = new Set();
  let prev = null;
  for (const entry of entries) {
    const key = String(entry.key);
    if (seen.has(key)) continue;
    seen.add(key);
    let node = existing.get(key) || null;
    // 上一轮正在退场的行又回来了（列表抖动 / 过滤来回切）：取消退场、原地留下这一行。
    // 不取消的话，那个 setTimeout 到点会把刚回来的行删掉 —— 列表少一行，而且没人补。
    if (node?.__leaving) cancelLeave(node);
    const cmp = norm(entry.html);
    if (node && node.__cmp !== cmp) {
      const fresh = makeNode(entry.html, key);
      if (fresh) { node.replaceWith(fresh); node = fresh; }
    } else if (!node) {
      node = makeNode(entry.html, key);
    }
    if (!node) continue;
    const wantNext = prev ? prev.nextElementSibling : container.firstElementChild;
    if (node !== wantNext) container.insertBefore(node, prev ? prev.nextSibling : container.firstChild);
    prev = node;
  }
  const leaving = [];
  for (const [key, node] of existing) {
    if (seen.has(key) || node.__leaving) continue;
    leaving.push(node);
  }
  if (leaving.length) {
    // 退场（可选，由调用方开）：先塔缩再移除，否则下面的行会”喍”地跳上来。
    // 只有两个前提都满足才值得等：
    //   ① 这个节点真的被渲染过（offsetHeight > 0）—— 没有布局盒就没有高度可塔；
    //      happy-dom 这类无布局环境也走这条，于是行为与改动前逐字一致（不延后删除）；
    //   ② 用户没关动效（data-motion 有值即算关，见下）。
    // 不具备时直接 remove()，语义与原来一模一样。
    //
    // 2026-10-09 审查两处修正：
    //   · 判据从”=== 'off'”放宽到”有值即关”：style.css 对 reduced 也是 animation:none
    //     （html[data-motion='reduced'] * 规则），只认 off 会让 reduced 下这一行先静止
    //     260ms 再消失 —— 正是”减少动效”想消掉的那一跳。
    //   · 先把该量的高度量完、再统一写：原来”逐行读 offsetHeight → 立即 remove”是读写交替，
    //     删 N 行触发 N 次强制重排（列表上百行时可感知）。
    const motionOff = Boolean(container.ownerDocument?.documentElement?.getAttribute('data-motion'));
    const heights = motionOff ? [] : leaving.map((node) => node.offsetHeight || 0);
    for (const [index, node] of leaving.entries()) {
      const height = motionOff ? 0 : heights[index];
      if (!exit || height <= 0) {
        node.remove();
        continue;
      }
      // 高度只能由 JS 量好——CSS 里没法从 auto 插值到 0（interpolate-size 也帮不上，
      // 因为这里要的是“从当前实际高度出发”而不是“从 auto 出发”）。
      const view = container.ownerDocument?.defaultView;
      node.__leaving = true;
      node.style.setProperty('--leave-h', `${height}px`);
      node.classList.add('leaving');
      node.__leaveTimer = (view?.setTimeout ? view.setTimeout.bind(view) : setTimeout)(
        () => { node.__leaving = false; node.remove(); }, LEAVE_MS);
    }
  }
}

// 只在内容真的变化时替换 DOM。
// 背景：控制页/异常页等会在每次状态刷新（15 秒一次 + 推送）时重建整块 HTML，
// 数据没变也照重建 —— 页面就"整页闪一下"。用这个函数收口：HTML 相同直接跳过。
/**
 * 取出容器内输入控件的当前值（按 id 存）：重画后要还回去，
 * 否则"用户在整块重画那一刻还没保存的输入"会被服务端上一次的值覆盖
 * （好友管理页二十多个数字框、异常处理设置、人物印象搜索框都踩过这一类）。
 * 只保留有 id 的控件 —— 没 id 的本来也只能靠位置猜，猜错反而更糟。
 */
function captureEditableValues(root) {
  const values = new Map();
  if (!root?.querySelectorAll) return values;
  const seen = new Map();     // id → 已出现几次：同容器内重复 id 时按出现序号配对，不串
  for (const node of root.querySelectorAll('input[id], select[id], textarea[id]')) {
    const box = node.type === 'checkbox' || node.type === 'radio';
    // __renderedValue = 上一轮**渲染出来**的值；与它不同才说明用户动过这个控件
    const current = box ? node.checked === true : String(node.value ?? '');
    const nth = seen.get(node.id) || 0;
    seen.set(node.id, nth + 1);
    values.set(`${node.id}|${nth}`, { box, current, rendered: node.__renderedValue });
  }
  return values;
}

/** 还回用户改过、还没保存的那一份：
 *  · **只还原"用户真的动过"的控件**（当前值 ≠ 上一轮渲染值）——没动过的控件要跟着服务端新值走，
 *    否则服务端纠正过的值（越界被夹、别名改名…）会被永久挡在界面外（2026-10-03 复审指出）。
 *  · **服务端这一轮也改了同一个值时不还原**（2026-10-04 复审 P2）：两个条件必须同时成立。
 *    只判"用户动过"的话，一次保存后的回填会把服务端刚夹好的值又盖回用户输的那个 ——
 *    好友管理页把 99999 输进 max=365 的框，服务端存 365，界面却显示 99999（存的不是显示的）。
 *  · 下拉只在**该选项还在**时还原（选项没了不强塞非法值）；控件换了类型（同名 checkbox↔text）不还原。
 *  · 遍历**新**节点而不是按 id 反查：省掉选择器转义，控件被删/改名时自然跳过。 */
function restoreEditableValues(root, values) {
  // 不用 values.size 提前返回：**每个新控件都要记下这一轮渲染出来的值**（首轮容器是空的，
  // values 为空，但记录渲染值仍要做，否则第二次重画时无从判断"用户动过没有"）。
  if (!root?.querySelectorAll) return;
  const seen = new Map();
  for (const node of root.querySelectorAll('input[id], select[id], textarea[id]')) {
    const nth = seen.get(node.id) || 0;
    seen.set(node.id, nth + 1);
    const saved = values.get(`${node.id}|${nth}`);
    const box = node.type === 'checkbox' || node.type === 'radio';
    const renderedNow = box ? node.checked === true : String(node.value ?? '');
    // 服务端这一轮有没有动这个值：动了就以服务端为准，不回填用户那份
    const serverChanged = saved && saved.rendered !== undefined
      && String(renderedNow) !== String(saved.rendered);
    if (saved && saved.box === box && saved.rendered !== undefined
      && saved.current !== saved.rendered && !serverChanged) {
      if (box) node.checked = saved.current;
      else if (node.tagName !== 'SELECT' || [...node.options].some((option) => option.value === saved.current)) {
        node.value = saved.current;
      }
    }
    // ⚠️ 必须记 **renderedNow（这一轮 HTML 渲染出来的值）**，不能记还原后的 node.value
    //（2026-10-04 复审 P1）。记成还原后的值等于把基线污染成"用户输入"：下一轮捕获时
    // current === rendered，看起来用户没动过；而服务端这一轮又确实改了值（renderedNow ≠
    // 基线）→ serverChanged 成立 → 不还原 → **未保存的输入在第二轮就被冲掉**。
    // 也就是说"保留未保存输入"只保得住一轮。实测：render1=1 → 用户改 42 → render2 保住 42
    // 但基线被写成 42 → render3 直接回到 1。
    node.__renderedValue = renderedNow;
  }
}

/**
 * 写一块 HTML，数据没变就跳过（去重靠 el.__renderedHtml）。
 * options.force：**用户自己触发的刷新**要设 true（筛选下拉、按回车搜索…）。
 *   背景：焦点守卫会拦下"焦点在输入类控件上"的整块重写，可它分不清"后台轮询要重画"和
 *   "刚刚那个控件自己要重画"。异常处理页的状态/等级筛选选完不动（表格还是上一档）、
 *   人物印象页搜索框按回车没反应，都是被自己触发的刷新被守卫挡了（2026-10-04 复审 P1）。
 *   兜底的 1.5 秒状态轮询会在焦点移开后补上，但那让用户看到的是"筛选时灵时不灵"，
 *   而异常日志页此刻正把没筛选的那批行当成筛选结果看。
 *   force 时顺带把焦点还给同一个 id 的控件（重画会换掉节点，不还就得重按一次）。
 */
function setHtmlIfChanged(el, html, options = {}) {
  if (!el) return false;
  if (el.__renderedHtml === html) return false;
  const values = captureEditableValues(el);
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  // 用户正在这块区域里打字时，这一轮重拉先别写：整块 innerHTML 会把输入框连同内容一起换掉
  //（焦点丢失、正在敲的字符消失）—— 与 2026-10-02「屏蔽名单搜索框只能输一个字」同族。
  // 只拦焦点在输入类控件上：按钮上的焦点不拦（保存后的「已保存」提示要能画出来），
  // 焦点离开后下一轮自动补上，不会卡住页面。
  const focusedInput = active && active !== el && el.contains?.(active)
    && /^(input|textarea|select)$/i.test(active.tagName || '');
  if (focusedInput && options.force !== true) return false;
  const refocusId = focusedInput && options.force === true ? active.id : '';
  el.__renderedHtml = html;
  el.innerHTML = html;
  restoreEditableValues(el, values);
  if (refocusId) {
    const again = el.querySelector(`#${CSS?.escape ? CSS.escape(refocusId) : refocusId}`);
    if (again && typeof again.focus === 'function') {
      again.focus();
      // 光标停在末尾：用户接着敲的是新内容，不是去改中间（搜索框场景最常见）
      if (typeof again.setSelectionRange === 'function') {
        try { again.setSelectionRange(again.value.length, again.value.length); } catch { /* number 类型不支持，忽略 */ }
      }
    }
  }
  return true;
}

// 把整块区域换成一句错误提示。**必须走这里**，不要直接写 innerHTML：
// setHtmlIfChanged 靠 el.__renderedHtml 去重，出错时缓存里还留着上一次成功渲染的 HTML，
// 而页面停在错误提示上；等下一次读取成功、HTML 又恰好与缓存相同（数据没变），
// 就会被判定成"没变化"跳过写入 —— 页面永远停在"读取失败"，只有 F5 能救。
// 控制页早就单独处理过这一点（见 renderControlHub 的注释），这里收口成同一个约定。
function setBoxError(el, html) {
  if (!el) return;
  el.__renderedHtml = null;
  if ('__hubBuilt' in el) el.__hubBuilt = false;
  el.innerHTML = html;
}

// 状态条里的标签：文字会随数据变长，窄窗口下容易换行把整块内容顶下去。
// 统一通过这个 setter 写，顺便把完整文本放进 title，截断时鼠标悬停还能看到。
function setStatusLabel(selector, text) {
  const el = $(selector);
  if (!el) return;
  el.textContent = text;
  el.title = text;
}

// 状态刷新时只换这一行的文字，不重渲染整段表单（否则会清掉用户正在填的内容）
function updateOnebotStatusLine() {
  const el = $('#onebot-status-line');
  if (el) el.innerHTML = onebotStatusLineHtml();
}

function scheduleSessionRender() {
  if (state.sessionRenderScheduled) return;
  state.sessionRenderScheduled = true;
  setTimeout(() => {
    state.sessionRenderScheduled = false;
    if (state.tab === 'sessions') renderSessionList();
    const id = state.currentSessionId;
    const patch = id ? pendingSessionDetail.get(id) : null;
    pendingSessionDetail.clear();
    if (patch && state.tab === 'sessions') {
      // 详情用事件里的消息流渲染：HTTP 详情（systemPrompt 等）打底，SSE patch 覆盖动态字段。
      // sent/finishReason 等收尾字段 patch 优先 —— 它们走 SSE 实时推，HTTP 详情里的是旧值。
      renderSessionDetail({
        ...(state.sessionDetail || {}),
        ...patch,
        triggerSummary: patch.triggerSummary ?? state.sessionDetail?.triggerSummary ?? '',
        systemPrompt: state.sessionDetail?.systemPrompt ?? '',
        userPrompt: state.sessionDetail?.userPrompt ?? '',
        sent: patch.sent ?? state.sessionDetail?.sent ?? [],
        error: patch.error !== undefined ? patch.error : (state.sessionDetail?.error ?? null),
        finishReason: patch.finishReason ?? state.sessionDetail?.finishReason ?? null,
        endedAt: patch.endedAt ?? state.sessionDetail?.endedAt ?? null
      });
    }
  }, 80);
}

function scheduleChatsRefresh() {
  if (state.chatsRefreshTimer) return;
  state.chatsRefreshTimer = setTimeout(() => {
    state.chatsRefreshTimer = null;
    if (state.tab === 'chats') loadChats({ quiet: true });
  }, 1500);
}

/**
 * 给滚动容器挂"滚到底部就加载更多"的监听。
 *
 * 要点：
 *   1. 节流必须带"尾随调用"：曾经是被节流的事件直接丢弃 —— 快速滚动时
 *      事件密集，"抵达底部"那一下几乎总是落在 120ms 窗口内被扔掉，
 *      用户停手后又不会再有新事件 → 加载永远不触发，表现为
 *      "滚得快会滚不下去，像撞墙"。现在窗口内的事件会留下一个尾随定时器，
 *      停手后最多 120ms 内补一次检查。
 *   2. 距底部 <400px 就触发（曾经是 100px）：快速甩滚时惯性大，
 *      100px 的提前量太小，内容还没加载出来人已经撞底了。
 *   3. 交给 onLoadMore 自己判断是否真有更多数据；没有就直接返回，避免空转重渲染
 */
function attachScrollLoader(elId, onLoadMore) {
  const el = document.getElementById(elId);
  if (!el) return;

  // ⚠️ 防重复绑定：这个函数会被多次调用（渲染一次调一次），
  //    曾经没做防护，结果加载 N 批就挂了 N 个监听器 ——
  //    滚一次会同时触发 N 次 onLoadMore，一次跳好几批，
  //    而且每个监听器各有自己的 last 变量，120ms 节流形同虚设。
  //    这里把状态存在元素自身上，重复调用直接复用。
  if (el.__scrollLoader) {
    el.__scrollLoader.onLoadMore = onLoadMore;   // 只更新回调，不重复挂监听
    return;
  }
  const stateLoader = { last: 0, pending: null, onLoadMore };
  el.__scrollLoader = stateLoader;

  const THROTTLE_MS = 120;
  const NEAR_BOTTOM_PX = 400;
  const check = () => {
    stateLoader.last = Date.now();
    // scrollTop + 可视高度 >= 总高度 - 400 就认为快到底了
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX) stateLoader.onLoadMore();
  };

  el.addEventListener('scroll', () => {
    const elapsed = Date.now() - stateLoader.last;
    if (elapsed >= THROTTLE_MS) {
      // 窗口外的正常事件：立即处理；有尾随定时器就取消（避免重复检查）
      if (stateLoader.pending) { clearTimeout(stateLoader.pending); stateLoader.pending = null; }
      check();
    } else if (!stateLoader.pending) {
      // 窗口内被节流的事件：不丢，留一个尾随调用 —— 停手后补做最后一次检查
      stateLoader.pending = setTimeout(() => { stateLoader.pending = null; check(); }, THROTTLE_MS - elapsed);
    }
  }, { passive: true });
}

/** 会话列表：滚到底部再加载 SESSION_PAGE 条。 */
function initSessionScrollLoader() {
  attachScrollLoader('session-list', () => {
    const all = state.sessions || [];
    if (state.sessionLimit >= all.length) return;   // 已经全显示了
    state.sessionLimit = Math.min(all.length, state.sessionLimit + SESSION_PAGE);
    renderSessionList();
  });
}

/**
 * 存档页消息列表：滚到底部再追加 CHAT_MSG_MORE 条。
 *
 * ⚠️ 监听目标是 #chat-detail —— 它自带 .detail-pane 类（overflow-y:auto），
 *   是真正滚动的容器。曾经在它内部又套了一层 .archive-scroll 想做内层滚动，
 *   结果内层没有高度基准、被内容撑开，滚动事件全发生在外层，
 *   导致监听挂空、"继续滚动没反应"。现在只保留一层滚动容器。
 *
 * ⚠️ 加载更多只走"追加"（appendChatMessageRows）：
 *   曾经这里调 updateChatMessagesBody(true)，每批都要全量 sort + 全量
 *   innerHTML 重建（行数越滚越多），还有 scrollTop 补偿把视口"吸"在底部
 *   → 连锁触发下一批加载 → 主线程被反复长阻塞，
 *   表现为"滑到临界线继续向下滚动反应迟钝"。
 */
function initChatScrollLoader() {
  attachScrollLoader('chat-detail', () => {
    const total = (state.chatMessages || []).length;
    const prev = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
    if (prev >= total) return;                     // 已经全显示了
    state.chatMsgLimit = Math.min(total, prev + CHAT_MSG_MORE);
    // 行数账本对不上（结构刚被轮询重建过等异常）→ 全量兜底；正常走追加
    if ((state.chatMsgRendered || 0) !== Math.min(prev, total)) {
      updateChatMessagesBody(true);
    } else {
      appendChatMessageRows(prev);
    }
  });
}

function readAssetImage(file) {
  if (!file) return Promise.resolve('');
  if (file.size > 8 * 1024 * 1024) return Promise.reject(new Error('表情图片不能超过 8 MiB'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 记忆页每条印象前面的标记：「[09-20 · 模型记的] 」——多老 + 谁写的，一眼分得开。
 *  时间戳以前会被每次整理刷成当天（已修），所以这个日期现在真能当"年龄"看。
 *  今年的只显示月-日；往年的要带年份，否则 1 月看到 [12-20] 会像是"还没到的那天"。 */
function impressionMetaLabel(entry) {
  const raw = Number(entry?.lastObservedAt || entry?.createdAt) || 0;
  // 坏数据（负数/纳秒级/超范围）会让 toISOString 抛 RangeError，整页记忆一起挂 —— 回退成 ??
  const at = Number.isFinite(raw) && raw > 0 && raw <= 8.64e15 ? raw : 0;
  const shanghai = (ts) => new Date(ts + 8 * 60 * 60 * 1000).toISOString();
  const thisYear = shanghai(Date.now()).slice(0, 4);
  let when = '??-??';
  if (at > 0) {
    const key = shanghai(at);
    when = key.startsWith(thisYear) ? key.slice(5, 10) : key.slice(0, 10);
  }
  const origin = { model: '模型记的', consolidated: '整理改写', manual: '手动编辑' }[entry?.origin] || '早先的';
  return `[${when} · ${origin}] `;
}

function identityPilotSettingsPatch(
  c,
  enabled,
  friendProposal = null,
  incomingFriendRequest = null
) {
  return {
    ...(c.identityPilot || {}),
    enabled: enabled === true,
    incomingFriendRequest: {
      ...(c.identityPilot?.incomingFriendRequest || {}),
      ...(incomingFriendRequest || {})
    },
    friendProposal: {
      ...(c.identityPilot?.friendProposal || {}),
      ...(friendProposal || {})
    }
  };
}

function experimentalFeatureLaunchPatch(c, feature, ownerUin = '') {
  const current = c.identityPilot || {};
  if (feature === 'identity') {
    return {
      identityPilot: {
        ...current,
        enabled: true,
        graduated: true
      }
    };
  }
  if (feature === 'auto-friend') {
    return {
      identityPilot: {
        ...current,
        enabled: true,
        incomingFriendRequest: {
          ...(current.incomingFriendRequest || {}),
          enabled: true,
          autoWhitelist: true
        },
        friendProposal: {
          ...(current.friendProposal || {}),
          enabled: true,
          graduated: true,
          activeDispatchEnabled: true,
          ownerUin: String(ownerUin || current.friendProposal?.ownerUin || '').trim()
        }
      }
    };
  }
  if (feature === 'slang') {
    return {
      slangPilot: {
        ...(c.slangPilot || {}),
        enabled: true,
        graduated: true,
        ownerUin: String(
          ownerUin
          || c.slangPilot?.ownerUin
          || c.identityPilot?.friendProposal?.ownerUin
          || ''
        ).trim()
      }
    };
  }
  if (feature === 'incidents') {
    return {
      incidentPilot: {
        ...(c.incidentPilot || {}),
        enabled: true,
        graduated: true,
        ownerUin: String(
          ownerUin
          || c.incidentPilot?.ownerUin
          || c.identityPilot?.friendProposal?.ownerUin
          || c.slangPilot?.ownerUin
          || ''
        ).trim()
      }
    };
  }
  throw new Error(`未知实验功能：${feature}`);
}

function requestExperimentOwnerUin(feature, current = '') {
  return new Promise((resolve) => {
    const allow = (state.config?.allow?.private || []).map(String);
    const overlay = modelModalShell({
      head: feature === 'auto-friend'
        ? '配置好友审批管理员'
        : feature === 'incidents'
          ? '配置异常告警管理员'
          : '配置黑话审批管理员',
      body: `
        <div class="field">
          <label>管理员 QQ</label>
          <input type="text" id="experiment-owner-uin" inputmode="numeric"
            list="experiment-owner-options" value="${esc(current)}" />
          <datalist id="experiment-owner-options">
            ${allow.map((uin) => `<option value="${esc(uin)}"></option>`).join('')}
          </datalist>
        </div>
        <div class="hint" id="experiment-owner-error">管理员必须在私聊白名单中。</div>`,
      foot: '<button type="button" class="btn" data-owner-cancel>取消</button>'
        + '<button type="button" class="btn btn-primary" data-owner-confirm>继续上线</button>'
    });
    const finish = (value) => {
      closeModelModal(overlay);
      resolve(value);
    };
    overlay.querySelector('[data-owner-cancel]').addEventListener('click', () => finish(''));
    overlay.querySelector('.model-modal-close').addEventListener('click', () => finish(''));
    overlay.querySelector('[data-owner-confirm]').addEventListener('click', () => {
      const value = overlay.querySelector('#experiment-owner-uin').value.trim();
      const allowed = state.config?.allowAllWhenEmpty === true || allow.includes(value);
      if (!/^\d{5,15}$/.test(value) || !allowed) {
        overlay.querySelector('#experiment-owner-error').textContent =
          '请输入私聊白名单中的有效 QQ 号。';
        return;
      }
      finish(value);
    });
  });
}

function splitThinkingRowsHtml(c) {
  const service = uiServiceOfUrl(c.api?.baseUrl);
  const stops = thinkingStops(c);
  const raw = (currentThinkingRaw(c) && typeof currentThinkingRaw(c) === 'object') ? currentThinkingRaw(c) : {};
  // 现有值可能不在该渠道的档位里（典型：聊天设了 off，但渠道关不掉）——映射到等价档显示：
  // off 在关不掉的渠道上等价于最低档 low（运行时发的就是同一个值），其余未知值按「默认」。
  const normStop = (val) => {
    const all = ['on', ...stops];
    if (all.includes(val)) return val;
    if (val === 'off') return stops.includes('off') ? 'off' : (stops[0] || 'on');
    return 'on';
  };
  const rows = THINKING_PURPOSES.map((p) => ({
    key: p.key,
    label: p.label,
    html: renderThinkingSeg(`thinking-seg-${p.key}`, stops, normStop(raw[p.key]), service, true)
  }));
  return {
    rows,
    note: stops.includes('off') ? ''
      : '<div class="hint" style="margin:2px 0 0">该渠道不提供「关闭」：原先的「关闭」设置会显示并发送为最低档（同一个值，等价）。</div>'
  };
}

/** 分设模式整块内容的 HTML（行标签 + 档位条）。 */
function splitRowsHtml(c) {
  const { rows, note } = splitThinkingRowsHtml(c);
  return {
    inner: rows.map((r) => `<div style="display:flex;align-items:center;gap:8px;margin-top:4px"><span class="muted" style="font-size: var(--fs-sm);white-space:nowrap;min-width:64px">${esc(r.label)}</span><div style="flex:1;min-width:0" id="thinking-seg-slot-${r.key}">${r.html}</div></div>`).join(''),
    note
  };
}

function extraBodyText(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).length === 0) return '';
  try { return JSON.stringify(obj, null, 2); } catch { return ''; }
}

/**
 * 保存成功后把"服务端实际存下来的值"回填到控件上。
 * 以前只有省 Token 页保存后会重画，别的页不回填：控件里留着旧输入，看着像保存成功了、
 * 其实存的是另一个值（夹上限、换算档位这类字段都会这样）。先从清单条数这一个做起。
 *
 * ⚠️ 滑条要补发一次 input 事件（2026-10-04 复审 P2）：程序化写 .value **不触发** input，
 *    而滑条的读数（#cfg-sticker-max-now）和填充色（--pos）只在那一个监听里更新 ——
 *    直接写值的话，滑块停在 10.4、服务端存 10，"已保存 ✓"出来了读数还显示着旧的。
 */
function syncClampedInputs() {
  const fill = (node, value) => {
    if (!node) return;
    const next = String(value);
    if (node.value !== next) node.value = next;
    // 滑条的联动全靠 input 事件（读数 + 填充色）；这里补发，让回填和用户拖动走同一条路
    if (typeof node.dispatchEvent === 'function') {
      try { node.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* 老环境没有 Event，忽略 */ }
    }
  };
  fill($('#cfg-sticker-max'), normalizeStickerMax(state.config?.sticker?.promptMaxStickers));
  fill($('#cfg-sticker-collect-max'), normalizeStickerCollectMax(state.config?.sticker?.maxCollectPerHour));
  fill($('#cfg-asr-max'), normalizeAsrMax(state.config?.asr?.maxPerHour));
}


/**
 * 「显示 / 隐藏」一个**正在输入**的密码框（登录令牌、控制台改密、SnowLuma 改密、
 * 新增搜索服务的 Key）—— 只切 type 与按钮文案，不向后端取任何值。
 *
 * 与已保存密钥那套（ui/pages/settings-bind.js 的 keyToggles）分开：那几个能从服务端
 * 回读明文，这几个还没有"已保存的值"可读，回读端点也没有意义。40 位的控制台令牌
 * 最容易输错一个字符却看不出来，所以这几处也值得有个明文看一眼的开关。
 */
function bindPeekToggle(buttonId, inputId) {
  const btn = typeof buttonId === 'string' ? document.getElementById(buttonId) : buttonId;
  const input = typeof inputId === 'string' ? document.getElementById(inputId) : inputId;
  if (!btn || !input) return;
  // 幂等：同一个按钮只接一次（渲染测试会在同一份假 DOM 上反复调 bindSettingsEvents，
  // 真实控制台每次重渲染给的是新元素 —— 两种情况都不会重复接）。
  if (btn.dataset.peekBound === '1') return;
  btn.dataset.peekBound = '1';
  btn.addEventListener('click', () => {
    // 状态记在按钮上，不读 input.type：渲染测试的假 DOM 不把 type="password" 映射成
    // .type（读它永远是 undefined，会"第一次点就走进隐藏分支"）。
    const show = btn.dataset.peeked !== '1';
    input.type = show ? 'text' : 'password';
    btn.dataset.peeked = show ? '1' : '0';
    btn.textContent = show ? '隐藏' : '显示';
  });
}

/** 顶部心情条：状态文案 + 两条 mini bar；未启用时隐藏，不影响其它顶栏项。 */
function updateMoodStatus(mood) {
  const box = $('#mood-label');
  if (!box) return;
  if (!mood || mood.enabled === false) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const rest = mood.rest?.active ? mood.rest : null;
  box.classList.toggle('is-resting', Boolean(rest));
  const text = $('#mood-text');
  if (text) {
    text.textContent = rest
      ? `${rest.kind === 'slack' ? '摸鱼中' : '睡觉中'} · 还剩 ${Math.max(0, Number(rest.remainingMinutes) || 0)} 分钟`
      : `心情：${mood.moodLabel || '-'} · 精力：${mood.energyLabel || '-'}`;
  }
  const setWidth = (id, value) => {
    const fill = $(`#${id}`);
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
  };
  setWidth('mood-fill', mood.mood);
  setWidth('energy-fill', mood.energy);
  const recent = mood.lastChange?.reason ? ` · 最近：${mood.lastChange.reason}` : '';
  box.title = `心情 ${Math.round(Number(mood.mood) || 0)}/100 · 精力 ${Math.round(Number(mood.energy) || 0)}/100${recent}`;
}

export {
  afterRender, askForConfirmation, bindPeekToggle, experimentalFeatureLaunchPatch, extraBodyText, hideLoading,
  identityPilotSettingsPatch, impressionMetaLabel, initChatScrollLoader, initSessionScrollLoader,
  patchKeyedList, pollUntilReady, readAssetImage, requestExperimentOwnerUin, revealLoadingIfSlow,
  scheduleChatsRefresh, scheduleSessionRender, setBoxError, setHtmlIfChanged, setLoadingStatus,
  closeDialog, setStatusLabel, splitRowsHtml, syncClampedInputs, syncGraduatedFeatureNavigation,
  updateMoodStatus, updateOnebotStatusLine
};