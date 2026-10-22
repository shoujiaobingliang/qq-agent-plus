// 换人设后「屏蔽旧人设发言」的渲染口径。
//
// 背景：换卡不会删聊天记录，旧卡的语气/自称仍会以「我：…」的历史行进入提示词，
// 指令层面的“旧口癖不作数”压不过示例层面（实测换卡 26 小时后仍在用旧口癖）。
// 控制台提供手动按钮：把点击时刻记成每个会话的 cutoff，早于 cutoff 的机器人发言
// 在提示词、翻历史、单条详情里统一遮成占位符；群友的消息与消息 id 全部保留。
//
// 为什么是“遮”不是“删”：旧发言里可能有承诺/事实，删掉会丢上下文；遮掉的是
// 语气示例本身，消息行、时间、#id 仍在，引用/看图/翻页不受影响。

import { getConfig } from './config.js';
import { forwardAwareText } from './forward-text.js';
import { formatQuoteRef } from './util.js';

export const OLD_PERSONA_SPEECH_TEXT = '[换卡前的旧发言（口吻不作数）]';

/** 该会话的屏蔽时间线：按会话覆盖优先，否则用全局 cutoff；未设置/坏值返回 0（= 不遮）。 */
export function personaSpeechCutoff(chatKey, cfg = getConfig()) {
  const perChat = Number(cfg?.personaSpeechCutoffs?.[String(chatKey || '')]);
  if (Number.isFinite(perChat) && perChat > 0) return perChat;
  const global = Number(cfg?.personaSpeechCutoffAt);
  return Number.isFinite(global) && global > 0 ? global : 0;
}

/** 这条消息是不是“换卡前机器人自己说的话”。 */
export function isOldPersonaSpeech(entry, chatKey, cfg = getConfig()) {
  const cutoff = personaSpeechCutoff(chatKey, cfg);
  return cutoff > 0 && Boolean(entry?.self) && Number(entry?.ts) > 0 && Number(entry.ts) <= cutoff;
}

/** 引用对象是不是“换卡前的机器人发言”（新消息引用旧卡发言也算示例污染）。 */
export function isOldPersonaReply(reply, chatKey, cfg = getConfig()) {
  const cutoff = personaSpeechCutoff(chatKey, cfg);
  return cutoff > 0 && Boolean(reply?.self) && Number(reply?.ts) > 0 && Number(reply.ts) <= cutoff;
}

/**
 * 给模型看的正文（含引用块、合并转发遮罩）。
 * 优先级：旧人设发言 > 旧人设引用 > 合并转发开关。
 */
export function personaAwareText(entry, chatKey, { cfg = getConfig(), forwardMuted = false } = {}) {
  if (isOldPersonaSpeech(entry, chatKey, cfg)) return OLD_PERSONA_SPEECH_TEXT;
  if (isOldPersonaReply(entry?.reply, chatKey, cfg)) {
    const text = String(entry?.text ?? '');
    const original = formatQuoteRef(entry.reply);
    // 引用块在 ingest 时就写进了正文：先把它换成遮罩版，再把剩下的正文交给 forwardAwareText，
    // 避免“旧引用块 + 新遮罩前缀”叠成两份。
    if (original && text.startsWith(original)) {
      const maskedReply = { ...entry.reply, text: OLD_PERSONA_SPEECH_TEXT };
      return forwardAwareText({
        ...entry,
        reply: maskedReply,
        text: `${formatQuoteRef(maskedReply)}${text.slice(original.length)}`
      }, { forwardMuted });
    }
    return forwardAwareText({ ...entry, reply: { ...entry.reply, text: OLD_PERSONA_SPEECH_TEXT } }, { forwardMuted });
  }
  return forwardAwareText(entry, { forwardMuted });
}

/** 结构化 reply 字段的遮罩（工具返回 reply 原文时用）。 */
export function personaAwareReply(entry, chatKey, cfg = getConfig()) {
  const reply = entry?.reply;
  if (!reply) return reply;
  if (isOldPersonaReply(reply, chatKey, cfg)) return { ...reply, text: OLD_PERSONA_SPEECH_TEXT };
  return reply;
}

/** 不经过引用块补全的纯正文口径（少数只需要正文的调用方）。 */
export function personaAwareRawText(entry, chatKey, cfg = getConfig()) {
  if (isOldPersonaSpeech(entry, chatKey, cfg)) return OLD_PERSONA_SPEECH_TEXT;
  return String(entry?.text ?? '');
}
