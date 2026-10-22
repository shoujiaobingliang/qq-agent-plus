// 人设初始化回复缓存：只按 personaPrompt 哈希保存，聊天运行只读。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-intro-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const {
  getPersonaIntro,
  personaIntroFile,
  savePersonaIntro
} = await import('../src/core/persona-intro-store.js');

test('人设回复写入后可读，notifiedAt 可增量更新', () => {
  assert.equal(getPersonaIntro('missing'), null);
  savePersonaIntro('hash-a', { text: '主人好呀', personaName: '小鲸鱼', createdAt: 1 });
  assert.equal(getPersonaIntro('hash-a').text, '主人好呀');
  savePersonaIntro('hash-a', { notifiedAt: 2 });
  const saved = getPersonaIntro('hash-a');
  assert.equal(saved.text, '主人好呀', '增量更新不丢正文');
  assert.equal(saved.notifiedAt, 2);

  const raw = JSON.parse(fs.readFileSync(personaIntroFile(root), 'utf8'));
  assert.equal(raw['hash-a'].personaName, '小鲸鱼');
});

test('缓存文件损坏时按空处理，下一次写入覆盖成合法 JSON', () => {
  fs.writeFileSync(personaIntroFile(root), '{broken');
  assert.equal(getPersonaIntro('hash-b'), null);
  savePersonaIntro('hash-b', { text: '新回复', createdAt: 3 });
  assert.equal(getPersonaIntro('hash-b').text, '新回复');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(personaIntroFile(root), 'utf8')));
});
