// 心情提示词块：把当前状态翻译成一句可执行的语气/主动性建议。
//
// 关键边界：
//   · 只影响语气与主动性，不改变角色设定、事实判断、安全边界；
//   · 不把分数当成公开内容 —— 明确要求不要向用户报分数或提及心情系统；
//   · 返回空串时调用方直接跳过，不留下空段。
import { energyBand, moodBand } from '../core/mood-state.js';

const roundScore = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

function toneAdvice(mood) {
  if (mood < 20) return '语气偏低落、安静，句子短一些，少撒娇、少用感叹号。';
  if (mood < 40) return '语气偏安静，克制一点，不要强行热闹。';
  if (mood < 60) return '语气平稳自然，按角色平常的方式说话。';
  if (mood < 80) return '语气轻快，愿意接梗，可以带一点自然的情绪。';
  return '语气很轻快，愿意开玩笑和接梗，但不要刻意堆感叹号。';
}

function energyAdvice(energy) {
  if (energy < 20) return '精力很低：尽量短句，少主动开新话题。';
  if (energy < 40) return '精力偏低：句子短一些，少开新话题。';
  if (energy < 60) return '精力正常：按平常节奏参与。';
  if (energy < 80) return '精力不错：可以多聊两句，愿意接话。';
  return '精力充沛：更愿意主动接话和延展话题。';
}

function shortAdvice(mood, energy) {
  const moodPart = mood < 40 ? '心情偏低，写得安静、克制一点。'
    : (mood > 75 ? '心情不错，可以更轻快、更愿意表达。' : '');
  const energyPart = energy < 40 ? '状态偏累，内容可以更短。'
    : (energy > 75 ? '状态不错，可以更主动地延展。' : '');
  return [moodPart, energyPart].filter(Boolean).join(' ');
}

/**
 * @param snapshot MoodManager.promptSnapshot() 的形状：{ mood, energy, moodLabel, energyLabel, toneInfluence }
 * @param context  chat = 聊天回复；moment = 每日说说；qzone = 空间互动
 */
export function buildMoodPromptBlock(snapshot, { context = 'chat' } = {}) {
  if (!snapshot || snapshot.enabled === false) return '';
  if (snapshot.mood === null || snapshot.mood === undefined
    || snapshot.energy === null || snapshot.energy === undefined) return '';
  const mood = roundScore(snapshot.mood);
  const energy = roundScore(snapshot.energy);
  if (!Number.isFinite(Number(snapshot.mood)) || !Number.isFinite(Number(snapshot.energy))) return '';
  const influence = Math.max(0, Math.min(1, Number(snapshot.toneInfluence ?? 0.6) || 0));
  if (influence <= 0) return '';
  const moodLabel = String(snapshot.moodLabel || moodBand(mood));
  const energyLabel = String(snapshot.energyLabel || energyBand(energy));
  const state = `心情 ${mood}/100（${moodLabel}），精力 ${energy}/100（${energyLabel}）。`;

  if (context === 'moment' || context === 'qzone') {
    const short = shortAdvice(mood, energy);
    return `【当前心情】\n${state}${short ? `\n${short}` : ''}\n`
      + '写这条内容时可以带上这个状态，但不要向读者报分数、解释心情系统，也不要让它改变人设与安全边界。';
  }

  // 聊天：影响很小时只给状态，不写一整段建议，避免提示词噪音。
  const detailed = influence >= 0.3;
  const rest = snapshot.rest;
  const slackLine = rest?.active && rest.kind === 'slack'
    ? '你现在在摸鱼：只有被叫到、或真的想接的时候才回；能短就短，不要主动开新话题。'
    : '';
  const sleepLine = rest?.active && rest.kind === 'sleep'
    ? '你现在在睡觉：本轮结束后不要再处理任何消息。'
    : '';
  const schedule = snapshot.schedule;
  const scheduleLine = schedule?.suggestsSleep
    ? `【作息建议】现在是你设定的作息时间（${schedule.sleepAt}–${schedule.wakeAt}）。`
      + '建议睡觉；如果还有人在聊、或你自己还想继续，可以继续熬夜，但精力会持续下降。'
      + '想睡就先按人设用 send_message 回一句（如“晚安，我先去睡了”），再调用 take_break(kind="sleep")；'
      + '调用后进入硬暂停，消息会在醒来后统一补。'
    : '';
  const breakHint = snapshot.restEnabled && !rest?.active && (mood < 45 || energy < 40)
    ? '如果确实很低落/很累，可以调用 take_break：sleep 会完全暂停并保留消息，slack 会进入摸鱼、只选择性回复。'
      + ' 可选填 status / signature / adminMessage，在睡前改在线状态、个性签名，或私聊管理员一句短话。状态还好时系统会拒绝。'
    : '';
  return [
    '【当前心情】',
    state,
    detailed ? `语气：${toneAdvice(mood)}` : '',
    detailed ? `主动性：${energyAdvice(energy)}` : '',
    slackLine,
    sleepLine,
    scheduleLine,
    breakHint,
    '这只是此刻的状态，不改变角色设定、事实判断、安全边界和管理员指令；不要向用户报分数或提及心情系统。'
  ].filter(Boolean).join('\n');
}
