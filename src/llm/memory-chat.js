// 每日长期记忆的模型调用收口。与聊天主路径分开：后台任务、固定低温、可注入 overrides。
import { chatCompletionWithRetry } from './llm.js';

function contentText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

/**
 * 调用模型做一次记忆抽取。
 * @returns {{text:string, usage:object, model:string}}
 */
export async function completeMemoryExtraction({
  messages, signal = null, overrides = null, temperature = 0.2
} = {}) {
  const response = await chatCompletionWithRetry({
    messages,
    temperature,
    purpose: 'judge',
    ignoreTimeControl: true,
    signal,
    overrides
  }, 1);
  return {
    text: contentText(response?.message?.content),
    usage: response?.usage || {},
    model: String(response?.model || '')
  };
}
