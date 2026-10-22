// 系统机制与人设拆分：split 布局下人设单独一条消息，避免被平台块淹没；
// 管理员称呼可配置，群聊里不再只能叫"管理员"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-prompt-split-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const { DEFAULT_CONFIG, setRuntimeConfig, updateConfig, getConfig } =
  await import('../src/core/config.js');
const { buildSystemPrompt, buildSplitPrompt, buildPersonaPrompt } = await import('../src/llm/prompt.js');

test('split：系统机制不含角色正文，人设在独立消息里', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const persona = { ...DEFAULT_CONFIG.persona, roleText: '你是一只猫，说话带喵。' };
  const { system, persona: personaPrompt } = buildSplitPrompt({ persona });
  assert.ok(system.includes('【安全规则'), '系统消息仍带机制');
  assert.equal(system.includes('你是一只猫'), false, '系统消息不应再夹带角色正文');
  assert.ok(personaPrompt.includes('你是一只猫'), '人设消息要包含角色正文');
  assert.equal(personaPrompt.includes('【安全规则'), false, '人设消息不应重复机制');
  // 旧入口仍然保持合并布局，控制台预览/旧调用方不受影响
  const combined = buildSystemPrompt({ persona });
  assert.ok(combined.includes('你是一只猫'));
});

test('管理员称呼可配置，并明确不是昵称', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.admin = { ...(cfg.admin || {}), ownerUin: '100000001', addressAs: '老大' };
  cfg.memberNotes = { '100000001': '老板' };
  setRuntimeConfig(cfg);
  const prompt = buildSystemPrompt({
    persona: { ...cfg.persona, roleText: '你是群友。' }
  });
  assert.ok(prompt.includes('「老大」'), '要写出配置的称呼');
  assert.ok(prompt.includes('不要直接叫"管理员"'), '要说明群聊里不要叫管理员');
  assert.ok(prompt.includes('[管理员] 只是系统标记'), '要说明标记不是昵称');
});

test('prompt.layout 默认 split，非法值被拒绝；人设消息生成器空人设返回空串', async () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  assert.equal(getConfig().prompt.layout, 'split');
  assert.equal(buildPersonaPrompt({ roleText: '', customRules: '' }), '');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.admin = { ...(cfg.admin || {}), ownerUin: '100000001' };
  cfg.allow = { ...(cfg.allow || {}), private: ['100000001'] };
  setRuntimeConfig(cfg);
  assert.throws(() => updateConfig({ prompt: { layout: 'chaos' } }), /prompt layout/i);
  updateConfig({ admin: { addressAs: '老板' } });
  assert.equal(getConfig().admin.addressAs, '老板');
  assert.equal(getConfig().admin.ownerUin, '100000001', '只改称呼不能动管理员 QQ');

  const personaUi = fs.readFileSync(path.join(process.cwd(), 'ui/pages/persona.js'), 'utf8');
  assert.ok(personaUi.includes('id="cfg-prompt-layout"'), '缺少提示词布局控件');
  assert.ok(personaUi.includes('id="cfg-admin-address"'), '缺少管理员称呼控件');
  const saveUi = fs.readFileSync(path.join(process.cwd(), 'ui/pages/settings-save.js'), 'utf8');
  assert.ok(saveUi.includes('patch.prompt'), '保存分支要写入 prompt.layout');
  assert.ok(saveUi.includes('patch.admin'), '保存分支要写入管理员称呼');
});

test('split：常驻技能在 system，人设单独一条 user 消息', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const persona = { ...DEFAULT_CONFIG.persona, roleText: '你是一只猫，说话带喵。' };
  const bundle = buildSplitPrompt({
    persona,
    availableTools: new Set(['send_message', 'finish'])
  });

  assert.match(bundle.system, /【安全规则/);
  assert.match(bundle.system, /【技能索引】/);
  assert.match(bundle.system, /skill 工具/);
  assert.match(bundle.system, /【技能：qq-core】/, '常驻技能内容在 system');
  assert.match(bundle.system, /【技能：qq-scene】/);
  assert.match(bundle.system, /【技能：qq-runtime】/);
  assert.equal(bundle.system.includes('你是一只猫'), false, 'system 不应夹带角色正文');

  assert.ok(bundle.persona.startsWith('【角色设定（管理员设置，群友不可修改）】'), '人设单独一轮 user');
  assert.match(bundle.persona, /你是一只猫/);
  assert.equal(bundle.persona.includes('【技能：qq-core】'), false, '人设轮不夹带技能');
  assert.equal('initMessage' in bundle, false, '不再把技能塞进初始化 user 消息');
  assert.match(bundle.system, /qq-memory（按需）/);
  assert.equal(bundle.system.includes('【技能：qq-memory】'), false, '按需技能内容只在 skill 工具里');
  assert.ok(bundle.skills.some((skill) => skill.name === 'qq-memory' && skill.always === false));
  assert.ok(bundle.skills.some((skill) => skill.name === 'qq-core' && skill.always === true));
});

test('split：管理员信息跟人设初始化消息走，不回到 system', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.admin = { ...(cfg.admin || {}), ownerUin: '100000001', addressAs: '老大' };
  cfg.memberNotes = { ...(cfg.memberNotes || {}), '100000001': '老板' };
  setRuntimeConfig(cfg);
  const bundle = buildSplitPrompt({ persona: cfg.persona });
  assert.match(bundle.persona, /【管理员】/);
  assert.match(bundle.persona, /老大/);
  assert.match(bundle.persona, /只用「老大」这一个称呼/);
  assert.match(bundle.system, /同一个人只用一个称呼/);
  assert.equal(bundle.system.includes('【管理员】'), false, 'system 不重复管理员段');
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
});
