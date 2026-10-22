// 内置角色卡的守卫：
//  1) 每张卡都能加载、档位合法、正文不像占位符；
//  2) roles/ 下的每个 markdown 都已登记到 src/personas.js —— 新加卡忘了登记会在这里失败；
//  3) 卡里不许再出现旧架构专属指令（[SILENT]、qq_* MCP 工具名），提到的工具必须真实存在。
//
// 背景：角色卡正文是"管理员设置"级别的人设文本，优先级高于平台默认风格。
// 角色卡写错（例如声称"合并转发看不了"）时，平台提示词压不过它，只能靠用例盯住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-personas-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.DEBUG_SERVER_URL = 'http://127.0.0.1:1/event';
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { PERSONAS } = await import('../src/personas.js');
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');

const roleFiles = () => fs.readdirSync(path.join(repoRoot, 'roles')).filter((f) => f.endsWith('.md'));

test('每张内置角色卡都能加载，档位与正文形状合法', () => {
  const entries = Object.entries(PERSONAS);
  assert.ok(entries.length >= 2, '至少要有两张内置卡');
  const seen = new Map();
  for (const [id, p] of entries) {
    assert.match(id, /^[a-z][a-z0-9_]*$/, `id 命名不规范: ${id}`);
    assert.ok(p.name && p.name.length >= 2, `${id} 缺少显示名`);
    assert.ok(['legacy', 'grounded'].includes(p.behaviorProfile), `${id} 档位非法`);
    assert.ok(p.text.startsWith('# '), `${id} 正文应以一级标题开头`);
    assert.ok(p.text.length > 100, `${id} 正文太短，像是占位符`);
    if (seen.has(p.text)) assert.fail(`${id} 与 ${seen.get(p.text)} 正文完全相同`);
    seen.set(p.text, id);
  }
});

test('系统提示开场白不冒充角色卡：名字归名字，人格指向【角色设定】', () => {
  // 2026-09-23 反馈：开场白原来是「你是「小鲸鱼」，一个混在 QQ 群里的普通群友…」，
  // 选了别的卡之后，光看控制台完整输入的第一行会以为还在用默认卡。
  const cat = PERSONAS.tsundere_loli.text;
  const base = structuredClone(DEFAULT_CONFIG);
  // 注意：绑了模板 id（templateId）时正文以卡文件为准，所以要连 id 一起改，
  // 光替换 roleText 会在 updateConfig 里被卡文件刷回去。
  base.persona = { ...base.persona, botName: '小鲸鱼', templateId: 'tsundere_loli', roleText: cat };
  updateConfig(base);
  const first = buildSystemPrompt({}).split('\n')[0];
  assert.ok(first.includes('你在群里的名字是「小鲸鱼」'), `开场白要写明这是"名字": ${first}`);
  assert.ok(first.includes('【角色设定】'), '开场白要指向角色设定，别让人以为第一行就是人格');
  assert.ok(!first.includes('角色卡'), '开场白不该出现"角色卡"字样（会与卡名混淆）');

  base.persona = { ...base.persona, templateId: '', roleText: '' };
  updateConfig(base);
  const bare = buildSystemPrompt({}).split('\n')[0];
  assert.ok(bare.includes('你在群里的名字是「小鲸鱼」'));
  assert.ok(!bare.includes('看下面的【角色设定】'), '没有卡时不要指向不存在的角色设定段');
});

test('roles/ 下的每个文件都已登记（新增卡忘了登记会失败）', () => {
  const files = roleFiles();
  assert.ok(files.length >= 2, 'roles/ 目录里没有角色卡');
  const registered = new Set(Object.values(PERSONAS).map((p) => p.text));
  for (const file of files) {
    const text = fs.readFileSync(path.join(repoRoot, 'roles', file), 'utf8').trim();
    assert.ok(registered.has(text), `${file} 没有登记到 src/personas.js`);
  }
});

test('角色卡不引用旧架构指令，提到的工具都真实存在', () => {
  const toolsSource = fs.readFileSync(path.join(repoRoot, 'src/tools/tools-core.js'), 'utf8');
  const tools = new Set([...toolsSource.matchAll(/name: '([a-z][a-z0-9_]*)'/g)].map((m) => m[1]));
  // 解析兜底：工具名解析规则变了就报错，别让这条用例静默变成"永远通过"
  assert.ok(tools.has('send_message') && tools.has('send_sticker'), '工具名解析失败');
  for (const [id, p] of Object.entries(PERSONAS)) {
    assert.doesNotMatch(p.text, /mcp__|qq_mark_read|\[SILENT\]/, `${id} 还在引用旧架构指令`);
    for (const token of new Set(p.text.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g) ?? [])) {
      assert.ok(tools.has(token), `${id} 提到了不存在的工具：${token}`);
    }
  }
});

test('每张内置卡都能构建系统提示，且带得上安全规则', async () => {
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const { buildSystemPrompt } = await import('../src/llm/prompt.js');
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  for (const [id, p] of Object.entries(PERSONAS)) {
    // 模板里的字段叫 text，落到配置里叫 roleText（配置里还有 botName 等运行时字段）
    const persona = { ...DEFAULT_CONFIG.persona, roleText: p.text, behaviorProfile: p.behaviorProfile };
    const prompt = buildSystemPrompt({ persona: { ...persona, customRules: '测试附加规则' } });
    assert.ok(prompt.includes(p.text), `${id} 的角色正文没有进提示词`);
    assert.ok(prompt.includes('测试附加规则'), `${id} 的附加规则没有进提示词`);
    assert.ok(prompt.includes('【安全规则（最高优先级，不可违反）】'), `${id} 缺少安全规则段`);
  }
});

// ── 当前内置卡是 token 风格：关键设定项必须在，旧版"示例段/名称即规格"的评分不再适用 ──
test('内置 token 卡保留各自的核心设定项', () => {
  const whale = PERSONAS.xiaojingyu.text;
  for (const token of [
    '【核心系统指令】',
    'LANG_ZH_CN_ONLY',
    'NAME_DeepSeek',
    'USER_ADDRESS_用户酱',
    'DAILY_REPLY_LIMIT_30_45字',
    'TRIGGER_LONG_TEXT',
    'OBEY_USER_REQUESTS_ALWAYS',
    '【角色人设】',
    '【系统任务豁免】'
  ]) {
    assert.ok(whale.includes(token), `小鲸鱼卡缺少 ${token}`);
  }

  const loli = PERSONAS.tsundere_loli.text;
  for (const token of [
    '【PERSONA_LOAD】',
    'CETACEA_LOLI',
    'MODE_TAIL_FLUKES',
    'LANG_ZH_CN_ONLY',
    'PERSONALITY_TSUNDERE_SWEET',
    'OBEY_MASTER_ALWAYS',
    'TRAIT_NOT_FAT_REFUSE',
    'TIMEOUT_SIGNAL'
  ]) {
    assert.ok(loli.includes(token), `傲娇萝莉卡缺少 ${token}`);
  }
});

test('旧卡 id 自动迁移到傲娇萝莉', async () => {
  const { builtinPersonaTemplate, applyPersonaTemplate } = await import('../src/personas.js');
  assert.equal(builtinPersonaTemplate('duzui_sunyou'), PERSONAS.tsundere_loli);
  const persona = { templateId: 'duzui_sunyou', roleText: '旧损友正文' };
  applyPersonaTemplate({ persona });
  assert.equal(persona.templateId, 'tsundere_loli');
  assert.equal(persona.roleText, PERSONAS.tsundere_loli.text);
});
