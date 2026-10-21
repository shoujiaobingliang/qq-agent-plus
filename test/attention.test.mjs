// 注意力层：低成本判定 ignore / peek / reply，失败回落概率；@/关键词/私聊必回。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-attention-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const { Orchestrator } = await import('../src/core/orchestrator.js');
const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const {
  buildAttentionMessages, parseAttentionDecision, attentionShouldReply, attentionContextCount
} = await import('../src/core/attention.js');

const attentionJson = (over = {}) => JSON.stringify({
  attend: 'ignore', readCount: 0, confidence: 0.8, reason: '测试', ...over
});

test('注意力 JSON 解析：合法/坏形状/夹取', () => {
  assert.deepEqual(parseAttentionDecision(attentionJson({ attend: 'reply', readCount: 120, confidence: 2 })), {
    attend: 'reply', readCount: 100, confidence: 1, reason: '测试'
  });
  assert.equal(parseAttentionDecision('not json'), null);
  assert.equal(parseAttentionDecision('{"attend":"unknown"}'), null);
  assert.equal(attentionShouldReply({ attend: 'reply', confidence: 0.7 }, 0.6), true);
  assert.equal(attentionShouldReply({ attend: 'reply', confidence: 0.5 }, 0.6), false);
  assert.equal(attentionContextCount({ readCount: 12 }, 40), 12);
  assert.equal(attentionContextCount({ readCount: 0 }, 40), 40);
});

test('注意力提示词：只带收件箱，不带工具表；人设摘要会进入', () => {
  const { messages } = buildAttentionMessages({
    persona: { roleText: '你是一只猫。' },
    selfNickname: '猫猫',
    contextMessages: [{ id: 1, mid: 1, senderId: 'u1', senderName: '甲', text: '前面的话' }],
    entries: [{ id: 2, mid: 2, senderId: 'u2', senderName: '乙', text: '新消息' }],
    handoff: { topic: '装机器', summary: '在聊 NAS' }
  });
  const text = messages.map((m) => m.content).join('\n');
  assert.ok(text.includes('注意力判定器'));
  assert.ok(text.includes('你是一只猫。'));
  assert.ok(text.includes('前面的话'));
  assert.ok(text.includes('新消息'));
  assert.ok(text.includes('装机器'));
  assert.ok(!text.includes('send_message'), '判定器不应看到工具协议');
});

function fixture(t, { randomPercent = 0 } = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'mock';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.api.maxRounds = 1;
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  cfg.conversation.replyGuardEnabled = false;
  cfg.proactive.enabled = false;
  cfg.proactive.followUpEnabled = false;
  cfg.proactive.selfWakeEnabled = false;
  cfg.trigger.mode = 'hybrid';
  cfg.trigger.attention.maxCallsPerDay = 100;
  cfg.trigger.attention.minConfidence = 0.55;
  cfg.store.randomPercent = randomPercent;
  cfg.wakeDelayMs = 20;
  cfg.wakeDelayMinMs = 20;
  cfg.wakeDelayMaxMs = 20;
  cfg.maxBatchWaitMs = 80;
  cfg.drainDelayMs = 100;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(root, 'store-')) });
  const sessions = new SessionRegistry();
  const sent = [];
  const sender = {
    sendTextBatch: async (_chatKey, messages) => {
      sent.push(...messages);
      return { sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })), failed: [] };
    }
  };
  const runner = new Orchestrator({
    store, sessions,
    memory: { formatForPrompt: () => '', formatHandoffForPrompt: () => '', getHandoff: () => null },
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
    if (!next) throw new Error('模型被多调了一次');
    return Response.json(next);
  };
  const attentionReply = (over = {}) => ({ choices: [{ message: { content: attentionJson(over) } }], usage: { total_tokens: 10 } });
  const sendReply = (text = '在') => ({
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
  const append = (mid, text = '普通闲聊', extra = {}) => store.appendIncoming('group:1', {
    mid, text, senderId: '42', senderName: 'member', ...extra
  });
  const wake = () => runner.wake('group:1');
  return { cfg, runner, store, sessions, sent, bodies, responses, attentionReply, sendReply, append, wake };
}

test('hybrid：注意力 ignore → 不跑主模型、不发言、标已读', async (t) => {
  const f = fixture(t);
  f.responses.push(f.attentionReply({ attend: 'ignore', confidence: 0.9, reason: '别人闲聊' }));
  f.append(1);
  await f.wake();
  assert.equal(f.bodies.length, 1, '只应调用注意力模型');
  assert.equal(f.bodies[0].messages[0].content.includes('注意力判定器'), true);
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.unreadCount('group:1'), 0);
});

test('hybrid：注意力 reply → 走主模型并发送', async (t) => {
  const f = fixture(t);
  f.responses.push(
    f.attentionReply({ attend: 'reply', confidence: 0.9, reason: '有人问它', readCount: 12 }),
    f.sendReply('在')
  );
  f.append(1, '你在吗');
  await f.wake();
  assert.equal(f.bodies.length, 2);
  assert.equal(f.bodies[1].messages[0].content.includes('注意力判定器'), false);
  assert.deepEqual(f.sent, ['在']);
});

test('hybrid：@ 必回，跳过注意力层', async (t) => {
  const f = fixture(t);
  f.responses.push(f.sendReply('在'));
  f.append(1, '@bot 在吗', { mentionsSelf: true });
  await f.wake();
  assert.equal(f.bodies.length, 1, '被 @ 不应多跑一次注意力');
  assert.equal(f.bodies[0].messages[0].content.includes('注意力判定器'), false);
  assert.deepEqual(f.sent, ['在']);
});

test('hybrid：注意力解析失败 → 回落概率（100% 时照常回复）', async (t) => {
  const f = fixture(t, { randomPercent: 100 });
  f.responses.push(
    { choices: [{ message: { content: '不是 JSON' } }], usage: { total_tokens: 5 } },
    f.sendReply('在')
  );
  f.append(1);
  await f.wake();
  assert.equal(f.bodies.length, 2);
  assert.deepEqual(f.sent, ['在']);
});

test('trigger 配置：hybrid 持久化、数值夹取、非法 mode 拒绝', async () => {
  const { updateConfig, getConfig } = await import('../src/core/config.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.admin = { ...(cfg.admin || {}), ownerUin: '100000001' };
  cfg.allow = { ...(cfg.allow || {}), private: ['100000001'] };
  setRuntimeConfig(cfg);
  updateConfig({
    trigger: {
      mode: 'hybrid',
      attention: { minConfidence: 2, maxCallsPerDay: -5, contextMessages: 1 }
    }
  });
  const next = getConfig();
  assert.equal(next.trigger.mode, 'hybrid');
  assert.equal(next.trigger.attention.minConfidence, 1);
  assert.equal(next.trigger.attention.maxCallsPerDay, 0);
  assert.equal(next.trigger.attention.contextMessages, 5);
  assert.throws(() => updateConfig({ trigger: { mode: 'chaos' } }), /trigger mode/i);

  const chatUi = fs.readFileSync(path.join(process.cwd(), 'ui/pages/chat.js'), 'utf8');
  assert.ok(chatUi.includes('id="cfg-trigger-mode"'), '缺少触发方式控件');
  const saveUi = fs.readFileSync(path.join(process.cwd(), 'ui/pages/settings-save.js'), 'utf8');
  assert.ok(saveUi.includes('patch.trigger'), '保存分支要写入 trigger 配置');
});
