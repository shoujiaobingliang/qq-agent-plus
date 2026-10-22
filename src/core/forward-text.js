// 合并转发 / 聊天记录卡片的形态判定与展示遮罩。
//
// 为什么单独成一个零依赖模块：prompt.js（历史渲染、触发判定）和 tools-core.js（翻历史、
// 单条详情）都要按同一套口径判断"这是不是转发"，两边各写一份迟早会漂移。
//
// messageTypes.expandForward=false 时：
//   · 入站不自动展开（console/app.js）；
//   · read_forward 工具被摘掉、执行层也拒绝（orchestrator.js / tools-core.js）；
//   · 纯转发消息不参与概率/关键词/注意力触发（prompt.js 的 resolveContextTier）；
//   · 历史里**已经展开过**的转发也遮成占位符，不再跟着每一轮上下文进模型。
//
// 判定优先用入库时打的 forward 标记；老库存没有这个字段时按正文形态兜底。
// 只看开头：引用块里转述的转发（[引用#…：…]）不算"这条消息本身是转发"。

import { formatQuoteRef, textWithQuote } from './util.js';

export const FORWARD_MUTED_TEXT = '[合并转发聊天记录（转发内容查看已关闭）]';

export function isForwardEntry(entry) {
  if (entry?.forward === true) return true;
  const text = String(entry?.text ?? '');
  return /^\[(?:合并转发 共\d+条|合并转发聊天记录|转发消息 [^\]]*|卡片聊天记录[^\]]*)\]/.test(text);
}

/**
 * 给模型看的正文（含引用块）。
 * forwardMuted=true 时：转发正文整段遮掉；引用的是转发时保留引用结构、只遮被引用的正文，
 * 避免"已经展开过的旧转发"借历史/工具出口继续把内容送进上下文。
 */
export function forwardAwareText(entry, { forwardMuted = false } = {}) {
  if (!forwardMuted) return textWithQuote(entry);
  if (isForwardEntry(entry)) return FORWARD_MUTED_TEXT;
  if (isForwardEntry({ text: entry?.reply?.text })) {
    const text = String(entry?.text ?? '');
    const original = formatQuoteRef(entry.reply);
    // 引用块在 ingest 时就写进了正文：只把被引用的转发正文换成遮罩，保留 id/说话人。
    // 老库存的引用块形态对不上时（没有 #id），宁可整条遮掉，也不漏那 120 字预览。
    if (original && text.startsWith(original)) {
      return `${formatQuoteRef({ ...entry.reply, text: FORWARD_MUTED_TEXT })}${text.slice(original.length)}`;
    }
    return FORWARD_MUTED_TEXT;
  }
  return textWithQuote(entry);
}
