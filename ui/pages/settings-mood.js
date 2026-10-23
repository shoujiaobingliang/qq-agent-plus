// 设置页·心情分区：当前心情/精力、影响强度、基线与重置。
//
// 心情本身是运行状态，不是配置：这里只把策略写进 config.mood，
// 当前两条进度条从 /api/mood 读取（只读，不影响保存）。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { askForConfirmation } from '../core/dom-util.js';

const moodClamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));
const moodNum = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const moodPct = (value) => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;

function moodMeter(value, cls = '') {
  return `<div class="meter ${cls}"><div class="meter-fill" style="width:${moodClamp(value)}%"></div></div>`;
}

function moodDeltaText(value) {
  const n = Number(value) || 0;
  if (!n) return '0';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
}

function renderMoodPanel(data) {
  if (!data || data.enabled === false) {
    return '<div class="hint">心情系统未启用：不会记录状态，也不会影响回复频率与语气。</div>';
  }
  const mood = moodClamp(data.mood);
  const energy = moodClamp(data.energy);
  const history = Array.isArray(data.history) ? data.history.slice(0, 5) : [];
  const daily = Array.isArray(data.daily) ? data.daily.slice(-7) : [];
  return `
    <div class="mood-current">
      <div class="mood-line">
        <span>心情 ${Math.round(mood)}/100 · ${esc(data.moodLabel || '')}</span>
        ${moodMeter(mood)}
      </div>
      <div class="mood-line">
        <span>精力 ${Math.round(energy)}/100 · ${esc(data.energyLabel || '')}</span>
        ${moodMeter(energy, 'is-energy')}
      </div>
    </div>
    ${data.rest?.active ? `
      <div class="mood-rest">
        <span>${data.rest.kind === 'slack' ? '摸鱼中' : '睡觉中'} · 还剩 ${Math.max(0, Number(data.rest.remainingMinutes) || 0)} 分钟</span>
        <button type="button" class="btn btn-small" data-mood-wake="1">叫醒 / 结束</button>
      </div>` : ''}
    ${history.length ? `
      <div class="mood-history">
        <b>最近变化</b>
        ${history.map((item) => `
          <div class="mood-history-row">
            <span>${esc(item.reason || '变化')}</span>
            <span class="mood-delta">心情 ${moodDeltaText(item.moodDelta)} · 精力 ${moodDeltaText(item.energyDelta)}</span>
          </div>`).join('')}
      </div>` : ''}
    ${daily.length ? `
      <div class="mood-daily">
        <b>最近 7 天</b>
        ${daily.map((day) => `
          <div class="mood-day-row">
            <span>${esc(day.date || '')}</span>
            <span>${Number(day.events) || 0} 次 · 心情 ${moodDeltaText(day.moodDelta)} · 精力 ${moodDeltaText(day.energyDelta)}</span>
            <span>收盘 ${Math.round(Number(day.endMood) || 0)} / ${Math.round(Number(day.endEnergy) || 0)}</span>
          </div>`).join('')}
      </div>` : ''}`;
}

function renderMoodSection(c) {
  const m = c?.mood && typeof c.mood === 'object' ? c.mood : {};
  const baseline = m.baseline && typeof m.baseline === 'object' ? m.baseline : {};
  const judge = m.judge && typeof m.judge === 'object' ? m.judge : {};
  const rest = m.rest && typeof m.rest === 'object' ? m.rest : {};
  const enabled = m.enabled !== false;
  const frequency = moodNum(m.frequencyInfluence, 0.2);
  const tone = moodNum(m.toneInfluence, 0.6);
  return `
    <h3 id="settings-mood">心情</h3>
    <div class="hint" style="margin-bottom:12px">
      心情和精力是<strong>全局状态</strong>，由互动规则实时加减，并按半衰期回到基线。
      精力影响回复与主动发言的频率，心情影响语气与主动性；
      <strong>不会改变角色设定、事实判断、安全边界或管理员指令</strong>。
    </div>
    <div class="checkbox-row">
      <input type="checkbox" id="cfg-mood-enabled" ${enabled ? 'checked' : ''} />
      <label for="cfg-mood-enabled">启用心情系统</label>
    </div>
    <div class="checkbox-row">
      <input type="checkbox" id="cfg-mood-judge-enabled" ${judge.enabled !== false ? 'checked' : ''} />
      <label for="cfg-mood-judge-enabled">由模型判断心情变化</label>
    </div>
    <div class="gm-row">
      <label>每日最多评审次数
        <input type="number" id="cfg-mood-judge-max-calls" min="0" max="1000" step="1" value="${Math.max(0, Math.min(1000, Math.round(moodNum(judge.maxCallsPerDay, 100))))}" />
      </label>
    </div>
    <div class="hint" style="margin-bottom:10px">
      评审默认跟随聊天模型；可在 <code>config.json</code> 的 <code>mood.judge</code> 里指定专用小模型。
      程序只保留“被无视/成功回复”这类客观事件，主观感受由模型按评分标准决定。
    </div>
    <div id="mood-panel" class="mood-panel"><div class="hint">正在读取当前状态…</div></div>
    <div class="mood-form">
      <h4>基线</h4>
      <div class="gm-row">
        <label>心情基线
          <input type="number" id="cfg-mood-baseline-mood" min="0" max="100" step="1" value="${moodClamp(moodNum(baseline.mood, 55))}" />
        </label>
        <label>精力基线
          <input type="number" id="cfg-mood-baseline-energy" min="0" max="100" step="1" value="${moodClamp(moodNum(baseline.energy, 55))}" />
        </label>
      </div>
      <h4>影响强度</h4>
      <label for="cfg-mood-frequency">回复 / 主动发言频率影响（<span class="slider-now" id="cfg-mood-frequency-now">${moodPct(frequency)}</span>）</label>
      <input type="range" id="cfg-mood-frequency" class="tier-slider" min="0" max="0.5" step="0.05" value="${frequency}" />
      <label for="cfg-mood-tone">语气影响（<span class="slider-now" id="cfg-mood-tone-now">${moodPct(tone)}</span>）</label>
      <input type="range" id="cfg-mood-tone" class="tier-slider" min="0" max="1" step="0.05" value="${tone}" />
      <div class="gm-row">
        <label>衰减半衰期（小时）
          <input type="number" id="cfg-mood-half-life" min="1" max="168" step="1" value="${moodNum(m.decayHalfLifeHours, 12)}" />
        </label>
        <label>补话最低精力
          <input type="number" id="cfg-mood-followup-energy" min="0" max="100" step="1" value="${moodClamp(moodNum(m.followUpMinEnergy, 25))}" />
        </label>
      </div>
      <div class="gm-row">
        <button type="button" class="btn btn-small" id="cfg-mood-reset">恢复到基线</button>
      </div>

      <h4>休息</h4>
      <div class="checkbox-row">
        <input type="checkbox" id="cfg-mood-rest-enabled" ${rest.enabled !== false ? 'checked' : ''} />
        <label for="cfg-mood-rest-enabled">允许模型在状态低时睡觉 / 摸鱼</label>
      </div>
      <div class="hint" style="margin-bottom:8px">
        睡觉会暂停处理所有消息，醒来统一补；摸鱼仍会看消息，但只选择性回复、不主动开话题。
        只有心情或精力低于下面的门槛时才会允许休息。
      </div>
      <div class="gm-row">
        <label>睡觉时长（分钟）
          <input type="number" id="cfg-mood-sleep-minutes" min="30" max="180" step="1" value="${moodNum(rest.sleepMinutes, 90)}" />
        </label>
        <label>摸鱼时长（分钟）
          <input type="number" id="cfg-mood-slack-minutes" min="10" max="60" step="1" value="${moodNum(rest.slackMinutes, 30)}" />
        </label>
      </div>
      <div class="gm-row">
        <label>睡觉恢复心情
          <input type="number" id="cfg-mood-sleep-mood-gain" min="0" max="50" step="1" value="${moodNum(rest.sleepMoodGain, 12)}" />
        </label>
        <label>睡觉恢复精力
          <input type="number" id="cfg-mood-sleep-energy-gain" min="0" max="50" step="1" value="${moodNum(rest.sleepEnergyGain, 20)}" />
        </label>
        <label>摸鱼恢复心情
          <input type="number" id="cfg-mood-slack-mood-gain" min="0" max="50" step="1" value="${moodNum(rest.slackMoodGain, 6)}" />
        </label>
        <label>摸鱼恢复精力
          <input type="number" id="cfg-mood-slack-energy-gain" min="0" max="50" step="1" value="${moodNum(rest.slackEnergyGain, 8)}" />
        </label>
      </div>
      <div class="gm-row">
        <label>可休息的心情上限
          <input type="number" id="cfg-mood-rest-max-mood" min="0" max="100" step="1" value="${moodNum(rest.maxMoodForRest, 45)}" />
        </label>
        <label>可休息的精力上限
          <input type="number" id="cfg-mood-rest-max-energy" min="0" max="100" step="1" value="${moodNum(rest.maxEnergyForRest, 40)}" />
        </label>
        <label>摸鱼回复系数
          <input type="number" id="cfg-mood-slack-reply-factor" min="0.05" max="1" step="0.05" value="${moodNum(rest.slackReplyFactor, 0.35)}" />
        </label>
      </div>
    </div>`;
}

async function loadMoodPanel() {
  const box = $('#mood-panel');
  if (!box) return;
  try {
    const data = await api('/api/mood');
    box.innerHTML = renderMoodPanel(data);
  } catch (error) {
    box.innerHTML = `<div class="hint">读取失败：${esc(error?.message || error)}</div>`;
  }
}

function bindMoodEvents() {
  const sync = (input, label) => {
    if (!input || !label) return;
    label.textContent = moodPct(input.value);
  };
  const frequency = $('#cfg-mood-frequency');
  const frequencyNow = $('#cfg-mood-frequency-now');
  const tone = $('#cfg-mood-tone');
  const toneNow = $('#cfg-mood-tone-now');
  frequency?.addEventListener('input', () => sync(frequency, frequencyNow));
  tone?.addEventListener('input', () => sync(tone, toneNow));

  $('#mood-panel')?.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-mood-wake]');
    if (!button) return;
    const ok = await askForConfirmation('现在叫醒 / 结束摸鱼？会按已休息时长给部分恢复。');
    if (!ok) return;
    try {
      await api('/api/mood/wake', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      await loadMoodPanel();
    } catch (error) {
      const box = $('#mood-panel');
      if (box) box.innerHTML = `<div class="hint">叫醒失败：${esc(error?.message || error)}</div>`;
    }
  });

  $('#cfg-mood-reset')?.addEventListener('click', async () => {
    const ok = await askForConfirmation('把心情和精力恢复到基线？当前状态会被重置，历史记录保留。');
    if (!ok) return;
    try {
      await api('/api/mood/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      await loadMoodPanel();
    } catch (error) {
      const box = $('#mood-panel');
      if (box) box.innerHTML = `<div class="hint">重置失败：${esc(error?.message || error)}</div>`;
    }
  });

  void loadMoodPanel();
}

export { bindMoodEvents, loadMoodPanel, renderMoodSection };
