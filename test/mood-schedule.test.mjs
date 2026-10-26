import assert from 'node:assert/strict';
import { test } from 'node:test';

const { sleepWindowFor } = await import('../src/core/mood-schedule.js');

// 全部用本地时间构造，避免测试机时区不同导致日期漂移。
const local = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0).getTime();

test('跨午夜窗口：23:30 入睡、次日 07:30 起床', () => {
  const opts = { sleepAt: '23:30', wakeAt: '07:30' };

  const before = sleepWindowFor(local(23, 22), opts);
  assert.equal(before.active, false);
  assert.equal(before.start, local(23, 23, 30));
  assert.equal(before.end, local(24, 7, 30));

  const during = sleepWindowFor(local(24, 3), opts);
  assert.equal(during.active, true);
  assert.equal(during.start, local(23, 23, 30));
  assert.equal(during.end, local(24, 7, 30));

  const after = sleepWindowFor(local(24, 12), opts);
  assert.equal(after.active, false);
  assert.equal(after.start, local(24, 23, 30));
  assert.equal(after.end, local(25, 7, 30));
});

test('同日窗口：13:00–15:00', () => {
  const opts = { sleepAt: '13:00', wakeAt: '15:00' };
  const during = sleepWindowFor(local(23, 14), opts);
  assert.equal(during.active, true);
  assert.equal(during.start, local(23, 13));
  assert.equal(during.end, local(23, 15));

  const before = sleepWindowFor(local(23, 12), opts);
  assert.equal(before.active, false);
  assert.equal(before.start, local(23, 13));
  assert.equal(before.end, local(23, 15));
});

test('相同时间视为无效窗口', () => {
  const win = sleepWindowFor(local(23, 12), { sleepAt: '12:00', wakeAt: '12:00' });
  assert.equal(win.active, false);
  assert.equal(win.durationMs, 0);
});
