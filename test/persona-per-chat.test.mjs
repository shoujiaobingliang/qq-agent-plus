// 按群人设（personaPerChat）：全局 persona + 每个会话的覆盖。
//
// 关键性质：没配的会话逐字节等于全局（升级前后行为一致）；配了内置卡的会话，
// 正文与档位以卡文件为准；坏键/坏字段在载入时就被丢掉，不让手改坏的配置进提示词。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-chat-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { applyPersonaPerChatTemplates, resolvePersona, PERSONAS } = await import('../src/personas.js');
const { normalizePersonaPerChat } = await import('../src/core/config-legacy.js');

const base = {
  botName: '小鲸鱼',
  selfNickname: '',
  roleText: PERSONAS.xiaojingyu.text,
  behaviorProfile: 'legacy',
  participation: 'medium',
  customRules: '',
  templateId: 'xiaojingyu'
};

test('没配置覆盖的会话：返回的就是全局那份（引用同一对象，零开销）', () => {
  const cfg = { persona: base, personaPerChat: {} };
  assert.equal(resolvePersona(cfg, 'group:100'), base);
  assert.equal(resolvePersona(cfg, 'private:200'), base);
});

test('按群绑定内置卡：正文与档位都跟卡走，其余字段继承全局', () => {
  const cfg = {
    persona: base,
    personaPerChat: { 'group:100': { templateId: 'tsundere_loli' } }
  };
  const resolved = resolvePersona(cfg, 'group:100');
  assert.equal(resolved.roleText, PERSONAS.tsundere_loli.text, '正文以卡文件为准');
  assert.equal(resolved.behaviorProfile, 'legacy', '档位也跟卡走');
  assert.equal(resolved.botName, '小鲸鱼', '没写的字段继承全局');
  assert.equal(resolved.participation, 'medium');
  // 别的群不受影响
  assert.equal(resolvePersona(cfg, 'group:200'), base);
});

test('按群显式覆盖档位 / 名字 / 附加规则：覆盖优先', () => {
  const cfg = {
    persona: base,
    personaPerChat: {
      'group:100': {
        templateId: 'tsundere_loli', behaviorProfile: 'grounded', botName: '猫猫', customRules: '别撒娇过头'
      }
    }
  };
  const resolved = resolvePersona(cfg, 'group:100');
  assert.equal(resolved.roleText, PERSONAS.tsundere_loli.text);
  assert.equal(resolved.behaviorProfile, 'grounded', '显式给的档位优先于卡自带的');
  assert.equal(resolved.botName, '猫猫');
  assert.equal(resolved.customRules, '别撒娇过头');
});

test('按群自定义正文（不绑卡）：原样使用，未写的字段继承全局', () => {
  const cfg = {
    persona: base,
    personaPerChat: { 'private:200': { roleText: '你是一只看门狗。' } }
  };
  const resolved = resolvePersona(cfg, 'private:200');
  assert.equal(resolved.roleText, '你是一只看门狗。');
  assert.equal(resolved.behaviorProfile, 'legacy');
});

test('未知卡 id：回落全局正文，不把提示词换空', () => {
  const cfg = {
    persona: base,
    personaPerChat: { 'group:100': { templateId: 'no-such-card', botName: '无名' } }
  };
  const resolved = resolvePersona(cfg, 'group:100');
  assert.equal(resolved.roleText, base.roleText);
  assert.equal(resolved.botName, '无名', '同一行的其它字段仍然生效');
});

test('归一化：只认规范 chatKey 与白名单字段，坏值直接丢', () => {
  const out = normalizePersonaPerChat({
    'group:100': { templateId: 'tsundere_loli', botName: ' 猫猫 ', behaviorProfile: 'grounded', unknown: 'x' },
    'private:200': { roleText: '  自定义正文  ', participation: 'high' },
    'group:abc': { templateId: 'tsundere_loli' },          // 键不合法
    'private:300': 'not-an-object',                   // 值不合法
    'group:400': { behaviorProfile: 'chaos', participation: 'max' },  // 字段值不合法 → 整条丢
    'group:500': { botName: '' }                      // 空字段 → 整条丢
  });
  assert.deepEqual(out, {
    'group:100': { templateId: 'tsundere_loli', botName: '猫猫', behaviorProfile: 'grounded' },
    'private:200': { roleText: '自定义正文', participation: 'high' }
  });
});

test('归一化：字符串字段收到对象/数组/数字时直接丢，不写成 [object Object]', () => {
  const out = normalizePersonaPerChat({
    'group:100': {
      customRules: { a: 1 },
      botName: ['猫猫'],
      templateId: 123,
      selfNickname: null,
      roleText: '正常正文'
    }
  });
  assert.deepEqual(out, { 'group:100': { roleText: '正常正文' } });
});

test('载入时校验按群的卡 id：认不出来就清掉，空条目一并删除', () => {
  const cfg = {
    persona: base,
    personaPerChat: {
      'group:100': { templateId: 'gone-card' },
      'group:200': { templateId: 'gone-card', botName: '留名' }
    }
  };
  applyPersonaPerChatTemplates(cfg);
  assert.equal('group:100' in cfg.personaPerChat, false, '只剩坏卡 id 的条目应当删除');
  assert.equal(cfg.personaPerChat['group:200'].templateId, undefined, '坏 id 清掉');
  assert.equal(cfg.personaPerChat['group:200'].botName, '留名', '同一条目里的其它覆盖保留');
});

test('坏卡 id 清理不能误删单独的参与度/档位覆盖', () => {
  // 只列了部分字段名时，participation / behaviorProfile 会被当成"空条目"删掉（2026-10-18 审查 P2）
  const cfg = {
    persona: base,
    personaPerChat: { 'group:300': { templateId: 'gone', participation: 'high', behaviorProfile: 'grounded' } }
  };
  applyPersonaPerChatTemplates(cfg);
  assert.deepEqual(cfg.personaPerChat['group:300'], { participation: 'high', behaviorProfile: 'grounded' });
});
