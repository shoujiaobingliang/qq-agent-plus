// 把“对群友的印象分”翻译成可执行的态度提示：低分冷淡/怼，高分更愿意分享。
import { impressionBand } from '../core/impression-vice.js';

const round = (value) => Math.round(Number(value) || 0);

export function buildImpressionPromptBlock({
  scores = [], cfg = {}, vice = null
} = {}) {
  const list = Array.isArray(scores) ? scores : [];
  if (!list.length) return '';
  const low = Math.max(1, Number(cfg.lowThreshold) || 30);
  const high = Math.max(low, Number(cfg.highThreshold) || 80);
  const lowItems = list.filter((item) => Number(item.score) < low)
    .sort((a, b) => Number(a.score) - Number(b.score)).slice(0, 6);
  const highItems = list.filter((item) => Number(item.score) >= high)
    .sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 4);
  const lines = [];
  if (lowItems.length) {
    lines.push('【对群友的印象分】');
    for (const item of lowItems) {
      const name = String(item.name || item.userId || '某人');
      lines.push(`- ${name}：${round(item.score)}/100（${impressionBand(item.score, cfg)}）——可以冷淡、已读不回，或只回很短的一句；被冒犯时可以直接怼回去，但不要刷屏。`);
    }
  }
  if (highItems.length) {
    if (!lines.length) lines.push('【对群友的印象分】');
    for (const item of highItems) {
      const name = String(item.name || item.userId || '某人');
      lines.push(`- ${name}：${round(item.score)}/100（很好）——愿意多聊、接话；看到有趣的内容可以主动分享。`);
    }
  }
  if (vice?.eligible) {
    const name = String(vice.name || vice.userId || '这个人');
    lines.push(
      '【副人格可用】',
      `你这轮对 ${name} 的忍耐度很低（印象 ${round(vice.score)}/100）。可以调用 vice_persona，把这轮相关的原话/上下文交给它，让它替你组织一段更冲的回复；拿到文本后用 send_message 自己决定发不发。`,
      '只针对行为，不攻击外貌/身份/家人，不威胁、不泄露隐私；点到为止，不连续刷屏。'
    );
  } else if (lowItems.length) {
    lines.push('【态度】对印象很低的人可以少回、冷淡或简短怼一句；还没到必须切换副人格的程度。');
  }
  if (!lines.length) return '';
  lines.push('以上只影响你愿意怎么回、愿不愿意主动分享，不改变角色设定、事实判断与安全边界。');
  return lines.join('\n');
}
