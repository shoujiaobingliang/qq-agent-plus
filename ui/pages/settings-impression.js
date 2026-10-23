// 设置页·印象分与副人格触发参数。副人格卡本身在「设置 → 人设」里配置。
import { esc } from '../core/dom.js';

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function renderImpressionSection(c) {
  const cfg = c?.impression && typeof c.impression === 'object' ? c.impression : {};
  const vice = cfg.vice && typeof cfg.vice === 'object' ? cfg.vice : {};
  const primarySet = Boolean(
    String(c?.persona?.roleText || '').trim()
    || String(c?.persona?.templateId || '').trim()
    || Object.values(c?.personaPerChat && typeof c.personaPerChat === 'object' ? c.personaPerChat : {})
      .some((item) => item && typeof item === 'object'
        && (String(item.roleText || '').trim() || String(item.templateId || '').trim()))
  );
  return `
    <h3 id="settings-impression">印象分与副人格</h3>
    <div class="hint" style="margin-bottom:12px">
      心情评审时会顺便判断“这个人让我舒服/不舒服”，按人写入人物记忆。
      印象分低会开始冷淡并降低回复概率；越低，嘴臭副人格出现的概率越高；单次大跌会进入短时爆点。
      高分群/高分对象会提高主动分享与开话题的概率。
    </div>
    <div class="checkbox-row">
      <input type="checkbox" id="cfg-imp-enabled" ${cfg.enabled !== false ? 'checked' : ''} />
      <label for="cfg-imp-enabled">启用印象分</label>
    </div>
    <div class="gm-row">
      <label>低印象阈值
        <input type="number" id="cfg-imp-low" min="1" max="100" step="1" value="${num(cfg.lowThreshold, 30)}" />
      </label>
      <label>高印象阈值
        <input type="number" id="cfg-imp-high" min="1" max="100" step="1" value="${num(cfg.highThreshold, 80)}" />
      </label>
      <label>衰减半衰期（天）
        <input type="number" id="cfg-imp-decay" min="1" max="60" step="1" value="${num(cfg.decayHalfLifeDays, 14)}" />
      </label>
    </div>
    <div class="gm-row">
      <label>低印象回复系数
        <input type="number" id="cfg-imp-low-reply" min="0.1" max="0.8" step="0.05" value="${num(cfg.lowReplyFactor, 0.4)}" />
      </label>
      <label>高分主动分享影响
        <input type="number" id="cfg-imp-share" min="0" max="0.5" step="0.05" value="${num(cfg.highShareInfluence, 0.25)}" />
      </label>
    </div>

    <h4>嘴臭副人格</h4>
    ${primarySet ? '' : '<div class="hint" style="color:var(--orange);margin-bottom:8px">先到「设置 → 人设」保存一张主人格卡，才能配置副人格。</div>'}
    <fieldset ${primarySet ? '' : 'disabled'} style="border:0;padding:0;margin:0;min-width:0">
    <div class="checkbox-row">
      <input type="checkbox" id="cfg-vice-enabled" ${vice.enabled !== false ? 'checked' : ''} />
      <label for="cfg-vice-enabled">允许低印象时调用副人格</label>
    </div>
    <div class="hint" style="margin-bottom:8px">副人格卡（默认 tieba，可编辑正文）在「设置 → 人设 → 副人格」里配置；这里只控制触发。</div>
    <div class="gm-row">
      <label>基础概率
        <input type="number" id="cfg-vice-base-chance" min="0" max="1" step="0.01" value="${num(vice.baseChance, 0.12)}" />
      </label>
      <label>最大概率
        <input type="number" id="cfg-vice-max-chance" min="0" max="1" step="0.01" value="${num(vice.maxChance, 0.7)}" />
      </label>
    </div>
    <div class="gm-row">
      <label>模型 Provider（留空跟随聊天）
        <input type="text" id="cfg-vice-provider" value="${esc(vice.provider || '')}" />
      </label>
      <label>模型名（留空跟随聊天）
        <input type="text" id="cfg-vice-model" value="${esc(vice.model || '')}" />
      </label>
    </div>
    <div class="gm-row">
      <label>单次大跌阈值（负数）
        <input type="number" id="cfg-vice-burst-delta" min="-10" max="0" step="1" value="${num(vice.burstDelta, -4)}" />
      </label>
      <label>大跌后分数上限
        <input type="number" id="cfg-vice-burst-below" min="0" max="100" step="1" value="${num(vice.burstBelow, 25)}" />
      </label>
      <label>冷却（分钟）
        <input type="number" id="cfg-vice-cooldown" min="1" max="1440" step="1" value="${num(vice.cooldownMinutes, 30)}" />
      </label>
    </div>
    <div class="gm-row">
      <label>最大上下文（字）
        <input type="number" id="cfg-vice-context" min="200" max="8000" step="100" value="${num(vice.maxContextChars, 2000)}" />
      </label>
      <label>保留历史条数
        <input type="number" id="cfg-vice-history" min="2" max="40" step="1" value="${num(vice.maxHistoryMessages, 12)}" />
      </label>
    </div>
    </fieldset>
    <div class="hint">
      副人格只负责生成文本，拿回后由主模型决定要不要发；它带有独立的安全边界：
      只怼行为、不攻击身份/家人、不威胁、不泄露隐私，点到为止。
    </div>`;
}

export { renderImpressionSection };
