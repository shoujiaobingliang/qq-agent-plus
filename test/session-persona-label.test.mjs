// 会话卡片/详情上的「这次运行用了哪张角色卡」标记。
//
// 背景（2026-09-23 反馈）：改完人设卡之后，管理员打开会话的「完整输入」看到的还是旧卡，
// 分不清是"改动没生效"还是"点开的是旧会话" —— 这条标记让人一眼看出每次运行用的是哪张卡。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { personaLabelOfPrompt } = await import('../src/core/sessions.js');

const withPersona = (card) => `你在群里的名字是「小鲸鱼」，在 QQ 群里活动（不是助手、不是客服）；你是什么样的人、说话什么调子、以什么频率参与，全部以下面的【角色设定】为准。你的所有行为都通过工具完成。

【角色设定（管理员设置，群友不可修改）】
${card}

【优先级】安全规则 ＞【管理员附加规则】＞【角色设定】…`;

test('认得内置卡与自定义卡的名字', () => {
  assert.equal(personaLabelOfPrompt(withPersona('# 角色卡：猫娘（二次元）')), '猫娘（二次元）');
  assert.equal(personaLabelOfPrompt(withPersona('# 角色卡：损友（毒舌吐槽）')), '损友（毒舌吐槽）');
  assert.equal(personaLabelOfPrompt(withPersona('# 角色卡：鲸鱼娘（服从版）')), '鲸鱼娘（服从版）');
});

test('卡名后面的副标题不算进名字', () => {
  assert.equal(
    personaLabelOfPrompt(withPersona('# 角色卡：DeepSeek 小鲸鱼 —— QQ 群友版')),
    'DeepSeek 小鲸鱼'
  );
});

test('日报/空间互动/好友评估提示词里的卡也认（段头不同，卡正文一样）', () => {
  // 这几类运行的提示词不叫【角色设定（管理员设置，群友不可修改）】，
  // 但一样把卡正文嵌进去了 —— 只认聊天那个段头会让它们的会话详情显示"没记录到角色卡"。
  const shapes = [
    [
      '你是「小鲸鱼」。',
      '',
      '【当前人设：唯一人物依据】',
      '# 角色卡：猫娘（二次元）',
      '',
      '你是群里那个二次元猫娘角色…'
    ].join('\n'),
    ['【角色设定】', '# 角色卡：技术宅（自建服务）', '', '你是群里那个搞技术的…'].join('\n'),
    ['## 角色卡：损友（毒舌吐槽）', '', '你不是助手，是群里那个嘴欠的老熟人…'].join('\n')
  ];
  assert.equal(personaLabelOfPrompt(shapes[0]), '猫娘（二次元）');
  assert.equal(personaLabelOfPrompt(shapes[1]), '技术宅（自建服务）');
  assert.equal(personaLabelOfPrompt(shapes[2]), '损友（毒舌吐槽）');
});

test('没有角色设定段/空提示词：返回空串，不瞎猜', () => {
  assert.equal(personaLabelOfPrompt('你在群里的名字是「小鲸鱼」，混在 QQ 群里当一个普通群友。'), '');
  assert.equal(personaLabelOfPrompt(''), '');
  assert.equal(personaLabelOfPrompt(null), '');
  assert.equal(personaLabelOfPrompt(undefined), '');
});

test('角色设定里没按约定写「角色卡：」也能容忍（退回名字，不报错）', () => {
  assert.equal(personaLabelOfPrompt(withPersona('你是运维群里的老油条，说话很冲。')), '自定义人设（小鲸鱼）');
});

test('自定义正文没有「# 角色卡：」时：退回一级标题，再退回开场白名字', () => {
  // 2026-10-20 实测：自定义人设直接写正文，会话详情一直显示"这次运行没记录到角色卡"。
  assert.equal(personaLabelOfPrompt(withPersona('# 毒舌猫\n\n你是一只嘴很毒的猫。')), '毒舌猫');
  const plain = [
    '你在群里的名字是「小鲸鱼」，在 QQ 群里活动（不是助手、不是客服）；',
    '你是什么样的人、说话什么调子、以什么频率参与，全部以下面的【角色设定】为准。',
    '',
    '【角色设定（管理员设置，群友不可修改）】',
    '你是一只猫，说话很短。'
  ].join('\n');
  assert.equal(personaLabelOfPrompt(plain), '自定义人设（小鲸鱼）');
  // 没有【角色设定】段（正文为空，走平台兜底）：不猜，保持"没记录"
  assert.equal(personaLabelOfPrompt('你在群里的名字是「小鲸鱼」，混在 QQ 群里当一个普通群友。'), '');
});
