import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  autoUpdatePaths,
  readAutoUpdateState,
  writeAutoUpdateRequest
} from '../src/auto-update.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 版本号主判定后，"没有可部署版本"的用例要给出与运行版本相同的假 Release tag，
// 否则 0.9.1 < v9.9.9 会被判成"有更新"，用例测的就不是 no-update 了。
const LOCAL_VERSION = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const LOCAL_TAG = `v${LOCAL_VERSION}`;

function writeDeployment(appDir, dataDir) {
  fs.writeFileSync(path.join(appDir, '.deployment.json'), JSON.stringify({
    root: appDir,
    data: dataDir,
    node: process.execPath,
    service: 'qq-agent-test'
  }));
}

function runUpdater({ appDir, dataDir, binDir = '', env = {}, timeout = 15000 }) {
  return spawnSync(process.execPath, [
    path.join(repo, 'scripts/auto-update.mjs'),
    '--app-dir', appDir,
    '--data-dir', dataDir,
    '--service', 'qq-agent-test'
  ], {
    cwd: repo,
    env: {
      ...process.env,
      ...(binDir ? { PATH: `${binDir}:${process.env.PATH || ''}` } : {}),
      ...env
    },
    encoding: 'utf8',
    timeout
  });
}

/**
 * 假的 GitHub API：更新器只认「已发布的 Release」，
 * 因此每个会走到判定的用例都要给它一个可用的 API（否则会去请求真的 api.github.com）。
 *
 * 必须用独立进程：用例通过 spawnSync 跑更新器，会阻塞测试进程的事件循环，
 * 进程内的 HTTP 服务器根本来不及响应，两边会互相等死。
 */
const FAKE_GITHUB_SOURCE = `
import http from 'node:http';
import fs from 'node:fs';
const options = JSON.parse(process.argv[2] || '{}');
const tag = options.tag || 'v9.9.9';
const status = options.status || 'ahead';
const commits = options.commits || ['新提交一', '新提交二'];
const published = options.published !== false;
// 第二条下载通道（API 解析 tag→sha + codeload 源码包）用的桩数据
const revision = options.revision || 'c'.repeat(40);
const tarballPath = options.tarballPath || '';
// 按调用序号让 /commits/ 返回 503（1 起算），用来测"瞬时 5xx 要重试"
const failCommitsAt = Array.isArray(options.failCommitsAt) ? options.failCommitsAt : [];
let commitsCalls = 0;
const server = http.createServer((req, res) => {
  const url = String(req.url || '');
  if (/\\/releases\\/latest$/.test(url)) {
    if (!published) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      tag_name: tag,
      name: tag + ' —— 测试版本',
      body: '- ' + tag + ' 的发布说明',
      published_at: '2026-09-20T00:00:00Z',
      html_url: 'https://example.com/' + tag,
      draft: false,
      prerelease: false
    }));
    return;
  }
  if (/\\/compare\\//.test(url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status,
      total_commits: commits.length,
      commits: commits.map((subject, index) => ({
        sha: String(index).repeat(40).slice(0, 40),
        commit: { message: subject + '\\n\\n细节' }
      }))
    }));
    return;
  }
  // GET /repos/<owner>/<repo>/commits/<ref>：tag 与分支都解析成同一个 sha
  if (/\\/repos\\/[^/]+\\/[^/]+\\/commits\\//.test(url)) {
    commitsCalls += 1;
    if (failCommitsAt.includes(commitsCalls)) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sha: revision }));
    return;
  }
  // codeload 源码包：/<owner>/<repo>/tar.gz/<sha>
  if (/\\/tar\\.gz\\//.test(url)) {
    if (!tarballPath || !url.includes(revision)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const body = fs.readFileSync(tarballPath);
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(body.length) });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\\n');
});
`;

async function startFakeGitHub(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-fake-github-'));
  const script = path.join(dir, 'server.mjs');
  fs.writeFileSync(script, FAKE_GITHUB_SOURCE, 'utf8');
  const child = spawn(process.execPath, [script, JSON.stringify(options)], {
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const base = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('fake GitHub server did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const match = /PORT=(\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake GitHub server exited early with ${code}`));
    });
  });
  return {
    base,
    close: () => {
      try { child.kill(); } catch { /* already gone */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('scheduled updater uses the persistent Git cache and records no-update', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-runner-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const revision = 'a'.repeat(40);
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'main',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${revision}\n`);
  // 更新器读的是 --app-dir 这棵树的版本；给它一个 package.json，覆盖"显式传入"的路径
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ version: LOCAL_VERSION }));
  writeDeployment(appDir, dataDir);

  const gitLog = path.join(root, 'git.log');
  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
args="$*"
[ -n "$FAKE_GIT_LOG" ] && printf '%s\\n' "$args" >> "$FAKE_GIT_LOG"
case "$args" in
  *" remote") printf '%s\\n' 'origin' ;;
  *"remote set-url origin"*) ;;
  *" ls-remote "*) printf '%s\\t%s\\n' '${revision}' 'refs/heads/main' ;;
  *" fetch "*) ;;
  *" rev-parse "*) printf '%s\\n' '${revision}' ;;
  *) printf 'unexpected git command: %s\\n' "$args" >&2; exit 9 ;;
esac
`, { mode: 0o700 });

  const github = await startFakeGitHub({ status: 'identical', tag: LOCAL_TAG });
  t.after(() => github.close());
  const result = runUpdater({
    appDir,
    dataDir,
    binDir,
    env: { FAKE_GIT_LOG: gitLog, QQ_AGENT_GITHUB_API: github.base },
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);

  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'no-update');
  assert.equal(state.currentRevision, revision);
  assert.equal(state.targetRevision, '', '没有可部署的 Release 时不解析目标提交');
  assert.equal(state.targetVersion, '');
  assert.equal(state.connectivity.status, 'ok');
  assert.equal(state.connectivity.attempts, 1);
  assert.ok(state.lastCheckAt > 0);
  assert.ok(state.completedAt >= state.lastCheckAt);
  assert.equal(fs.existsSync(autoUpdatePaths(dataDir).lock), false);
  const gitCalls = fs.readFileSync(gitLog, 'utf8');
  assert.doesNotMatch(gitCalls, /\bfetch\b/, '版本相同不解析目标：不 fetch');
  assert.doesNotMatch(gitCalls, /rev-parse/, '版本相同不解析目标提交');
});

test('no published release means the updater never fetches or deploys', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-no-release-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const revision = 'a'.repeat(40);
  for (const directory of [appDir, dataDir, binDir]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'main',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${revision}\n`);
  writeDeployment(appDir, dataDir);

  // branch 上有新提交也不算数：仓库还没发过 Release（草稿不算）
  const github = await startFakeGitHub({ published: false });
  t.after(() => github.close());

  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
args="$*"
case "$args" in
  *" remote") printf '%s\\n' 'origin' ;;
  *"remote set-url origin"*) ;;
  *" ls-remote "*) printf '%s\\t%s\\n' '${'f'.repeat(40)}' 'refs/heads/main' ;;
  *" fetch "*) printf '%s\\n' 'fetch must not run without a release' >&2; exit 21 ;;
  *" checkout "*) printf '%s\\n' 'checkout must not run without a release' >&2; exit 22 ;;
  *) printf 'unexpected git command: %s\\n' "$args" >&2; exit 9 ;;
esac
`, { mode: 0o700 });

  const result = runUpdater({
    appDir,
    dataDir,
    binDir,
    env: { QQ_AGENT_GITHUB_API: github.base },
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no released version to deploy/);

  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'no-update');
  assert.equal(state.currentRevision, revision, '不会拿 branch 上的提交当目标');
  assert.equal(state.targetRevision, '');
  assert.equal(state.notification.pending, false, '没有 Release 不算失败，不发告警');
  assert.equal(state.updateNotice.reason, 'no-release');
});

test('checkOnly only checks the release and never creates a checkout', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-check-only-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const revision = 'a'.repeat(40);
  for (const directory of [appDir, dataDir]) fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      checkOnly: true,
      notifyOnUpdate: false,
      ownerUin: '900001',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'main',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${revision}\n`);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ version: LOCAL_VERSION }));
  writeDeployment(appDir, dataDir);

  const github = await startFakeGitHub({ tag: 'v9.9.9' });
  t.after(() => github.close());

  const result = runUpdater({
    appDir,
    dataDir,
    env: { QQ_AGENT_GITHUB_API: github.base },
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);

  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'update-available');
  assert.equal(state.targetVersion, 'v9.9.9');
  assert.equal(state.targetRevision, '', 'checkOnly 不解析/拉取目标提交');
  assert.equal(state.reason, 'check-only');
  assert.equal(state.notification.pending, false, 'notifyOnUpdate=false 不排队通知');
  assert.equal(fs.existsSync(path.join(dataDir, 'update-work')), false,
    'checkOnly 不创建工作目录，更不会 npm ci/测试/部署');
  assert.equal(fs.existsSync(autoUpdatePaths(dataDir).lock), false);
});

test('updater tests a checkout and delegates deployment with the exact revision', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-deploy-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const candidate = path.join(root, 'candidate');
  const marker = path.join(root, 'deployed.txt');
  const previousRevision = 'a'.repeat(40);
  const targetRevision = 'b'.repeat(40);
  for (const directory of [
    appDir,
    dataDir,
    binDir,
    candidate,
    path.join(candidate, 'src'),
    path.join(candidate, 'scripts'),
    path.join(candidate, 'test')
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'main',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${previousRevision}\n`);
  writeDeployment(appDir, dataDir);
  fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({
    name: 'qq-agent',
    type: 'module'
  }));
  fs.writeFileSync(path.join(candidate, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(candidate, 'src/server.js'), '');
  fs.writeFileSync(path.join(candidate, 'scripts/auto-update.mjs'), '');
  fs.writeFileSync(
    path.join(candidate, 'test/smoke.test.mjs'),
    "import { test } from 'node:test'; import fs from 'node:fs'; import path from 'node:path';\n"
      + "test('candidate', () => { fs.mkdirSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'candidate-test-marker'), 'ok'); });\n"
  );
  fs.writeFileSync(path.join(candidate, 'deploy.sh'), `#!/bin/sh
printf '%s\\n' "$QQ_AGENT_SOURCE_REVISION" > "$FAKE_DEPLOY_MARKER"
`, { mode: 0o700 });

  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
args="$*"
case "$args" in
  *" remote") printf '%s\\n' 'origin' ;;
  *"remote set-url origin"*) ;;
  *" ls-remote "*) printf '%s\\t%s\\n' '${targetRevision}' 'refs/heads/main' ;;
  *" fetch "*) ;;
  *" rev-parse "*) printf '%s\\n' '${targetRevision}' ;;
  *" checkout "*)
    work=''
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--work-tree" ]; then work="$2"; shift 2; else shift; fi
    done
    cp -R "$FAKE_CANDIDATE"/. "$work"/
    ;;
  *) printf 'unexpected git command: %s\\n' "$args" >&2; exit 9 ;;
esac
`, { mode: 0o700 });
  const fakeNpm = path.join(binDir, 'npm');
  fs.writeFileSync(fakeNpm, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const github = await startFakeGitHub({ status: 'ahead' });
  t.after(() => github.close());
  const result = runUpdater({
    appDir,
    dataDir,
    binDir,
    env: {
      QQ_AGENT_UPDATE_NPM: fakeNpm,
      FAKE_CANDIDATE: candidate,
      FAKE_DEPLOY_MARKER: marker,
      QQ_AGENT_GITHUB_API: github.base
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), targetRevision, '部署的是 Release tag 指向的提交');
  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'succeeded');
  assert.equal(state.transport, 'git', 'git 通道可用时仍走 git（API 通道只是兜底）');
  assert.equal(state.currentRevision, targetRevision);
  assert.equal(state.targetVersion, 'v9.9.9');
  assert.equal(state.lastSuccessAt > 0, true);
  assert.equal(state.connectivity.status, 'ok');
  assert.equal(state.connectivity.transport, 'git');
  assert.equal(fs.existsSync(path.join(dataDir, 'candidate-test-marker')), false);
});

test('transient GitHub TLS failures are retried before fetch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-retry-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const counter = path.join(root, 'probe-count');
  const revision = 'c'.repeat(40);
  for (const directory of [appDir, dataDir, binDir]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'main',
      intervalHours: 6,
      networkRetries: 3,
      retryBaseMs: 100,
      retryMaxMs: 200,
      connectivityTimeoutSeconds: 3
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${revision}\n`);
  writeDeployment(appDir, dataDir);

  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
args="$*"
case "$args" in
  *" remote") printf '%s\\n' 'origin' ;;
  *"remote set-url origin"*) ;;
  *" ls-remote "*)
    n=0; [ -f "$FAKE_COUNTER" ] && n=$(cat "$FAKE_COUNTER")
    n=$((n+1)); printf '%s' "$n" > "$FAKE_COUNTER"
    if [ "$n" -lt 3 ]; then printf '%s\\n' 'fatal: GnuTLS recv error (-110): TLS connection was non-properly terminated.' >&2; exit 1; fi
    printf '%s\\t%s\\n' '${revision}' 'refs/heads/main'
    ;;
  *" fetch "*) ;;
  *" rev-parse "*) printf '%s\\n' '${revision}' ;;
  *) printf 'unexpected git command: %s\\n' "$args" >&2; exit 9 ;;
esac
`, { mode: 0o700 });

  const github = await startFakeGitHub({ status: 'identical', tag: LOCAL_TAG });
  t.after(() => github.close());
  const result = runUpdater({
    appDir,
    dataDir,
    binDir,
    env: { FAKE_COUNTER: counter, QQ_AGENT_GITHUB_API: github.base },
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(counter, 'utf8'), '3');
  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'no-update');
  assert.equal(state.connectivity.status, 'ok');
  assert.equal(state.connectivity.attempts, 3);
  assert.match(result.stderr, /retry 2\/4/);
});

test('probe request checks repository and branch without fetching or deploying', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-probe-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const revision = 'd'.repeat(40);
  for (const directory of [appDir, dataDir, binDir]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: false,
      ownerUin: '',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'feat/test-branch',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  writeDeployment(appDir, dataDir);
  writeAutoUpdateRequest(dataDir, 'probe');

  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
args="$*"
case "$args" in
  *" remote") printf '%s\\n' 'origin' ;;
  *"remote set-url origin"*) ;;
  *" ls-remote "*) printf '%s\\t%s\\n' '${revision}' 'refs/heads/feat/test-branch' ;;
  *" fetch "*) printf '%s\\n' 'fetch must not run during probe' >&2; exit 21 ;;
  *" checkout "*) printf '%s\\n' 'checkout must not run during probe' >&2; exit 22 ;;
  *) printf 'unexpected git command: %s\\n' "$args" >&2; exit 9 ;;
esac
`, { mode: 0o700 });

  const result = runUpdater({ appDir, dataDir, binDir, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'idle');
  assert.equal(state.mode, 'probe');
  assert.equal(state.phase, 'complete');
  assert.equal(state.connectivity.status, 'ok');
  assert.equal(state.connectivity.branch, 'feat/test-branch');
  assert.equal(state.connectivity.revision, revision);
});

test('runner failure disables future automatic updates by default and preserves a pending notice', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-failure-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://example.invalid/not-allowed.git',
      branch: 'main',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 9, token: 'token' }
  }));
  writeDeployment(appDir, dataDir);

  const result = runUpdater({
    appDir,
    dataDir,
    env: {
      QQ_AGENT_UPDATE_NOTIFY_ATTEMPTS: '1',
      QQ_AGENT_UPDATE_NOTIFY_RETRY_MS: '10'
    },
    timeout: 5000
  });
  assert.equal(result.status, 1);

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  const state = readAutoUpdateState(dataDir);
  assert.equal(config.autoUpdate.enabled, false);
  assert.equal(state.status, 'failed');
  assert.equal(state.autoDisabled, true);
  assert.equal(state.notification.pending, true);
  assert.equal(state.notification.ownerUin, '900001');
  assert.match(state.error, /approved GitHub HTTPS URL/);
});

test('runner failure can preserve automatic updates when disableOnFailure is false', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-keep-enabled-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://example.invalid/not-allowed.git',
      branch: 'main',
      intervalHours: 6,
      disableOnFailure: false
    },
    server: { host: '127.0.0.1', port: 9, token: 'token' }
  }));
  writeDeployment(appDir, dataDir);

  const result = runUpdater({
    appDir,
    dataDir,
    env: {
      QQ_AGENT_UPDATE_NOTIFY_ATTEMPTS: '1',
      QQ_AGENT_UPDATE_NOTIFY_RETRY_MS: '10'
    },
    timeout: 5000
  });
  assert.equal(result.status, 1);
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  const state = readAutoUpdateState(dataDir);
  assert.equal(config.autoUpdate.enabled, true);
  assert.equal(state.autoDisabled, false);
  assert.equal(state.notification.pending, true);
});

test('git 通道不通时改用 API + codeload 源码包完成部署', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('更新器只在 Linux 上运行（需要 /bin/bash、tar 与 systemd）');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-api-lane-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const packDir = path.join(root, 'pack');
  const marker = path.join(root, 'deployed.txt');
  const previousRevision = 'a'.repeat(40);
  const targetRevision = 'c'.repeat(40);
  // codeload 的压缩包顶层目录形如 <owner>-<repo>-<短 sha>，解包时要被 strip 掉
  const topDir = `sakurawwwxh-qq-agent-plus-${targetRevision.slice(0, 7)}`;
  const tree = path.join(packDir, topDir);
  for (const directory of [
    appDir,
    dataDir,
    binDir,
    path.join(tree, 'src'),
    path.join(tree, 'scripts'),
    path.join(tree, 'test')
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'main',
      intervalHours: 6,
      // 用例里不重试：假 git 立刻失败，重试只会白等
      networkRetries: 0,
      retryBaseMs: 100
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${previousRevision}\n`);
  writeDeployment(appDir, dataDir);

  // 假的源码树（内容要求与 git 通道那条用例一致：validateCheckout + 语法检查 + 一个能过的用例）
  fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({
    name: 'qq-agent-plus',
    type: 'module'
  }));
  fs.writeFileSync(path.join(tree, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(tree, 'src/server.js'), '');
  fs.writeFileSync(path.join(tree, 'scripts/auto-update.mjs'), '');
  fs.writeFileSync(
    path.join(tree, 'test/smoke.test.mjs'),
    "import { test } from 'node:test';\n"
      + "test('candidate from tarball', () => {});\n"
  );
  fs.writeFileSync(path.join(tree, 'deploy.sh'), `#!/bin/sh
printf '%s\n' "$QQ_AGENT_SOURCE_REVISION" > "$FAKE_DEPLOY_MARKER"
`, { mode: 0o700 });
  const tarballPath = path.join(root, 'source.tar.gz');
  const packed = spawnSync('tar', ['-czf', tarballPath, '-C', packDir, topDir], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr || 'tar 打包失败');

  // 假 git：仓库级命令正常，网络级命令统统失败（模拟 github.com 的 git 通道黑洞）
  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
# 跳过 --git-dir/--work-tree 与它们的值，找到真正的子命令
cmd=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --git-dir|--work-tree|-c) shift 2 ;;
    -*) shift ;;
    *) cmd="$1"; break ;;
  esac
done
case "$cmd" in
  init) ;;
  remote)
    case "$*" in
      *set-url*) ;;
      *) printf '%s\\n' 'origin' ;;
    esac
    ;;
  ls-remote|fetch|rev-parse|checkout)
    printf 'fatal: unable to access %s: Failed to connect to github.com\\n' "$cmd" >&2
    exit 128
    ;;
  *) printf 'unexpected git command: %s\\n' "$*" >&2; exit 9 ;;
esac
`, { mode: 0o700 });
  const fakeNpm = path.join(binDir, 'npm');
  fs.writeFileSync(fakeNpm, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const github = await startFakeGitHub({
    status: 'ahead',
    revision: targetRevision,
    tarballPath
  });
  t.after(() => github.close());
  const result = runUpdater({
    appDir,
    dataDir,
    binDir,
    env: {
      QQ_AGENT_UPDATE_NPM: fakeNpm,
      FAKE_DEPLOY_MARKER: marker,
      QQ_AGENT_GITHUB_API: github.base,
      QQ_AGENT_CODELOAD: github.base,
      // 明文基地址要显式放行（桩件是 http://127.0.0.1）；生产默认要求 HTTPS
      QQ_AGENT_CODELOAD_ALLOW_INSECURE: '1'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), targetRevision, '部署的是 Release tag 解析出的提交');
  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'succeeded');
  assert.equal(state.transport, 'api', '记录走的是 API + 源码包通道');
  assert.equal(state.connectivity.transport, 'api');
  assert.equal(state.currentRevision, targetRevision);
  assert.equal(state.targetVersion, 'v9.9.9');
});

test('API 通道取源码失败时回退 git，并先 fetch 再 checkout', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('更新器只在 Linux 上运行（需要 /bin/bash、tar 与 systemd）');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-lane-fallback-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const candidate = path.join(root, 'candidate');
  const marker = path.join(root, 'deployed.txt');
  const gitLog = path.join(root, 'git.log');
  const previousRevision = 'a'.repeat(40);
  const targetRevision = 'd'.repeat(40);
  for (const directory of [
    appDir,
    dataDir,
    binDir,
    candidate,
    path.join(candidate, 'src'),
    path.join(candidate, 'scripts'),
    path.join(candidate, 'test')
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'main',
      intervalHours: 6,
      networkRetries: 0,
      retryBaseMs: 100
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${previousRevision}\n`);
  writeDeployment(appDir, dataDir);

  fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({
    name: 'qq-agent-plus',
    type: 'module'
  }));
  fs.writeFileSync(path.join(candidate, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(candidate, 'src/server.js'), '');
  fs.writeFileSync(path.join(candidate, 'scripts/auto-update.mjs'), '');
  fs.writeFileSync(
    path.join(candidate, 'test/smoke.test.mjs'),
    "import { test } from 'node:test';\ntest('candidate via git fallback', () => {});\n"
  );
  fs.writeFileSync(path.join(candidate, 'deploy.sh'), `#!/bin/sh
printf '%s\n' "$QQ_AGENT_SOURCE_REVISION" > "$FAKE_DEPLOY_MARKER"
`, { mode: 0o700 });

  // 假 git：ls-remote 不通（→ 探活走 API 通道），但 fetch/checkout 可用
  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
cmd=''
work=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --git-dir) shift 2 ;;
    --work-tree) work="$2"; shift 2 ;;
    -c) shift 2 ;;
    -*) shift ;;
    *) cmd="$1"; break ;;
  esac
done
printf '%s\\n' "$cmd" >> "$FAKE_GIT_LOG"
case "$cmd" in
  init) ;;
  remote)
    case "$*" in
      *set-url*) ;;
      *) printf '%s\\n' 'origin' ;;
    esac
    ;;
  ls-remote)
    printf 'fatal: unable to access: Failed to connect to github.com\\n' >&2
    exit 128
    ;;
  fetch|rev-parse) ;;
  cat-file) exit 1 ;;
  checkout)
    cp -R "$FAKE_CANDIDATE"/. "$work"/
    ;;
  *) printf 'unexpected git command: %s\\n' "$*" >&2; exit 9 ;;
esac
`, { mode: 0o700 });
  const fakeNpm = path.join(binDir, 'npm');
  fs.writeFileSync(fakeNpm, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  // 假 GitHub：tag 能解析，但源码包一律 500（逼 API 取源码失败）
  const github = await startFakeGitHub({ status: 'ahead', revision: targetRevision });
  t.after(() => github.close());
  const result = runUpdater({
    appDir,
    dataDir,
    binDir,
    env: {
      QQ_AGENT_UPDATE_NPM: fakeNpm,
      FAKE_CANDIDATE: candidate,
      FAKE_DEPLOY_MARKER: marker,
      FAKE_GIT_LOG: gitLog,
      QQ_AGENT_GITHUB_API: github.base,
      QQ_AGENT_CODELOAD: github.base,
      // 明文基地址要显式放行（桩件是 http://127.0.0.1）；生产默认要求 HTTPS
      QQ_AGENT_CODELOAD_ALLOW_INSECURE: '1'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /改走另一条通道/, '应记录通道回退');
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), targetRevision);
  const calls = fs.readFileSync(gitLog, 'utf8');
  assert.match(calls, /^fetch$/m, 'revision 来自 API 时，git 取源码必须先 fetch 再 checkout');
  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'succeeded');
  assert.equal(state.transport, 'git', '最终成功的是 git 取源码');
  assert.equal(state.connectivity.transport, 'api', '探活阶段走的是 API 通道');
});

test('API 解析 tag 遇到瞬时 5xx 会按配置重试（不再一次抖动就放弃）', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('更新器只在 Linux 上运行（需要 /bin/bash、tar 与 systemd）');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-api-retry-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const packDir = path.join(root, 'pack');
  const marker = path.join(root, 'deployed.txt');
  const previousRevision = 'a'.repeat(40);
  const targetRevision = 'e'.repeat(40);
  const topDir = `sakurawwwxh-qq-agent-plus-${targetRevision.slice(0, 7)}`;
  const tree = path.join(packDir, topDir);
  for (const directory of [
    appDir,
    dataDir,
    binDir,
    path.join(tree, 'src'),
    path.join(tree, 'scripts'),
    path.join(tree, 'test')
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'main',
      intervalHours: 6,
      // 允许 1 次重试、退避很短
      networkRetries: 1,
      retryBaseMs: 50
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${previousRevision}\n`);
  writeDeployment(appDir, dataDir);

  fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({
    name: 'qq-agent-plus',
    type: 'module'
  }));
  fs.writeFileSync(path.join(tree, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(tree, 'src/server.js'), '');
  fs.writeFileSync(path.join(tree, 'scripts/auto-update.mjs'), '');
  fs.writeFileSync(
    path.join(tree, 'test/smoke.test.mjs'),
    "import { test } from 'node:test';\ntest('candidate after api retry', () => {});\n"
  );
  fs.writeFileSync(path.join(tree, 'deploy.sh'), `#!/bin/sh
printf '%s\n' "$QQ_AGENT_SOURCE_REVISION" > "$FAKE_DEPLOY_MARKER"
`, { mode: 0o700 });
  const tarballPath = path.join(root, 'source.tar.gz');
  const packed = spawnSync('tar', ['-czf', tarballPath, '-C', packDir, topDir], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr || 'tar 打包失败');

  // 假 git：网络级命令全失败 → 只能走 API 通道
  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
cmd=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --git-dir|--work-tree|-c) shift 2 ;;
    -*) shift ;;
    *) cmd="$1"; break ;;
  esac
done
case "$cmd" in
  init) ;;
  remote)
    case "$*" in
      *set-url*) ;;
      *) printf '%s\n' 'origin' ;;
    esac
    ;;
  *) printf 'fatal: unable to access: Failed to connect to github.com\n' >&2; exit 128 ;;
esac
`, { mode: 0o700 });
  const fakeNpm = path.join(binDir, 'npm');
  fs.writeFileSync(fakeNpm, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  // 第 1 次 /commits/ 是连通性探活（必须成功），第 2 次是 tag 解析（刻意 503 一次）
  const github = await startFakeGitHub({
    status: 'ahead',
    revision: targetRevision,
    tarballPath,
    failCommitsAt: [2]
  });
  t.after(() => github.close());
  const result = runUpdater({
    appDir,
    dataDir,
    binDir,
    env: {
      QQ_AGENT_UPDATE_NPM: fakeNpm,
      FAKE_DEPLOY_MARKER: marker,
      QQ_AGENT_GITHUB_API: github.base,
      QQ_AGENT_CODELOAD: github.base,
      // 明文基地址要显式放行（桩件是 http://127.0.0.1）；生产默认要求 HTTPS
      QQ_AGENT_CODELOAD_ALLOW_INSECURE: '1'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /api resolve failed; retry/, 'tag 解析遇到 5xx 要走退避重试');
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), targetRevision);
  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'succeeded');
  assert.equal(state.transport, 'api');
});

// 2026-10-01 第五轮审查（P2）：判定"可以接管"与抢互斥文件之间会被调度挂起，期间并发赢家
// 可能已经建好新锁并跑起来 —— 拿到互斥后必须**再判一次**，否则会删掉别人正在用的锁、
// 两边同时往下走（与 deploy.sh 的 take_over_lock 同一个道理）。
// 这条是结构断言：要在行为上稳定复现这个窗口得靠调度时序，做不到确定性复现。
// 变异对照：删掉互斥内的 lockJudgement() 调用 → 本条必红。
// 2026-10-01 第六轮审查补强：原先只钉了"互斥 → 重判"，没钉"重判 → 删锁"—— 把删旧锁挪到
// 重判之前同样全绿，而那正是要防的窗口。现在把三步的相对次序都钉住。
test('auto-update：拿到接管互斥后再判一次锁的状态，判定逻辑只有一处', () => {
  const source = fs.readFileSync(path.join(repo, 'scripts/auto-update.mjs'), 'utf8');
  const takeOverAt = source.indexOf('function autoUpdateTryTakeOver()');
  const acquireAt = source.indexOf('function acquireLock()');
  assert.ok(takeOverAt > 0 && acquireAt > takeOverAt, '两个函数都要在（脚本结构变了就更新这条用例）');
  const body = source.slice(takeOverAt, acquireAt);
  const mutexAt = body.indexOf("fs.openSync(mutex, 'wx', 0o600)");
  const recheckAt = body.indexOf('lockJudgement().takeable');
  const removeAt = body.indexOf('fs.unlinkSync(paths.lock)');
  const recreateAt = body.indexOf("lockHandle = fs.openSync(paths.lock, 'wx'");
  assert.ok(mutexAt > 0 && recheckAt > mutexAt, '互斥拿到手之后必须再判一次锁是否仍可接管');
  assert.ok(removeAt > 0 && recreateAt > 0, '删锁与重建锁两个锚点都要在（删的是陈旧锁、建的是自己的锁）');
  assert.ok(recheckAt < removeAt, '重判必须排在删锁之前：反了就会删掉并发赢家刚建好的锁');
  assert.ok(removeAt < recreateAt, '先删陈旧锁再重建（顺序反了等于把刚建的锁又删掉）');
  // 判定只留一份：acquireLock 与互斥内各写一套迟早漂开（口径必须完全一致）
  assert.equal((source.match(/function lockJudgement\(\)/g) || []).length, 1, 'lockJudgement 只定义一次');
  assert.ok((source.match(/lockJudgement\(\)/g) || []).length >= 2, 'acquireLock 与互斥内都要调用它');
});

test('并发更新：抢锁失败的一方不碰胜出方的锁与源码包（2026-09-29 审查 P1）', async (t) => {
  // 背景：releaseLock() 里的 unlink/rmSync 原先写在 `if (lockHandle !== null)` 之外，
  // 于是抢锁失败的一方（UPDATE_BUSY 时 lockHandle 仍是 null）也会把**胜出方**的锁文件和
  // 它在用的源码包删掉。随后第三个进程能进、它调 deploy.sh 会被 .deploy.lock 挡住而判失败，
  // 在 disableOnFailure 打开时还会把自动更新一起关掉。这条用例钉住"失败方什么都不动"。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-lock-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const candidate = path.join(root, 'candidate');
  const marker = path.join(root, 'deployed.txt');
  const releaseFile = path.join(root, 'release');
  const previousRevision = 'a'.repeat(40);
  const targetRevision = 'b'.repeat(40);
  for (const directory of [appDir, dataDir, binDir, candidate, path.join(candidate, 'src'), path.join(candidate, 'scripts'), path.join(candidate, 'test')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'main',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${previousRevision}\n`);
  writeDeployment(appDir, dataDir);
  fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({ name: 'qq-agent', type: 'module' }));
  fs.writeFileSync(path.join(candidate, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(candidate, 'src/server.js'), '');
  fs.writeFileSync(path.join(candidate, 'scripts/auto-update.mjs'), '');
  fs.writeFileSync(
    path.join(candidate, 'test/smoke.test.mjs'),
    "import { test } from 'node:test';\ntest('candidate', () => {});\n"
  );
  // 假 deploy.sh：等 release 文件出现才收尾 —— 让 A 稳稳地"持有锁运行中"
  fs.writeFileSync(path.join(candidate, 'deploy.sh'), `#!/bin/sh
while [ ! -f "$FAKE_DEPLOY_RELEASE" ]; do sleep 0.2; done
printf '%s\n' "$QQ_AGENT_SOURCE_REVISION" > "$FAKE_DEPLOY_MARKER"
`, { mode: 0o700 });
  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
args="$*"
case "$args" in
  *" remote") printf '%s\n' 'origin' ;;
  *"remote set-url origin"*) ;;
  *" ls-remote "*) printf '%s\t%s\n' '${targetRevision}' 'refs/heads/main' ;;
  *" fetch "*) ;;
  *" rev-parse "*) printf '%s\n' '${targetRevision}' ;;
  *" checkout "*)
    work=''
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--work-tree" ]; then work="$2"; shift 2; else shift; fi
    done
    cp -R "$FAKE_CANDIDATE"/. "$work"/
    ;;
  *) exit 9 ;;
esac
`, { mode: 0o700 });
  const fakeNpm = path.join(binDir, 'npm');
  fs.writeFileSync(fakeNpm, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const github = await startFakeGitHub({ status: 'ahead' });
  t.after(() => github.close());
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    QQ_AGENT_UPDATE_NPM: fakeNpm,
    FAKE_CANDIDATE: candidate,
    FAKE_DEPLOY_MARKER: marker,
    FAKE_DEPLOY_RELEASE: releaseFile,
    QQ_AGENT_GITHUB_API: github.base
  };
  const args = [
    path.join(repo, 'scripts/auto-update.mjs'),
    '--app-dir', appDir,
    '--data-dir', dataDir,
    '--service', 'qq-agent-test'
  ];
  const lockFile = autoUpdatePaths(dataDir).lock;

  const first = spawn(process.execPath, args, { cwd: repo, env });
  let firstOut = '';
  first.stdout.on('data', (chunk) => { firstOut += String(chunk); });
  let firstErr = '';
  first.stderr.on('data', (chunk) => { firstErr += String(chunk); });
  const firstExit = new Promise((resolve) => first.on('exit', (code) => resolve(code ?? -1)));
  t.after(() => { try { first.kill('SIGKILL'); } catch { /* ignore */ } });

  // 等 A 真的拿到锁（写锁的是它自己，内容里有它的 pid）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !fs.existsSync(lockFile)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(lockFile), 'A 应已持有锁：' + firstOut + firstErr);
  const ownerPid = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid;
  assert.equal(ownerPid, first.pid, '锁里记的应是 A 的 pid');

  // B 在 A 持锁期间启动：应干净退出（busy 不是失败），且**不能动 A 的锁**
  const second = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(second.status, 0, `抢锁失败应按 0 退出：${second.stderr || second.stdout}`);
  assert.match(`${second.stdout}${second.stderr}`, /Another update process is running/, '应说明是被别的更新进程挡住');
  assert.ok(fs.existsSync(lockFile), 'A 的锁文件必须还在（B 抢锁失败就什么都不该动）');

  // 放 A 收尾：正常完成、清掉自己的锁
  fs.writeFileSync(releaseFile, 'go\n');
  assert.equal(await firstExit, 0, 'A 应正常完成：' + firstOut + firstErr);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), targetRevision, 'A 完成时确实部署了');
  assert.equal(fs.existsSync(lockFile), false, 'A 完成后清掉自己的锁');
  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'succeeded');
});

/**
 * 一套"什么都不用做"的更新器安装：远端与本地同版本（no-update 立刻收尾），
 * 因此除了抢锁那一步，跑完是很轻的。用来单独观察锁的行为。
 */
function seedIdleUpdater(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const revision = 'a'.repeat(40);
  for (const directory of [appDir, dataDir, binDir]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
      branch: 'main',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${revision}\n`);
  writeDeployment(appDir, dataDir);
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh
args="$*"
case "$args" in
  *" remote") printf '%s\\n' 'origin' ;;
  *"remote set-url origin"*) ;;
  *" ls-remote "*) printf '%s\\t%s\\n' '${revision}' 'refs/heads/main' ;;
  *" fetch "*) ;;
  *" rev-parse "*) printf '%s\\n' '${revision}' ;;
  *) printf 'unexpected git command: %s\\n' "$args" >&2; exit 9 ;;
esac
`, { mode: 0o700 });
  return { root, appDir, dataDir, binDir, revision };
}

// ── 2026-10-01 审查（第五轮）：自动更新抢锁的两处竞态 ──────────────────────────
// 1) 原来只有 `pid > 0` 才去检查属主活没活，pid 读不出来（空文件 / 写了一半被杀 / 坏 JSON）
//    就直接 unlink + 重建 —— 等于把"刚 open('wx') 还没写 JSON"的并发进程的锁抢走。
// 2) 接管的 unlink → open('wx') 不是原子对，两个进程同时判"陈旧"会互相删掉对方刚建的锁，
//    双双拿到"唯一"锁。现在先抢一个 .takeover 互斥文件，只有赢家动手；互斥本身带陈旧兜底，
//    否则持有者被 SIGKILL 之后，自动更新会永久卡在"有人在接管"。

// 这两条在 Windows 上跳过：假 git 桩靠 PATH 里塞一个无扩展名的 sh 脚本，Windows 既认 ':' 分隔符
// 也不认这种脚本，和本文件另三条需要桩 git 的用例一样在 win32 上跑不通（那三条在 fail-base.txt 里）。
const posixOnly = { skip: process.platform === 'win32' ? '需要 POSIX 假 git 桩（在 Linux 服务器上跑）' : false };

test('自动更新锁：读不出 pid 的锁在宽限期内不被抢，做旧后可以接管', posixOnly, async (t) => {
  const { appDir, dataDir, binDir } = seedIdleUpdater(t, 'qq-update-stale-');
  const github = await startFakeGitHub({ status: 'identical', tag: LOCAL_TAG });
  t.after(() => github.close());
  const env = { QQ_AGENT_GITHUB_API: github.base };
  const lockFile = autoUpdatePaths(dataDir).lock;

  fs.writeFileSync(lockFile, '');   // 半成品锁：没有 pid
  const blocked = runUpdater({ appDir, dataDir, binDir, env });
  assert.equal(blocked.status, 0, `busy 要按 0 退出：${blocked.stderr}`);
  assert.match(`${blocked.stdout}${blocked.stderr}`, /Another update process is starting/,
    '刚建好还没写 pid 的锁要当有并发，不能抢');
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '', '宽限期内不许动这把锁');

  // 同一把空锁做旧：这才像"写到一半被杀"，应当接管 —— 否则一次崩溃就把自动更新永久钉住
  const ancient = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockFile, ancient, ancient);
  const taken = runUpdater({ appDir, dataDir, binDir, env });
  assert.equal(taken.status, 0, taken.stderr);
  assert.doesNotMatch(`${taken.stdout}${taken.stderr}`, /Another update process is starting/,
    '过期空锁必须能被接管');
  assert.equal(fs.existsSync(lockFile), false, '接管并跑完后释放自己的锁');
  assert.equal(readAutoUpdateState(dataDir).status, 'no-update');
});

test('自动更新锁：接管先抢互斥文件；遗留互斥过 5 分钟可被清掉', posixOnly, async (t) => {
  const { appDir, dataDir, binDir } = seedIdleUpdater(t, 'qq-update-takeover-');
  const github = await startFakeGitHub({ status: 'identical', tag: LOCAL_TAG });
  t.after(() => github.close());
  const env = { QQ_AGENT_GITHUB_API: github.base };
  const lockFile = autoUpdatePaths(dataDir).lock;
  const mutex = `${lockFile}.takeover`;

  // 属主已死的旧锁（pid 来自一个刚退出的进程，必死）+ 一把新的互斥文件 → 有人正在接管
  const dead = spawnSync(process.execPath, ['-e', '']);
  const staleOwner = { pid: dead.pid, startedAt: Date.now() - 60 * 60 * 1000 };
  fs.writeFileSync(lockFile, JSON.stringify(staleOwner));
  fs.writeFileSync(mutex, '');
  const blocked = runUpdater({ appDir, dataDir, binDir, env });
  assert.equal(blocked.status, 0, `被互斥挡住也应按 0 退出：${blocked.stderr}`);
  assert.match(`${blocked.stdout}${blocked.stderr}`, /taking over the lock/,
    '互斥文件在手时后来者只能退出，不能一起删锁');
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, staleOwner.pid, '被挡住时不许动旧锁');

  // 互斥文件做旧（持有者被 SIGKILL 的形态）→ 必须能清掉继续，不能永久卡住
  const ancient = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(mutex, ancient, ancient);
  const taken = runUpdater({ appDir, dataDir, binDir, env });
  assert.equal(taken.status, 0, taken.stderr);
  assert.doesNotMatch(`${taken.stdout}${taken.stderr}`, /taking over the lock/,
    '陈旧的互斥文件必须能被清掉，否则被 SIGKILL 一次就永久卡住');
  assert.equal(fs.existsSync(lockFile), false, '接管成功并跑完后释放自己的锁');
  assert.equal(readAutoUpdateState(dataDir).status, 'no-update');
});
