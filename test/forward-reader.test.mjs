import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readForwardMessages } from '../src/onebot/forward-reader.js';

// tools-core 在定义期就会读配置（buildToolDefs → getConfig，persist 会回写 data/config.json）：
// 必须先把数据目录指到临时目录，再用动态 import 载入 —— 静态 import 先于任何代码执行，
// env 来不及生效（2026-10-12 审查：本文件曾回写真实仓库的 data/config.json）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-forward-reader-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { buildToolDefs } = await import('../src/tools/tools-core.js');

const card = [{ type: 'forward', data: { id: 'fresh-resource' } }];
const messages = [{ sender: { nickname: 'test' }, message: [{ type: 'text', data: { text: 'forward content' } }] }];

test('ingest reads a received resource ID without querying the wrong message_id', async () => {
  const calls = [];
  const onebot = { call: async (action, args) => {
    calls.push([action, args]);
    if (args.id === 'fresh-resource') return { messages };
    throw Object.assign(new Error('download forward message payload is empty'), { retcode: 100 });
  } };
  assert.deepEqual(await readForwardMessages(onebot, -123, card), messages);
  assert.deepEqual(calls, [['get_forward_msg', { id: 'fresh-resource' }]]);
});

test('tool resolves a fresh resource ID, saves expanded text, then uses the archive', async () => {
  const calls = [];
  const entry = { mid: '-123', text: '[合并转发聊天记录]' };
  const ctx = {
    chatKey: 'group:1',
    store: {
      findByMid: () => entry,
      updateByMid: (chat, mid, patch) => {
        assert.equal(chat, 'group:1'); assert.equal(mid, '-123'); entry.text = patch.text;
      }
    },
    onebot: { call: async (action, args) => {
      calls.push([action, args]);
      if (action === 'get_msg') return { message: card };
      if (args.id === 'fresh-resource') return { messages };
      throw new Error('wrong lookup');
    } }
  };
  const tool = buildToolDefs().find(t => t.name === 'read_forward');
  const result = await tool.execute(ctx, { messageId: '-123' });
  assert.equal(result.isError, undefined);
  assert.match(entry.text, /合并转发 共1条/);
  assert.match(entry.text, /forward content/);
  assert.deepEqual(calls, [['get_msg', { message_id: -123 }], ['get_forward_msg', { id: 'fresh-resource' }]]);
  await tool.execute(ctx, { messageId: '-123' });
  assert.equal(calls.length, 2);
});

test('older adapters can fall back to message_id when get_msg is unavailable', async () => {
  const onebot = { call: async (action, args) => {
    if (action === 'get_msg') throw new Error('unsupported');
    assert.deepEqual(args, { message_id: -123 });
    return { data: { messages } };
  } };
  assert.deepEqual(await readForwardMessages(onebot, -123), messages);
});

test('empty or rejected resource lookup has one bounded legacy fallback', async () => {
  for (const mode of ['empty', 'rejected']) {
    let calls = 0;
    const onebot = { call: async (_, args) => {
      calls++;
      if (args.id) {
        if (mode === 'rejected') throw Object.assign(new Error('empty payload'), { retcode: 100 });
        return { messages: [] };
      }
      return { messages };
    } };
    assert.deepEqual(await readForwardMessages(onebot, -123, card), messages);
    assert.equal(calls, 2);
  }
});

test('a rejected resource lookup with any other retcode still falls back', async () => {
  let calls = 0;
  const onebot = { call: async (_, args) => {
    calls++;
    if (args.id) throw Object.assign(new Error('unsupported param: id'), { retcode: 1404 });
    return { messages };
  } };
  assert.deepEqual(await readForwardMessages(onebot, -123, card), messages);
  assert.equal(calls, 2);
});

test('transport or authentication failures are not hidden by fallback', async () => {
  let calls = 0;
  const onebot = { call: async () => { calls++; throw new Error('HTTP 401'); } };
  await assert.rejects(readForwardMessages(onebot, -123, card), /HTTP 401/);
  assert.equal(calls, 2);
});

test('嵌套转发多读一层（深度 2 封顶），再深写占位', async () => {
  const { expandForwardNodes } = await import('../src/onebot/onebot.js');
  const outer = [{ sender: { nickname: '外层' }, message: [
    { type: 'text', data: { text: '先说一句' } },
    { type: 'forward', data: { id: 'inner-rid' } }
  ] }];

  // 第一层嵌套：取一次并展开
  const calls = [];
  const ex = await expandForwardNodes(outer, {
    fetchNested: async (rid) => { calls.push(rid); return [{ sender: { nickname: '内层' }, message: [{ type: 'text', data: { text: '记录里的记录' } }] }]; }
  });
  assert.deepEqual(calls, ['inner-rid']);
  assert.match(ex.text, /↳ \[合并转发 共1条\]/, '内层要带 ↳ 与自己的条数');
  assert.match(ex.text, /内层: 记录里的记录/);

  // 内层再嵌一层：不再取数，写占位
  const calls2 = [];
  const ex2 = await expandForwardNodes(outer, {
    fetchNested: async (rid) => {
      calls2.push(rid);
      return [{ sender: { nickname: 'X' }, message: [{ type: 'text', data: { text: 'a' } }, { type: 'forward', data: { id: 'deep' } }] }];
    }
  });
  assert.equal(calls2.length, 1, '只取一层，不再往下钻');
  assert.match(ex2.text, /\[嵌套转发（未展开）\]/);
});

test('嵌套取数有上限；取不到与没有取数器都如实写占位', async () => {
  const { expandForwardNodes } = await import('../src/onebot/onebot.js');
  const mk = (id) => ({ sender: { nickname: 'A' }, message: [{ type: 'text', data: { text: '外壳' } }, { type: 'forward', data: { id } }] });

  const calls = [];
  const ex = await expandForwardNodes([mk('r1'), mk('r2'), mk('r3'), mk('r4')], {
    maxNestedFetches: 3,
    fetchNested: async (rid) => { calls.push(rid); return []; }   // 取回空 = 取不到
  });
  assert.equal(calls.length, 3, '最多为嵌套取三次');
  assert.equal((ex.text.match(/取回失败，未展开/g) || []).length, 3);
  assert.match(ex.text, /\[嵌套转发（超出取数上限，未展开）\]/);

  const ex2 = await expandForwardNodes([mk('r9')]);   // 没有 fetchNested（老调用点）
  assert.match(ex2.text, /\[嵌套转发（未展开）\]/);
});

test('聊天记录卡片：能从卡片里取到资源 id（取不到就是 null）', async () => {
  const { forwardResIdFromSegment } = await import('../src/onebot/forward-reader.js');
  const multimsg = JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail_1: { resid: 'abcDEF123456xyz' } } });
  assert.equal(forwardResIdFromSegment({ type: 'json', data: { data: multimsg } }), 'abcDEF123456xyz');
  assert.equal(forwardResIdFromSegment({ type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.tuwen' }) } }), null);
  assert.equal(forwardResIdFromSegment({ type: 'xml', data: { data: '<msg resid="xmlRid1234567" />' } }), 'xmlRid1234567');
  assert.equal(forwardResIdFromSegment({ type: 'forward', data: { res_id: 'rid-1' } }), 'rid-1');
  assert.equal(forwardResIdFromSegment({ type: 'text', data: { text: 'x' } }), null);
});

test('按资源 id 取节点：非数字 resid 不再回落成 message_id:NaN', async () => {
  const { readForwardNodesById } = await import('../src/onebot/forward-reader.js');
  const calls = [];
  const onebot = { call: async (action, args) => { calls.push([action, args]); return { messages: [] }; } };
  // 取到空也算失败 → 但 resid 不是数字，拿它当 message_id 只会发一次 NaN 请求
  assert.deepEqual(await readForwardNodesById(onebot, 'abcDEFgh123456'), []);
  assert.deepEqual(calls, [['get_forward_msg', { id: 'abcDEFgh123456' }]],
    '非数字 resid 不该再拿 Number() 的结果去当 message_id');

  // 纯数字才值得再试一次（老适配器只认 message_id 的那条兼容路径）
  calls.length = 0;
  await readForwardNodesById(onebot, '12345');
  assert.deepEqual(calls, [
    ['get_forward_msg', { id: '12345' }],
    ['get_forward_msg', { message_id: 12345 }]
  ], '数字 id 仍要保留兼容回落');
});

test('聊天记录卡片单独标成 [卡片聊天记录 …]：提示词里的锚点必须真的出现在正文里', async () => {
  const { cardToText } = await import('../src/onebot/onebot.js');
  const multimsg = JSON.stringify({
    app: 'com.tencent.multimsg', prompt: '[聊天记录]',
    meta: { detail_1: { resid: 'abcdefgh12345', title: '群聊的聊天记录' } }
  });
  // 模型按提示词找的就是这几个字；原来一律渲染成「[卡片…]」，那个锚点从来不存在
  assert.match(cardToText({ type: 'json', data: { data: multimsg } }), /^\[卡片聊天记录/);
  const news = JSON.stringify({ app: 'com.tencent.structmsg', prompt: '[分享]', meta: { news: { title: '标题', desc: '摘要' } } });
  assert.match(cardToText({ type: 'json', data: { data: news } }), /^\[卡片 /, '普通分享卡片不该跟着改名字');
  assert.equal(cardToText({ type: 'json', data: {} }), '[卡片消息]');
});

// 2026-10-22 口径变更：`messageTypes.expandForward=false` 现在是**硬开关** ——
// 不只拦入站自动展开，运行中的 read_forward 也必须拒绝（否则开关只是把展开推迟到模型调用）。
// 开关打开时按需展开照旧可用。
test('关掉转发查看后，read_forward 执行层也拒绝；打开后按需展开照旧可用', async () => {
  const { updateConfig } = await import('../src/core/config.js');
  const calls = [];
  const entry = { mid: '-123', text: '[合并转发聊天记录]' };
  const ctx = {
    chatKey: 'group:1',
    store: {
      findByMid: () => entry,
      updateByMid: (_chat, _mid, patch) => { entry.text = patch.text; }
    },
    onebot: { call: async (action, args) => {
      calls.push([action, args]);
      if (action === 'get_msg') return { message: card };
      if (args.id === 'fresh-resource') return { messages };
      throw new Error('wrong lookup');
    } }
  };
  const tool = buildToolDefs().find((t) => t.name === 'read_forward');
  updateConfig({ messageTypes: { expandForward: false } });
  try {
    const result = await tool.execute(ctx, { messageId: '-123' });
    assert.equal(result.isError, true, '关掉后执行层必须拒绝');
    assert.match(result.content, /关闭了合并转发展开/);
    assert.equal(entry.text, '[合并转发聊天记录]', '不能把展开正文写回存档');
    assert.equal(calls.length, 0, '拒绝时不该向协议端请求');
  } finally {
    updateConfig({ messageTypes: { expandForward: true } });
  }
  const result = await tool.execute(ctx, { messageId: '-123' });
  assert.equal(result.isError, undefined);
  assert.match(entry.text, /forward content/, '开关打开后按需展开仍要写回存档');
});
