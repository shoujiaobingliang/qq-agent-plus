// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';


import { closeModelModal, loadSettings, modelModalShell } from '../app.js';
import { api } from '../core/api.js';
import {
  PERSONA_BAD_SECTIONS, PERSONA_RULE_EXAMPLES, PERSONA_SECTION_EMOJI, PERSONA_TAG_SECTIONS
} from '../core/constants.js';
import { $, esc } from '../core/dom.js';
import { perChatOptions } from './persona-per-chat.js';
import { personaDescCache, state } from '../core/state.js';
function findPersonaTemplateId(roleText, behaviorProfile = 'legacy', customRules = '') {
  return Object.entries(state.personaTemplates || {}).find(([, p]) =>
    p.text === roleText && (p.behaviorProfile || 'legacy') === behaviorProfile
      && (p.customRules || '') === customRules)?.[0] || '';
}

function currentPersonaId() {
  return findPersonaTemplateId(
    $('#cfg-roletext')?.value ?? '',
    $('#cfg-behavior-profile')?.value || 'legacy',
    $('#cfg-customrules')?.value ?? ''
  );
}

/** 草稿与生效配置不一致时，卡库/详情头要跟着草稿说，不能只认已保存的那份。 */
function personaDraftState() {
  const cfg = state.config || {};
  return {
    id: currentPersonaId(),
    roleText: $('#cfg-roletext')?.value ?? (cfg.persona?.roleText || ''),
    behaviorProfile: $('#cfg-behavior-profile')?.value || cfg.persona?.behaviorProfile || 'legacy',
    customRules: $('#cfg-customrules')?.value ?? (cfg.persona?.customRules || '')
  };
}

/**
 * 草稿里有没有还没保存的人设改动（只比决定口吻的三项：正文 / 交流策略 / 附加规则）。
 * 「换人设后清空交接」据此先拦一下：那不保存的话交接清了、人设没换，机器人还是旧人设 ——
 * 用户反馈的"清空之后还是之前的人设"多半就卡在这一步（2026-10-12）。
 * 名字与参与度不算"旧人设残留"的来源（改名/调参与度不影响它沿用哪张卡的口气），不给它们挡路。
 */
function personaDraftDirty() {
  const saved = state.config?.persona || {};
  const draft = personaDraftState();
  return String(draft.roleText || '').trim() !== String(saved.roleText || '').trim()
    || String(draft.behaviorProfile || 'legacy') !== String(saved.behaviorProfile || 'legacy')
    || String(draft.customRules || '').trim() !== String(saved.customRules || '').trim();
}

/** 已保存配置正对应卡库里的哪张卡（匹配不上 = 自定义正文，或卡库还没读出来）。 */
function savedPersonaId() {
  const saved = state.config?.persona || {};
  return findPersonaTemplateId(
    saved.roleText || '',
    saved.behaviorProfile || 'legacy',
    saved.customRules || ''
  );
}

function syncPersonaButtons() {
  const draft = personaDraftState();
  refreshPersonaFold(draft.roleText);
  const tpl = state.personaTemplates[draft.id];
  // 卡库还没读出来时，"匹配不到任何卡"并不等于"正文被改过" —— 下面几处提示都要区分这两种情况
  const templatesKnown = Object.keys(state.personaTemplates || {}).length > 0;
  const delBtn = $('#del-persona-btn');
  if (delBtn) delBtn.classList.toggle('hidden', !String(draft.id).startsWith('custom_'));
  const hint = $('#persona-pick-hint');
  // 正文与内置模板不一致时（升级改了模板而实例里存的是旧正文，或管理员手改过），
  // 选择框会是空的，容易让人以为人设丢了 —— 用提示行说明这是按自定义处理。
  const hasText = String(draft.roleText || '').trim().length > 0;
  if (hint) {
    hint.textContent = tpl
      ? (tpl.builtin ? `内置卡：跟着 roles/ 下的卡文件走，改卡重启即生效。` : `自定义卡「${tpl.name}」。`)
      : (hasText
        ? (templatesKnown ? '当前正文与内置模板不一致（按自定义处理，可在上面的卡库里点一张卡换回来）'
          : (state.personaTemplatesFailed ? '人设卡读取失败，刷新页面重试。' : '正在读取人设卡…'))
        : '');
  }
  // 详情视图：正文、档位、绑定状态都按草稿渲染。
  // 「恢复本节 / 恢复整张卡」按**草稿那张卡**取文件正文（不是 config 里已保存的绑定）——
  // 刚在卡库点了另一张卡、还没保存时，用旧绑定会把两张卡的内容拼在一起。
  const baseTpl = state.personaTemplates[personaBaseCardId()];
  const fileText = baseTpl?.builtin ? baseTpl.text : '';
  // 只有内容真的变了才重画：人设页的输入事件（改名字、改附加规则、改正文）都会走到这里，
  // 每次都重画 15KB 正文 + 5 张卡的话，打字时每敲一键都要多花约 10ms。
  const viewKey = [draft.roleText, state.personaEditingSection,
    [...state.personaCollapsedSections].sort((a, b) => a - b).join(','), fileText].join('\u0000');
  const detail = $('#persona-card-view');
  if (detail && viewKey !== personaViewKey) {
    personaViewKey = viewKey;
    detail.innerHTML = renderPersonaCardBody(draft.roleText, {
      collapsed: state.personaCollapsedSections,
      editing: state.personaEditingSection,
      fileText
    });
  }
  const restoreBtn = $('#restore-persona-btn');
  if (restoreBtn) {
    const dirty = Boolean(fileText) && String(draft.roleText || '').trim() !== String(fileText).trim();
    restoreBtn.classList.toggle('hidden', !dirty);
  }
  const note = $('#persona-edit-note');
  if (note) {
    // 提示只在"草稿与卡文件不一致"时留着；一旦恢复成卡文件原文就自动消失
    const dirty = Boolean(fileText)
      ? String(draft.roleText || '').trim() !== String(fileText).trim()
      : true;
    note.textContent = dirty ? state.personaEditNote : '';
  }
  const title = $('#persona-view-title');
  if (title) title.textContent = tpl?.name || (hasText ? (templatesKnown ? '自定义正文' : '角色设定') : '（还没设置角色设定）');
  const profileChip = $('#persona-view-profile');
  if (profileChip) profileChip.textContent = draft.behaviorProfile === 'grounded' ? '自然可靠' : '原版群友';
  const bindChip = $('#persona-view-binding');
  if (bindChip) {
    const boundId = String((state.config?.persona?.templateId) || '');
    bindChip.className = 'chip';
    if (tpl?.builtin) {
      // 只有草稿正文就是这张卡的正文、且实例确实绑着它，才算"正在跟随卡文件"
      bindChip.classList.add(draft.id === boundId ? 'ok' : 'warn');
      bindChip.textContent = draft.id === boundId ? '跟随卡文件' : '保存后跟随卡文件';
    } else if (tpl) {
      bindChip.textContent = '自定义卡';
    } else if (hasText && templatesKnown) {
      bindChip.classList.add('warn');
      bindChip.textContent = '自定义正文 · 与卡文件解绑';
    } else if (hasText) {
      // 卡库还没读出来（或读取失败）时别断言"已解绑"——那时根本不知道有没有对应的卡
      bindChip.textContent = state.personaTemplatesFailed ? '卡库读取失败' : '读取卡库中…';
    } else {
      bindChip.textContent = '';
    }
  }
  const gridKey = [state.personaTemplatesVersion || 0,
    String(state.config?.persona?.templateId || ''),
    state.config?.persona?.roleText || '', state.config?.persona?.behaviorProfile || '',
    state.config?.persona?.customRules || '', draft.roleText, draft.behaviorProfile, draft.customRules].join('\u0000');
  const grid = $('#persona-grid');
  if (grid && gridKey !== personaGridKey) {
    personaGridKey = gridKey;
    grid.innerHTML = renderPersonaGrid(state.config || {}, draft);
  }
  // 折叠按钮的文案要跟着实际状态走（折叠状态是跨分区保留的，不能只靠点击时改文字）
  const expandBtn = $('#persona-expand-btn');
  if (expandBtn) {
    const total = parsePersonaCard(draft.roleText).sections.length;
    expandBtn.textContent = total > 0 && state.personaCollapsedSections.size >= total ? '全部展开' : '全部收起';
  }
}

function applyPersonaDraft(tpl, id = '') {
  $('#cfg-roletext').value = tpl.text;
  $('#cfg-customrules').value = tpl.customRules || '';
  $('#cfg-behavior-profile').value = tpl.behaviorProfile || 'legacy';
  state.personaEditingSection = -1;
  state.personaEditNote = '';
  // 记下"草稿是从哪张卡来的"：没保存之前 config 里还是旧绑定，
  // 「恢复本节 / 恢复整张卡」必须按草稿这张卡来，否则会把两张卡拼在一起。
  personaDraftCardId = id || findPersonaTemplateId(tpl.text, tpl.behaviorProfile || 'legacy', tpl.customRules || '');
  syncPersonaButtons();
}

/**
 * 草稿对应的内置卡 id：正文与某张内置卡完全一致就用那张；否则用用户最近点的那张
 * （点完卡再逐节改，正文就不完全一致了，但"基准卡"还是它）。
 */
function personaBaseCardId() {
  const draft = personaDraftState();
  const exact = findPersonaTemplateId(draft.roleText, draft.behaviorProfile, draft.customRules);
  if (exact && state.personaTemplates[exact]?.builtin) return exact;
  const picked = String(personaDraftCardId || '');
  return picked && state.personaTemplates[picked]?.builtin ? picked : '';
}

// personaCollapsedSections / personaEditingSection / personaEditNote 的初始化在 core/state.js：
// 它们现在是 state 的属性，而顶层写 state 会在**模块求值期**读 `state` —— 本文件与
// core/state.js 在同一个 import 环上，可能先求值，那样会踩 TDZ（见那边的注释与契约用例）。

let personaFoldKey = null;

let personaViewKey = null;        // 上次画正文视图用的内容指纹（没变就跳过重画）

let personaGridKey = null;        // 同上，卡库

let personaDraftCardId = '';      // 草稿是从哪张卡来的（点卡时记下）

/**
 * 默认折叠策略：只展开"你是谁"和"你的标志"，其余小节收起来。
 * 一张卡的正文能有三千多像素，全展开会把下面的名字/参与度/附加规则/保存按钮压到很远，
 * 用起来像"页面滚不动"。想看全的点「全部展开」。
 */
function defaultPersonaFold(roleText) {
  const card = parsePersonaCard(roleText);
  const folded = new Set();
  card.sections.forEach((section, index) => {
    if (!/你是谁|标志|招牌/.test(section.name)) folded.add(index);
  });
  return folded;
}

/**
 * 正文变了就更新折叠基准：换了另一张卡就按默认折叠重算，
 * 只是改了某一节（小节数没变）就保留用户当前展开/收起的状态。
 */
function refreshPersonaFold(roleText) {
  const key = String(roleText || '');
  if (personaFoldKey === key) return;
  const previousKey = personaFoldKey;
  const sameShape = previousKey !== null
    && parsePersonaCard(previousKey).sections.length === parsePersonaCard(key).sections.length;
  personaFoldKey = key;
  if (!sameShape) {
    state.personaCollapsedSections = defaultPersonaFold(key);
    state.personaEditingSection = -1;
  }
}

/** 行内格式：`code`、**加粗**（先转义再替换，避免注入）。 */
function personaInline(text) {
  return esc(String(text))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function parsePersonaCard(text) {
  const source = String(text || '');
  if (state.personaParseCache.text === source) return state.personaParseCache.card;
  const card = { title: '', sections: [] };
  let section = null;
  const blocks = () => (section ? section.blocks : (card.intro ||= []));
  const lastBlock = () => blocks()[blocks().length - 1];
  const lines = String(text || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\s+$/, '');
    if (!line.trim()) continue;
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) { card.title = h1[1].trim(); continue; }
    const h2 = line.match(/^##\s*(?:([一二三四五六七八九十]+|\d+)\s*[、.．]\s*)?(.*)$/);
    if (h2) {
      if (section) section.to = index;
      section = { num: (h2[1] || '').trim(), name: (h2[2] || '').trim(), blocks: [], from: index, to: lines.length };
      card.sections.push(section);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const last = lastBlock();
      if (last?.type === 'quote') last.lines.push(quote[1]);
      else blocks().push({ type: 'quote', lines: [quote[1]] });
      continue;
    }
    const listItem = line.match(/^\s*(?:[-*]|\d+[.．])\s+(.*)$/);
    if (listItem) {
      const last = lastBlock();
      if (last?.type === 'list') last.items.push(listItem[1]);
      else blocks().push({ type: 'list', items: [listItem[1]] });
      continue;
    }
    const turn = line.trim().match(/^(群友|你不要|你可以|或者|但|示例)[：:]\s*(.*)$/);
    if (turn) {
      const role = turn[1] === '群友' ? 'peer' : (turn[1] === '你不要' ? 'bad' : 'ok');
      const last = lastBlock();
      if (role === 'peer' || last?.type !== 'example') {
        blocks().push({ type: 'example', turns: [{ role, text: turn[2] }] });
      } else {
        last.turns.push({ role, text: turn[2] });
      }
      continue;
    }
    // 续行：接到上一段/上一条列表项后面（卡里的换行大多是折行，不是新句）
    const last = lastBlock();
    if (last?.type === 'list' && last.items.length) last.items[last.items.length - 1] += ` ${line.trim()}`;
    else if (last?.type === 'p') last.text += ` ${line.trim()}`;
    else blocks().push({ type: 'p', text: line.trim() });
  }
  state.personaParseCache = { text: source, card };
  return card;
}

/** 取某一节的正文（不含小节标题那一行）。 */
function personaSectionBody(text, index) {
  const source = String(text || '');
  const section = parsePersonaCard(source).sections[index];
  if (!section) return '';
  return source.split(/\r?\n/).slice(section.from + 1, section.to).join('\n').replace(/^\n+|\n+$/g, '');
}

function renderPersonaBlock(block, { asTags = '' } = {}) {
  if (block.type === 'quote') {
    return `<div class="pd-quote">${block.lines.map(personaInline).join('<br>')}</div>`;
  }
  if (block.type === 'list') {
    if (asTags) {
      return `<div class="pd-tags">${block.items.map((item) => `<span class="pd-tag ${asTags}">${personaInline(item)}</span>`).join('')}</div>`;
    }
    return `<ul class="pd-list">${block.items.map((item) => `<li>${personaInline(item)}</li>`).join('')}</ul>`;
  }
  if (block.type === 'example') {
    const MARK = { peer: '', bad: '✗', ok: '✓' };
    return `<div class="pd-chat">${block.turns.map((t) => `
      <div class="pd-msg ${t.role}">
        <span class="mark">${MARK[t.role] || ''}</span>
        <span class="bubble">${t.role === 'peer' ? '<span class="who">群友 </span>' : ''}${personaInline(t.text)}</span>
      </div>`).join('')}</div>`;
  }
  if (block.type === 'p') return `<p>${personaInline(block.text)}</p>`;
  return '';
}

/**
 * 把卡正文渲染成分节视图。
 * @param {object} options
 *   collapsed  收起来的小节序号集合
 *   editing    正在按小节编辑的序号（-1 = 没在编辑）
 *   fileText   这张卡对应的卡文件正文（有值时每节出现「恢复本节」）
 */
function renderPersonaCardBody(text, { collapsed = new Set(), showTitle = true, editing = -1, fileText = '' } = {}) {
  const card = parsePersonaCard(text);
  if (!card.sections.length) {
    return `<div class="pd-empty">这段正文还没分节，点「编辑正文」直接改；想有分节视图就按内置卡的写法用 <code>## 一、小节名</code>。</div>`;
  }
  const fileCard = fileText ? parsePersonaCard(fileText) : null;
  const sections = card.sections.map((sec, i) => {
    const isStar = PERSONA_TAG_SECTIONS.test(sec.name);
    const isBad = PERSONA_BAD_SECTIONS.test(sec.name);
    const emoji = isStar ? '✨' : (isBad ? '🚫' : (PERSONA_SECTION_EMOJI[sec.name.replace(/（.*?）/g, '')] || ''));
    const body = sec.blocks.map((block) => renderPersonaBlock(block, {
      asTags: isStar ? 'star' : (isBad ? 'bad' : '')
    })).join('');
    const chips = [];
    if (isStar) chips.push('<span class="chip star">招牌特征</span>');
    if (/示例/.test(sec.name)) chips.push('<span class="chip">✓ 可用 / ✗ 禁用</span>');
    const isEditing = editing === i;
    // 卡文件里同一节还在、而且写法不同 → 给一个"只把这一节改回卡文件写法"的入口
    const fileBody = fileCard && fileCard.sections[i] && fileCard.sections[i].name === sec.name
      ? personaSectionBody(fileText, i) : null;
    const canRevert = fileBody !== null && fileBody !== personaSectionBody(text, i);
    const actions = `
      <span class="pd-sec-actions">
        ${canRevert ? `<button type="button" class="pd-sec-revert" data-sec="${i}">恢复本节</button>` : ''}
        <button type="button" class="pd-sec-edit" data-sec="${i}">${isEditing ? '正在编辑' : '编辑'}</button>
      </span>`;
    const sectionBody = isEditing
      ? `<div class="pd-edit">
           <textarea class="pd-edit-text" data-sec="${i}" spellcheck="false" placeholder="这一节的正文（markdown）。小节标题不在这里改。">${esc(personaSectionBody(text, i))}</textarea>
           <div class="pd-edit-row">
             <button type="button" class="btn btn-small btn-primary pd-sec-save" data-sec="${i}">保存本节</button>
             <button type="button" class="btn btn-small pd-sec-cancel">取消</button>
             <span class="muted pd-edit-hint">保存只是改草稿；要生效还得点底部那条「保存设置」。</span>
           </div>
         </div>`
      : body;
    return `
      <div class="pd-sec ${collapsed.has(i) && !isEditing ? 'collapsed' : ''} ${isEditing ? 'editing' : ''}" data-sec="${i}">
        <div class="pd-sec-head">
          <span class="idx">${esc(sec.num || String(i + 1))}</span>
          <span class="name">${emoji ? `${emoji} ` : ''}${esc(sec.name)}</span>
          ${chips.join('')}
          ${actions}
          <span class="caret">▾</span>
        </div>
        <div class="pd-sec-body">${sectionBody}</div>
      </div>`;
  }).join('');
  const head = showTitle && card.title
    ? `<div class="pd-headline">${esc(card.title)}</div>`
    : '';
  return `${head}${sections}`;
}

function personaCardDesc(tpl) {
  const key = `${tpl.name}\u0000${tpl.text.length}\u0000${tpl.text.slice(0, 24)}`;
  if (personaDescCache.has(key)) return personaDescCache.get(key);
  const parsed = parsePersonaCard(tpl.text);
  const sec = parsed.sections.find((s) => s.name.includes('你是谁'));
  const text = sec?.blocks.find((b) => b.type === 'p')?.text || '';
  const desc = text.length > 46 ? `${text.slice(0, 46)}…` : text;
  personaDescCache.set(key, desc);
  return desc;
}

function renderPersonaGrid(c, draft = {}) {
  const draftText = draft.roleText ?? c.persona?.roleText ?? '';
  const draftProfile = draft.behaviorProfile ?? c.persona?.behaviorProfile ?? 'legacy';
  const draftRules = draft.customRules ?? c.persona?.customRules ?? '';
  const draftId = findPersonaTemplateId(draftText, draftProfile, draftRules);
  const savedId = findPersonaTemplateId(
    c.persona?.roleText || '', c.persona?.behaviorProfile || 'legacy', c.persona?.customRules || ''
  );
  const boundId = String(c.persona?.templateId || '');
  const templates = Object.entries(state.personaTemplates || {});
  if (!templates.length) {
    // 区分"卡库还没读出来/读取失败"和"真的一张卡都没有"，别让人以为人设丢了
    return state.personaTemplatesFailed
      ? '<div class="pd-empty">人设卡读取失败，刷新页面重试。</div>'
      : '<div class="pd-empty">正在读取人设卡…</div>';
  }
  return templates.map(([id, tpl]) => {
    const isDraft = id === draftId;
    const isInUse = id === savedId && id === boundId;
    const desc = personaCardDesc(tpl);
    return `
      <div class="persona-card ${isDraft ? 'selected' : ''}" data-persona-id="${esc(id)}" role="button" tabindex="0">
        <div class="pc-top">
          <span class="pc-name">${esc(tpl.name)}</span>
          ${isInUse ? '<span class="chip ok">使用中</span>' : (isDraft ? '<span class="chip">草稿中</span>' : '')}
        </div>
        <div class="pc-meta">
          <span class="pc-tag">${tpl.behaviorProfile === 'grounded' ? '自然可靠' : '原版群友'}</span>
          <span class="pc-src">${tpl.builtin ? '内置 · 跟随卡文件' : '自定义'}</span>
        </div>
        <div class="pc-desc">${esc(desc)}</div>
      </div>`;
  }).join('');
}

/** 人设卡库：点一张卡就把它的正文填进草稿（保存后才生效）。 */
function renderPersonaLibrary(c) {
  return `
    <div class="persona-lib">
      <div class="persona-lib-head">
        <span class="pl-title">人设卡库</span>
        <span class="spacer"></span>
        <button class="btn btn-small" id="persona-expand-btn">全部收起</button>
        <button class="btn btn-small" id="new-persona-btn">＋ 新建自定义卡</button>
        <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义卡</button>
        <button class="btn btn-small" id="persona-reset-handoff-btn" title="换完人设后点一下：清掉所有群的会话交接与线程状态，避免它继续沿用上一张卡的口癖/自称">换人设后清空交接</button>
        <button class="btn btn-small" id="persona-mask-old-speech-btn" title="换完人设后点一下：把此前机器人自己发的消息在提示词与工具里遮成『换卡前的旧发言』，避免模型照着旧口癖学；不删聊天记录、不动群友发言">屏蔽旧人设发言</button>
      </div>
      <div class="hint" style="margin:2px 0 8px" id="persona-reset-handoff-hint">
        换了角色卡之后，它历史里还留着自己上一张卡的发言和"交接"，容易继续用旧口癖（我们实测换卡一天后仍在喵）。
        正文/优先级已经写明"以当前卡为准"，点上面两个按钮可以再彻底一点：
        「换人设后清空交接」清掉各群的会话交接与线程状态；「屏蔽旧人设发言」把**所有群（包括以后新增的会话）**在此之前的机器人发言在提示词/工具里遮成占位符
        （<strong>不删聊天记录、不动群友发言、不动人物印象</strong>）。两个都点最彻底。
      </div>
      <div class="hint" style="margin:2px 0 8px" id="persona-mask-old-speech-hint"></div>
      <div class="persona-grid" id="persona-grid">${renderPersonaGrid(c)}</div>
    </div>
    <span id="persona-pick-hint" class="muted" style="font-size: var(--fs-sm)"></span>`;
}

function renderPersonaSection(c) {
  const roleText = c.persona.roleText || '';
  refreshPersonaFold(roleText);
  // 整个设置页会重画 DOM：正文视图与卡库都要按当前状态（折叠/编辑中）画一次，
  // 并把指纹清空，交给随后的 syncPersonaButtons 校一遍。
  personaViewKey = null;
  personaGridKey = null;
  return `
    <h3>人设</h3>
    <div class="field-row">
      <div class="field"><label>提示词布局</label>
        <select id="cfg-prompt-layout">
          <option value="split" ${c.prompt?.layout !== 'combined' ? 'selected' : ''}>分离（精简系统提示 + 人设/技能初始化消息，推荐）</option>
          <option value="combined" ${c.prompt?.layout === 'combined' ? 'selected' : ''}>合并（全部拼进系统提示，旧行为）</option>
        </select>
        <div class="hint">分离布局把 QQ 操作说明放进技能，system 只保留运行时入口；人设与常驻技能作为首条消息发送。合并布局与旧版逐字一致，可作为回滚。</div>
      </div>
      <div class="field"><label>对管理员的称呼（可选）</label>
        <input type="text" id="cfg-admin-address" value="${esc(c.admin?.addressAs || '')}" maxlength="20" placeholder="老大 / 主人 / 老板" />
        <div class="hint">群聊里用这个称呼指代管理员；[管理员] 仍只是系统标记，不会当成昵称。</div>
      </div>
    </div>
    ${renderPersonaLibrary(c)}
    <div class="persona-detail">
      <div class="pd-head">
        <span class="pd-title" id="persona-view-title"></span>
        <span class="chip" id="persona-view-profile"></span>
        <span class="chip" id="persona-view-binding"></span>
        <span class="spacer"></span>
        <button class="btn btn-small hidden" id="restore-persona-btn">恢复整张卡</button>
        <button class="btn btn-small" id="toggle-persona-edit">编辑全文</button>
      </div>
      <div class="pd-body" id="persona-card-view">${renderPersonaCardBody(roleText)}</div>
    </div>
    <div class="hint" id="persona-edit-note"></div>
    <div class="field hidden" id="persona-raw-field">
      <label>角色设定（原文）</label>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(roleText)}</textarea>
      <div class="hint">上面那屏是这份原文的读法，保存的也是这份原文。平时逐节改就够了（每节右上角有「编辑」「恢复本节」）；
        这里改一个字也会<strong>解除与内置卡的绑定</strong>（正文归你自己管），想重新跟随卡文件，回上面的卡库里点一下那张卡。</div>
    </div>
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" />
        <div class="hint">它是账号的名字，<strong>不随角色卡切换</strong>（换卡只换下面的正文）；群里显示的是「群内展示名」或 QQ 群名片。</div></div>
      <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
      <div class="field"><label>交流策略</label>
        <select id="cfg-behavior-profile">
          <option value="legacy" ${c.persona.behaviorProfile !== 'grounded' ? 'selected' : ''}>原版群友</option>
          <option value="grounded" ${c.persona.behaviorProfile === 'grounded' ? 'selected' : ''}>自然可靠</option>
        </select></div>
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
    </div>
    <div class="hint">角色正文是人格与发言频率的唯一来源：填了正文时，系统提示只保留安全规则、合规边界和工具机制，不再附加任何默认群友风格；参与度（安静/普通/活跃）只在正文为空时作为兜底频率。交流策略在有正文时只影响技术内容格式与表情频率：「原版群友」不输出 Markdown；「自然可靠」允许代码围栏，表情更克制。</div>
    <div class="field"><label>管理员附加规则（可选；排在角色设定之后 —— 想补充或压过角色设定就写这里）</label>
      <div class="pd-tags" id="persona-rule-chips">
        ${PERSONA_RULE_EXAMPLES.map((rule) => `<button type="button" class="pd-tag rule-chip" data-rule="${esc(rule)}">＋ ${esc(rule)}</button>`).join('')}
      </div>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px" placeholder="例如：别装傻、别反问，不接话就安静；称呼固定用「老板」；被怼只淡淡带过">${esc(c.persona.customRules || '')}</textarea>
      <div class="hint">冲突时优先级：安全规则 &gt; 这里 &gt; 角色设定。角色的口吻/称呼/脾气/发言频率写在「角色设定」里就行，这里的硬要求会盖过角色设定。上面几个例子点一下就加进去，可以再改。</div></div>
    ${renderPersonaPerChat(c)}
    <div class="hint">改完记得点页面最下面那条<strong>「保存设置」</strong>（一直悬在底部）——它保存的就是这一页的人设。</div>`;
}

/**
 * 按群人设：白名单里的每个群/私聊可以单独选一张卡（空 = 跟随全局）。
 * 行来自「聊天白名单」+ 已经配置过的会话；保存时整份替换 personaPerChat。
 */
function renderPersonaPerChat(c) {
  const map = c.personaPerChat && typeof c.personaPerChat === 'object' ? c.personaPerChat : {};
  const templates = Object.entries(state.personaTemplates || {});
  const chats = new Set();
  for (const id of (c.allow?.groups || [])) chats.add(`group:${String(id).trim()}`);
  for (const id of (c.allow?.private || [])) chats.add(`private:${String(id).trim()}`);
  for (const key of Object.keys(map)) chats.add(key);
  const rows = [...chats].filter((key) => /^(group|private):\d+$/.test(key)).sort();
  const labelOf = (key) => (key.startsWith('group:') ? `群 ${key.slice(6)}` : `私聊 ${key.slice(8)}`);
  return `
    <h3 id="persona-per-chat">按群人设</h3>
    <div class="hint">每个群 / 私聊可以单独选一张卡；不选 = 跟随上面的全局人设。<b>人物记忆是全局的</b>——
      同一个群友在不同群共用一份印象，只是当前用哪套口吻不同。想给新的群设置，先在「聊天白名单」里加上它。</div>
    <div class="per-chat-list">
      ${rows.length ? rows.map((key) => `
        <div class="per-chat-row" data-per-chat="${esc(key)}">
          <span class="per-chat-name">${esc(labelOf(key))}</span>
          <select class="per-chat-select" aria-label="${esc(labelOf(key))} 的人设">${perChatOptions(map[key], templates)}</select>
        </div>`).join('') : '<div class="pd-empty">白名单里还没有群或私聊。</div>'}
    </div>`;
}

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
/** 添加人设：弹窗填写人设名称、角色设定、管理员附加规则。 */
function openPersonaCreateModal() {
  const overlay = modelModalShell({
    head: '添加人设',
    body: `
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称</label>
        <input type="text" id="new-persona-name" placeholder="例如：毒舌老哥" />
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>交流策略</label>
        <select id="new-persona-profile">
          <option value="legacy" ${$('#cfg-behavior-profile')?.value !== 'grounded' ? 'selected' : ''}>原版群友</option>
          <option value="grounded" ${$('#cfg-behavior-profile')?.value === 'grounded' ? 'selected' : ''}>自然可靠</option>
        </select>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定</label>
        <textarea id="new-persona-text" class="persona-role-text" style="min-height:220px" placeholder="人设文本">${esc($('#cfg-roletext')?.value || '')}</textarea>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>管理员附加规则（可选）</label>
        <textarea id="new-persona-rules" style="min-height:90px" placeholder="可选：追加到系统提示的规则">${esc($('#cfg-customrules')?.value || '')}</textarea>
      </div>`,
    foot: `<button class="btn" id="persona-add-cancel">取消</button>
           <button class="btn btn-primary" id="persona-add-apply">确认添加</button>`
  });
  overlay.querySelector('#persona-add-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-add-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-persona-name').value.trim();
    const text = overlay.querySelector('#new-persona-text').value.trim();
    const customRules = overlay.querySelector('#new-persona-rules').value.trim();
    const behaviorProfile = overlay.querySelector('#new-persona-profile').value;
    if (!name) { $('#persona-pick-hint').textContent = '人设名称不能为空'; return; }
    if (!text) { $('#persona-pick-hint').textContent = '角色设定不能为空'; return; }
    try {
      await api('/api/persona-templates', {
        method: 'POST',
        body: JSON.stringify({ name, text, customRules, behaviorProfile })
      });
      closeModelModal(overlay);
      await loadSettings();
      applyPersonaDraft({ name, text, customRules, behaviorProfile });
      $('#persona-pick-hint').textContent = `人设「${name}」已添加。记得点底部的「保存设置」使当前填写生效。`;
    } catch (e) {
      $('#persona-pick-hint').textContent = `添加失败：${e.message}`;
    }
  });
}


/**
 * 「屏蔽旧人设发言」按钮：确认后调用接口，把点击前的机器人发言在提示词/工具里遮掉。
 * 与「换人设后清空交接」互补：前者清工作状态，这里清“旧语气示例”。
 * 绑定逻辑留在 settings-bind.js（它手里有草稿冲正与确认弹窗），这里只放行为，
 * 避免 settings-bind 再长一截撞上 max-lines 闸门。
 */
async function runMaskOldSpeech({ flushDraft, confirm, button }) {
  flushDraft();
  const hint = $('#persona-mask-old-speech-hint');
  if (personaDraftDirty()) {
    const text = '人设改动还没保存：先点页面最底下的「保存设置」，再点「屏蔽旧人设发言」。';
    if (hint) hint.textContent = text;
    alert(text);
    return;
  }
  const NL = String.fromCharCode(10);
  const ok = await confirm(
    '屏蔽所有群里机器人此前（点击前）自己发的消息？' + NL + NL
    + '· 提示词与工具结果里会显示成「[换卡前的旧发言（口吻不作数）]」' + NL
    + '· 不删聊天记录、不动群友发言、不动人物印象' + NL
    + '· 同时关闭进行中的对话线程（否则生命周期里旧轮次仍会续接）' + NL
    + '· 全局生效：所有群（包括以后新增的会话）都按这条时间线屏蔽' + NL
    + '· 和「换人设后清空交接」一起点最彻底'
  );
  if (!ok) return;
  button.disabled = true;
  try {
    const res = await api('/api/persona/mask-old-speech', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    const activeNote = res.note ? ` ${res.note}` : '';
    if (hint) hint.textContent = `已屏蔽 ${res.chats || 0} 个群的旧人设发言（关闭了 ${res.threadsClosed || 0} 个进行中的线程）。${activeNote}`;
  } catch (error) {
    if (hint) hint.textContent = `屏蔽失败：${error?.message ?? error}`;
  } finally {
    button.disabled = false;
  }
}

export {
  applyPersonaDraft, currentPersonaId, defaultPersonaFold, openPersonaCreateModal, parsePersonaCard,
  personaBaseCardId, personaDraftDirty, personaSectionBody, renderPersonaSection, runMaskOldSpeech,
  savedPersonaId, syncPersonaButtons
};