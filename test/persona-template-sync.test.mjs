// 内置角色卡的"文件即来源"约定：
//   控制台选卡时会把模板 id 存进 persona.templateId；只要还绑着内置卡，
//   载入配置 / 保存配置时就按 roles/*.md 的正文刷新实例副本。
//
// 背景：实例里存的是正文副本，以前改了卡必须回控制台重选一次才生效
// （"改完卡没生效"被反复当成 bug 报上来）。这里同时盯住反面：手改正文、
// 用自定义卡、以及**老配置没有 templateId 键**时，正文绝不能被文件覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-sync-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.DEBUG_SERVER_URL = 'http://127.0.0.1:1/event';

const { PERSONAS, applyPersonaTemplate, builtinPersonaTemplate, PERSONA_TEMPLATE_IDS } =
  await import('../src/personas.js');
const { loadConfig, updateConfig, getConfig, CONFIG_FILE } = await import('../src/core/config.js');

const writeConfig = (persona) => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ persona }, null, 2), { mode: 0o600 });
};
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

test('登记的模板 id 都能取到卡，未知 id 返回 null', () => {
  assert.ok(PERSONA_TEMPLATE_IDS.includes('tsundere_loli'));
  assert.equal(builtinPersonaTemplate('tsundere_loli').name, '傲娇萝莉');
  assert.equal(builtinPersonaTemplate('custom_0'), null);
  assert.equal(builtinPersonaTemplate(''), null);
  assert.equal(builtinPersonaTemplate(undefined), null);
});

test('绑定的内置卡：载入时按卡文件刷新正文（改了卡不用重选）', () => {
  // 档位故意写成与卡不同的值：绑定的卡只管正文，档位是实例自己的开关（见 personas.js 注释）
  writeConfig({ templateId: 'tsundere_loli', roleText: '# 角色卡：傲娇萝莉\n（实例里的旧正文）', behaviorProfile: 'grounded' });
  const cfg = loadConfig();
  assert.equal(cfg.persona.roleText, PERSONAS.tsundere_loli.text, '正文应被卡文件刷新');
  assert.equal(cfg.persona.behaviorProfile, 'grounded', '刷新正文不该顺手改掉档位');
});

test('卡文件改了以后，下次载入就跟着变（模拟升级带的正文更新）', () => {
  const original = PERSONAS.tsundere_loli.text;
  try {
    PERSONAS.tsundere_loli.text = '# 角色卡：傲娇萝莉\n（升级后的新正文）';
    writeConfig({ templateId: 'tsundere_loli', roleText: original, behaviorProfile: 'legacy' });
    assert.equal(loadConfig().persona.roleText, PERSONAS.tsundere_loli.text);
  } finally {
    PERSONAS.tsundere_loli.text = original;
  }
  // 绑定关系还在：磁盘上放一份过期正文，下次载入照样被刷回文件内容
  writeConfig({ templateId: 'tsundere_loli', roleText: '（绑定还在，但这正文过期了）', behaviorProfile: 'legacy' });
  assert.equal(loadConfig().persona.roleText, PERSONAS.tsundere_loli.text);
});

test('磁盘上人设段是标量/数组/字符串时：载入与保存都不打崩', () => {
  for (const bad of ['小鲸鱼', 42, true, []]) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ persona: bad }, null, 2), { mode: 0o600 });
    const cfg = loadConfig();
    assert.equal(typeof cfg.persona, 'object', `persona=${JSON.stringify(bad)} 应被换回对象`);
    assert.ok(cfg.persona.botName, '换回的人设对象应带默认字段');
    assert.doesNotThrow(() => updateConfig({ runtime: { mode: 'observe' } }), `persona=${JSON.stringify(bad)} 时保存不该抛错`);
    assert.equal(getConfig().persona.botName, '小鲸鱼');
  }
  // roleText 空串是合法状态（故意不挂卡），不该被"兜底"成默认卡
  writeConfig({ templateId: '', roleText: '', behaviorProfile: 'legacy' });
  assert.equal(loadConfig().persona.roleText, '');
});

test('未绑定（手改正文 / 自定义卡）：正文原样保留', () => {
  writeConfig({ templateId: '', roleText: '我手改的正文', behaviorProfile: 'grounded' });
  let cfg = loadConfig();
  assert.equal(cfg.persona.roleText, '我手改的正文');
  assert.equal(cfg.persona.behaviorProfile, 'grounded', '未绑定时档位也不该被改');

  writeConfig({ templateId: 'custom_0', roleText: '自定义卡正文', behaviorProfile: 'legacy' });
  cfg = loadConfig();
  assert.equal(cfg.persona.roleText, '自定义卡正文');
});

test('老配置（没有 templateId 键）不会被误绑成默认卡', () => {
  // 默认值里带的是 templateId: 'xiaojingyu'，迁移必须补空串把它挡住
  writeConfig({ roleText: '# 角色卡：傲娇萝莉\n（老实例里存着的傲娇萝莉正文）' });
  const cfg = loadConfig();
  assert.equal(cfg.persona.templateId, '');
  assert.ok(cfg.persona.roleText.includes('傲娇萝莉'), '老实例的正文不能被换成默认卡');
  assert.notEqual(cfg.persona.roleText, PERSONAS.xiaojingyu.text);
});

test('保存配置时同样会刷新，且只在绑定时生效', () => {
  writeConfig({ templateId: 'tsundere_loli', roleText: '旧正文', behaviorProfile: 'legacy' });
  updateConfig({ persona: { templateId: 'tsundere_loli', roleText: '旧正文' } });
  assert.equal(updateConfig({}).persona.roleText, PERSONAS.tsundere_loli.text);

  // 解绑后保存自己的正文：不会被文件覆盖，且落盘
  updateConfig({ persona: { templateId: '', roleText: '解绑后的自定义正文' } });
  assert.equal(readConfig().persona.roleText, '解绑后的自定义正文');
  assert.equal(readConfig().persona.templateId, '');
});

test('applyPersonaTemplate 对空配置/坏配置不抛错', () => {
  assert.equal(applyPersonaTemplate(null), null);
  assert.equal(applyPersonaTemplate({}), null);
  assert.equal(applyPersonaTemplate({ persona: {} }), null);
  assert.equal(applyPersonaTemplate({ persona: null }), null);
  assert.equal(applyPersonaTemplate({ persona: 'not-an-object' }), null);
  assert.equal(applyPersonaTemplate({ persona: { templateId: 'tsundere_loli', roleText: PERSONAS.tsundere_loli.text } }), null);
  const note = applyPersonaTemplate({ persona: { templateId: 'tsundere_loli', roleText: 'stale' } });
  assert.deepEqual(note, { id: 'tsundere_loli', name: '傲娇萝莉' });
});

test('认不出的 templateId 会被清成未绑定（不留永远不生效的 id）', () => {
  const cfg = { persona: { templateId: 'nope', roleText: '我的正文', behaviorProfile: 'legacy' } };
  assert.equal(applyPersonaTemplate(cfg), null);
  assert.equal(cfg.persona.templateId, '');
  assert.equal(cfg.persona.roleText, '我的正文', '清 id 不该动正文');

  writeConfig({ templateId: 'custom_0', roleText: '自定义卡正文', behaviorProfile: 'legacy' });
  assert.equal(loadConfig().persona.templateId, '');
});

test('人设字段传了非对象（null / 字符串）时当没改，不会打崩保存', () => {
  // 不依赖磁盘/缓存先后顺序：先把运行态设成想要的样子，再断言坏 patch 什么都没改
  updateConfig({ persona: { templateId: 'tsundere_loli', roleText: '旧正文', behaviorProfile: 'legacy' } });
  const before = structuredClone(getConfig().persona);
  assert.equal(before.roleText, PERSONAS.tsundere_loli.text);

  assert.doesNotThrow(() => updateConfig({ persona: null }));
  assert.deepEqual(getConfig().persona, before, '坏 patch 不该改动人设');
  assert.doesNotThrow(() => updateConfig({ persona: 'oops' }));
  assert.doesNotThrow(() => updateConfig({ persona: [] }));
  assert.deepEqual(getConfig().persona, before, '字符串 / 数组同理');
  assert.ok(getConfig().persona.botName, '人设对象仍然完整');
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
