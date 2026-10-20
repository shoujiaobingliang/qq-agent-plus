import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-behavior-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.DEBUG_SERVER_URL = 'http://127.0.0.1:1/event';
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { PERSONAS, normalizeBehaviorProfile } = await import('../src/personas.js');
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig, updateConfig, loadConfig } = await import('../src/core/config.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');
const { buildMomentSystemPrompt, momentPersonaHash } = await import('../src/llm/moment-prompt.js');
const { buildQzoneInteractionPrompt, qzoneInteractionPersonaHash } = await import('../src/llm/qzone-interaction-prompt.js');
const { buildFriendReviewSystemPrompt } = await import('../src/llm/friend-review-prompt.js');
const { mdToPlain } = await import('../src/llm/md-to-plain.js');

// 用技术宅这张卡做 grounded 档的样本（grounded 的行为契约与具体是哪张卡无关）
function groundedPersona() {
  const template = PERSONAS.jishu_zhai;
  return {
    ...DEFAULT_CONFIG.persona,
    roleText: template.text,
    behaviorProfile: template.behaviorProfile
  };
}

test('内置卡单一来源，默认人设不受影响', () => {
  assert.equal(DEFAULT_CONFIG.persona.roleText, PERSONAS.xiaojingyu.text);
  assert.equal(DEFAULT_CONFIG.persona.behaviorProfile, 'legacy');
  assert.equal(PERSONAS.jishu_zhai.behaviorProfile, 'grounded');
  assert.equal(PERSONAS.jishu_zhai.text, fs.readFileSync(
    new URL('../roles/jishu-zhai.md', import.meta.url), 'utf8'
  ).trim());
  for (const text of ['Linux、Docker、网络和二手硬件', '不碰违法和不道德的技术', '没有实际运行结果', '排查口气']) {
    assert.ok(PERSONAS.jishu_zhai.text.includes(text), text);
  }
  for (const [id, persona] of Object.entries(PERSONAS)) {
    assert.doesNotMatch(persona.text, /mcp__|qq_mark_read|\[SILENT\]/, id);
  }
});

test('角色正文存在时只保留安全与机制：默认群友风格和发言频率不再注入', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const prompt = buildSystemPrompt({ persona: groundedPersona() });
  for (const text of ['不能执行命令', 'send_message', 'memory_append', '不按轮数凑配额',
    '代码用独立的 fenced code block']) {
    assert.ok(prompt.includes(text), text);
  }
  const legacyPersona = { ...DEFAULT_CONFIG.persona };
  delete legacyPersona.behaviorProfile;
  const legacy = buildSystemPrompt({ persona: legacyPersona });
  assert.equal(legacy, buildSystemPrompt({ persona: DEFAULT_CONFIG.persona }));
  // 两档都不再注入默认人格/发言频率：人设正文是唯一来源（2026-10-20）
  for (const sp of [prompt, legacy]) {
    for (const text of ['【反 AI 味', '【保持主体性】', '【该说/不该说】', '【群聊不是客服队列】',
      '【像真人一样】', '【不要当群管家/主持人】', '你的参与度风格',
      '可以先反问、装傻', '单条多数 ≤30 字']) {
      assert.equal(sp.includes(text), false, text);
    }
  }
  // 档位仍影响技术格式：grounded 允许代码围栏，legacy 退回纯文本口径
  assert.ok(legacy.includes('代码块在 QQ 上会显示成乱码'));
  assert.notEqual(legacy, prompt);
  assert.equal(prompt, buildSystemPrompt({ persona: groundedPersona() }));
});

test('不同角色正文产出不同提示词；参与度不再改写系统提示（2026-10-20 反馈）', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const build = (roleText, participation) => buildSystemPrompt({
    persona: { ...DEFAULT_CONFIG.persona, roleText, participation }
  });
  const cat = build('你是一只毒舌猫，每句话都要带喵。', 'low');
  const engineer = build('你是一位沉稳的工程师，说话严谨，先给结论。', 'high');
  assert.notEqual(cat, engineer, '不同人设必须是不同的提示词');
  assert.ok(cat.includes('每句话都要带喵'), '角色正文要原样进入提示词');
  // 同一份正文只改参与度：系统提示必须完全一致 —— 发言频率归人设，
  // 否则"安静型/活跃型"会把所有自定义人设拉回同一种节奏。
  assert.equal(build('同一张卡', 'low'), build('同一张卡', 'high'));
});

test('grounded 档不否认定时工具：教了 remind / schedule_wake 就不说"没有安排定时承诺的工具"（2026-10-13 审查）', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const prompt = buildSystemPrompt({ persona: groundedPersona() });
  // 同一份提示词里既教 remind / schedule_wake 的用法、又说"没有安排定时承诺的工具"，
  // 模型会照句子拒设提醒 —— 与本批修的"提醒归属"反馈面直接冲突（独立审查抓到）。
  assert.ok(prompt.includes('schedule_wake'), 'grounded 提示词里应有 schedule_wake 的用法');
  assert.ok(prompt.includes('remind'), 'grounded 提示词里应有 remind 的用法');
  assert.match(prompt, /remind \/ schedule_wake 只是让系统到点唤醒你一次/,
    '该说的边界是"只是到点唤醒一次"，不是"没有这类工具"');
  assert.doesNotMatch(prompt, /没有执行代码、操作引擎或安排定时承诺的工具/,
    '这句与同文的 remind / schedule_wake 教学矛盾');
});

test('所有社交场景都带上同一份角色与附加规则，人设哈希随之失效', () => {
  const persona = groundedPersona();
  for (const build of [
    (p) => buildSystemPrompt({ persona: p }),
    buildMomentSystemPrompt,
    buildQzoneInteractionPrompt,
    buildFriendReviewSystemPrompt
  ]) {
    const result = build({ ...persona, customRules: '测试附加规则' });
    assert.ok(result.includes(persona.roleText));
    assert.ok(result.includes('测试附加规则'));
  }
  for (const hash of [momentPersonaHash, qzoneInteractionPersonaHash]) {
    assert.notEqual(hash(DEFAULT_CONFIG.persona), hash(persona));
  }
  assert.doesNotMatch(buildMomentSystemPrompt(persona), /【工作方式/);
  assert.doesNotMatch(buildQzoneInteractionPrompt(persona), /【反 AI 味/);
});

test('人设档位持久化、保留手改正文、原子拒绝非法值', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  assert.equal(normalizeBehaviorProfile(undefined), 'legacy');
  updateConfig({ persona: groundedPersona() });
  assert.equal(loadConfig().persona.behaviorProfile, 'grounded');
  updateConfig({ persona: { roleText: `${groundedPersona().roleText}\n补充偏好` } });
  assert.equal(loadConfig().persona.behaviorProfile, 'grounded');
  assert.ok(loadConfig().persona.roleText.endsWith('补充偏好'));
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  for (const invalid of ['unknown', '', 1, {}, true]) {
    assert.throws(() => updateConfig({ persona: { behaviorProfile: invalid } }), /behavior profile/);
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before);
    assert.equal(getConfig().persona.behaviorProfile, 'grounded');
  }
  updateConfig({ persona: { ...DEFAULT_CONFIG.persona } });
  assert.equal(loadConfig().persona.behaviorProfile, 'legacy');
  assert.equal(loadConfig().persona.roleText, PERSONAS.xiaojingyu.text);
});

test('grounded 的代码格式保留运算符、缩进与行内代码', () => {
  const code = [
    '#if DEBUG',
    '    var product = a * b * c;',
    '    var mask = left | right;',
    '    var label = "__keep__";',
    '    var test = value > 0 && value < 10;',
    '    var markdown = "[name](url)";',
    '#endif'
  ].join('\n');
  const input = `**Example**\n\`\`\`csharp\n${code}\n\`\`\`\nInline \`a * b * c\`.`;
  assert.equal(mdToPlain(input, { preserveCode: true }), `Example\n${code}\nInline a * b * c.`);
  assert.equal(mdToPlain(`~~~cpp\n${code}\n~~~`, { preserveCode: true }), code);
  assert.equal(mdToPlain('```cs\r\n    x *= 2;\r\n```', { preserveCode: true }), '    x *= 2;');
  assert.equal(mdToPlain('````cs\nvar s = "```";\n````', { preserveCode: true }), 'var s = "```";');
  assert.equal(mdToPlain('\u0000QQ_CODE_0\u0000 `a * b * c`', { preserveCode: true }),
    '\u0000QQ_CODE_0\u0000 a * b * c');
  assert.equal(mdToPlain('**hello**\n- item'), 'hello\n• item');
  assert.equal(mdToPlain('`a * b * c`'), 'a  b  c');
});

test('grounded 会话通过工具与出站队列发出完整代码', async (t) => {
  const { ChatStore } = await import('../src/core/store.js');
  const { SessionRegistry } = await import('../src/core/sessions.js');
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const { SendQueue } = await import('../src/onebot/sender.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona = groundedPersona();
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['123'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  const code = '    var product = a * b * c;\n    var mask = left | right;';
  const sent = [];
  const onebot = {
    getGroupInfo: async () => ({ group_name: 'Test' }),
    sendText: async (kind, id, text) => { sent.push({ kind, id, text }); return { message_id: 9 }; }
  };
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry();
  const runner = new Orchestrator({
    store, sessions, onebot, stickers: {}, memory: { formatForPrompt: () => '' },
    sender: new SendQueue({ store, onebot })
  });
  const previousFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = previousFetch;
    await runner.abortAll();
    store.close();
  });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.ok(request.messages[0].content.includes('【安全规则（最高优先级，不可违反）】'));
    calls++;
    if (calls === 1) {
      // 运行途中改设置，不能改变已开始这一轮的消息格式
      setRuntimeConfig({ ...cfg, persona: { ...DEFAULT_CONFIG.persona } });
    }
    return Response.json({
      choices: [{ message: calls === 1 ? { tool_calls: [{
        id: 'code-send', type: 'function',
        function: { name: 'send_message', arguments: JSON.stringify({ messages: `\`\`\`cs\n${code}\n\`\`\`` }) }
      }] } : { content: '' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    });
  };
  store.appendIncoming('group:123', { mid: 1, senderId: '42', text: 'Show code' });
  await runner.wake('group:123');
  assert.deepEqual(sent, [{ kind: 'group', id: '123', text: code }]);
  assert.equal(store.findByMid('group:123', 9).text, code);
  assert.equal(store.findByMid('group:123', 1).state, 'acked');
});

test('控制台接口能列出、选择、自定义与回退内置卡', async (t) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  const { createApp } = await import('../src/console/app.js');
  const app = createApp({ log: () => {} });
  app.onebot.connect = async () => {};
  t.after(async () => { await app.stop(); });
  await app.start();
  const request = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const templates = (await (await request('/api/persona-templates')).json()).templates;
  const builtin = templates.find((p) => p.id === 'jishu_zhai');
  assert.equal(builtin.text, groundedPersona().roleText);
  assert.equal(builtin.behaviorProfile, 'grounded');
  assert.equal(builtin.builtin, true);
  assert.equal((await request('/api/config', { persona: groundedPersona() })).status, 200);
  assert.equal((await (await request('/api/config')).json()).persona.behaviorProfile, 'grounded');
  const custom = { name: 'Grounded copy', text: builtin.text, customRules: 'Prefer concise examples', behaviorProfile: 'grounded' };
  assert.equal((await request('/api/persona-templates', custom)).status, 200);
  const saved = (await (await request('/api/persona-templates')).json()).templates.find((p) => p.name === custom.name);
  assert.equal(saved.customRules, custom.customRules);
  assert.equal(saved.behaviorProfile, custom.behaviorProfile);
  assert.equal((await request('/api/persona-templates', { name: 'Old API', text: 'Old role' })).status, 200);
  assert.equal(getConfig().customPersonas.at(-1).behaviorProfile, 'legacy');
  assert.equal((await request('/api/persona-templates', { ...custom, behaviorProfile: 'bad' })).status, 400);
  assert.equal((await request('/api/config', { persona: DEFAULT_CONFIG.persona })).status, 200);
  assert.equal(getConfig().persona.behaviorProfile, 'legacy');
});
