// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」）。
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（test/ui-modules.test.mjs 的守恒断言盯住）。
'use strict';


import { closeModelModal, modelModalShell, refreshStatus } from '../app.js';
import { api } from '../core/api.js';
import { CHAT_MSG_PAGE, STICKER_LEVELS } from '../core/constants.js';
import { askForConfirmation, initChatScrollLoader, patchKeyedList } from '../core/dom-util.js';
import { $, $$, esc } from '../core/dom.js';
import {
  chatNameOf, fmtTime, fmtTok, formatChatTitle, groupSliderPosForUi, normalizeStickerCollectMax,
  normalizeStickerMax, paramActiveForProbability, segOfProbability, sliderDesc, sliderToTierUI,
  sliderToTierUI_tierToSlider
} from '../core/format.js';
import { state } from '../core/state.js';
function renderConversationModePanels(conversation = {}) {
  const activeMode = ['legacy', 'threaded', 'lifecycle'].includes(conversation.mode)
    ? conversation.mode
    : 'legacy';
  const modes = [
    ['legacy', '传统触发', '按规则启动'],
    ['threaded', '参与者续接', '短窗口延续'],
    ['lifecycle', '完整生命周期', '持续批次判断']
  ];
  const panelAttrs = (mode) =>
    `class="conversation-mode-panel${activeMode === mode ? '' : ' hidden'} mode-${mode}" `
    + `data-conversation-panel="${mode}" aria-hidden="${activeMode === mode ? 'false' : 'true'}"`;

  return `
    <div class="conversation-mode-shell mode-${activeMode}" id="conversation-mode-shell" data-mode="${activeMode}">
      <div class="conversation-mode-switch" role="tablist" aria-label="默认对话模式">
        ${modes.map(([mode, label, subtitle]) => `
          <button type="button"
            class="conversation-mode-option mode-${mode}${activeMode === mode ? ' active' : ''}"
            data-conversation-mode="${mode}" role="tab"
            aria-selected="${activeMode === mode ? 'true' : 'false'}">
            <span>${label}</span>
            <small>${subtitle}</small>
          </button>`).join('')}
      </div>
      <input type="hidden" id="cfg-conversation-mode" value="${activeMode}" />

      <div class="conversation-mode-stage">
        <section ${panelAttrs('legacy')}>
          <div class="conversation-mode-heading">
            <div>
              <strong>传统触发</strong>
              <span>每个消息批次独立判断</span>
            </div>
            <span class="mode-state-token">无持续线程</span>
          </div>
          <div class="conversation-mode-flow" aria-label="传统触发流程">
            <span>响应档位</span><i></i><span>单次运行</span><i></i><span>结束</span>
          </div>
          <dl class="conversation-mode-facts">
            <div><dt>启动条件</dt><dd>@ / 关键词 / 概率</dd></div>
            <div><dt>后续消息</dt><dd>重新判断触发条件</dd></div>
            <div><dt>上下文</dt><dd>按档位读取消息</dd></div>
          </dl>
        </section>

        <section ${panelAttrs('threaded')}>
          <div class="conversation-mode-heading">
            <div>
              <strong>参与者续接</strong>
              <span>机器人发言后为当前参与者保留续接窗口</span>
            </div>
            <span class="mode-state-token">参与者限定</span>
          </div>
          <div class="conversation-mode-flow" aria-label="参与者续接流程">
            <span>首次触发</span><i></i><span>参与者续接</span><i></i><span>线程过期</span>
          </div>
          <div class="field-row conversation-mode-fields">
            <div class="field"><label>确定性续接窗口（秒）</label><input type="number" id="cfg-cont-window" min="10" max="1800" value="${esc(Math.round((conversation.continuationWindowMs ?? 180000) / 1000))}" /></div>
            <div class="field"><label>线程空闲过期（分钟）</label><input type="number" id="cfg-thread-ttl" min="5" max="1440" value="${esc(Math.round((conversation.threadTtlMs ?? 1800000) / 60000))}" /></div>
            <div class="field"><label>续接读取历史条数</label><input type="number" id="cfg-cont-history" min="1" max="500" value="${esc(conversation.continuationContextCount ?? 100)}" /></div>
          </div>
        </section>

        <section ${panelAttrs('lifecycle')}>
          <div class="conversation-mode-heading">
            <div>
              <strong>完整生命周期</strong>
              <span>生命周期内每批消息都进入模型判断</span>
            </div>
            <span class="mode-state-token">持久化线程</span>
          </div>
          <div class="conversation-mode-flow" aria-label="完整生命周期流程">
            <span>监听</span><i></i><span>活跃</span><i></i><span>硬上限</span><i></i><span>待续接</span>
          </div>
          <div class="field-row conversation-mode-fields">
            <div class="field"><label>监听空闲结束（分钟）</label><input type="number" id="cfg-life-silent" min="1" max="60" value="${esc(Math.round((conversation.silentIdleMs ?? 300000) / 60000))}" /></div>
            <div class="field"><label>活跃空闲结束（分钟）</label><input type="number" id="cfg-life-active" min="1" max="120" value="${esc(Math.round((conversation.activeIdleMs ?? 1200000) / 60000))}" /></div>
            <div class="field"><label>生命周期硬上限（分钟）</label><input type="number" id="cfg-life-hard" min="5" max="240" value="${esc(Math.round((conversation.hardLifetimeMs ?? 1800000) / 60000))}" /></div>
          </div>
          <div class="field-row conversation-mode-fields">
            <div class="field"><label>硬上限后待续接（分钟）</label><input type="number" id="cfg-life-rollover" min="1" max="60" value="${esc(Math.round((conversation.rolloverArmedMs ?? 600000) / 60000))}" /></div>
            <div class="field"><label>首次读取历史条数</label><input type="number" id="cfg-life-history" min="1" max="500" value="${esc(conversation.lifecycleContextCount ?? 100)}" /></div>
            <div class="field"><label>换代输入上限（Token）</label><input type="number" id="cfg-life-tokens" min="5000" max="500000" step="1000" value="${esc(conversation.lifecycleRolloverInputTokens ?? 32000)}" /></div>
            <div class="field"><label>追加上下文兜底（字符）</label><input type="number" id="cfg-life-chars" min="20000" max="1000000" step="10000" value="${esc(conversation.maxTranscriptChars ?? 240000)}" /></div>
          </div>
        </section>
      </div>
    </div>`;
}

function renderChatSection(c) {
  const st = c.store || {};
  const conversation = c.conversation || {};
  // 滑条位置是唯一真相，而且**滑条上的数字就是概率**（与后端 tier-slider.js 同一套规则）
  const sliderPos = sliderToTierUI_tierToSlider(st);
  const { randomPercent: curPct } = sliderToTierUI(sliderPos);
  // 刻度高亮与参数高亮都按"当前概率落在哪一段"来点
  const curSeg = segOfProbability(curPct);
  const paramOn = paramActiveForProbability(curPct);
  const triggerMode = c.trigger?.mode === 'hybrid' ? 'hybrid' : 'probability';
  const att = c.trigger?.attention || {};
return `
    <h3>对话模式</h3>
    ${renderConversationModePanels(conversation)}

    <div class="conversation-scope">
      <div class="conversation-scope-heading">
        <strong>应用范围</strong>
        <span>模式参数按类型共用，群聊只选择使用哪一种模式</span>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-conversation-unified" ${conversation.unifiedMode !== false ? 'checked' : ''} />
        <label for="cfg-conversation-unified">所有群聊统一使用默认模式</label></div>
      <div id="conversation-pergroup-wrap"${conversation.unifiedMode === false ? '' : ' style="display:none"'}>
        <div class="field-row">
          <div class="field"><label>选择群聊</label><select id="conversation-group-select"></select></div>
          <div class="field"><label>该群模式</label>
            <select id="conversation-group-mode">
              <option value="legacy">传统触发</option>
              <option value="threaded">参与者续接</option>
              <option value="lifecycle">完整生命周期</option>
            </select>
          </div>
        </div>
        <input type="hidden" id="conversation-group-json" value="${esc(JSON.stringify(conversation.groupModes || {}))}" />
        <div class="conversation-scope-actions">
          <button class="btn btn-small btn-danger" id="conversation-group-clear-btn">清除该群覆盖</button>
          <span class="hint">未覆盖的群聊与私聊跟随默认模式。</span>
        </div>
      </div>
    </div>

    <h3>所有模式 · 运行节奏</h3>
    <div class="field-row">
      <div class="field"><label>未思考等待最短值（毫秒）</label><input type="number" id="cfg-wakedelay-min" min="0" max="20000" value="${esc(c.wakeDelayMinMs ?? c.wakeDelayMs ?? 8000)}" /></div>
      <div class="field"><label>未思考等待最长值（毫秒）</label><input type="number" id="cfg-wakedelay-max" min="0" max="20000" value="${esc(c.wakeDelayMaxMs ?? c.wakeDelayMs ?? 12000)}" /></div>
      <div class="field"><label>批次间隔（毫秒）—— 上轮结束到下轮处理的间隔</label><input type="number" id="cfg-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      <div class="field"><label>同时处理几个会话</label><input type="number" id="cfg-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
    </div>

    <h3>所有模式 · 发送保护</h3>
    <div class="field-row">
      <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="cfg-mingap" min="200" value="${esc(c.send.minGapMs)}" /></div>
      <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="cfg-maxgap" min="500" value="${esc(c.send.maxGapMs)}" /></div>
      <div class="field"><label>每分钟最多发送</label><input type="number" id="cfg-maxpermin" min="1" value="${esc(c.send.maxPerMinute)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>每小时最多发送</label><input type="number" id="cfg-maxperhour" min="1" value="${esc(c.send.maxPerHour ?? 500)}" /></div>
      <div class="field"><label>按字数附加间隔（毫秒/字）</label><input type="number" id="cfg-bylength" min="0" value="${esc(c.send.byLengthMs ?? 20)}" /></div>
      <div class="field"><label>QQ 硬限制切分长度（0 = 不切）</label><input type="number" id="cfg-hardsplit" min="0" value="${esc(c.send.hardSplitAt ?? 4000)}" /></div>
    </div>

    <h3>所有模式 · 主动开话题</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
      <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
    <div class="field-row">
      <div class="field"><label>检查间隔下限（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
      <div class="field"><label>检查间隔上限（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
      <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-pro-followup" ${c.proactive?.followUpEnabled !== false ? 'checked' : ''} />
      <label for="cfg-pro-followup">说完话没人接，过十来分钟补一句（"？"/"人呢"）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-pro-selfwake" ${c.proactive?.selfWakeEnabled !== false ? 'checked' : ''} />
      <label for="cfg-pro-selfwake">允许模型给自己安排稍后的主动发言</label></div>
    <div class="hint">
      这三项互不影响：只取消第一条，机器人仍可能在说完话没人接时补一句、也可能按自己安排的时机开口；
      完全不想让它主动开口就把三个都取消。后两项在较早版本里一直生效，本版起可以在控制台关掉。
    </div>

    <h3>所有模式 · 表情包</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
      <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>

    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker-collect" ${(c.sticker?.collectEnabled !== false && c.sticker?.autoCollect !== false) ? 'checked' : ''} />
      <label for="cfg-sticker-collect">允许机器人自己收藏表情包（关掉后不再自动收，也不会在聊天里主动收；手动添加不受影响）</label></div>

    <div class="field">
      <label for="cfg-sticker-collect-max">每小时最多收藏（<span class="slider-now" id="cfg-sticker-collect-max-now">${normalizeStickerCollectMax(c.sticker?.maxCollectPerHour)}</span> 张）</label>
      <div class="tier-slider-wrap">
        <input type="range" id="cfg-sticker-collect-max" class="tier-slider" min="1" max="60" step="0.1"
          value="${normalizeStickerCollectMax(c.sticker?.maxCollectPerHour)}" aria-label="每小时最多收藏张数" />
      </div>
      <div class="hint">
        拖动设置 1-60（默认 10 张/小时）。全局上限；每个会话另有 3 张/小时的上限。
        控制台里手动添加表情不受这两项影响。
      </div>
    </div>

    <div class="field">
      <label for="cfg-sticker-collect-criteria">收藏的判定标准（留空 = 内置默认）</label>
      <textarea id="cfg-sticker-collect-criteria" rows="4" maxlength="2000" placeholder="只写「收什么 / 不收什么」；留空用内置默认（与之前版本完全一致）">${esc(c.sticker?.collectCriteria || '')}</textarea>
      <div class="hint">
        这段文字替换表情判定里的"判定标准"部分（"你是「谁」、正在看谁的图"仍由代码补充），
        只影响<b>哪些图会被收进表情库</b>，不影响聊天与发送。改完即时生效、不用重启；
        超 2000 字判定时只取前 2000。
      </div>
    </div>

    <div class="field">
      <label>发表情包的积极程度</label>
      <select id="cfg-sticker-encourage">
        ${STICKER_LEVELS.map(([v, label]) =>
          `<option value="${v}" ${Number(c.sticker?.encourage ?? 1) === v ? 'selected' : ''}>${esc(label)}</option>`
        ).join('')}
      </select>
      <div class="hint">
        这是"引导"不是"强制"，模型仍会自行判断什么时机合适。
      </div>
    </div>

    <div class="field">
      <label for="cfg-sticker-max">系统提示里的表情清单条数（<span class="slider-now" id="cfg-sticker-max-now">${normalizeStickerMax(c.sticker?.promptMaxStickers)}</span> 条）</label>
      <div class="tier-slider-wrap">
        <input type="range" id="cfg-sticker-max" class="tier-slider" min="1" max="60" step="0.1"
          value="${normalizeStickerMax(c.sticker?.promptMaxStickers)}" aria-label="表情清单条数" />
      </div>
      <div class="hint">
        拖动设置 1-60（默认 10）。清单一半放常用的，一半放没用过/很久没用的，发掉一张自动换下一张上来
        （不会再总是那几张）。条数越大能选的范围越宽，代价是每轮提示词变长；省 Token 模式还会再夹到
        3~5 条。库容量不受这一项影响。
      </div>
    </div>

    <h3>首次唤醒与历史</h3>
    <div class="hint conversation-trigger-hint" id="conversation-trigger-hint"></div>

    <div class="field">
      <label>触发方式</label>
      <select id="cfg-trigger-mode">
        <option value="probability" ${triggerMode === 'probability' ? 'selected' : ''}>概率（现有行为）</option>
        <option value="hybrid" ${triggerMode === 'hybrid' ? 'selected' : ''}>模型注意力（普通群聊先判定）</option>
      </select>
      <div class="hint">模型注意力：@、关键词、引用机器人、私聊、失败重试仍然必回；普通群聊消息先让小模型判断
        ignore / peek / reply，失败时回落到下面的概率。判定本身也计入预算与每日上限。
        仅在「传统触发」模式下生效；参与者续接 / 完整生命周期已有自己的模型判断，不重复判定。</div>
    </div>
    <div class="field-row" id="trigger-attention-fields" style="${triggerMode === 'hybrid' ? '' : 'display:none'}">
      <div class="field"><label>注意力判定模型（留空 = 聊天模型）</label>
        <input type="text" id="cfg-attention-model" value="${esc(att.model || '')}" placeholder="例如 deepseek-v4-flash" /></div>
      <div class="field"><label>最低置信度 0~1</label>
        <input type="number" id="cfg-attention-confidence" step="0.05" min="0" max="1" value="${esc(att.minConfidence ?? 0.55)}" /></div>
      <div class="field"><label>每日判定上限（0 = 不调用）</label>
        <input type="number" id="cfg-attention-maxcalls" min="0" max="5000" value="${esc(att.maxCallsPerDay ?? 300)}" /></div>
    </div>

    <div class="checkbox-row"><input type="checkbox" id="cfg-unifiedtier" ${st.unifiedTier !== false ? 'checked' : ''} />
      <label for="cfg-unifiedtier">统一设置响应概率（关掉就能给每个白名单群聊单独拖）</label></div>

    <!-- 统一模式：一个滑条管所有会话（原行为） -->
    <div id="tier-unified-wrap"${st.unifiedTier === false ? ' style="display:none"' : ''}>
    <div class="tier-slider-wrap">
      <input type="range" id="ctx-tier-slider" class="tier-slider"
             min="0" max="100" step="0.5" value="${esc(sliderPos)}"
             aria-label="响应概率滑条" />
      <div class="tier-scale" id="tier-scale">
        <span class="tier-seg seg1${curSeg === 1 ? ' on' : ''}" data-seg="1" style="flex:12">0% · 只回 @/关键词</span>
        <span class="tier-seg seg2${curSeg === 2 ? ' on' : ''}" data-seg="2" style="flex:30">约 33%</span>
        <span class="tier-seg seg3${curSeg === 3 ? ' on' : ''}" data-seg="3" style="flex:30">约 66%</span>
        <span class="tier-seg seg4${curSeg === 4 ? ' on' : ''}" data-seg="4" style="flex:28">100% · 全响应</span>
      </div>
    </div>

    <div class="hint" id="ctx-tier-note" style="margin-top:8px">${sliderDesc(sliderPos)}</div>
    </div>

    <!-- 分群模式：下拉选群，各拖各的。滑条实时值是 DOM，切换群时先收进隐藏 JSON 再换 -->
    <div id="tier-pergroup-wrap"${st.unifiedTier === false ? '' : ' style="display:none"'}>
      <div class="field"><label>选择要单独设置的群聊（来自白名单）</label>
        <select id="tier-group-select"></select>
      </div>
      <input type="hidden" id="tier-group-json" value="${esc(JSON.stringify(groupSliderPosForUi(st)))}" />
      <div class="tier-slider-wrap">
        <input type="range" id="ctx-tier-slider-g" class="tier-slider"
               min="0" max="100" step="0.5" value="${esc(sliderPos)}"
               aria-label="该群响应概率滑条" />
        <div class="tier-scale" id="tier-scale-g">
          <span class="tier-seg seg1" data-seg="1" style="flex:12">0% · 只回 @/关键词</span>
          <span class="tier-seg seg2" data-seg="2" style="flex:30">约 33%</span>
          <span class="tier-seg seg3" data-seg="3" style="flex:30">约 66%</span>
          <span class="tier-seg seg4" data-seg="4" style="flex:28">100% · 全响应</span>
        </div>
      </div>
      <div class="hint" id="ctx-tier-note-g" style="margin-top:8px"></div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button class="btn btn-small btn-danger" id="tier-group-clear-btn">清除该群的单独设置</button>
        <span class="hint" style="margin:0">没单独设置过的群聊和所有私聊，跟随上方统一滑条的概率。</span>
      </div>
    </div>

    <div class="tier-params">
      <div class="hint" style="margin:0 0 8px">
        「已读」= 已经被处理过的历史消息（机器人看过、回过，或当时决定不回的）。每次响应发给模型的是
        「这次要处理的新消息（未读）」+ 最近这么多条历史（已读），好让它知道前面在聊什么；
        条数越大上下文越全，每轮的提示词花费也越高。
      </div>
      <div class="tier-param${paramOn.at ? '' : ' dim'}">
        <label>① 被艾特时：发未读 + <input type="number" id="cfg-atcount" min="0" max="500" value="${esc(st.atCount ?? 20)}" /> 条已读</label>
        <div class="hint">有人 @ 机器人时<b>一定响应</b>，不受上面概率的影响。</div>
      </div>
      <div class="tier-param${paramOn.keyword ? '' : ' dim'}">
        <label>② 命中关键词时：发未读 + <input type="number" id="cfg-kwcount" min="0" max="500" value="${esc(st.keywordCount ?? 15)}" /> 条已读</label>
        <div class="hint">关键词（每行一个，不区分大小写）；命中<b>一定响应</b>。留空就只回 @：</div>
        <textarea id="cfg-keywords" rows="3" placeholder="小鲸鱼&#10;bot">${esc((st.keywords || []).join('\n'))}</textarea>
      </div>
      <div class="tier-param${paramOn.random ? '' : ' dim'}">
        <label>③ 按概率响应时：发未读 + <input type="number" id="cfg-randcount" min="0" max="500" value="${esc(st.randomCount ?? 8)}" /> 条已读</label>
        <div class="hint">概率在 0 和 100 之间时，普通消息按这个概率接。</div>
      </div>
      <div class="tier-param${paramOn.all ? '' : ' dim'}">
        <label>④ 全响应时：发未读 + <input type="number" id="cfg-allcount" min="0" max="500" value="${esc(st.allCount ?? 80)}" /> 条已读</label>
        <div class="hint">滑条拖到 <b>100%</b> 时，任何消息都响应。</div>
      </div>
    </div>

    <h3>存储与清理</h3>
    <div class="field-row">
      <div class="field"><label>聊天消息保留天数（0 = 不清理）</label>
        <input type="number" id="cfg-message-retention" min="0" max="3650" value="${esc(st.messageRetentionDays ?? 7)}" /></div>
      <div class="field"><label>会话日志保留天数（0 = 不清理）</label>
        <input type="number" id="cfg-session-retention" min="0" max="3650" value="${esc(st.sessionRetentionDays ?? 7)}" /></div>
      <div class="field"><label>运行中会话落盘间隔（毫秒）</label>
        <input type="number" id="cfg-session-persist-ms" min="2000" max="60000" step="1000" value="${esc(st.sessionPersistIntervalMs ?? 10000)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>SQLite 同步级别</label>
        <select id="cfg-sqlite-synchronous">
          <option value="NORMAL" ${String(st.sqliteSynchronous || 'NORMAL').toUpperCase() !== 'FULL' ? 'selected' : ''}>NORMAL（推荐，低 IOPS）</option>
          <option value="FULL" ${String(st.sqliteSynchronous || '').toUpperCase() === 'FULL' ? 'selected' : ''}>FULL（更严格的掉电持久化）</option>
        </select>
        <div class="hint">NORMAL 在 WAL 下仍能扛进程崩溃，但断电时可能丢最后几个事务；改成 FULL 会增加云盘 fsync/IOPS。</div>
      </div>
    </div>
    <div class="hint">每天清理一次：只删除已处理/失败的消息和已关闭线程的旧 transcript；未处理消息不会删。默认保留 7 天，0 = 不按时间删除。</div>

    <h3>屏蔽名单</h3>
    <div class="field">
      <button class="btn btn-small" id="blocklist-btn">管理屏蔽名单</button>
      <div class="hint" style="margin-top:6px">被屏蔽群员的消息不会存档、不会触发回复，也不会作为聊天背景发给模型。机器人自己的发言不受影响。</div>
    </div>`;
}

// 由 ui/core/widgets.js 机械拆出（2026-10-01，同一次「UI 结构治理」：把混装的叶子按域归位）。
// 从 app.js 机械切出（只切不改，语句逐字节一致）；跨文件引用走 import，可变状态挂 state。

// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
    // 存档页不再自动重拉消息：消息只在 selectChat() / 手动刷新 / 操作后加载。
    // 旧行为会随 chat-update 每条消息触发一次整段历史重拉，活跃群等于持续全库扫描
    //（2026-10-29 磁盘风暴：vda 143MB/s、97% util 持续到重启）。
  } catch (e) { if (!quiet) console.error(e); }
}

function chatControlIcon(chat) {
  const mode = chat.incidentControl?.mode || 'auto';
  if (mode === 'blocked') return { icon: '■', label: '会话已阻塞' };
  if (mode === 'continue') return { icon: '▶', label: '会话强制继续' };
  if (chat.incidentDecision?.effectiveState === 'degraded') {
    return { icon: '!', label: '会话降级运行' };
  }
  return { icon: '◉', label: '会话自动处理' };
}

async function openChatRuntimeControl(chatKey) {
  const data = await api(`/api/chats/${chatKey.replace(':', '_')}/runtime-control`);
  const control = data.control || { mode: 'auto', reason: '', version: 0 };
  const overlay = modelModalShell({
    head: `会话运行控制 · ${formatChatTitle(chatKey, chatNameOf(chatKey))}`,
    body: `
      <div class="field"><label>运行模式</label>
        <select id="chat-runtime-mode">
          <option value="auto" ${control.mode === 'auto' ? 'selected' : ''}>自动处理（推荐）</option>
          <option value="blocked" ${control.mode === 'blocked' ? 'selected' : ''}>阻塞会话</option>
          <option value="continue" ${control.mode === 'continue' ? 'selected' : ''}>继续处理新消息</option>
        </select></div>
      <div class="field"><label>原因</label><input type="text" id="chat-runtime-reason" value="${esc(control.reason || '')}" placeholder="可选，记录人工操作原因" /></div>
      <div class="field"><label>积压消息</label>
        <select id="chat-runtime-backlog">
          <option value="keep">保留未读，暂不唤醒</option>
          <option value="recent">仅处理最近一批</option>
          <option value="discard">从下一条新消息开始</option>
        </select></div>
      <div class="hint">当前未读 ${fmtTok(data.unread)} 条，待核对写入 ${fmtTok(data.held)} 条。继续模式不会重试未知旧写入，也不能绕过全局观察、白名单或时间控制。</div>`,
    foot: '<button type="button" class="btn" data-control-cancel>取消</button>'
      + '<button type="button" class="btn btn-primary" data-control-save>保存</button>'
  });
  overlay.querySelector('[data-control-cancel]').addEventListener('click', () =>
    closeModelModal(overlay));
  overlay.querySelector('[data-control-save]').addEventListener('click', async () => {
    const mode = overlay.querySelector('#chat-runtime-mode').value;
    const button = overlay.querySelector('[data-control-save]');
    button.disabled = true;
    try {
      await api(`/api/chats/${chatKey.replace(':', '_')}/runtime-control`, {
        method: 'PUT',
        body: JSON.stringify({
          mode,
          reason: overlay.querySelector('#chat-runtime-reason').value.trim(),
          backlogAction: overlay.querySelector('#chat-runtime-backlog').value,
          expectedVersion: control.version,
          confirm: mode === 'continue'
        })
      });
      closeModelModal(overlay);
      await loadChats();
    } catch (error) {
      button.disabled = false;
      alert(error.message);
    }
  });
}

async function openUnknownOperations(chatKey) {
  const data = await api(`/api/chats/${chatKey.replace(':', '_')}/unknown-operations`);
  const operations = data.operations || [];
  const overlay = modelModalShell({
    head: `核对未知写入 · ${formatChatTitle(chatKey, chatNameOf(chatKey))}`,
    body: operations.length
      ? `<div class="control-key-list">${operations.map((operation) => `
          <div class="control-key-row">
            <span><strong>${esc(operation.payload?.type || '外部操作')}</strong>
              <small>${esc(JSON.stringify(operation.payload || {}).slice(0, 180))}</small>
              <small>${esc(operation.error || '结果未知')}</small></span>
            <span class="settings-actions" style="margin:0">
              <button type="button" class="btn btn-small" data-unknown-result="sent" data-operation-id="${esc(operation.id)}">确认已发送</button>
              <button type="button" class="btn btn-small" data-unknown-result="failed" data-operation-id="${esc(operation.id)}">确认未发送</button>
            </span>
          </div>`).join('')}</div>`
      : '<div class="empty-hint">没有待核对的外部写入</div>',
    foot: '<button type="button" class="btn" data-unknown-close>关闭</button>'
  });
  overlay.querySelector('[data-unknown-close]').addEventListener('click', () =>
    closeModelModal(overlay));
  overlay.querySelectorAll('[data-unknown-result]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const sent = button.dataset.unknownResult === 'sent';
        if (!await askForConfirmation(sent
          ? '确认已在 QQ 中看到这次操作成功？不会再次发送。'
          : '确认这次操作未成功？系统也不会自动重试。')) return;
        button.disabled = true;
        await api(
          `/api/chats/${chatKey.replace(':', '_')}/unknown-operations/${encodeURIComponent(button.dataset.operationId)}/reconcile`,
          {
            method: 'POST',
            body: JSON.stringify({
              result: button.dataset.unknownResult,
              confirm: true
            })
          }
        );
        closeModelModal(overlay);
        await loadChats();
      } catch (error) {
        // 失败时保留弹窗（用户可以再试或关掉），并给出明确反馈
        button.disabled = false;
        alert(`核对写入失败：${error.message}`);
      }
    });
  });
}

function renderChatList() {
  const box = $('#chat-items');
  state.seenChatKeys = state.seenChatKeys || new Set();
  // 存档筛选（关键字 + 类型，纯前端过滤）；控件是 index.html 里的静态元素，绑一次即可
  if (!box.__archiveFilterBound) {
    box.__archiveFilterBound = true;
    $('#archive-search')?.addEventListener('input', () => renderChatList());
    $('#archive-filter-type')?.addEventListener('change', () => renderChatList());
    // 存档页只在用户点"刷新"时重新读取；不再跟随消息流自动刷新。
    $('#archive-refresh')?.addEventListener('click', async () => {
      await loadChats();
      if (state.currentChatKey) await loadChatMessages(state.currentChatKey);
    });
  }
  const q = String($('#archive-search')?.value || '').trim().toLowerCase();
  const ftype = String($('#archive-filter-type')?.value || 'all');
  let visibleChats = state.chats;
  if (q) visibleChats = visibleChats.filter((c) => `${formatChatTitle(c.key, chatNameOf(c.key))} ${c.lastText || ''}`.toLowerCase().includes(q));
  if (ftype === 'group' || ftype === 'private') visibleChats = visibleChats.filter((c) => c.key.startsWith(`${ftype}:`));
  else if (ftype === 'failed') visibleChats = visibleChats.filter((c) => (c.failed || 0) > 0);
  else if (ftype === 'held') visibleChats = visibleChats.filter((c) => (c.held || 0) > 0);
  const chatRows = visibleChats.map((c) => {
    const name = formatChatTitle(c.key, chatNameOf(c.key));
    const isNew = !state.seenChatKeys.has(c.key);
    const mode = conversationModeForChat(c.key);
    let threadLabel = '';
    if (mode === 'threaded' && Number(c.thread?.engagedUntil) > Date.now()) {
      threadLabel = '续接中';
    } else if (mode === 'lifecycle' && c.thread?.state === 'active') {
      threadLabel = '生命周期 · 活跃';
    } else if (mode === 'lifecycle' && c.thread?.state === 'listening') {
      threadLabel = '生命周期 · 监听';
    } else if (mode === 'lifecycle' && c.thread?.state === 'rollover_armed') {
      threadLabel = '等待续接';
    }
    const incidentControl = chatControlIcon(c);
    const showIncidentControl = c.key.startsWith('group:')
      && state.config?.incidentPilot?.enabled === true;
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''} ${c.unread ? 'unread-row' : ''} ${isNew ? 'new-item' : ''}" data-key="${esc(c.key)}" role="button" tabindex="0">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${c.timeControl?.enabled ? `<span class="thread-pill">${c.timeControl.active ? '活跃时段' : '仅记录'}</span>` : ''}
          ${threadLabel ? `<span class="thread-pill mode-${mode}">${threadLabel}</span>` : ''}
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
          ${showIncidentControl ? `<button type="button" class="icon-btn chat-runtime-control" data-chat-runtime="${esc(c.key)}" title="${esc(incidentControl.label)}" aria-label="${esc(incidentControl.label)}">${incidentControl.icon}</button>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条 · 失败 ${c.failed || 0} · 待确认 ${c.held || 0}${c.thread ? ` · 线程 v${c.thread.version}` : ''}</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).map((html, index) => ({ key: String(visibleChats[index].key), html }));
  // 空状态也必须作为"带 key 的行"交给 patchKeyedList：这层提示没有 data-key，直接写
  // box.innerHTML 的话既不进 existing、也永远不会被删，列表重新有内容时会沉到最底部一直留着
  // （新行走 insertBefore(node, firstChild) 插到它前面；2026-10-01 审查）。
  const rows = visibleChats.length
    ? chatRows
    : [{ key: '__empty__', html: `<div class="list-head muted">${state.chats.length ? '没有匹配筛选条件的会话' : '还没有消息存档（等白名单里的群/好友来消息）'}</div>` }];
  // exit: true —— 行被筛掉/归档时先塔缩再移除（见 ui/core/dom-util.js 与 style.css 的 rowOut）
  patchKeyedList(box, rows, 'data-key', { exit: true });
  for (const c of state.chats) state.seenChatKeys.add(c.key);
  $$('.chat-item', box).forEach((el) => {
    if (el.__bound) return;      // 增量更新会保留旧行，别重复绑定
    el.__bound = true;
    el.addEventListener('click', () => selectChat(el.dataset.key));
    // 键盘也要能进会话：存档列表原来是纯 div（无 role/tabindex），Tab 直接跳过整列 ——
    // 只能点鼠标才打得开（2026-10-08 审查）。与「会话」列表同样的 Enter/Space 口径。
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      selectChat(el.dataset.key);
    });
  });
  $$('[data-chat-runtime]', box).forEach((button) => {
    if (button.__bound) return;
    button.__bound = true;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openChatRuntimeControl(button.dataset.chatRuntime).catch((error) => alert(error.message));
    });
  });
}

async function selectChat(key) {
  state.currentChatKey = key;
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

/**
 * 拉取并渲染某会话的存档消息。
 *
 * @param {string} key
 * @param {boolean} keepView  true = 保留当前分页与滚动位置（标记已读等操作后刷新用）；
 *                            false = 重置为第一页并重建结构（切换会话/手动刷新用）。
 *
 * ⚠️ 这个参数是修"滚动被冲掉"的关键：
 *    操作后刷新如果走"重置分页 + 重建 DOM"，用户滚出来的内容会瞬间刷回第一页，
 *    滚动位置也回到顶部 —— 表现为"明明滚下去了，过一会儿自己弹回上面"。
 */
async function loadChatMessages(key, { keepView = false } = {}) {
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=${CHAT_MSG_PAGE}`);
    // 期间用户可能切走了会话，那就别覆盖当前视图
    if (state.currentChatKey !== key) return;
    state.chatMessages = data.messages || [];

    if (keepView && (state.chatMsgLimit || 0) > 0 && $('#chat-msg-body')) {
      // 只更新表格内容：分页不变、滚动位置不变
      updateChatMessagesBody(true);
    } else {
      // 切换会话：重置分页并从第一页开始
      state.chatMsgLimit = CHAT_MSG_PAGE;
      renderChatMessages();
    }
  } catch (e) {
    if (state.currentChatKey !== key) return;
    const box = $('#chat-detail');
    if (box) box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 存档消息列表：首次建结构 + 填充内容。
 *
 * ⚠️ 关键：这个只在"切换会话 / 首次打开"时调用，负责建出完整骨架并绑定工具栏事件。
 *    滚动加载更多时走 updateChatMessagesBody() —— 只替换 tbody 与底部文案，
 *    不碰外层结构。
 *
 *    曾经每次加载更多都走整个函数（innerHTML 全量重建），后果有两个：
 *      1. 浏览器丢失 scrollTop → 表现为"明明在往下滚，却自己弹回上面"
 *      2. 工具栏事件被反复绑定 → 点一次发好几条
 */
function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const detail = $('#chat-detail');
  if (!detail) return;

  // 切换会话时重置分页（每个会话独立从第一页开始）
  state.chatMsgLimit = CHAT_MSG_PAGE;

  const name = formatChatTitle(key, chatNameOf(key));
  const meta = state.chats.find((c) => c.key === key) || {};
  const threadStatus = meta.thread
    ? `${meta.thread.mode} · ${meta.thread.state} · v${meta.thread.version}`
    : '无活动线程';

  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub"><span data-field="chat-msg-count"></span><span>${esc(threadStatus)}</span></div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">主动唤醒</button>
      ${key.startsWith('group:') && state.config?.incidentPilot?.enabled === true
        ? `<button type="button" class="icon-btn" id="chat-runtime-control" title="更改会话运行模式" aria-label="更改会话运行模式">${chatControlIcon(meta).icon}</button>`
        : ''}
      <span class="muted chat-action-result" id="chat-wake-result" role="status"></span>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <button class="btn btn-small" id="chat-retry-btn">重试失败批次</button>
      <button class="btn btn-small" id="chat-resolve-btn">核对未知写入</button>
      <button class="btn btn-small" id="chat-thread-close-btn" ${meta.thread ? '' : 'disabled'}>结束对话线程</button>
      <button class="btn btn-small btn-danger" id="chat-clear-btn">清空本会话存档</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <table class="archive-table"><tbody id="chat-msg-body"></tbody></table>
    <div class="list-more muted" id="chat-msg-more"></div>`;

  // 工具栏事件：只在这里绑一次
  $('#chat-wake-btn').addEventListener('click', async () => {
    const button = $('#chat-wake-btn');
    const result = $('#chat-wake-result');
    button.disabled = true;
    result.textContent = '正在唤醒…';
    try {
      const response = await api(`/api/chats/${key.replace(':', '_')}/wake`, {
        method: 'POST',
        body: '{}'
      });
      result.textContent = response.mode === 'unread'
        ? '已开始处理未读消息'
        : '已基于最近存档开始思考';
      await refreshStatus();
    } catch (error) {
      result.textContent = `唤醒失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  $('#chat-runtime-control')?.addEventListener('click', () =>
    openChatRuntimeControl(key).catch((error) => alert(error.message)));
  $('#chat-read-btn').addEventListener('click', async () => {
    try {
      await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
      loadChats();
      // 保持视图：用户可能已经滚到中间了，别把他弹回顶部
      loadChatMessages(key, { keepView: true });
    } catch (error) {
      alert(`标记已读失败：${error.message}`);
    }
  });
  $('#chat-retry-btn')?.addEventListener('click', async () => {
    try {
      if (!await askForConfirmation('重新处理确定未发送成功的失败批次？')) return;
      await api(`/api/chats/${key.replace(':', '_')}/retry-failed`, { method: 'POST', body: '{"confirm":true}' });
      loadChats();
    } catch (error) {
      alert(`重试失败：${error.message}`);
    }
  });
  $('#chat-resolve-btn')?.addEventListener('click', async () => {
    try {
      if (state.config?.incidentPilot?.enabled === true) {
        await openUnknownOperations(key);
        return;
      }
      if (!await askForConfirmation('已核对 QQ 中的实际发送结果？确认后将结束待确认批次，不会重发。')) return;
      await api(`/api/chats/${key.replace(':', '_')}/resolve-held`, {
        method: 'POST', body: '{"confirm":true}'
      });
      loadChats();
    } catch (error) {
      alert(`核对失败：${error.message}`);
    }
  });
  $('#chat-thread-close-btn')?.addEventListener('click', async () => {
    try {
      if (!await askForConfirmation('结束当前对话线程？后续普通消息将重新遵循响应档位。')) return;
      await api(`/api/chats/${key.replace(':', '_')}/thread`, { method: 'DELETE', body: '{}' });
      await loadChats();
    } catch (error) {
      alert(`结束线程失败：${error.message}`);
    }
  });
  $('#chat-clear-btn')?.addEventListener('click', async () => {
    const button = document.getElementById('chat-clear-btn');
    const result = document.getElementById('chat-wake-result');
    if (!await askForConfirmation(
      `清空「${formatChatTitle(key, chatNameOf(key))}」的存档？\n\n`
      + '· 删除这个会话的聊天消息、对话线程与检查点\n'
      + '· 同时清除该会话的交接\n'
      + '· 不影响其它会话、群友长期印象、备注与配置\n'
      + '· 删除后不可恢复（建议先备份 data/messages.sqlite）'
    )) return;
    button.disabled = true;
    if (result) result.textContent = '正在清空…';
    try {
      const cleared = await api(`/api/chats/${key.replace(':', '_')}/messages`, {
        method: 'DELETE', body: JSON.stringify({ confirm: true })
      });
      if (result) {
        result.textContent = `已清空：消息 ${cleared.messages || 0} 条、线程 ${cleared.threads || 0} 个，交接已清除`;
      }
      await loadChats();
      await loadChatMessages(key);
    } catch (error) {
      if (result) result.textContent = `清空失败：${error.message}`;
      else alert(`清空失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    try {
      await api(`/api/chats/${key.replace(':', '_')}/test-send`, {
        method: 'POST', body: JSON.stringify({ text })
      });
      input.value = '';
      // 同理，保持当前分页与滚动位置
      loadChatMessages(key, { keepView: true });
    } catch (error) {
      alert(`发送失败：${error.message}`);
    }
  });

  updateChatMessagesBody();
  // 滚动加载只挂一次（attachScrollLoader 内部有防重复）
  initChatScrollLoader();
}

function chatMessagesNewestFirst() {
  const src = state.chatMessages || [];
  if (state.chatMsgSortCache.src !== src) {
    const sorted = src.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    sorted.reverse();
    state.chatMsgSortCache = { src, newestFirst: sorted };
  }
  return state.chatMsgSortCache.newestFirst;
}

/** 单行消息 HTML（全量渲染与滚动追加共用同一个模板，保证两处长得一样）。 */
function chatMsgRowHtml(m) {
  return `
    <tr class="${m.read ? '' : 'unread'}">
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
    </tr>`;
}

/** 更新底部"还有 N 条"与顶部计数文案（全量渲染与追加都要刷这两处）。 */
function updateChatMessagesMeta(newestFirst) {
  const total = newestFirst.length;
  const meta = state.chats.find((c) => c.key === state.currentChatKey) || {};
  const archiveTotal = Number(meta.total) || total;
  const shownCount = Math.min(Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE), total);
  const rest = total - shownCount;
  const more = $('#chat-msg-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更早的（还有 ${rest} 条）`
      : (archiveTotal > shownCount
          // 单次只拉 CHAT_MSG_PAGE 条：存档里还有更早的，但当前不再自动加载
          ? `仅显示最近 ${shownCount} 条（存档共 ${archiveTotal} 条）`
          : (total > CHAT_MSG_PAGE ? `已显示全部 ${total} 条` : ''));
  }
  const cnt = $('#chat-detail')?.querySelector('[data-field="chat-msg-count"]');
  if (cnt) {
    cnt.textContent = archiveTotal
      ? `共 ${archiveTotal} 条 · 已显示 ${shownCount} 条 · 存储于 data/messages/`
      : '暂无消息';
  }
}

/**
 * 滚动加载更多的追加路径：只把新批次的行插到 tbody 末尾。
 * 不重排（走缓存）、不重建已有行、不碰滚动位置 —— 内容加在视口下方，
 * 浏览器天然保持视口稳定，所以这里**绝对不能**做 scrollTop 补偿。
 */
function appendChatMessageRows(prevShown) {
  const tbody = $('#chat-msg-body');
  if (!tbody) return;
  const newestFirst = chatMessagesNewestFirst();
  const limit = Math.min(state.chatMsgLimit, newestFirst.length);
  const rows = newestFirst.slice(prevShown, limit);
  if (rows.length) tbody.insertAdjacentHTML('beforeend', rows.map(chatMsgRowHtml).join(''));
  state.chatMsgRendered = limit;
  updateChatMessagesMeta(newestFirst);
}

/**
 * 只更新消息表格的内容（不重建外层结构）。
 * 轮询刷新与首次填充走这里 —— 表格内容变长，但滚动容器没动，
 * 所以用户的滚动位置天然保持，不会再"自己弹回上面"。
 *
 * @param {boolean} keepScroll 轮询路径传 true：新消息从**顶部**进来，
 *        内容高度变化会把视口顶走，按增量补偿回阅读位置。
 *        （滚动加载更多不走这里，走 appendChatMessageRows —— 底部追加不需要补偿）
 */
function updateChatMessagesBody(keepScroll = false) {
  const detail = $('#chat-detail');
  const tbody = $('#chat-msg-body');
  if (!detail || !tbody) return;

  const prevTop = keepScroll ? detail.scrollTop : 0;
  const prevHeight = keepScroll ? detail.scrollHeight : 0;

  // 倒序后取前 N 条 = 最新的 N 条（排序结果走引用缓存，数据没变不重排）
  const newestFirst = chatMessagesNewestFirst();
  state.chatMsgLimit = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
  const shown = newestFirst.slice(0, state.chatMsgLimit);

  tbody.innerHTML = shown.map(chatMsgRowHtml).join('');
  state.chatMsgRendered = shown.length;   // 行数账本：滚动追加靠它判断该不该走增量
  updateChatMessagesMeta(newestFirst);

  // 保险：若内容高度变了导致视口跳动，按增量补偿回来
  if (keepScroll) {
    const delta = detail.scrollHeight - prevHeight;
    if (delta !== 0) detail.scrollTop = prevTop + delta;
  }
}

function conversationModeForChat(chatKey, cfg = state.config) {
  const conversation = cfg?.conversation || {};
  if (conversation.unifiedMode !== false) return conversation.mode || 'legacy';
  const match = /^group:(\d+)$/.exec(String(chatKey || ''));
  return match && conversation.groupModes?.[match[1]]
    ? conversation.groupModes[match[1]]
    : (conversation.mode || 'legacy');
}


export { appendChatMessageRows, loadChats, renderChatSection, updateChatMessagesBody };