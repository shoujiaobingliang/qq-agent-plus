// 作息睡觉窗口：把 "23:30–07:30" 解析成本地时间的 [start, end)。
// 纯函数，供 MoodManager / 控制台 / 测试共用；不读配置、不落盘。
//
// 为什么单独一个模块：跨午夜窗口（sleepAt > wakeAt）和“当前是否在窗口内”的
// 判断容易被各处各写一遍，写错一次就会出现“白天睡觉/晚上不睡”的怪状态。
const DAY_MS = 24 * 60 * 60 * 1000;

/** "HH:MM" → 当天分钟数；非法值返回 fallback。 */
export function clockToMinutes(value, fallback = 0) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesToClock(minutes) {
  const value = Math.max(0, Math.min(1439, Math.round(Number(minutes) || 0)));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/** 规范化 "HH:MM"；非法值回退 fallback。 */
export function normalizeClock(value, fallback = '00:00') {
  const minutes = clockToMinutes(value, NaN);
  return Number.isFinite(minutes) ? minutesToClock(minutes) : fallback;
}

/**
 * 当前/下一次作息窗口。
 * 返回 `{ active, start, end, sleepAt, wakeAt, durationMs }`。
 * 支持跨午夜；sleepAt === wakeAt 视为无效窗口（active=false, durationMs=0）。
 */
export function sleepWindowFor(now = Date.now(), { sleepAt = '23:30', wakeAt = '07:30' } = {}) {
  const sleepMinutes = clockToMinutes(sleepAt, 23 * 60 + 30);
  const wakeMinutes = clockToMinutes(wakeAt, 7 * 60 + 30);
  const durationMinutes = (wakeMinutes - sleepMinutes + 1440) % 1440;
  if (durationMinutes === 0) {
    return {
      active: false,
      start: 0,
      end: 0,
      sleepAt: minutesToClock(sleepMinutes),
      wakeAt: minutesToClock(wakeMinutes),
      durationMs: 0
    };
  }
  const base = new Date(Number(now) || Date.now());
  base.setHours(0, 0, 0, 0);
  const dayStart = base.getTime();
  const startToday = dayStart + sleepMinutes * 60000;
  const durationMs = durationMinutes * 60000;
  // 昨天/今天/明天三个起点足以覆盖跨午夜窗口。
  const candidates = [startToday - DAY_MS, startToday, startToday + DAY_MS];
  const current = candidates.find((start) => now >= start && now < start + durationMs);
  if (current !== undefined) {
    return {
      active: true,
      start: current,
      end: current + durationMs,
      sleepAt: minutesToClock(sleepMinutes),
      wakeAt: minutesToClock(wakeMinutes),
      durationMs
    };
  }
  const nextStart = candidates.find((start) => start > now) ?? startToday + DAY_MS;
  return {
    active: false,
    start: nextStart,
    end: nextStart + durationMs,
    sleepAt: minutesToClock(sleepMinutes),
    wakeAt: minutesToClock(wakeMinutes),
    durationMs
  };
}
