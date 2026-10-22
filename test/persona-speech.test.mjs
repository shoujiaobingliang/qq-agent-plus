// 换人设后「屏蔽旧人设发言」：只遮机器人自己在 cutoff 之前的发言，群友消息与 #id 保留；
// 引用旧发言、历史渲染、交接里的 lastReply 走同一口径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-speech-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const { updateConfig } = await import('../src/core/config.js');
const {
  OLD_PERSONA_SPEECH_TEXT, personaAwareText, personaSpeechCutoff, isOldPersonaSpeech
} = await import('../src/core/persona-speech.js');
const { buildPastState, buildSystemPrompt } = await import('../src/llm/prompt.js');
const { ChatStore } = await import('../src/core/store.js');
const { MemoryStore } = await import('../src/memory/memory.js');

const setCutoffs = (cutoffs = {}, global = 0) => updateConfig({
  personaSpeechCutoffAt: global,
  personaSpeechCutoffs: { __replace__: cutoffs }
});
const oldSelf = (text = '喵~旧口癖') => ({ self: true, ts: 500, text });
const newSelf = (text = '新口吻') => ({ self: true, ts: 1500, text });
const user = (text = '在吗') => ({ self: false, ts: 500, senderId: '42', senderName: '群友', text });

test('全局 cutoff：所有群都遮 cutoff 之前的机器人发言，群友消息与换卡后的新发言保留', () => {
  setCutoffs({}, 1000);
  assert.equal(personaAwareText(oldSelf(), 'group:1'), OLD_PERSONA_SPEECH_TEXT);
  assert.equal(personaAwareText(oldSelf(), 'group:2'), OLD_PERSONA_SPEECH_TEXT, '人设是全局的，新会话也覆盖');
  assert.equal(personaAwareText(newSelf(), 'group:1'), '新口吻');
  assert.equal(personaAwareText(user(), 'group:1'), '在吗');
  assert.equal(isOldPersonaSpeech(oldSelf(), 'group:1'), true);
  assert.equal(isOldPersonaSpeech(user(), 'group:1'), false);
  assert.equal(personaSpeechCutoff('group:1'), 1000);
  assert.equal(personaSpeechCutoff('group:999'), 1000, '以后新增的会话也按全局时间线');
  setCutoffs({}, 0);
});

test('按会话覆盖优先于全局（留给按群人设分别换卡的场景）', () => {
  setCutoffs({ 'group:1': 400 }, 1000);
  // group:1 用 400：ts=500 的发言不算旧；group:2 没有覆盖，按全局 1000 遮
  assert.equal(personaAwareText(oldSelf(), 'group:1'), '喵~旧口癖');
  assert.equal(personaAwareText(oldSelf(), 'group:2'), OLD_PERSONA_SPEECH_TEXT);
  assert.equal(personaSpeechCutoff('group:1'), 400);
  assert.equal(personaSpeechCutoff('group:2'), 1000);
  setCutoffs({}, 0);
});

test('引用旧发言：保留引用块结构，只遮被引用正文；引用新发言不遮', () => {
  setCutoffs({}, 1000);
  const quote = (replyTs) => ({
    self: false,
    ts: 1500,
    text: `[引用#1·我：${replyTs <= 1000 ? '喵~旧口癖' : '新口吻'}]你看`,
    reply: { messageId: '1', sender: '我', self: true, ts: replyTs, text: replyTs <= 1000 ? '喵~旧口癖' : '新口吻' }
  });
  const masked = personaAwareText(quote(500), 'group:1');
  assert.ok(masked.includes(OLD_PERSONA_SPEECH_TEXT));
  assert.ok(!masked.includes('喵~旧口癖'));
  assert.ok(masked.includes('你看'));
  assert.ok(masked.includes('#1·我'), '消息 id 与说话人保留，引用/定位不受影响');
  const fresh = personaAwareText(quote(1500), 'group:1');
  assert.ok(fresh.includes('新口吻'));
  assert.ok(!fresh.includes(OLD_PERSONA_SPEECH_TEXT));
  setCutoffs({}, 0);
});

test('历史渲染：buildPastState 遮旧发言、保留群友消息与消息行', () => {
  setCutoffs({}, 1000);
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(root, 'store-')) });
  try {
    store.appendSelf('group:1', { mid: 's1', ts: 500, text: '喵~旧口癖' });
    store.appendIncoming('group:1', { mid: 'u1', ts: 600, text: '在吗', senderId: '42', senderName: '群友' }, { recordOnly: true });
    const past = buildPastState(store, 'group:1', { limit: 10 });
    assert.ok(!past.text.includes('喵~旧口癖'), '旧人设的正文不能再进上下文');
    assert.ok(past.text.includes(OLD_PERSONA_SPEECH_TEXT), '要留下“这里说过话”的占位');
    assert.ok(past.text.includes('在吗'), '群友的消息照常保留');
    assert.ok(past.text.includes('#s1'), '消息 id 保留，引用/看图仍能定位');
  } finally {
    store.close();
    setCutoffs({});
  }
});

test('交接：换卡前的 lastReply 不再注入，事实与工作状态保留', () => {
  const memory = new MemoryStore();
  memory.setHandoff('group:1', {
    topic: '在聊换卡',
    summary: '聊到了旧卡的喵口癖',
    lastReply: '喵~旧口癖'
  });
  setCutoffs({}, Date.now() + 1);
  try {
    const text = memory.formatHandoffForPrompt('group:1');
    assert.ok(!text.includes('喵~旧口癖'), '旧卡的原话不能继续当示例');
    assert.ok(text.includes('换卡前的旧交接'), '要标注这份交接来自换卡前');
    assert.ok(text.includes('聊到了旧卡的喵口癖'), '事实/摘要仍保留');
  } finally {
    memory.clearHandoff('group:1');
    setCutoffs({});
  }
});

test('提示词：允许适当吐槽上一条鱼，但禁止编造/刷屏/解释机制', () => {
  const prompt = buildSystemPrompt({
    persona: { botName: '测试', roleText: '你是一只猫娘，说话带一点懒散。' }
  });
  assert.match(prompt, /上一条鱼/, '要点出“上一条鱼”这个调侃对象');
  assert.match(prompt, /适当/, '要限定频率与场合');
  assert.match(prompt, /不要编造它说了什么/, '被遮住的内容不许猜');
  assert.match(prompt, /不要每条都提/, '不能变成口头禅');
  assert.match(prompt, /不要把这条机制解释给群友听/, '不要把换人设机制讲给群友');
});
