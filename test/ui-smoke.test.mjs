// UI 真实 DOM 冒烟（改进方案 #1 A 档）：happy-dom 提供真实 DOM 语义（对比 render-test 的
// 手写桩件），加载 index.html 骨架 + 全部 ui/*.js（按 script 清单顺序），断言：
// 11 个 tab 的渲染入口都不抛、api() 走 fetch 桩、登录表单提交走通。
// **缺 happy-dom 时自动跳过** —— D6 约定：更新器用 --omit=dev 不装 devDeps，
// 这条 skip 路径是必须守住的（不许删；删了更新器环境会红）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { toClassicScript } from './helpers/ui-module-source.mjs';

let WindowClass = null;
try {
  ({ Window: WindowClass } = await import('happy-dom'));
} catch (e) {
  // 只有"依赖确实没装"才跳过（生产/更新器环境是 npm ci --omit=dev）；装了却加载失败
  // （版本与 Node 不兼容 / 包损坏）必须抛出去 —— 否则这层门禁静默消失，CI 照样绿（2026-10-01 审查）。
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
const SKIP = WindowClass ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';

const UI = path.resolve('ui');
const RAW_HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const SCRIPT_FILES = [...RAW_HTML.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));
const TABS = [...new Set([...RAW_HTML.matchAll(/data-tab="([a-z-]+)"/g)].map((m) => m[1]))];

function settle(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadPage() {
  const window = new WindowClass({ url: 'http://127.0.0.1:3210/' });
  // 骨架进 DOM；script 标签不交给 happy-dom 自己加载，由测试按清单手动按序执行
  window.document.write(RAW_HTML.replace(/<script[^>]*>\s*<\/script>/g, ''));
  const fetchLog = [];
  // 桩配置要能让**每个分区**都渲染得出来：漏字段时是那个分区的渲染函数抛
  // "Cannot read properties of undefined"，用例只会说"那个控件不存在"，
  // 查起来很绕（2026-10-08：聊天设置页因为缺 c.sticker 直接渲染失败）。
  const cfgStub = {
    api: { model: 'smoke-model', maxRounds: 3, temperature: 0.7 },
    allow: { groups: ['10001', '20002'], private: [] },
    server: {}, runtime: { mode: 'observe' },
    webSearch: { enabled: false }, asr: {}, tts: {},
    // OneBot 分区的渲染读 c.onebot.wsUrl 等（不带可选链）——桩缺这段会让整个分区渲染抛
    //（2026-10-09：新增的「随版本对齐」开关用例第一次渲染这个分区时暴露）
    onebot: { wsUrl: 'ws://127.0.0.1:3391', httpUrl: 'http://127.0.0.1:3390', wsHeartbeat: 'auto', hasAccessToken: false, hasHttpAccessToken: false },
    identityPilot: {}, slangPilot: {}, incidentPilot: {}, memory: {},
    sticker: { enabled: false },
    // 人设分区的渲染读 c.persona.*（不带可选链）——缺这段会让"人设"分区渲染抛
    //（2026-10-12："没保存就清交接"的拦截用例第一次渲染这个分区时暴露）
    persona: {
      botName: '小鲸鱼', selfNickname: '', participation: 'medium',
      behaviorProfile: 'legacy', roleText: '# 冒烟卡\n\n## 一、你是谁\n测试用的群友。', customRules: '', templateId: ''
    },
    send: { minGapMs: 1000, maxGapMs: 3000, maxPerMinute: 80, maxPerHour: 500, byLengthMs: 20, hardSplitAt: 4000 },
    proactive: { enabled: false, probability: 0.25, checkIntervalMinMs: 1800000, checkIntervalMaxMs: 5400000 },
    conversation: {}, store: {}, wakeDelayMs: 8000
  };
  // 用量页要一份"真形状"的 stats：25 个模型（> 折叠阈值 20）才能验证「展开全部」
  //（2026-10-09 审查：这个按钮曾经没有任何点击监听，点它毫无反应）。
  const usageStatsStub = {
    rangeLabel: '最近 7 天',
    models: Array.from({ length: 25 }, (_, i) => ({
      key: `model-${String(i).padStart(2, '0')}`,
      model: `model-${String(i).padStart(2, '0')}`,
      vendor: '', runs: i + 1,
      promptTokens: 100 * (i + 1), completionTokens: 50 * (i + 1),
      cacheHitRate: 0.5, cost: 0.01 * (i + 1)
    })),
    days: [], chats: []
  };
  window.fetch = async (url) => {
    const urlStr = String(url);
    fetchLog.push(urlStr);
    if (urlStr.includes('/api/usage/stats')) {
      return { ok: true, status: 200, json: async () => usageStatsStub };
    }
    return {
      ok: true,
      status: 200,
      json: async () => (urlStr.includes('/api/config') ? cfgStub : {})
    };
  };
  // 浏览器标准全局：happy-dom 的 vm 上下文里没有 structuredClone，而 UI 代码（时间控制草稿、
  // 按群覆盖草稿）用它做深拷贝 —— 补上，别让"浏览器里有、测试里没有"的差异把用例判红。
  if (typeof window.structuredClone !== 'function') {
    window.structuredClone = (value) => JSON.parse(JSON.stringify(value));
  }
  window.EventSource = class EventSourceStub {
    constructor() { this.readyState = 0; }
    addEventListener() {}
    close() {}
  };
  const errors = [];
  window.addEventListener('error', (event) => errors.push(String(event?.error ?? event?.message ?? event)));
  const ctx = vm.createContext(window);
  for (const file of SCRIPT_FILES) {
    const raw = fs.readFileSync(path.join(UI, file), 'utf8');
    new vm.Script(toClassicScript(raw, file), { filename: `ui/${file}` }).runInContext(ctx);
  }
  return { window, fetchLog, errors };
}

test('插件页骨架：标签分面在左栏里、且真的渲染出来', { skip: SKIP }, async () => {
  // 这条放在真实 DOM 里量：render-test 用的手写 DOM 桩没有属性 API（hidden/outerHTML/style.display
  // 全缺），而且它**不解析 HTML** —— 骨架里的子节点在那边根本不存在，能查到的只有脚本写进去的容器。
  //
  // 历史：标签那组原来单独摆在卡片**上方**（`#plugins-tags`），2026-10-17 用户指出"标签放在插件
  // 上面很难看"。参照（Obsidian / VS Code）的筛选全在侧栏，所以四组统一进 `#plugins-facets`。
  // 这条用例钉两件事：标签**在左栏里**（而不是又跑回列表上方），且整组可见（不是被
  // `[hidden] { display:none !important }` 压住的那种"渲染了但看不见"）。
  const { window, errors } = loadPage();
  await settle();
  try {
    window.switchTab('plugins');
    await settle(60);
    const doc = window.document;
    const rail = doc.getElementById('plugins-facets');
    assert.ok(rail, '插件页要有 #plugins-facets（左侧分面栏）');
    assert.notEqual(rail.hidden, true, '分面栏必须可见');
    const html = String(rail.innerHTML);
    // 「范围」与「其他」是固定的两组（不依赖索引内容）；「分类」「标签」只有在索引里有条目时
    // 才出现 —— 这个冒烟环境的 fetch 桩没有索引数据，所以这里不能硬要求那两组（否则断言的
    // 其实是"桩里有没有数据"）。有数据时的分组断言在 render-test 里用 fixture 钉。
    assert.ok(html.includes('范围') && html.includes('其他'),
      '分面栏要有「范围」与「其他」两组（不依赖索引内容）');
    assert.ok((html.match(/plugin-facet-group/g) || []).length >= 2, '分组结构要渲染进去');
    assert.equal(doc.getElementById('plugins-tags'), null,
      '标签不许再从骨架里单开一个容器横铺在列表上方');
    assert.ok(doc.querySelector('[data-plugin-action="manage-sources"]'), '目录面要有「管理来源」入口');
    assert.ok(doc.getElementById('plugins-sources-panel'), '来源管理面板要渲染进骨架');
    assert.deepEqual(errors, [], `切到插件页出现未捕获错误：${errors.join(' | ')}`);
  } finally { window.happyDOM?.abort?.(); }
});

test('插件页「发布插件」：页签切得过去、指南里三条命令在、外链只走 https', { skip: SKIP }, async () => {
  // 为什么在真实 DOM 里测：切页签靠 `renderPane()` 给别的面板 setAttribute('hidden')、
  // 给当前面板 removeAttribute('hidden')。render-test 的手写 DOM 桩这两样都没有（hidden 也永远
  // 读不到），在那儿写的"切过去了"恒为真 —— 与上面那条标签分面同一个坑。
  const { window, errors } = loadPage();
  await settle();
  try {
    window.switchTab('plugins');
    await settle(60);
    const doc = window.document;
    const tab = doc.querySelector('[data-plugin-pane="publish"]');
    assert.ok(tab, '要有「发布插件」页签（作者入口）');
    const pub = doc.querySelector('[data-plugin-pane-body="publish"]');
    const cat = doc.querySelector('[data-plugin-pane-body="catalog"]');
    assert.ok(pub && cat, '发布面与目录面都要在');
    assert.equal(pub.hidden, true, '默认停在目录面');
    tab.click();
    await settle(30);
    assert.notEqual(pub.hidden, true, '点了页签要能看到发布面');
    assert.equal(cat.hidden, true, '目录面要收起（不同时显示两个面）');
    const html = String(pub.innerHTML);
    // 三步命令都要在：作者照着敲就能跑起来，不靠去翻文档找命令名
    for (const cmd of ['plugin-create.mjs', 'plugin-dev.mjs', 'plugin-pack.mjs']) {
      assert.ok(html.includes(cmd), `指南里要有 ${cmd}`);
    }
    // 三条分发渠道：官方索引 / 自己的索引 / 直接给包
    assert.ok(html.includes('qq-agent-plugins') && html.includes('plugins.indexUrls'),
      '要分别给出"官方索引"与"自己的索引"两条路');
    // 外链只许 https —— 这是页面上唯一会跳出控制台的地方
    assert.equal(/href="http:\/\//.test(html), false, '外部链接只许 https');
    assert.deepEqual(errors, [], `发布面渲染出现未捕获错误：${errors.join(' | ')}`);
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：加载全部脚本、全部 tab 切换入口不抛', { skip: SKIP }, async () => {
  const { window, errors } = loadPage();
  await settle();
  try {
    assert.ok(SCRIPT_FILES.length >= 12, `脚本清单应含 i18n+core+app+8 外挂，实际 ${SCRIPT_FILES.length}`);
    assert.deepEqual(errors, [], `加载期出现未捕获错误：${errors.join(' | ')}`);
    assert.ok(typeof window.switchTab === 'function', 'switchTab 应可用');
    const failed = [];
    for (const tab of TABS) {
      try {
        window.switchTab(tab);
        await settle(30);
      } catch (error) {
        failed.push(`${tab}: ${error?.message ?? error}`);
      }
    }
    assert.deepEqual(failed, [], `这些 tab 的渲染入口抛错：${failed.join(' | ')}`);
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：用量页「按模型」>20 行时「展开全部」点了真的展开（2026-10-09 审查）', { skip: SKIP }, async () => {
  const { window } = loadPage();
  await settle();
  try {
    window.switchTab('usage');
    await settle(200);
    const doc = window.document;
    const btn = doc.getElementById('models-expand');
    assert.ok(btn, '用量页要有 #models-expand 按钮');
    assert.notEqual(btn.style.display, 'none', '模型数 25 > 20，按钮应可见');
    const tbody = doc.querySelector('[data-table="models"] tbody');
    assert.ok(tbody, '要有按模型表');
    const countRows = () => tbody.querySelectorAll('tr[data-key]').length;
    assert.equal(countRows(), 20, '默认只显示前 20 行');
    btn.click();
    await settle(80);
    assert.equal(tbody.dataset.expanded, '1', '点击要翻转展开状态');
    assert.equal(countRows(), 25, '展开后 25 行都在');
    assert.match(btn.textContent, /收起/, '按钮文案跟着切到收起');
    btn.click();
    await settle(80);
    assert.equal(countRows(), 20, '再点一次收起回 20 行');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：OneBot 分区的「随版本对齐」开关默认勾选（缺键即开）', { skip: SKIP }, async () => {
  const { window } = loadPage();
  await settle();
  try {
    window.switchTab('settings');
    await settle(60);
    const nav = window.document.querySelector('.settings-menu-item[data-section="onebot"]');
    assert.ok(nav, '设置侧栏要有 OneBot 分区');
    nav.click();
    await settle(150);
    const follow = window.document.getElementById('cfg-snowluma-follow-baseline');
    assert.ok(follow, '要有「随版本对齐」复选框');
    assert.equal(follow.checked, true, '配置里没有该键时默认勾选（真实用户配置的常态）');
    const auto = window.document.getElementById('cfg-snowluma-auto');
    assert.equal(auto.checked, false, '周期自动更新开关仍默认不勾选');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：外观（明暗/色板/强调色/圆角/密度/微调）能存下去、点了就生效', { skip: SKIP }, async () => {
  const { window } = loadPage();
  await settle();
  try {
    window.switchTab('settings');
    await settle(60);
    const nav = window.document.querySelector('.settings-menu-item[data-section="appearance"]');
    assert.ok(nav, '设置侧栏要有独立的「外观」分区');
    nav.click();
    await settle(150);
    const doc = window.document;
    const rootVars = doc.documentElement.style;

    // ① 外观是独立分区，六张卡都在
    for (const id of ['appearance-mode', 'appearance-darkintensity', 'appearance-schemes',
      'appearance-presets', 'appearance-scope', 'appearance-sidebarstyle', 'appearance-bg',
      'appearance-font', 'appearance-radius', 'appearance-density', 'appearance-tweaks']) {
      assert.ok(doc.getElementById(id), `外观面板缺少 #${id}`);
    }
    // 分段控件要插上滑块（否则选中的那格和滑块对不齐）
    assert.ok(doc.querySelectorAll('#appearance-mode .seg-pill').length === 1, '分段控件要有滑块');
    assert.equal(doc.querySelectorAll('#appearance-mode .seg-item.selected').length, 1, '显示模式要恰好选中一项');

    // ② 强调色：预设色板点了立刻生效，且不是"只改了高亮"
    const presets = [...doc.querySelectorAll('#appearance-presets [data-preset]')];
    assert.ok(presets.length >= 5, `强调色预设应至少 5 个，实际 ${presets.length}`);
    presets[3].click();
    await settle(60);
    assert.equal(doc.querySelectorAll('#appearance-presets [data-preset].on').length, 1, '色板同时只有一个选中');
    assert.equal(presets[3].classList.contains('on'), true);

    // ③ 自定义强调色：文本框输入即时生效
    const accent = doc.getElementById('cfg-accent');
    accent.value = '#ff8800';
    accent.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(rootVars.getPropertyValue('--accent'), '#ff8800', '自定义强调色要立刻套到 :root');
    assert.equal(doc.querySelectorAll('#appearance-presets [data-preset].on').length, 0, '有自定义色时预设全部取消选中');

    // ④ 圆角：改档位（分段控件）→ --r-scale 跟着变
    const cozy = doc.querySelector('#appearance-radius .seg-item[data-v="cozy"]');
    assert.ok(cozy, '圆角要有「舒适」档');
    cozy.click();
    assert.equal(rootVars.getPropertyValue('--r-scale'), '1.2', '圆角倍率立刻生效');

    // ⑤ 显示密度：改档位 → data-density 跟着变
    doc.querySelector('#appearance-density .seg-item[data-v="roomy"]').click();
    assert.equal(doc.documentElement.dataset.density, 'roomy', '密度立刻生效');

    // ⑤.5 关键回归：没动过主题微调时，patch 里的 tweaks 必须是空的
    //     （实测踩过：六个色值框的占位色 #888888 被当成用户选择，一点外观变更就把
    //       --bg/--border 全刷成中灰，界面糊成一片，色板怎么换都没反应）
    const uiNow = window.currentAppearance();
    // 注意用长度判断：沙箱里的对象与测试进程里的对象原型不同，deepStrictEqual 会误判
    assert.equal(Object.keys(uiNow.tweaks || {}).length, 0, '没动过微调就一个变量都不该被覆盖');

    // ⑥ 主题微调：选一个颜色 → 该变量落到 <html> 上
    const bgTweak = doc.querySelector('#appearance-tweaks [data-tweak="--bg"]');
    assert.ok(bgTweak, '主题微调要有 --bg 一行');
    bgTweak.value = '#123456';
    bgTweak.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(rootVars.getPropertyValue('--bg'), '#123456', '主题微调要覆盖到变量');
    // 重置 → 把内联属性摘掉（控制权还给色板），并把值恢复成"默认"字面
    doc.querySelector('#appearance-tweaks [data-tweak-reset="--bg"]').click();
    assert.equal(rootVars.getPropertyValue('--bg'), '', '重置要把内联变量摘掉');
    assert.equal(doc.querySelector('#appearance-tweaks [data-tweak-hex="--bg"]').textContent, '默认');

    // ⑦ 无障碍开关：是否落到 data-motion
    const noMotion = doc.getElementById('cfg-nomotion');
    noMotion.checked = true;
    noMotion.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(doc.documentElement.dataset.motion, 'off', '关闭全部动效要落到 data-motion');

    // ⑧ 保存：所有轴都要进 patch.ui
    const posts = [];
    window.fetch = async (url, options = {}) => {
      posts.push({ url: String(url), method: options?.method || 'GET', body: options?.body });
      return { ok: true, status: 200, json: async () => ({ config: {} }) };
    };
    doc.querySelector('#save-cfg-btn').click();
    await settle(200);
    const save = posts.find((p) => p.url.includes('/api/config') && p.method === 'POST');
    assert.ok(save, '点保存必须 POST /api/config');
    const patch = JSON.parse(save.body || '{}');
    assert.equal(patch.ui?.accent, '#ff8800', '自定义强调色要进 patch.ui');
    assert.equal(patch.ui?.radius, 1.2, '圆角倍率要进 patch.ui');
    assert.equal(patch.ui?.density, 'roomy', '密度要进 patch.ui');
    assert.equal(patch.ui?.accentPreset, presets[3].dataset.preset, '选中的预设 id 要进 patch.ui');
    assert.equal(patch.ui?.noMotion, true, '无障碍开关要进 patch.ui');
    assert.equal(patch.ui?.theme, doc.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
      '明暗要存在老字段 ui.theme 上（首屏内联脚本读的就是它）');
    assert.equal('mode' in (patch.ui || {}), false, '不该再多出一个 ui.mode（两个真源）');
    assert.equal(Object.keys(patch.ui?.tweaks || {}).length, 0, '重置过之后 tweaks 应当只剩用户真正动过的（这里是空）');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：波纹回调延迟执行时，连续操作仍以最后一次为准', { skip: SKIP }, async () => {
  // 真浏览器里 View Transitions 的更新回调是在下一个渲染时机才跑的，所以"排队时的那份外观"
  // 可能已经过时了。实测踩过：快速连点三个配色方案，最后生效的是第一个 —— 回调拿的是排队时的
  // 旧快照。这里装一个"延迟执行"的 View Transition 把这个时序钉住。
  const { window } = loadPage();
  await settle();
  try {
    window.switchTab('settings');
    await settle(60);
    window.document.querySelector('.settings-menu-item[data-section="appearance"]').click();
    await settle(160);
    const doc = window.document;
    const pending = [];
    doc.startViewTransition = (cb) => {
      pending.push(cb);
      // finished 立刻 resolve → "忙"标记在下一个微任务就放掉，于是**每一次**点击都会开一次
      // 过渡、每次的回调都被延后（真浏览器里连续操作就是这个样子：上一次动画还在跑，新的照开，
      // 只是被跳过；而回调落到下一帧）。updateCallbackDone 挂着不 settle，避免兜底分支提前把
      // 变更灌进去，让用例真正测"回调延迟"这件事。
      return { finished: Promise.resolve(), updateCallbackDone: new Promise(() => {}) };
    };
    for (const scheme of ['nord', 'rose', 'slate']) {
      doc.querySelector(`#appearance-schemes .scheme-card[data-scheme="${scheme}"]`).click();
      await settle(25);
    }
    assert.ok(pending.length >= 1, '第一次点击应当开了一次过渡（回调被挂起）');
    for (const cb of pending.splice(0)) cb();   // 现在才让浏览器执行更新回调
    await settle(80);
    assert.equal(doc.documentElement.getAttribute('data-scheme'), 'slate',
      '延迟执行的回调必须应用"最新那一份"，而不是排队时的快照');
    assert.equal(doc.querySelectorAll('#appearance-schemes .scheme-card.on')[0]?.dataset.scheme, 'slate',
      '视觉选中态与生效值也要一致');

    // 同一件事在强调色上更容易露馅：色板的"高亮"是每次生效后重新推出来的（syncLabels），
    // 而生效可能是延迟发生的 —— 刷新动作必须挂在"已生效"这个事件上，否则高亮会停在中途那一格
    // （实测：连点三个强调色，色值落在了最后一个，高亮却停在中间那个）。
    const presets = [...doc.querySelectorAll('#appearance-presets [data-preset]')];
    for (const i of [0, 3, 6]) { presets[i].click(); await settle(25); }
    for (const cb of pending.splice(0)) cb();
    await settle(80);
    const onNow = [...doc.querySelectorAll('#appearance-presets [data-preset].on')];
    assert.equal(onNow.length, 1, '色板同时只有一个高亮');
    assert.equal(onNow[0].dataset.preset, presets[6].dataset.preset,
      '高亮要跟着"最后选中的那个"走，不能停在中途那一格');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：api() 走 fetch 桩', { skip: SKIP }, async () => {
  const { window, fetchLog } = loadPage();
  await settle();
  try {
    const data = await window.api('/api/smoke-probe');
    assert.ok(fetchLog.includes('/api/smoke-probe'), `fetch 桩应收到调用，实际：${fetchLog.slice(0, 5).join(', ')}`);
    assert.deepEqual(data, {}, '桩返回空对象');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：登录表单提交打到 /api/login 且不抛', { skip: SKIP }, async () => {
  const { window, fetchLog } = loadPage();
  await settle();
  try {
    const form = window.document.querySelector('#console-login-form');
    assert.ok(form, 'index.html 应含 #console-login-form');
    const input = form.querySelector('input');
    if (input) input.value = 'smoke-token';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(150);
    assert.ok(fetchLog.some((u) => u.includes('/api/login')), `提交应请求 /api/login，实际：${fetchLog.slice(0, 6).join(', ')}`);
  } finally { window.happyDOM?.abort?.(); }
});

// 去插件化（§11 C2）之后的交互层覆盖：render-test 只验"渲染不抛"，这里验"钩子真的改写了输出"。
// 这条断言的由来：stable-features.js 原先靠 `window[name] = wrapped` 包裹渲染函数，
// 改成 QARegistry 注册后，"注册了但没人调用"会变成静默失效 —— 页面照常渲染，只是改造没了。
test('真实 DOM 冒烟：QARegistry 的 transform / after / override 真的接上了渲染入口', { skip: SKIP }, async () => {
  const { window } = loadPage();
  await settle();
  try {
    const { QARegistry } = window;
    assert.ok(QARegistry, 'index.html 必须先加载 core/registry.js');

    const cfg = {
      identityPilot: { enabled: false, graduated: false },
      slangPilot: {}, incidentPilot: {},
      api: {}, allow: {}, server: {}, runtime: {}
    };

    // ① transform：返回值被钩子改写（stable-features 的"摘掉已转正/退役控件"走的就是这条）
    const before = window.renderExperimentalSettingsSection(cfg);
    assert.ok(typeof before === 'string' && before.length > 0, '原实现应返回 html');
    QARegistry.onTransform('renderExperimentalSettingsSection', (html) => `${html}<!--smoke-transform-->`);
    const after = window.renderExperimentalSettingsSection(cfg);
    assert.ok(after.includes('<!--smoke-transform-->') && !before.includes('<!--smoke-transform-->'),
      '注册 transform 后，渲染函数的输出应被改写');

    // ② after：原实现跑完后触发（stable-features 在此挂"全局管理员"面板）
    // 注意：app.js 的 `const state` 是全局**词法**绑定，不挂 window（只有函数声明会挂），
    // 所以这里不能写 window.state.xxx —— 渲染函数自己闭包取 state 就行。
    let afterCalls = 0;
    QARegistry.onAfter('renderIdentityFeaturePage', () => { afterCalls += 1; });
    window.renderIdentityFeaturePage({ active: true, people: 0, aliases: 0, sources: 0, legacyMemories: 0, friends: 0 }, [], []);
    assert.equal(afterCalls, 1, 'after 钩子应在渲染函数返回后触发一次');

    // ③ override：整体接管（status-refresh.js 接管 refreshStatus 走的就是这条）
    QARegistry.override('refreshStatus', async () => 'smoke-override');
    assert.equal(await window.refreshStatus(), 'smoke-override', 'override 应接管全局入口');
    assert.equal(typeof QARegistry.base('refreshStatus'), 'function', 'override 之后仍能取回原实现');
  } finally { window.happyDOM?.abort?.(); }
});

// P1（2026-10-07 独立复审）：patch 装配挂错了分区 —— 平台能力页的开关全在 settings-save.js
// 的 `sec === 'chat'` 块里，在这一页点保存时 patch 为空（界面还提示"已保存"），开关只能手改
// config.json 才生效。这条用例走真实点按路径：切 tab → 点侧边栏分区 → 改控件 → 点保存，
// 断言 POST 体里真的有这一页的控件 —— 纯渲染断言（"不抛"）咬不住这类"存不下去"。
//
// 2026-10-07 第二批（设置细化）：读/写拆开（15 个门控键）+ 每项的工具清单占位 +
// 四个闸门配额可改 + 按群覆盖编辑器。这条用例同时钉住"UI 的键表 == 服务端的键表"：
// 在服务端加一个门控键而 UI 没跟上（或反过来），下面第一个 deepEqual 就会红。
test('真实 DOM 冒烟：「平台能力」页的开关/配额/按群覆盖能真的存下去（保存块不许挂错分区）', { skip: SKIP }, async () => {
  const { window } = loadPage();
  await settle();
  try {
    const { PLATFORM_GATE_KEYS, PLATFORM_QUOTA_KEYS, PLATFORM_QUOTA_DEFAULTS, PLATFORM_DEFAULT_OFF } =
      await import('../src/core/platform-gates.js');
    window.switchTab('settings');
    await settle(50);
    const menuItem = window.document.querySelector('.settings-menu-item[data-section="platform"]');
    assert.ok(menuItem, '设置侧边栏应有「平台能力」入口');
    menuItem.click();
    await settle(80);

    // ① 渲染侧：门控复选框必须与服务端键表一一对应
    const renderedIds = [...window.document.querySelectorAll('#settings-form input[type="checkbox"]')]
      .map((el) => el.id).filter(Boolean).sort();
    // 门控键 + 三个"行为开关"（正在输入 / 标已读 / 日报卡片 —— 它们不是工具门控，但仍归这一页）
    assert.deepEqual(renderedIds,
      [...PLATFORM_GATE_KEYS.map((k) => `cfg-platform-${k.toLowerCase()}`),
        'cfg-typing', 'cfg-platform-readreceipts', 'cfg-platform-forwardcards'].sort(),
      '「平台能力」页的开关集合与服务端门控键表不一致（服务端加键、UI 没跟上就会红）');
    // 每个键都要有"它管的工具"占位（工具名由 /api/platform/gates 异步补）
    const slots = [...window.document.querySelectorAll('[data-gate-tools]')].map((el) => el.dataset.gateTools).sort();
    assert.deepEqual(slots, [...PLATFORM_GATE_KEYS].sort(), '每个门控键都要有工具清单占位');
    // 配额输入框按服务端的配额键表渲染
    const quotaIds = [...window.document.querySelectorAll('#settings-form input[type="number"]')]
      .map((el) => el.id).filter((id) => id.startsWith('cfg-platform-quota-')).sort();
    assert.deepEqual(quotaIds, PLATFORM_QUOTA_KEYS.map((k) => `cfg-platform-quota-${k}`).sort(),
      '四个闸门配额都要有输入框');
    // UI 里那两份"硬编码副本"必须与服务端表一致（否则渲染的默认值/默认关取向会漂）
    const platSrc = fs.readFileSync(path.join(UI, 'pages', 'platform.js'), 'utf8');
    const quotaRows = [...platSrc.matchAll(/\['([a-zA-Z]+)', '[^']*', (\d+)\]/g)].map((m) => [m[1], Number(m[2])]);
    assert.deepEqual(Object.fromEntries(quotaRows), { ...PLATFORM_QUOTA_DEFAULTS },
      'ui/pages/platform.js 的 QUOTA_ROWS 默认值要与服务端 PLATFORM_QUOTA_DEFAULTS 一致（第二份真源，必须锚住）');
    const offBlock = /const DEFAULT_OFF_KEYS = new Set\(\[([^\]]*)\]\)/.exec(platSrc);
    const offKeys = [...(offBlock?.[1] || '').matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(offKeys, [...PLATFORM_DEFAULT_OFF].sort(), 'UI 的"默认关"集合要与服务端 PLATFORM_DEFAULT_OFF 一致');

    // 按群覆盖编辑器：白名单的群可切换，且每个门控键都有三态下拉
    assert.ok(window.document.querySelector('#pergroup-group'), '按群覆盖要有"选择群"下拉');
    const perIds = [...window.document.querySelectorAll('[data-pergroup-key]')].map((el) => el.dataset.pergroupKey).sort();
    assert.deepEqual(perIds, [...PLATFORM_GATE_KEYS].sort(), '按群覆盖要覆盖全部门控键');
    // 行之间不许有游离字符：外层 map 返回数组、忘了 flat() 的话 join 会塞进逗号（真机踩过）
    const perText = window.document.querySelector('#pergroup-rows')?.textContent || '';
    assert.ok(!perText.includes(','), `按群覆盖区出现了游离的逗号：${perText.slice(0, 60)}`);

    // ② 行为侧：改四个控件（门控复选框 / 音色 / 配额 / 按群覆盖），保存后都要在 POST 体里
    const writeBox = window.document.querySelector('#cfg-platform-reactionswrite');
    assert.equal(writeBox.checked, true, '未配置时按内置默认：读写都开');
    writeBox.checked = false;
    const voiceSel = window.document.querySelector('#cfg-platform-voicechar');
    assert.ok(voiceSel, '「语音音色」下拉应渲染');
    voiceSel.insertAdjacentHTML('beforeend', '<option value="lucy-voice-daji">妲己</option>');
    voiceSel.value = 'lucy-voice-daji';
    const quota = window.document.querySelector('#cfg-platform-quota-avatarsPerWeek');
    assert.ok(quota, '换头像配额输入框应渲染');
    quota.value = '5';
    // 另一项留空：应**不写进 patch**（让服务端默认生效），而不是把界面上的数字写死进配置
    window.document.querySelector('#cfg-platform-quota-remarksPerDay').value = '';
    const perSel = window.document.querySelector('#pergroup-albumWrites');
    assert.ok(perSel, '按群覆盖：相册点赞/评论该有三态下拉');
    perSel.value = 'on';
    perSel.dispatchEvent(new window.Event('change'));
    // 切到别的群再切回来：草稿不丢（切群只是换渲染的数据源）
    const groupSel = window.document.querySelector('#pergroup-group');
    assert.equal(groupSel.value, '10001', '默认选中第一个白名单群');
    groupSel.value = '20002';
    groupSel.dispatchEvent(new window.Event('change'));
    assert.equal(window.document.querySelector('#pergroup-albumWrites').value, '', '另一个群没覆盖过 → 跟随全局');
    groupSel.value = '10001';
    groupSel.dispatchEvent(new window.Event('change'));
    assert.equal(window.document.querySelector('#pergroup-albumWrites').value, 'on', '切回来草稿要还在');

    const posts = [];
    window.fetch = async (url, options = {}) => {
      posts.push({ url: String(url), method: options?.method || 'GET', body: options?.body });
      // 用量接口给一份能算出来的桩：右列要按"服务端生效上限"回填（含被夹过的值）
      if (String(url).includes('/api/platform/quota-usage')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            quotas: Object.fromEntries(Object.entries({
              reactions: ['reactionsPerHour', 3600000, 11],
              albumWrites: ['albumWritesPerHour', 3600000, 999],
              profile: ['profilePerDay', 86400000, 1],
              remarks: ['remarksPerDay', 86400000, 1],
              avatars: ['avatarsPerWeek', 604800000, 1]
            }).map(([group, [key, windowMs, limit]]) => [group, { key, windowMs, limit, used: 0, chats: [] }]))
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ config: {} }) };
    };
    window.document.querySelector('#save-cfg-btn').click();
    await settle(200);

    const save = posts.find((p) => p.url.includes('/api/config') && p.method === 'POST');
    assert.ok(save, '点「保存设置」必须 POST /api/config');
    const patch = JSON.parse(save.body || '{}');
    assert.equal(patch.platform?.reactionsWrite, false, '改过的开关要按界面状态存下去（挂了错误分区时这里是 undefined）');
    assert.equal(patch.platform?.reactions, true, '没动过的读开关按当前值存');
    assert.equal(patch.platform?.readReceipts, false, '默认关的项没勾 = false');
    assert.equal(patch.platform?.avatarWrites, false, '换头像默认关（没勾就是 false）');
    assert.equal(patch.platform?.qqVoiceCharacter, 'lucy-voice-daji', '选中的音色要跟着保存');
    assert.deepEqual(patch.platform?.quotas?.__replace__, { reactionsPerHour: 10, albumWritesPerHour: 5, profilePerDay: 1, avatarsPerWeek: 5 },
      '配额用 __replace__ 整表替换：留空的那项不写（回落服务端默认），改过的按界面值写');
    assert.equal(patch.platform?.quotas?.__replace__?.remarksPerDay, undefined, '留空的配额不许把界面上的默认数字固化进配置');
    assert.deepEqual(patch.platform?.perGroup, { __replace__: { '10001': { albumWrites: true } } },
      '按群覆盖要带 __replace__ 存下去（普通深合并删不掉旧覆盖）');
    assert.deepEqual(Object.keys(patch.platform || {}).sort(),
      [...PLATFORM_GATE_KEYS, 'qqVoiceCharacter', 'quotas', 'perGroup', 'readReceipts', 'forwardCards'].sort(),
      '这一页的每个控件都要进 patch（漏一个 = 下次的"配了不生效"）');
    assert.equal(patch.send?.typingIndicator, true, '「正在输入」也归这一页保存');
    // 保存后右列必须重拉（否则一直挂着旧上限，看起来像"改了没生效"）
    assert.ok(posts.some((p) => p.url.includes('/api/platform/quota-usage')),
      '保存成功后要重新拉一次用量（右列"当前用量 x / 上限 y"是渲染时拉的）');
    // 输入框回填成服务端生效值：被夹过的 999 → 200，改过的按新值
    assert.equal(window.document.querySelector('#cfg-platform-quota-albumWritesPerHour')?.value, '999',
      '服务端返回什么就显示什么（这里桩给的 999 说明是"按接口值回填"而不是写死 UI 默认）');
    assert.equal(window.document.querySelector('#cfg-platform-quota-reactionsPerHour')?.value, '11');
    // 保存映射不许再手写第二份键清单（必须用 platform.js 的共享键表）
    const saveSrc = fs.readFileSync(path.join(UI, 'pages', 'settings-save.js'), 'utf8');
    assert.ok(saveSrc.includes('ALL_GATE_KEYS') && saveSrc.includes('gateCheckboxId'),
      '保存映射要用 platform.js 的键表/命名约定（手抄清单迟早与渲染漂掉）');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：总览的跳转入口指向对的目标（分区键与目标页都要对）', { skip: SKIP }, async () => {
  // 背景：「全部异常 →」曾经调 window.switchTab（生产里没有这个全局，点了只抛 TypeError）；
  // 「去更新 / 看详情」曾经 switchTab + 派发一个全仓无人监听的 qa-settings-section 事件，
  // 于是"跳到 OneBot 分区"从来没发生过。这里能直接验的是"点了确实到了目标页/带了正确的分区键"。
  // 注意：data-open-settings 的**委托处理器注册在 init() 里**，而这个沙箱只跑脚本、不跑 init()
  //（与既有用例一致），所以"点了跳到设置页"那一半在这里测不了 —— 那半边的守卫在
  // test/ui-review-fixes-2026-10-08.test.mjs 的源码锚点（禁止 window.switchTab / qa-settings-section）。
  const { window } = loadPage();
  await settle();
  try {
    const doc = window.document;
    window.switchTab('overview');
    await settle(150);

    const inc = doc.getElementById('overview-goto-incidents');
    assert.ok(inc, '总览要有「全部异常」入口');
    inc.click();
    await settle(120);
    assert.equal(doc.getElementById('view-incidents')?.classList.contains('active'), true,
      '「全部异常」应切到异常处理页（id=view-incidents）');

    window.switchTab('overview');
    await settle(120);
    const one = doc.getElementById('overview-goto-onebot');
    assert.ok(one, '总览要有「去更新 / 看详情」入口');
    assert.equal(one.dataset.openSettings, 'onebot',
      '要走 app.js 那一个 data-open-settings 全局委托，且分区键必须是侧栏里真有的 onebot');
    assert.equal(one.tagName, 'A', '入口样式是行内链接（改了标签就要同步 .panel-link 的样式口径）');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：总览的异常列表用服务端取值（warning/acknowledged 不漏英文、色块不丢）', { skip: SKIP }, async () => {
  // 服务端的 severity 是 info|warning|error|critical、state 是 open|acknowledged|resolved，
  // 总览曾经自己写了一份 warn/acked 的小表 → 界面上直接印出英文 "warning"/"acknowledged"，
  // 色块也匹配不上（2026-10-08 审查）。喂一条真实取值，逐项核对中文与色块。
  const { window } = loadPage();
  await settle();
  try {
    const doc = window.document;
    // 只接管这一个接口，其余（含 /api/config）照旧走原始桩 —— 整个换掉会让设置页拿不到配置
    const orig = window.fetch;
    window.fetch = async (url, options) => {
      if (String(url).includes('/api/incidents')) {
        return { ok: true, status: 200, json: async () => ({
          incidents: [{ severity: 'warning', state: 'acknowledged', message: '磁盘水位偏高', lastAt: Date.now(), count: 2 }],
          status: { counts: { open: 1, acknowledged: 1, resolved: 0, critical: 0 } }
        }) };
      }
      return orig(url, options);
    };
    window.switchTab('overview');
    await settle(150);
    doc.getElementById('overview-refresh').click();
    await settle(220);

    const feed = doc.querySelector('#overview-page .feed');
    assert.ok(feed, '要有异常列表');
    const text = feed.textContent;
    assert.ok(text.includes('警告'), `warning 要显示成「警告」，实际：${text}`);
    assert.ok(text.includes('已确认'), `acknowledged 要显示成「已确认」，实际：${text}`);
    assert.equal(/(^|\s)(warning|acknowledged)($|\s)/.test(text), false, '不该把服务端的英文取值印到界面上');
    assert.ok(feed.querySelector('.chip.warn'), 'warning 要带上告警色块（色表也曾经与取值对不上）');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：数字字段填 0 要存成 0（不被 `|| 默认值` 吃掉）', { skip: SKIP }, async () => {
  // min="0" 的控件里 0 是文档化的合法值：温度 0 = 贪心解码、批次间隔 0 = 不等、触发概率 0 =
  // 从不主动开口、按字数附加间隔 0 = 不额外等。写成 `Number(val(...)) || 默认值` 时 0 是假值
  // → 存回去变成 0.8 / 1200 / 0.25 / 20，界面上看着像"没保存"（2026-10-08 审查）。
  // 这里走完整的"改控件 → 点保存 → 看 POST 体"。
  const { window } = loadPage();
  await settle();
  try {
    const doc = window.document;
    const posts = [];
    const orig = window.fetch;
    window.fetch = async (url, options = {}) => {
      if ((options?.method || 'GET').toUpperCase() === 'POST') {
        posts.push({ url: String(url), body: options?.body });
        // 保存成功后 saveConfig 会做 `state.config = data.config` 并重渲染 —— 这里必须把
        // 一份**形状完整的配置**还回去，否则 state.config 变成 {}，接着渲染另一个分区就抛
        // "Cannot read properties of undefined"（实测踩到）。借原始桩的配置形状最省事。
        const shape = await orig('/api/config').then((r) => r.json());
        return { ok: true, status: 200, json: async () => ({ config: shape }) };
      }
      return orig(url, options);   // GET 照旧：换掉会让设置页读不到 state.config
    };
    window.switchTab('settings');
    await settle(100);

    // ① 模型 API：温度 0
    doc.querySelector('.settings-menu-item[data-section="api"]').click();
    await settle(160);
    const temp = doc.getElementById('cfg-temperature');
    assert.ok(temp, '模型 API 页要有温度控件');
    temp.value = '0';
    doc.querySelector('#save-cfg-btn').click();
    await settle(220);

    // ② 聊天设置：批次间隔 0 / 触发概率 0 / 按字数附加间隔 0
    doc.querySelector('.settings-menu-item[data-section="chat"]').click();
    await settle(200);
    for (const id of ['cfg-draindelay', 'cfg-pro-prob', 'cfg-bylength']) {
      assert.ok(doc.getElementById(id), `聊天设置页要有 #${id}`);
      doc.getElementById(id).value = '0';
    }
    doc.querySelector('#save-cfg-btn').click();
    await settle(220);

    const cfgPosts = () => posts.filter((p) => p.url.includes('/api/config')).map((p) => JSON.parse(p.body || '{}'));
    assert.equal(cfgPosts().length, 2, '两次保存都要发出 POST /api/config');
    assert.equal(cfgPosts()[0].api?.temperature, 0, '温度填 0 要存成 0（不是 0.8）');
    assert.equal(cfgPosts()[1].drainDelayMs, 0, '批次间隔填 0 要存成 0（不是 1200）');
    assert.equal(cfgPosts()[1].proactive?.probability, 0, '触发概率填 0 要存成 0（不是 0.25）');
    assert.equal(cfgPosts()[1].send?.byLengthMs, 0, '按字数附加间隔填 0 要存成 0（不是 20）');

    // 反向：留空仍然等价于"恢复原值/default"，不能变成 0（否则清了字段等于把行为改掉）
    doc.getElementById('cfg-draindelay').value = '';
    doc.querySelector('#save-cfg-btn').click();
    await settle(220);
    const last = cfgPosts().pop();
    assert.notEqual(last.drainDelayMs, 0, '留空不该被写成 0（那是"清空 = 恢复默认"的路子）');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：人物记忆页 15s 轮询不叠监听（点一次「保存备注」只发一个请求）（2026-10-12 审查）', { skip: SKIP }, async () => {
  // setHtmlIfChanged 不改 DOM 时不能重挂监听：这一页每 15s 轮询 + 每次 focus 都会重渲染，
  // 旧代码（e1d20f7 把 innerHTML 换成 setHtmlIfChanged 时漏了守卫）会在每一轮给同一批按钮
  // 再 addEventListener 一份 —— 开着一小时，点一次「保存备注」发约 240 个 POST。
  const { window } = loadPage();
  await settle();
  try {
    const doc = window.document;
    const posts = [];
    const orig = window.fetch;
    const person = {
      userId: '123456',
      name: '叠监听受害案例',
      updatedAt: 1700000000000,
      sourceChatKeys: ['group:10001'],
      impressions: [{ content: '喜欢猫', createdAt: 1700000000000, lastObservedAt: 1700000000000, sourceChatKeys: ['group:10001'] }]
    };
    window.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      const method = (options?.method || 'GET').toUpperCase();
      if (method === 'POST' && urlStr.includes('/api/config')) {
        posts.push({ url: urlStr, body: options?.body });
        return { ok: true, status: 200, json: async () => ({ config: {} }) };
      }
      if (urlStr.includes('/api/memory-files')) {
        if (/\/api\/memory-files\/(group|private)_\d+/.test(urlStr)) {
          return { ok: true, status: 200, json: async () => ({ members: [structuredClone(person)] }) };
        }
        return { ok: true, status: 200, json: async () => ({ files: [{ chatKey: 'group:10001', impressionCount: 1 }] }) };
      }
      return orig(url, options);   // 其余照旧走原始桩（含设置页与状态轮询要的 /api/config GET）
    };

    window.switchTab('people-memory');
    await settle(60);
    window.dispatchEvent(new window.Event('focus'));   // 打开页面时的首次加载
    await settle(120);
    const personBtn = doc.querySelector('#global-memory-items [data-gm-key]');
    assert.ok(personBtn, '人物列表要有条目（fetch 桩已给一份数据）');
    personBtn.click();
    await settle(60);
    assert.ok(doc.getElementById('gm-note-save'), '选中人物后要有「保存备注」按钮');

    // 模拟一轮 15s 轮询：内容没变 → setHtmlIfChanged 不动 DOM；此时**不能**再挂监听
    window.dispatchEvent(new window.Event('focus'));
    await settle(120);

    doc.getElementById('gm-note-save').click();
    await settle(150);
    const saves = posts.filter((p) => p.url.includes('/api/config'));
    assert.equal(saves.length, 1, `一次点击只能发一个保存请求，实发 ${saves.length} 个（每轮重渲染叠了一份监听）`);
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：每日动态状态块的群摘要展开态在轮询重建后保持（2026-10-12 审查）', { skip: SKIP }, async () => {
  // loadDailyMomentsStatus 每次都把整块 innerHTML 重写：`<details>` 的展开态不在 HTML 里，
  // 不记住就会每 15 秒折叠一次、正在读摘要的人被反复打断。
  const { window } = loadPage();
  await settle();
  try {
    const doc = window.document;
    const orig = window.fetch;
    const statusStub = {
      enabled: true, running: false, nextRunAt: null, records: [],
      latest: {
        id: 'm1', dayKey: '2026-10-12', status: 'preview', decision: 'hold', content: '草稿',
        groupSummaries: [{ groupName: '群A', summary: '聊了天气' }]
      }
    };
    window.fetch = async (url, options = {}) => {
      if (String(url).includes('/api/daily-moments/status')) {
        return { ok: true, status: 200, json: async () => structuredClone(statusStub) };
      }
      return orig(url, options);
    };
    // 状态块在「设置 → 自动行为 → 每日动态」分区里，先把这个分区渲染出来
    window.switchTab('settings');
    await settle(80);
    doc.querySelector('.settings-menu-item[data-section="moments"]').click();
    await settle(160);
    await window.loadDailyMomentsStatus();
    const box = doc.getElementById('daily-moments-status');
    assert.ok(box, '每日动态分区要有状态块');
    const details = box.querySelector('.moment-summaries');
    assert.ok(details, '有群摘要时要渲染 details');
    details.open = true;
    await window.loadDailyMomentsStatus();   // 模拟一轮状态轮询重建
    const again = doc.getElementById('daily-moments-status').querySelector('.moment-summaries');
    assert.equal(again?.open, true, '轮询重建后展开态要被恢复');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：人设没保存时「换人设后清空交接」先拦下，保存后才照常清（2026-10-12 反馈）', { skip: SKIP }, async () => {
  // 反馈："在设置人设清空交谈之后，机器人还是之前的人设" —— 交接清了、人设没保存，
  // 按钮当时没有任何前置检查，看着像成功了。现在：草稿未保存 → 拦下并指路「保存设置」。
  const { window, fetchLog } = loadPage();
  await settle();
  try {
    const doc = window.document;
    const alerts = [];
    window.alert = (message) => alerts.push(String(message));
    window.switchTab('settings');
    await settle(80);
    doc.querySelector('.settings-menu-item[data-section="persona"]').click();
    await settle(160);
    const btn = doc.getElementById('persona-reset-handoff-btn');
    assert.ok(btn, '人设页要有「换人设后清空交接」按钮');
    const role = doc.getElementById('cfg-roletext');
    assert.ok(role, '人设页要有角色设定编辑框');
    const saved = role.value;
    const resetCalls = () => fetchLog.filter((u) => u.includes('/api/persona/reset-handoffs')).length;

    // ① 草稿改了、没保存：点按钮要被拦，不发请求，提示先去保存
    role.value = saved + '\n\n（临时加一句，还没保存）';
    btn.click();
    await settle(120);
    assert.equal(resetCalls(), 0, '未保存时不该发清空请求（发了就是"交接清了、人设没换"）');
    // 先转布尔再断言：失败时把 happy-dom 节点交给 assert 的 inspect 会炸（Array buffer allocation failed）
    assert.equal(Boolean(doc.querySelector('.model-modal-overlay')), false, '未保存时应被直接拦下，不该走到确认框');
    assert.ok(alerts.some((m) => m.includes('保存')), `要弹提示让人先去保存，实际弹了：${JSON.stringify(alerts)}`);
    assert.match(doc.getElementById('persona-reset-handoff-hint').textContent, /保存/);

    // ①b 逐节编辑是主路径：字只在分节框里、还没落回 #cfg-roletext 时也要算"没保存"
    //（独立审查：漏这条路径时守卫读到旧正文，等于白做）
    role.value = saved;
    const secEdit = doc.querySelector('#persona-card-view .pd-sec-edit[data-sec="0"]');
    assert.ok(secEdit, '分节视图要有「编辑」按钮');
    secEdit.click();
    await settle(80);
    const secBox = doc.querySelector('#persona-card-view .pd-edit-text[data-sec="0"]');
    assert.ok(secBox, '点「编辑」后要出现分节编辑框');
    secBox.value = secBox.value + '\n（这条只在分节框里，还没落回草稿）';
    btn.click();
    await settle(120);
    assert.equal(resetCalls(), 0, '分节框里的未保存改动也要算"没保存"');
    assert.equal(Boolean(doc.querySelector('.model-modal-overlay')), false, '分节编辑未保存时也该被拦下');
    doc.querySelector('#persona-card-view .pd-sec-cancel')?.click();   // 退出分节编辑，别影响下面
    await settle(60);

    // ② 改回已保存的样子：先弹确认框，确认后才发请求
    role.value = saved;
    btn.click();
    await settle(80);
    const overlay = doc.querySelector('.model-modal-overlay');
    assert.ok(overlay, '草稿与配置一致时要走确认框流程');
    overlay.querySelector('[data-confirm-accept]').click();
    await settle(200);
    assert.equal(resetCalls(), 1, '确认后要发一次清空请求');
    assert.match(doc.getElementById('persona-reset-handoff-hint').textContent, /已清空/);
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：删掉正在用的自定义卡要说清"人设还没换"（2026-10-12 反馈）', { skip: SKIP }, async () => {
  // 反馈里最常见的坑之一：自定义卡删了以为就换回默认了 —— 其实正文是拷进配置的快照，
  // 删除只把卡从库里移走。现在：确认框先警告 + 删除后明确指路「保存设置」。
  const { window } = loadPage();
  await settle();
  try {
    const doc = window.document;
    const customText = '# 毒舌卡\n\n## 一、你是谁\n你说话很毒。';
    const defaultText = '# 小鲸鱼（默认）\n\n## 一、你是谁\n你是默认卡。';
    const deleted = [];
    let customPresent = true;
    const orig = window.fetch;
    const base = await (await orig('/api/config')).json();   // 基础桩：其余分区字段照旧
    window.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      const method = (options?.method || 'GET').toUpperCase();
      if (urlStr.includes('/api/persona-templates') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            templates: [
              { id: 'xiaojingyu', name: '小鲸鱼（默认）', text: defaultText, behaviorProfile: 'legacy', builtin: true },
              ...(customPresent
                ? [{ id: 'custom_0', name: '毒舌卡', text: customText, customRules: '', behaviorProfile: 'legacy', builtin: false }]
                : [])
            ]
          })
        };
      }
      if (urlStr.includes('/api/config') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...structuredClone(base),
            persona: {
              botName: '小鲸鱼', selfNickname: '', participation: 'medium',
              behaviorProfile: 'legacy', roleText: customText, customRules: '', templateId: ''
            }
          })
        };
      }
      if (method === 'DELETE' && urlStr.includes('/api/persona-templates/custom_0')) {
        deleted.push(urlStr);
        customPresent = false;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return orig(url, options);
    };
    await window.loadSettings();
    window.switchTab('settings');
    await settle(80);
    doc.querySelector('.settings-menu-item[data-section="persona"]').click();
    await settle(160);

    const delBtn = doc.getElementById('del-persona-btn');
    assert.ok(delBtn, '要有人设删除按钮');
    assert.equal(delBtn.classList.contains('hidden'), false, '当前草稿是自定义卡时删除按钮要可见');
    delBtn.click();
    await settle(60);
    const overlay = doc.querySelector('.model-modal-overlay');
    assert.ok(overlay, '删除要弹确认框');
    assert.match(overlay.textContent, /正在用的就是这张卡/, '用着的卡要先说破"删卡≠换人设"');
    overlay.querySelector('[data-confirm-accept]').click();
    await settle(260);
    assert.deepEqual(deleted, ['/api/persona-templates/custom_0'], '确认后要发 DELETE');
    const hint = doc.getElementById('persona-pick-hint').textContent;
    assert.match(hint, /仍在用被删卡的那份正文/, '删除后要说明人设还没换');
    assert.match(hint, /保存设置/, '要指路到「保存设置」');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：人物记忆页点「刷新」不会把列表卡在占位符上（2026-10-12 复审 P2）', { skip: SKIP }, async () => {
  // 强制刷新会先把列表换成"正在读取…"占位符。若这次直接写 innerHTML 而不清 __renderedHtml，
  // 数据没变时 setHtmlIfChanged 会判成"没变化"跳过重画 —— 占位符就永远留着，只有 F5 能救。
  // 占位符/错误提示必须走 setBoxError（它清缓存），与 dom-util 里写明的约定一致。
  const { window } = loadPage();
  await settle();
  try {
    const doc = window.document;
    const orig = window.fetch;
    const person = {
      userId: '223456',
      name: '刷新受害案例',
      updatedAt: 1700000000000,
      sourceChatKeys: ['group:10001'],
      impressions: [{ content: '喜欢猫', createdAt: 1700000000000, lastObservedAt: 1700000000000, sourceChatKeys: ['group:10001'] }]
    };
    window.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/memory-files')) {
        if (/\/api\/memory-files\/(group|private)_\d+/.test(urlStr)) {
          return { ok: true, status: 200, json: async () => ({ members: [structuredClone(person)] }) };
        }
        return { ok: true, status: 200, json: async () => ({ files: [{ chatKey: 'group:10001', impressionCount: 1 }] }) };
      }
      return orig(url, options);
    };

    window.switchTab('people-memory');
    await settle(60);
    window.dispatchEvent(new window.Event('focus'));
    await settle(120);
    assert.ok(doc.querySelector('#global-memory-items [data-gm-key]'), '先要有列表（fetch 桩已给一份数据）');

    const refresh = doc.getElementById('gm-refresh');
    assert.ok(refresh, '列表上方要有「刷新」按钮');
    refresh.click();
    await settle(200);

    assert.ok(!doc.querySelector('#global-memory-items .gm-empty'), '占位符不该留在 DOM 里');
    assert.ok(doc.querySelector('#global-memory-items [data-gm-key]'), '刷新后列表要回来（数据没变也不能卡在"正在读取…"）');
  } finally { window.happyDOM?.abort?.(); }
});

test('插件详情：打开压一条 history，浏览器后退回到目录', { skip: SKIP }, async () => {
  // 用户反馈：进了详情只能找「← 返回目录」，浏览器的后退（含鼠标侧键 / 右键菜单后退）
  // 直接退出插件页 —— 因为打开详情**没有压 history**。这里验那条链路：
  // 点一个带 data-plugin-open 的卡片 → history.state 里有 pluginDetail；后退 → 回到目录。
  // ⚠️ 不能 import 模块函数来测：happy-dom 里的页面跑在 window 上下文，Node 侧再 import 一份
  // 会拿到没有 document 的另一个实例（dom.js 直接 ReferenceError）。
  const { window, errors } = loadPage();
  await settle();
  try {
    window.switchTab('plugins');
    await settle(80);
    const doc = window.document;
    const grid = doc.getElementById('plugins-index');
    assert.ok(grid, '要有目录容器');
    grid.innerHTML = '<article class="plugin-card" data-plugin-open="smoke" tabindex="0" role="button">假卡片</article>';
    const before = window.history.length;
    grid.querySelector('[data-plugin-open="smoke"]').click();
    await settle(60);
    assert.equal(window.history.state?.pluginDetail, 'smoke', '打开详情要压一条 history（浏览器后退才有的退）');
    assert.ok(window.history.length > before, 'history 长度要增加');
    window.history.back();
    await settle(80);
    assert.equal(window.history.state?.pluginDetail ?? '', '', '后退之后不该再停在详情态');
    assert.equal(doc.querySelector('[data-plugin-pane-body="catalog"]')?.hidden, false, '后退之后仍在目录面');

    // 反方向也要一致：UI 的「← 返回目录」走 history.back()，不能只是把详情清掉 ——
    // 否则按钮退一步、浏览器后退又退一步，URL 栈与界面会错开
    // 注意：点完之后 renderIndex 会**重写** #plugins-index，注入的节点会被冲掉 ——
    // 所以卡片要重新注入，「返回目录」按钮要挂到 #plugins-page 上（不在被重写的区域里）
    grid.innerHTML = '<article class="plugin-card" data-plugin-open="smoke2" tabindex="0" role="button">假卡片</article>';
    grid.querySelector('[data-plugin-open="smoke2"]').click();
    await settle(60);
    assert.equal(window.history.state?.pluginDetail, 'smoke2', '第二次打开也要压 history');
    const closer = doc.createElement('button');
    closer.setAttribute('data-plugin-close', '1');
    doc.getElementById('plugins-page').appendChild(closer);
    closer.click();
    await settle(80);
    assert.equal(window.history.state?.pluginDetail ?? '', '', '「返回目录」按钮要退掉自己压的那条 history（不是只清界面）');
    assert.deepEqual(errors, [], `插件详情交互出现未捕获错误：${errors.join(' | ')}`);
  } finally { window.happyDOM?.abort?.(); }
});

test('插件页：反复进出后按 Enter 只压一条 history；Esc 能关详情', { skip: SKIP }, async () => {
  // 审查 P1-1：keydown 原来注册在 delegationBound 守卫**之前**，而 #plugins-page 是静态容器，
  // 每进一次插件页就叠一条 —— 按一次 Enter 打开 N 次、压 N 条 history，「返回目录」要连点 N 次。
  const { window, errors } = loadPage();
  await settle();
  try {
    // 进出三次（每次都是 force 重建）
    for (let i = 0; i < 3; i += 1) {
      window.switchTab('plugins');
      await settle(60);
      window.switchTab('sessions');
      await settle(30);
    }
    window.switchTab('plugins');
    await settle(80);
    const doc = window.document;
    const grid = doc.getElementById('plugins-index');
    grid.innerHTML = '<article class="plugin-card" data-plugin-open="kb" tabindex="0" role="button">假卡片</article>';
    const card = grid.querySelector('[data-plugin-open="kb"]');
    const before = window.history.length;
    card.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(60);
    assert.equal(window.history.length - before, 1,
      `一次 Enter 只能压一条 history（进出 3 次后仍应是 1；实际 ${window.history.length - before}，说明 keydown 叠加了）`);
    assert.equal(window.history.state?.pluginDetail, 'kb');

    // Esc 关详情（也走 history.back，栈保持平衡）
    doc.getElementById('plugins-page').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(80);
    assert.equal(window.history.state?.pluginDetail ?? '', '', 'Esc 之后不该再停在详情态');
    assert.deepEqual(errors, [], `键盘交互出现未捕获错误：${errors.join(' | ')}`);
  } finally { window.happyDOM?.abort?.(); }
});

test('插件页：「手动安装」的按钮失败后能再点（不是一次性锁）', { skip: SKIP }, async () => {
  // 审查 P2-2：静态骨架里的按钮不会被 refreshPlugins 重画，`disabled = true` 一直不复位 ——
  // 装失败一次就连重试都点不了。
  const { window, errors } = loadPage();
  await settle();
  try {
    window.switchTab('plugins');
    await settle(80);
    const doc = window.document;
    doc.getElementById('plugins-manual-url').value = 'https://example.com/x.tar.gz';
    doc.getElementById('plugins-manual-sha').value = 'a'.repeat(64);
    const realFetch = window.fetch;
    window.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: '假装失败' }) });
    const btn = doc.getElementById('plugins-manual-install');
    btn.click();
    await settle(120);
    window.fetch = realFetch;
    assert.equal(btn.disabled, false, '安装失败之后按钮要能再点（重试）');
    assert.deepEqual(errors, [], `手动安装出现未捕获错误：${errors.join(' | ')}`);
  } finally { window.happyDOM?.abort?.(); }
});
