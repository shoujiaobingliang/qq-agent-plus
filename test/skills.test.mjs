// 技能加载与 skill 工具：技能是给模型看的操作手册，不是群友消息。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-skills-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const {
  clearSkillCacheForTest,
  createSkillRegistry,
  listSkills,
  parseSkillMarkdown
} = await import('../src/skills/registry.js');
const { buildToolDefs } = await import('../src/tools/tools-core.js');
const { experimentalToolClass } = await import('../src/pilots/experimental-tool-scheduler.js');

function makeRoot(name) {
  const dir = fs.mkdtempSync(path.join(root, name));
  return dir;
}

function writeSkill(dir, name, {
  description = '测试技能',
  always = false,
  body = '# 测试\n\n技能正文。'
} = {}) {
  const target = path.join(dir, name);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `always: ${always}`,
    '---',
    body
  ].join('\n'));
}

test('frontmatter：LF/CRLF、name 校验、保留名、空正文', () => {
  const crlf = parseSkillMarkdown([
    '---',
    'name: qq-test',
    'description: "带引号的说明"',
    'always: yes',
    '---',
    '# 标题',
    '正文'
  ].join('\r\n'), { fallbackName: 'qq-test', source: 'user' });
  assert.equal(crlf.skill.name, 'qq-test');
  assert.equal(crlf.skill.description, '带引号的说明');
  assert.equal(crlf.skill.always, true);
  assert.match(crlf.skill.content, /正文/);

  assert.match(parseSkillMarkdown('---\nname: ../evil\n---\nx', { fallbackName: 'evil' }).error, /名称|无效/);
  assert.match(parseSkillMarkdown('---\nname: qq-core\n---\nx', { fallbackName: 'qq-core' }).error, /保留名/);
  assert.match(parseSkillMarkdown('---\nname: other\n---\nx', { fallbackName: 'dir' }).error, /目录名一致/);
  assert.match(parseSkillMarkdown('---\nname: empty\n---\n  ', { fallbackName: 'empty' }).error, /正文为空/);
});

test('注册表：用户目录覆盖内置目录，保留名被跳过，缺失目录返回空', () => {
  const builtin = makeRoot('builtin-');
  const user = makeRoot('user-');
  writeSkill(builtin, 'same-skill', { body: '内置版本' });
  writeSkill(user, 'same-skill', { body: '用户版本' });
  writeSkill(user, 'user-only', { always: true });
  writeSkill(user, 'qq-core', { body: '不能覆盖运行协议' });

  const registry = createSkillRegistry({ builtinRoot: builtin, userRoot: user });
  const { skills, errors } = registry.load();
  assert.deepEqual(errors, []);
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  assert.equal(byName.get('same-skill').content, '用户版本');
  assert.equal(byName.get('user-only').always, true);
  assert.equal(byName.has('qq-core'), false, '保留名不能被磁盘技能覆盖');

  const missing = createSkillRegistry({
    builtinRoot: path.join(builtin, 'nope'),
    userRoot: path.join(user, 'nope')
  });
  assert.deepEqual(missing.load(), { skills: [], errors: [] });
  assert.deepEqual(missing.list(), []);
});

test('skill 工具：列索引、读全文、未知技能报错、回退磁盘', async () => {
  const tool = buildToolDefs().find((entry) => entry.name === 'skill');
  assert.ok(tool, '工具表里应有 skill');

  const ctx = {
    skills: [
      { name: 'qq-memory', description: '记忆', always: false, source: 'builtin', content: '记忆正文' },
      { name: 'qq-core', description: '核心', always: true, source: 'builtin', content: '核心正文' }
    ]
  };
  const listResult = await tool.execute(ctx, {});
  const list = JSON.parse(listResult.content);
  assert.equal(list.count, 2);
  assert.deepEqual(list.skills.map((skill) => skill.name), ['qq-memory', 'qq-core']);

  const readResult = await tool.execute(ctx, { name: 'qq-memory' });
  const read = JSON.parse(readResult.content);
  assert.equal(read.content, '记忆正文');
  assert.equal(read.always, false);

  const missing = await tool.execute(ctx, { name: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /qq-memory/);

  // 没有 ctx.skills 时回退到 DATA_DIR/skills 的磁盘技能。
  writeSkill(path.join(root, 'skills'), 'disk-skill', { body: '磁盘正文' });
  clearSkillCacheForTest();
  const disk = await tool.execute({}, { name: 'disk-skill' });
  assert.equal(JSON.parse(disk.content).content, '磁盘正文');
  assert.ok(listSkills().some((skill) => skill.name === 'disk-skill'));
});

test('skill 是串行读取工具，不参与并发预启动', () => {
  assert.equal(experimentalToolClass('skill'), 'ordered-read');
});
