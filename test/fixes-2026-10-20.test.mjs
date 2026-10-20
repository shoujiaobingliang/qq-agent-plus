// 2026-10-20 用户反馈的修复回归。
// 行为验证分散在各自模块的用例里：
//   · 合并转发开关不再被 @ 绕过 → test/message-types.test.mjs
//   · 连通性测试不受时间控制      → test/time-control-integration.test.mjs
//   · 内置官方索引快照            → test/plugin-index.test.mjs
// 这里补两处只能在控制台点开、单测拿不到的事件处理锚点（剥注释后比对源码）。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('删除模型后，删除弹窗的本地快照要就地更新（不再显示已删掉的模型）', () => {
  const settings = src('ui/pages/settings.js');
  // 弹窗打开时拿的是 state.providers 的快照；loadSettings() 换掉 state.providers 后，
  // 弹窗仍握着旧数组 —— 必须用 DELETE 返回的 provider 更新本地快照，再重绘两列。
  assert.match(settings, /const index = providers\.findIndex\(\(x\) => x\.id === p\.id\)/,
    '删除成功后要定位弹窗快照里的同一条提供商标');
  assert.match(settings, /providers\[index\] = \{ \.\.\.providers\[index\], \.\.\.updated \}/,
    '要用服务端返回的 provider 更新快照');
  assert.match(settings, /renderLeft\(\);\s*renderRight\(\);\s*loadSettings\(\);/,
    '更新后要重绘左列/右列并刷新设置页');
});

test('插件页要说明当前列表来自内置官方索引快照（远端全挂时的兜底）', () => {
  const plugins = src('ui/pages/plugins.js');
  assert.ok(plugins.includes('index?.bundled'), '页头/页脚要识别 bundled 标记');
  assert.ok(plugins.includes('内置官方索引'), '要让人看得出这是离线快照，不是远端最新索引');
});
