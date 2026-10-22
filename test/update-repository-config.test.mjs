// 自动更新仓库/分支的配置归一化：默认仓库跟随部署来源，分支可配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-config-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const { DEFAULT_CONFIG, getConfig, updateConfig } = await import('../src/core/config.js');

test('默认仓库不写死上游：加载后按当前部署来源解析', () => {
  assert.match(DEFAULT_CONFIG.autoUpdate.repository, /^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
  assert.equal(DEFAULT_CONFIG.autoUpdate.repositoryPinned, false);
  const cfg = getConfig();
  assert.match(cfg.autoUpdate.repository, /^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
  assert.equal(cfg.autoUpdate.branch, 'main');
});

test('目标仓库与分支可保存；显式仓库会被保留', () => {
  const cfg = updateConfig({
    autoUpdate: {
      repository: 'https://github.com/fork-owner/fork',
      repositoryPinned: true,
      branch: 'release'
    }
  });
  assert.equal(cfg.autoUpdate.repository, 'https://github.com/fork-owner/fork.git');
  assert.equal(cfg.autoUpdate.repositoryPinned, true);
  assert.equal(cfg.autoUpdate.branch, 'release');
  assert.equal(getConfig().autoUpdate.branch, 'release');
});

test('非法分支被拒绝', () => {
  assert.throws(
    () => updateConfig({ autoUpdate: { branch: '-bad' } }),
    /自动更新分支名称无效/
  );
  assert.throws(
    () => updateConfig({ autoUpdate: { branch: 'a..b' } }),
    /自动更新分支名称无效/
  );
});
