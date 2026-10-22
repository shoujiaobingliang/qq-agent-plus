// 「该回却没发」的补救（issue #39）：私聊 / 被 @ / 引用机器人 / 点名时，模型只输出正文
// （QQ 里看不到）→ 一次纠正请求（只给 send_message）→ 仍未发送则固定兜底。
//
// 每条用例同时断言四件事：模型调用次数、纠正请求的工具面、真正发出的内容、会话状态。
// 只断言"有消息发出"会漏掉"转发了内部草稿"或"多调了一次模型"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reply-guard-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { Orchestrator, isDirectedAtBot } = await import('../src/core/orchestrator.js');
const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

const replyText = '现在没开空间动态，暂时发不了。';

function fixture(t, { group = false, maxRounds = 3, guard = true } = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = group ? ['1'] : [];
  cfg.allow.private = group ? [] : ['2'];
  cfg.api.model = 'mock';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.api.maxRounds = maxRounds;
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  cfg.conversation.replyGuardEnabled = guard;
  cfg.wakeDelayMs = 30;
  cfg.wakeDelayMinMs = 30;
  cfg.wakeDelayMaxMs = 30;
  cfg.maxBatchWaitMs = 120;
  cfg.drainDelayMs = 200;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(root, 'store-')) });
  const sessions = new SessionRegistry();
  const sent = [];
  const sender = {
    // 非文本回复（拍一拍/语音/群文件）也要能让 guard 知道"已经回过了"
    poke: async () => ({ ok: true }),
    sendTextBatch: async (chatKey, messages) => {
      if (sender.failNext) {
        sender.failNext = false;
        return { sent: [], failed: messages.map((text) => ({ text, error: sender.failReason || 'muted' })) };
      }
      sent.push(...messages);
      return { sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: [] };
    }
  };
  const runner = new Orchestrator({
    store, sessions, memory: { formatForPrompt: () => '', formatHandoffForPrompt: () => '', getHandoff: () => null },
    stickers: {}, sender,
    onebot: { selfId: '888', selfNickname: 'bot', getGroupInfo: async () => ({ group_name: 'g' }), getGroupMemberInfo: async () => ({ nickname: 'member' }) }
  });
  const original = globalThis.fetch;
  t.after(async () => { await runner.abortAll(); store.close(); globalThis.fetch = original; });

  const bodies = [];
  const responses = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body || '{}'));
    const next = responses.shift();
    if (!next) throw new Error('没有预置的模型响应了（模型被多调了一次）');
    return Response.json(next);
  };
  const textReply = (text = replyText) => ({ choices: [{ message: { content: text } }], usage: { total_tokens: 10 } });
  const sendReply = (text = replyText) => ({
    choices: [{
      message: {
        tool_calls: [{
          id: 'call_1', type: 'function',
          function: { name: 'send_message', arguments: JSON.stringify({ messages: text }) }
        }]
      }
    }],
    usage: { total_tokens: 12 }
  });
  const append = (mid, text = '你能发空间动态吗', extra = {}) => store.appendIncoming(group ? 'group:1' : 'private:2', {
    mid, text, senderId: '42', senderName: 'member', ...extra
  });
  const wake = () => runner.wake(group ? 'group:1' : 'private:2');
  const lastSession = () => {
    const summary = sessions.listSummaries(10)[0];
    return summary ? sessions.get(summary.id) : null;
  };
  return { cfg, runner, store, sessions, sent, sender, bodies, responses, textReply, sendReply, append, wake, lastSession };
}

test('报告场景：私聊问空间动态、首轮只回正文 → 纠正后发出说明，首轮正文不被转发', async (t) => {
  const f = fixture(t);
  f.responses.push(f.textReply(), f.sendReply());
  f.append('m1');
  await f.wake();

  assert.equal(f.bodies.length, 2, '应当只有一次纠正请求');
  const correctionTools = (f.bodies[1].tools || []).map((tool) => tool.function?.name);
  assert.deepEqual(correctionTools, ['send_message'], '纠正请求只给发送工具，避免重新执行别的操作');
  assert.deepEqual(f.sent, [replyText], '发出去的是纠正轮显式发送的内容');
  assert.notEqual(f.sent[0], '你能发空间动态吗');
  assert.equal(f.lastSession()?.replyCorrection, 'corrected');
  assert.equal(f.lastSession()?.status, 'done');
});

test('纠正轮返回两条 send_message：都要发出，不能静默丢掉后半句', async (t) => {
  const f = fixture(t);
  const twoSends = {
    choices: [{
      message: {
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ messages: ['第一句'] }) } },
          { id: 'c2', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ messages: ['第二句'] }) } }
        ]
      }
    }],
    usage: { total_tokens: 12 }
  };
  f.responses.push(f.textReply(), twoSends);
  f.append('m1');
  await f.wake();

  assert.deepEqual(f.sent, ['第一句', '第二句']);
  assert.equal(f.lastSession()?.replyCorrection, 'corrected');
});

test('纠正轮仍只回正文 → 发固定兜底句，恰好一条', async (t) => {
  const f = fixture(t);
  f.responses.push(f.textReply(), f.textReply('我还是只写正文'));
  f.append('m1');
  await f.wake();

  assert.equal(f.bodies.length, 2);
  assert.deepEqual(f.sent, ['这条我暂时处理不了，稍后再试。'], '兜底是固定文案，不含第一轮正文');
  assert.equal(f.lastSession()?.replyCorrection, 'fallback');
  assert.equal(f.lastSession()?.status, 'done');
});

test('首轮已经发送：不再纠正（正常的两轮收尾不算纠正）', async (t) => {
  const f = fixture(t);
  f.responses.push(f.sendReply('直接回答'), f.textReply(''));
  f.append('m1');
  await f.wake();

  assert.deepEqual(f.sent, ['直接回答']);
  assert.equal(f.bodies.some((body) => String(body.messages?.at(-1)?.content || '').includes('你上一轮把回答写成了正文')), false,
    '已发送的会话不该出现纠正请求');
  assert.equal(f.lastSession()?.replyCorrection, undefined);
});

test('群里没人叫它：保持沉默，不纠正也不发送', async (t) => {
  const f = fixture(t, { group: true });
  f.responses.push(f.textReply());
  f.append('m1', '今天天气不错');
  await f.wake();

  assert.equal(f.bodies.length, 1, '不该有纠正请求');
  assert.deepEqual(f.sent, []);
  assert.equal(f.lastSession()?.status, 'noreply');
});

test('群里被 @：走纠正路径', async (t) => {
  const f = fixture(t, { group: true });
  f.responses.push(f.textReply(), f.sendReply());
  f.append('m1', '@bot 你能发空间动态吗', { mentionsSelf: true });
  await f.wake();

  assert.equal(f.bodies.length, 2);
  assert.deepEqual(f.sent, [replyText]);
});

test('群里引用机器人 / 文本点名：同样算"明确问它"', async (t) => {
  for (const [label, extra, text] of [
    ['引用机器人', { reply: { senderId: '888', sender: 'bot', text: '之前的回复' } }, '这个还能用吗'],
    ['文本点名', {}, '小鲸鱼 你能发空间动态吗']
  ]) {
    const f = fixture(t, { group: true });
    f.responses.push(f.textReply(), f.sendReply());
    f.append('m1', text, extra);
    await f.wake();
    assert.equal(f.bodies.length, 2, `${label} 应触发纠正`);
    assert.deepEqual(f.sent, [replyText], `${label} 应发出说明`);
  }
});

test('发送结果不确定：不补发、不纠正（交人工核对）', async (t) => {
  const f = fixture(t);
  f.store.hasUncertainEffects = () => true;
  f.responses.push(f.textReply());
  f.append('m1');
  await f.wake();

  assert.equal(f.bodies.length, 1, '不能因为不确定就再请求一次模型');
  assert.deepEqual(f.sent, []);
  assert.equal(f.lastSession()?.replyCorrection, 'skipped');
});

test('纠正发送被禁言：不重试、不崩溃，状态保持 noreply', async (t) => {
  const f = fixture(t);
  f.sender.failNext = true;                       // 第一次发送（纠正轮）被禁言
  f.responses.push(f.textReply(), f.sendReply());
  f.append('m1');
  await f.wake();

  assert.deepEqual(f.sent, [], '禁言时什么都不该发出去');
  assert.equal(f.lastSession()?.replyCorrection, 'failed');
  assert.equal(f.lastSession()?.status, 'noreply');
});

test('轮数耗尽且未发送：兜底文案用"还没处理完"', async (t) => {
  const f = fixture(t, { maxRounds: 1 });
  f.responses.push({
    choices: [{
      message: {
        tool_calls: [{
          id: 'call_0', type: 'function',
          function: { name: 'get_active_members', arguments: '{}' }
        }]
      }
    }],
    usage: { total_tokens: 10 }
  }, f.textReply());
  f.append('m1');
  await f.wake();

  assert.equal(f.bodies.length, 2, '轮数用尽也要走纠正/兜底');
  assert.deepEqual(f.sent, ['这条我还没处理完，稍后再试。']);
});

test('开关关闭：退回旧行为（只靠提示词）', async (t) => {
  const f = fixture(t, { guard: false });
  f.responses.push(f.textReply());
  f.append('m1');
  await f.wake();

  assert.equal(f.bodies.length, 1);
  assert.deepEqual(f.sent, []);
});

test('纠正请求的 usage 记进会话（成本不能漏账）', async (t) => {
  const f = fixture(t);
  f.responses.push(f.textReply(), f.sendReply());
  f.append('m1');
  await f.wake();
  const session = f.lastSession();
  assert.equal(session?.replyCorrectionUsage?.total_tokens, 12);
  assert.equal(session?.usage?.calls, 2, '两次模型调用都要计入 calls（不能漏记也不能重复记）');
  assert.equal(session?.usage?.totalTokens, 22, '10 + 12，纠正请求不能重复记账');
});

test('纠正指令不进会话消息流 / lifecycle transcript（下一轮不该看到内部提示）', async (t) => {
  const f = fixture(t);
  f.cfg.conversation.mode = 'lifecycle';
  f.cfg.conversation.unifiedMode = true;
  setRuntimeConfig(f.cfg);
  f.responses.push(f.textReply(), f.sendReply());
  f.append('m1');
  await f.wake();

  const session = f.lastSession();
  const stored = JSON.stringify(session?.messages || []);
  assert.equal(stored.includes('你上一轮把回答写成了正文'), false, '合成指令不能进 session.messages');
  assert.deepEqual(f.sent, [replyText]);
  // 线程里存的是 provider transcript：同样不该含合成指令
  const thread = typeof f.store.getConversationThread === 'function' ? f.store.getConversationThread('private:2') : null;
  if (thread?.threadId && typeof f.store.getThreadTurns === 'function') {
    assert.equal(JSON.stringify(f.store.getThreadTurns(thread.threadId)).includes('你上一轮把回答写成了正文'), false);
  }
});

test('判定函数：引用第三方的原文、展开的合并转发里出现名字都不算"在问它"', () => {
  const persona = { botName: '小鲸鱼', selfNickname: '' };
  const base = { kind: 'group', persona, selfId: '888', accountNickname: 'bot' };
  assert.equal(isDirectedAtBot({ ...base, triggerEntries: [{ text: '今天天气不错' }] }), false);
  assert.equal(isDirectedAtBot({ ...base, triggerEntries: [{ text: '小鲸鱼 在吗' }] }), true);
  assert.equal(isDirectedAtBot({ ...base, triggerEntries: [{ text: '小鲸鱼在吗' }] }), true,
    '中文名字后面通常没有空格，直接接正文也要算');
  assert.equal(isDirectedAtBot({
    ...base,
    triggerEntries: [{ text: '[引用#12·A：小鲸鱼今天怎么不说话]估计在忙', reply: { senderId: '7', sender: 'A' } }]
  }), false, '引用别人的话里出现名字不算叫它');
  assert.equal(isDirectedAtBot({
    ...base,
    triggerEntries: [{ text: '[合并转发 共3条] A：小鲸鱼在吗 B：在忙' }]
  }), false, '展开的合并转发是转述');
  assert.equal(isDirectedAtBot({ ...base, triggerEntries: [{ reply: { senderId: '888' } }] }), true, '引用机器人算');
});

test('判定函数：CQ 码的 @ 与短名字边界', () => {
  const base = { kind: 'group', persona: { botName: '小鲸鱼', selfNickname: '' }, selfId: '888', accountNickname: 'bot' };
  assert.equal(isDirectedAtBot({
    ...base,
    triggerEntries: [{ text: '[CQ:at,qq=888] 你能发空间动态吗' }]
  }), true, '字符串上报没有 mentionsSelf，CQ:at 也要算叫它');
  assert.equal(isDirectedAtBot({
    ...base,
    triggerEntries: [{ text: '[CQ:at,qq=999] 你能发空间动态吗' }]
  }), false, '@的是别人');

  const shortName = { ...base, persona: { botName: '小鲸', selfNickname: '' } };
  assert.equal(isDirectedAtBot({
    ...shortName,
    triggerEntries: [{ text: '@小鲸鱼 今天吃什么' }]
  }), false, '@小鲸鱼 不算在叫「小鲸」');
  assert.equal(isDirectedAtBot({
    ...shortName,
    triggerEntries: [{ text: '@小鲸 在吗' }]
  }), true);
  assert.equal(isDirectedAtBot({
    ...shortName,
    triggerEntries: [{ text: '小鲸鱼真可爱' }]
  }), false, '裸名字也要独立成词');

  assert.equal(isDirectedAtBot({
    ...base,
    triggerEntries: [{ text: '[卡片聊天记录] A：小鲸鱼在吗' }]
  }), false, '卡片聊天记录同样是转述');
});

test('纠正请求沿用该群生效的人设（按群人设）', async (t) => {
  const f = fixture(t, { group: true });
  f.cfg.personaPerChat = { 'group:1': { templateId: 'tsundere_loli' } };
  setRuntimeConfig(f.cfg);
  f.responses.push(f.textReply(), f.sendReply());
  f.append('m1', '@bot 在吗', { mentionsSelf: true });
  await f.wake();

  assert.equal(f.bodies.length, 2);
  const personaSeen = f.bodies[1].messages?.some((m) => /傲娇萝莉/.test(String(m.content || '')));
  assert.ok(personaSeen, '纠正请求仍带上该群生效的卡（split 布局下在独立人设消息里）');
});

test('纠正轮发送明确失败（连接被拒）：仍发兜底说明（不能一句都没有）', async (t) => {
  const f = fixture(t);
  // 明确失败（不是超时/5xx 那种"可能已发出"）：允许再试一次兜底。
  // 不确定的失败由发送队列的 hasUncertainEffects 挡住，另有专门用例。
  f.sender.failReason = 'ECONNREFUSED';
  f.sender.failNext = true;                       // 纠正轮发送失败一次
  f.responses.push(f.textReply(), f.sendReply());
  f.append('m1');
  await f.wake();

  assert.deepEqual(f.sent, ['这条我暂时处理不了，稍后再试。'], '非禁言失败要继续走兜底');
  assert.equal(f.lastSession()?.status !== 'error', true);
});

test('已经用拍一拍回复过：不再触发文字纠正（非文本回复也算"回过了"）', async (t) => {
  const f = fixture(t);
  f.responses.push({
    choices: [{
      message: {
        tool_calls: [{
          id: 'poke_1', type: 'function',
          function: { name: 'send_poke', arguments: '{}' }
        }]
      }
    }],
    usage: { total_tokens: 10 }
  }, f.textReply(''));
  f.append('m1');
  await f.wake();

  assert.equal(f.bodies.some((body) => String(body.messages?.at(-1)?.content || '').includes('你上一轮把回答写成了正文')), false,
    '拍一拍已经让用户看到了回应，不该再补文字');
  assert.deepEqual(f.sent, []);
});
