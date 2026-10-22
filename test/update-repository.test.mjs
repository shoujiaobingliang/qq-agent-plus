// 自动更新目标仓库：fork 部署默认指向自己的来源，而不是上游。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const {
  clearUpdateRepositoryCacheForTest,
  defaultUpdateRepository,
  LEGACY_DEFAULT_UPDATE_REPOSITORY,
  normalizeUpdateRepository
} = await import('../src/update-repository.js');

function tempRoot(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qq-update-repo-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('仓库地址归一化：https / git@ / ssh / git+ 都转成 GitHub HTTPS .git', () => {
  assert.equal(
    normalizeUpdateRepository('https://github.com/me/fork'),
    'https://github.com/me/fork.git'
  );
  assert.equal(
    normalizeUpdateRepository('git@github.com:me/fork.git'),
    'https://github.com/me/fork.git'
  );
  assert.equal(
    normalizeUpdateRepository('ssh://git@github.com/me/fork.git'),
    'https://github.com/me/fork.git'
  );
  assert.equal(
    normalizeUpdateRepository('git+https://github.com/me/fork.git'),
    'https://github.com/me/fork.git'
  );
  assert.equal(normalizeUpdateRepository('https://gitlab.com/me/fork.git'), '');
  assert.equal(normalizeUpdateRepository(''), '');
});

test('默认仓库优先 .deployment.json，其次 package.json，最后上游', (t) => {
  clearUpdateRepositoryCacheForTest();
  const deployed = tempRoot(t, 'deployed');
  fs.writeFileSync(path.join(deployed, '.deployment.json'), JSON.stringify({
    repository: 'https://github.com/fork-owner/deployed-fork.git'
  }));
  assert.equal(
    defaultUpdateRepository({ root: deployed, env: {} }),
    'https://github.com/fork-owner/deployed-fork.git'
  );

  const packaged = tempRoot(t, 'packaged');
  fs.writeFileSync(path.join(packaged, 'package.json'), JSON.stringify({
    repository: { url: 'git+https://github.com/fork-owner/package-fork.git' }
  }));
  assert.equal(
    defaultUpdateRepository({ root: packaged, env: {} }),
    'https://github.com/fork-owner/package-fork.git'
  );

  const empty = tempRoot(t, 'empty');
  assert.equal(
    defaultUpdateRepository({ root: empty, env: {} }),
    LEGACY_DEFAULT_UPDATE_REPOSITORY
  );
});

test('环境变量 QQ_AGENT_REPOSITORY 优先；缓存可由 refresh 强制刷新', (t) => {
  clearUpdateRepositoryCacheForTest();
  const root = tempRoot(t, 'cache');
  fs.writeFileSync(path.join(root, '.deployment.json'), JSON.stringify({
    repository: 'https://github.com/fork-owner/old.git'
  }));
  assert.equal(
    defaultUpdateRepository({ root, env: { QQ_AGENT_REPOSITORY: 'https://github.com/fork-owner/env.git' } }),
    'https://github.com/fork-owner/env.git'
  );
  // 同一进程内缓存：不 refresh 时保留第一次结果
  assert.equal(
    defaultUpdateRepository({ root, env: {} }),
    'https://github.com/fork-owner/env.git'
  );
  assert.equal(
    defaultUpdateRepository({ root, env: {}, refresh: true }),
    'https://github.com/fork-owner/old.git'
  );
});
