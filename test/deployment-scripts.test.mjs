import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    ...options
  });
}

test('deploy script verifies and rolls back the update service and timer', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(source, /scripts\/auto-update\.mjs/);
  assert.match(source, /UPDATE_SERVICE="\$\{SERVICE\}-update"/);
  // 行锚（^…$）而不是裸子串：注掉/缩进改坏这行都要红（裸匹配连注释都算命中，2026-10-07 复核）
  assert.match(source, /^\s*systemd-analyze --user verify "\$UPDATE_UNIT_FILE"\s*$/m);
  assert.match(source, /systemctl --user enable --now "\$UPDATE_SERVICE\.timer"/);
  assert.match(source, /cp -p "\$LOCK_DIR\/state\/update\.service" "\$UPDATE_UNIT_FILE"/);
  assert.match(source, /QQ_AGENT_SOURCE_REVISION/);
});

// 2026-10-01 审查：接管陈旧锁的判据曾经整个反了（写成 -z），后果是 SIGKILL 之后
// 无人值守的更新永久卡在"Another deployment is running"，而刚 mkdir 还没写 pid 的
// 并发锁反被抢走。这条断言盯住 `-mmin +5` 的判定方向（find 命中才输出 = 必须 -n）。
test('deploy.sh：失败/回滚路径的防线都在（trap、健康闸门、权限、中断标记）', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');

  // ① 出错/中断必须自动回滚：没有这条，一次半途而废的部署会把服务留在坏状态
  assert.match(source, /^trap rollback_deployment ERR INT TERM$/m,
    '必须装 ERR/INT/TERM → rollback_deployment 的 trap（失败与 Ctrl-C 都要退回去）');
  assert.match(source, /^rollback_deployment\(\) \{$/m, 'rollback_deployment 本体要存在（trap 指向的函数）');

  // ② 健康检查是"装好了"的唯一判据：失败必须回滚 + 非 0 退出，不能打印成功
  const failAt = source.indexOf('HEALTHY=false');
  const gateAt = source.indexOf('[[ "$HEALTHY" == true ]]');
  assert.ok(failAt > 0, 'HEALTHY 初始必须是 false（写成 true 等于闸门永不触发）');
  assert.ok(gateAt > failAt, '健康闸门要在 HEALTHY=false 之后判（顺序反了等于没闸门）');
  const gateLine = source.slice(gateAt, source.indexOf('\n', gateAt));
  assert.match(gateLine, /rollback_deployment/, '健康检查失败的分支里必须调 rollback_deployment');
  assert.match(gateLine, /exit 1/, '并且以非 0 退出（不能打印成功）');

  // ③ 含密钥的产物权限：config.json / console-access.txt / 回滚快照都不能全局可读
  assert.match(source, /^umask 077$/m, '脚本要 umask 077（配置与回滚快照里是明文密钥）');

  // ④ 中断标记：装到一半被打断（SIGKILL/OOM/掉电，不执行 trap）时，systemd 不能把半更新的树
  //    当正常代码拉起来 —— 标记必须成对出现（部署前写、结束或回滚时清）
  // ⚠️ 必须锚**调用点**，不能锚函数定义 —— bash 里定义天然在调用之前，锚定义会让
  //   "两个调用点都被删掉"照样绿（2026-10-03 复审实测过这个假绿）。用"裸调用的行"正则取位置：
  //   定义行是 `name() {`，调用行没有括号与花括号。
  const markAt = source.search(/^\s*mark_deploy_in_progress\s*$/m);
  const clearAt = source.search(/^\s*clear_deploy_marker\s*$/m);
  assert.ok(markAt >= 0, '部署前要真的调用 mark_deploy_in_progress（不是只定义）');
  assert.ok(clearAt >= 0, '结束/回滚时要真的调用 clear_deploy_marker');
  // 取**标记之后**那次停服：rollback_deployment 里也有一次 stop（在标记之前），与本断言无关
  const stopAfterMark = source.indexOf('systemctl --user stop "$SERVICE.service"', markAt);
  assert.ok(stopAfterMark > markAt, '必须先写标记再停服（停服后崩掉才留得下标记给恢复流程用）');
  assert.match(source, /IN_PROGRESS_MARKER="\$DATA_DIR\/\.deploy-in-progress"/,
    '标记落在数据目录（ops 巡检也看它）');
});


test('deploy.sh：只有"属主已死且锁确实超过 5 分钟"才接管陈旧锁', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(
    source,
    /\[\[ -n "\$\(find "\$1" -maxdepth 0 -mmin \+5/,
    '判据必须是 -n（find 的 -mmin +5 命中时才打印路径）；写成 -z 会把语义反过来'
  );
  assert.match(
    source,
    /! lock_owner_alive && stale_enough "\$LOCK_DIR"/,
    '两个条件都要满足：属主进程不在 **且** 锁确实超过 5 分钟'
  );
  assert.doesNotMatch(source, /-z "\$\(find/, '不许再用 -z 判陈旧');
});

// 2026-10-01 审查：deploy.sh 三处收口 —— 路径嵌套要双向都拒、下载 Node 的临时目录要进 EXIT trap、
// 接管陈旧锁要过一道互斥（否则两个并发部署会互相删锁、双双往下走）。
test('deploy.sh：路径嵌套双向都拒、TMP_DIR 进 EXIT trap、抢锁走互斥', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  // 两个方向的拒绝文案都要在（具体比较见下一条用例：已改成归一化后的 *_CANON）
  assert.match(source, /Installation path must not be nested inside the source repository/);
  assert.match(source, /The source repository must not be nested inside the installation path/);
  // 下载 Node 失败时 set -e 直接退出，临时目录必须由 EXIT trap 清（原来只在成功路径 rm）
  assert.match(source, /^TMP_DIR=""$/m, 'TMP_DIR 要先声明：set -u 下 trap 引用未定义变量会报错');
  assert.match(source, /if \[\[ -n "\$TMP_DIR" \]\]; then rm -rf -- "\$TMP_DIR"; fi/,
    'TMP_DIR 必须挂在 EXIT trap 的清理里');
  assert.match(source, /TAKEOVER_DIR="\$LOCK_DIR\.takeover"/);
  assert.match(source, /if ! mkdir "\$TAKEOVER_DIR" 2>\/dev\/null; then/,
    '抢锁前先抢互斥（mkdir 是原子的），只有赢家去删锁重建');
  assert.match(source, /rm -rf -- "\$TAKEOVER_DIR"/, '互斥要跟着 trap 一起收');
});

// 2026-10-01 第五轮审查 P1/P2：修锁的时候不能把锁修成新的死锁。
//  · 互斥目录自己也要有陈旧兜底：SIGKILL/OOM/掉电不执行 trap，互斥永久遗留时，
//    之后每次接管都会死在"retry in a moment"上；
//  · trap 必须**先于**抢锁安装：抢锁窗口里 exit 1（比如"别的进程刚建了锁"）也要把互斥收掉；
//  · 清理按"确实持有"来：没抢到锁的一方绝不能删别人的锁；
//  · 拿到互斥后要再判一次：判定与抢互斥之间可能被挂起，期间锁已被赢家刷新；
//  · 嵌套判定前先归一化：`//`、`..`、符号链接这些等价写法不能绕过双向拒绝。
test('deploy.sh：互斥有陈旧兜底、trap 先于抢锁、持有才清、抢到互斥后再判一次、路径先归一化', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(source, /stale_enough "\$TAKEOVER_DIR"/,
    '互斥目录本身要过 5 分钟陈旧宽限，否则一次 SIGKILL 就永久卡住自动更新');
  assert.match(source, /Leftover takeover lock \(older than 5 minutes\)/);
  const trapAt = source.indexOf('trap cleanup_lock EXIT');
  const lockAt = source.indexOf('if ! mkdir "$LOCK_DIR" 2>/dev/null; then');
  assert.ok(trapAt > 0 && lockAt > 0, '两个锚点都要在（脚本结构变了就更新这条用例）');
  assert.ok(trapAt < lockAt, 'trap 必须在抢锁之前安装：抢锁窗口里的 exit 1 也要清掉互斥');
  assert.match(source, /if \[\[ "\$LOCK_OWNED" == true \]\]/, '清锁前要确认确实持有它');
  assert.match(source, /if \[\[ "\$TAKEOVER_OWNED" == true \]\]/, '清互斥同理');
  assert.match(source, /the lock was refreshed while taking over/,
    '拿到互斥后必须再判一次陈旧（否则会删掉并发赢家刚建好的锁）');
  // 顺序断言（2026-10-01 第六轮审查）：只钉"有这句话"不够 —— 把 rm 挪到重判**之前**照样全绿，
  // 而那样正好恢复了"删掉并发赢家新锁"的窗口。钉住 take_over_lock 里的真实次序。
  {
    const fnAt = source.indexOf('take_over_lock() {');
    const fnEnd = source.indexOf('\n}', fnAt);
    assert.ok(fnAt > 0 && fnEnd > fnAt, 'take_over_lock 的结构变了就更新这条用例');
    const body = source.slice(fnAt, fnEnd);
    const recheckAt = body.indexOf('if ! lock_is_stale; then');
    const removeAt = body.indexOf('rm -rf -- "$LOCK_DIR"');
    const recreateAt = body.indexOf('mkdir "$LOCK_DIR"');
    assert.ok(recheckAt > 0 && removeAt > 0 && recreateAt > 0, '三个锚点都要在 take_over_lock 里');
    assert.ok(recheckAt < removeAt, '重判必须排在删锁之前（否则并发赢家刚建好的锁会被删掉）');
    assert.ok(removeAt < recreateAt, '先删旧锁再重建（顺序反了等于把刚建的锁又删掉）');
  }
  assert.match(source, /ROOT_CANON="\$\(canon_path "\$ROOT"\)"/, '嵌套判定前先把路径归一化');
  assert.match(source, /INSTALL_CANON="\$\(canon_path "\$INSTALL_DIR"\)"/);
  // 归一化失败必须 fail-closed（2026-10-01 第六轮审查）：原先是 `|| printf '%s' "$1"` 退回
  // 未归一化的原串，等于守卫静默失效 —— 带 `//`、`..`、符号链接的等价写法又能绕过嵌套判定。
  assert.doesNotMatch(source, /realpath[^\n]*\|\|\s*printf/,
    '不许在 realpath 失败时退回未归一化的原串');
  assert.match(source, /Cannot normalize the source path/, '归一化失败要有明确报错');
  assert.match(source, /Cannot normalize the installation path/);
  assert.match(source, /\|\| \{ printf 'Cannot normalize the source path[^\n]*exit 2; \}/,
    '报错之后要真的停（exit 2），不能继续往下跑');
  assert.match(source, /"\$INSTALL_CANON" == "\$ROOT_CANON\/"\*/);
  assert.match(source, /"\$ROOT_CANON" == "\$INSTALL_CANON\/"\*/);
});

// Issue #5（2026-09-22）：国内服务器拉不到 Docker Hub，脚本只报「after 3 attempts」就退出，
// 用户不知道还能换镜像站。这组断言守住四件事：认用户指定的镜像站、用户的值排在前面、
// 一个都没给时用内置兜底列表（2026-10-12 改：不兜底的话每个国内新部署都要先撞一次失败）、
// 失败时给可操作的指引。
test('deploy-all retries through a user-specified image mirror, then a built-in fallback list', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');

  // 列表先置空，之后按"用户给的 → 内置兜底"两段填充
  assert.match(source, /^IMAGE_MIRRORS=\(\)$/m, '镜像站列表要以空数组初始化');
  assert.match(source, /^IMAGE_MIRROR_ARG=""$/m, '--image-mirror 默认必须为空');
  assert.match(source, /^DEFAULT_IMAGE_MIRRORS=\(docker\.1panel\.live docker\.m\.daocloud\.io\)$/m,
    '内置兜底列表要显式定义：国内直连 Docker Hub 必失败，没兜底每个新部署都会先撞一次（2026-10-12）');
  const userMirrorIdx = source.indexOf('IMAGE_MIRRORS+=("$IMAGE_MIRROR_ARG")');
  const defaultsIdx = source.indexOf('for mirror in "${DEFAULT_IMAGE_MIRRORS[@]}"');
  assert.ok(userMirrorIdx > 0 && defaultsIdx > userMirrorIdx, '内置兜底必须追加在用户指定的值之后（用户的优先）');
  assert.match(source, /\[\[ "\$existing" == "\$mirror" \]\] && \{ duplicate=true; break; \}/,
    '内置站与用户给的重名时不再追加（否则同一条地址要在失败路径上多试一遍）');

  // 两条入口：环境变量（逗号分隔）+ 命令行
  assert.match(source, /QQ_AGENT_IMAGE_MIRROR/);
  assert.match(source, /IFS=',' read -r -a IMAGE_MIRRORS/);
  assert.match(source, /--image-mirror\) require_value "\$@"; IMAGE_MIRROR_ARG="\$2"; shift 2 ;;/);
  assert.match(source, /\[\[ "\$mirror" =~ \^\[A-Za-z0-9\.-\]\+\(:\[0-9\]\+\)\?\$ \]\]/, '镜像站 host 要校验格式');

  // 回退顺序：直连（3 次退避）→ 逐个镜像站 → 仍失败才报错
  assert.match(source, /pull_with_retry\(\)/);
  assert.match(source, /if pull_with_retry "\$IMAGE"; then\n  PULLED=true/);
  // 候选引用从 BASE_IMAGE（剥掉**当前列表里认得**的前缀之后）拼，而不是原样拿 IMAGE ——
  // .env 里存着旧镜像前缀时（默认走内置兜底后的常态），不剥就永远换不到新站；
  // 认不出的自定义 registry 引用不猜，照旧原样重试（2026-10-12 审查）。
  assert.match(source, /BASE_IMAGE="\$IMAGE"/);
  assert.match(source, /BASE_IMAGE="\$\{BASE_IMAGE#"\$known"\/\}"/, '旧镜像前缀要先剥掉再重拼');
  assert.match(source, /candidate="\$\{mirror%\/\}\/\$BASE_IMAGE"/);
  assert.match(source, /\[\[ "\$candidate" == "\$IMAGE" \]\] && continue/, '直连那步试过的引用不再原样重试');
  assert.match(source, /if pull_with_retry "\$candidate"; then/);
  // 换了镜像站要把 .env 里的引用一起改掉（compose 走 --env-file），且保持权限
  // ⚠️ 锚**调用点**不是定义点：`update_env_image()` 这个写法只在 699 行的定义处命中，
  // 749 行的调用是 `update_env_image || true` —— 删掉调用照样绿，.env 会继续引用旧镜像
  //（2026-10-07 复核，同文件 60-66 行早写过同款教训）。
  assert.match(source, /^\s*update_env_image( \|\| true)?\s*$/m, '必须真的调用 update_env_image（不是只定义）');
  assert.match(source, /chmod --reference="\$ENV_FILE"/);

  // 失败时的指引：三条路都写到，并说明内置兜底已经自动试过一轮
  assert.match(source, /image_pull_hint\(\)/);
  for (const needle of ['QQ_AGENT_IMAGE_MIRROR=<mirror>', 'registry-mirrors', 'docker save',
    '镜像站由第三方提供', '内置的公共加速站已经自动试过一轮']) {
    assert.ok(source.includes(needle), `失败提示里应包含：${needle}`);
  }
  assert.match(source, /image_pull_hint\n  die /, '先打指引再退出');
});

// 凭据不经手变量、也不进子进程环境：既能少一份密钥驻留，也是 Mimosa「硬编码凭据」规则盯的地方。
test('deploy-all 现读现用凭据，模型 Key 走 0600 文件而不是子进程环境', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  assert.doesNotMatch(source, /^OLD_[A-Z_]*(PASSWORD|TOKEN)[A-Z_]*=/m, '旧凭据不该留在变量里');
  assert.match(source, /stored_value\(\) \{ env_value "\$ENV_FILE" "\$1"; \}/);
  assert.match(source, /SNOWLUMA_PASSWORD="\$\{SNOWLUMA_PASSWORD:-\$\(stored_value SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD\)\}"/);
  assert.match(source, /SNOWLUMA_PASSWORD" != "\$\(stored_value SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD\)"/);

  assert.doesNotMatch(source, /export QQ_AGENT_MODEL_API_KEY=/, '模型 Key 不该导出进子进程环境');
  assert.match(source, /mktemp "\$\{TMPDIR:-\/tmp\}\/qq-agent-model-key\.XXXXXX"/);
  assert.match(source, /chmod 600 "\$MODEL_KEY_FILE"/);
  assert.match(source, /export QQ_AGENT_MODEL_KEY_FILE="\$MODEL_KEY_FILE"/);
  // 2026-10-06 复审：EXIT trap 统一收口到 deploy_all_exit（原先分散的 trap 互相覆盖，
  // 且只在设置了 MODEL_API_KEY 时才挂——会顶掉 fresh 清理钩子），Key 文件删除在钩子里兜底。
  assert.match(source, /deploy_all_exit\(\) \{/);
  assert.match(source, /rm -f "\$MODEL_KEY_FILE"/);
  assert.match(source, /trap deploy_all_exit EXIT/);
});

test('configure-linux creates observe config and preserves runtime mode on update', (t) => {
  const dataDir = tempDir(t, 'qq-deploy-config-');
  const script = path.join(repo, 'scripts/configure-linux.mjs');
  const first = runNode(script, [
    '--data-dir', dataDir,
    '--host', '127.0.0.1',
    '--port', '43210'
  ]);
  assert.equal(first.status, 0, first.stderr);

  const configFile = path.join(dataDir, 'config.json');
  const initial = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(initial.runtime.mode, 'observe');
  assert.equal(initial.server.host, '127.0.0.1');
  assert.equal(initial.server.port, 43210);
  assert.ok(initial.server.token.length >= 32);
  // 安全意图：不得泄露给 group/other。不能精确断言 0600——btrfs（部分 NAS）
  // 上 writeFileSync/chmod 的 mode 会落成 0700（owner-only 但带 x 位，Issue #11）。
  assert.equal(fs.statSync(configFile).mode & 0o077, 0);

  initial.runtime.mode = 'active';
  fs.writeFileSync(configFile, JSON.stringify(initial), { mode: 0o600 });
  const second = runNode(script, [
    '--data-dir', dataDir,
    '--host', '0.0.0.0',
    '--port', '43211'
  ]);
  assert.equal(second.status, 0, second.stderr);

  const updated = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(updated.runtime.mode, 'active');
  assert.equal(updated.server.host, '0.0.0.0');
  assert.equal(updated.server.port, 43211);
  assert.equal(updated.server.token, initial.server.token);
});

test('configure-linux accepts full-stack credentials and OneBot endpoints', (t) => {
  const dataDir = tempDir(t, 'qq-full-deploy-config-');
  const result = runNode(path.join(repo, 'scripts/configure-linux.mjs'), [
    '--data-dir', dataDir,
    '--host', '0.0.0.0',
    '--port', '43212'
  ], {
    env: {
      ...process.env,
      QQ_AGENT_CONSOLE_TOKEN: 'agent-console-token-1234',
      QQ_AGENT_ONEBOT_TOKEN: 'onebot-ws-token-1234',
      QQ_AGENT_ONEBOT_HTTP_TOKEN: 'onebot-http-token-1234',
      QQ_AGENT_ONEBOT_WS_URL: 'ws://127.0.0.1:33001',
      QQ_AGENT_ONEBOT_HTTP_URL: 'http://127.0.0.1:33000',
      QQ_AGENT_MODEL_BASE_URL: 'https://model.example/v1',
      QQ_AGENT_MODEL_API_KEY: 'model-secret',
      QQ_AGENT_MODEL: 'model-name',
      QQ_AGENT_ALLOW_GROUPS: '123,456',
      QQ_AGENT_ALLOW_PRIVATE: '789'
    }
  });
  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(config.server.token, 'agent-console-token-1234');
  assert.equal(config.onebot.wsUrl, 'ws://127.0.0.1:33001');
  assert.equal(config.onebot.httpUrl, 'http://127.0.0.1:33000');
  assert.equal(config.onebot.accessToken, 'onebot-ws-token-1234');
  assert.equal(config.onebot.httpAccessToken, 'onebot-http-token-1234');
  assert.equal(config.api.baseUrl, 'https://model.example/v1');
  assert.equal(config.api.apiKey, 'model-secret');
  assert.equal(config.api.model, 'model-name');
  assert.deepEqual(config.allow.groups, ['123', '456']);
  assert.deepEqual(config.allow.private, ['789']);
});

test('模型 Key 也可以走 QQ_AGENT_MODEL_KEY_FILE（不留在子进程环境里）', (t) => {
  const dataDir = tempDir(t, 'qq-keyfile-config-');
  const keyFile = path.join(tempDir(t, 'qq-keyfile-'), 'model-key');
  fs.writeFileSync(keyFile, 'key-from-file\n', { mode: 0o600 });
  const result = runNode(path.join(repo, 'scripts/configure-linux.mjs'), [
    '--data-dir', dataDir,
    '--host', '127.0.0.1',
    '--port', '43213'
  ], {
    env: {
      ...process.env,
      QQ_AGENT_MODEL_BASE_URL: 'https://model.example/v1',
      QQ_AGENT_MODEL: 'model-name',
      QQ_AGENT_MODEL_API_KEY: '',
      QQ_AGENT_MODEL_KEY_FILE: keyFile
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(config.api.apiKey, 'key-from-file', '尾随换行要被去掉');

  // 文件不存在时报错要指得出是哪个变量，而不是静默当成没配 Key
  const missing = runNode(path.join(repo, 'scripts/configure-linux.mjs'), [
    '--data-dir', tempDir(t, 'qq-keyfile-missing-'),
    '--host', '127.0.0.1',
    '--port', '43214'
  ], {
    env: { ...process.env, QQ_AGENT_MODEL_KEY_FILE: path.join(dataDir, 'nope') }
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /QQ_AGENT_MODEL_KEY_FILE/);
});

test('configure-snowluma synchronizes global and per-account server tokens', (t) => {
  const dataDir = tempDir(t, 'qq-snowluma-config-');
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'onebot_12345.json'), JSON.stringify({
    mode: 'snapshot',
    networks: {
      httpServers: [{ name: 'custom-http', host: '127.0.0.1', port: 3100 }],
      wsServers: [{ name: 'custom-ws', host: '127.0.0.1', port: 3101, role: 'Event' }]
    }
  }));

  const result = runNode(path.join(repo, 'scripts/configure-snowluma.mjs'), [
    '--data-dir', dataDir,
    '--token', 'shared-onebot-token-1234',
    '--http-port', '3000',
    '--ws-port', '3001'
  ]);
  assert.equal(result.status, 0, result.stderr);

  for (const name of ['onebot.json', 'onebot_12345.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
    assert.equal(config.networks.httpServers[0].host, '0.0.0.0');
    assert.equal(config.networks.httpServers[0].port, 3000);
    assert.equal(config.networks.httpServers[0].accessToken, 'shared-onebot-token-1234');
    assert.equal(config.networks.wsServers[0].host, '0.0.0.0');
    assert.equal(config.networks.wsServers[0].port, 3001);
    assert.equal(config.networks.wsServers[0].accessToken, 'shared-onebot-token-1234');
  }
  assert.ok(fs.existsSync(path.join(configDir, 'onebot_12345.json.bak')));
});

test('installed manage launcher uses the exact deployed Node runtime', (t) => {
  const root = tempDir(t, 'qq-deploy-root-');
  const home = tempDir(t, 'qq-deploy-home-');
  const data = path.join(root, 'data');
  const capture = path.join(root, 'node-invocation.txt');
  const fakeNode = path.join(root, 'private-node');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.copyFileSync(path.join(repo, 'manage.sh'), path.join(root, 'manage.sh'));
  fs.writeFileSync(path.join(root, 'scripts/manage.mjs'), '');
  fs.writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`, { mode: 0o700 });

  const install = runNode(path.join(repo, 'scripts/install-service.mjs'), [], {
    env: {
      ...process.env,
      HOME: home,
      QQ_INSTALL_DIR: root,
      QQ_DATA_DIR: data,
      QQ_NODE: fakeNode,
      QQ_SERVICE: 'qq-agent-test',
      QQ_SNOWLUMA_WEBUI_URL: 'http://127.0.0.1:15099'
    }
  });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.deployment-node'), 'utf8'), `${fakeNode}\n`);
  // 同上：btrfs 上可能落成 0700，只断言不泄露给 group/other
  assert.equal(fs.statSync(path.join(root, '.deployment-node')).mode & 0o077, 0);
  const unit = fs.readFileSync(path.join(home, '.config/systemd/user/qq-agent-test.service'), 'utf8');
  assert.match(unit, /Environment="SNOWLUMA_WEBUI_URL=http:\/\/127\.0\.0\.1:15099"/);
  const updateUnit = fs.readFileSync(
    path.join(home, '.config/systemd/user/qq-agent-test-update.service'),
    'utf8'
  );
  const updateTimer = fs.readFileSync(
    path.join(home, '.config/systemd/user/qq-agent-test-update.timer'),
    'utf8'
  );
  assert.match(updateUnit, /scripts\/auto-update\.mjs/);
  // 更新器最坏预算（2026-10-07 复审重算）：入口探测 ≤2×(5×20s) + 目标解析 ≤(retries+1)×fetch
  // （默认 300s×4）+ 物化源码再一轮同量级 + npm ci 10min + 单测 20min + deploy.sh 20min ——
  // 默认设置下已 ~100min，fetchTimeoutSeconds/networkRetries 调大后数小时。unit 超时必须大于
  // 最坏预算，否则 systemd 会在 deploy.sh 中途（含回滚中）SIGKILL 整个 cgroup，
  // 留下半新半旧的安装目录且失败告警发不出去。
  assert.match(updateUnit, /TimeoutStartSec=240min/);
  assert.match(updateUnit, /TimeoutStopSec=10min/);
  assert.match(updateTimer, /OnUnitInactiveSec=1h/);
  assert.match(updateTimer, /RandomizedDelaySec=10min/);
  const deployment = JSON.parse(fs.readFileSync(path.join(root, '.deployment.json'), 'utf8'));
  assert.equal(deployment.updateService, 'qq-agent-test-update');
  assert.equal(deployment.repository, 'https://github.com/sakurawwwxh/qq-agent-plus.git');
  assert.equal(deployment.branch, 'main');

  const manage = spawnSync('/bin/bash', [path.join(root, 'manage.sh'), 'health'], {
    cwd: root,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8'
  });
  assert.equal(manage.status, 0, manage.stderr);
  assert.deepEqual(
    fs.readFileSync(capture, 'utf8').trim().split('\n'),
    ['scripts/manage.mjs', 'health']
  );
});

// Issue #15（2026-09-25）：unit 带 NoNewPrivileges 时重启后 sudo 必死，linger 步骤
// 一失败整个更新就回滚。linger 只影响下次开机自启，必须是尽力而为：先预检 NNP
// 别让 sudo 去撞内核限制，sudo 失败走警告分支（if/elif 保护，不触发 ERR 回滚）。
test('deploy script treats linger as best-effort and never rolls back over it', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(
    source,
    /loginctl show-user "\$USER" -p Linger --value 2>\/dev\/null \|\| true/,
    'loginctl 查询失败要当作"未开 linger"处理，不能让命令替换触发 ERR'
  );
  assert.match(
    source,
    /if grep -q 'NoNewPrivs:\[\[:space:\]\]\*1' \/proc\/self\/status/,
    '先预检 NoNewPrivileges：被加固时跳过 sudo，给出手动指引而不是内核报错'
  );
  assert.match(
    source,
    /elif ! sudo loginctl enable-linger "\$USER"/,
    'sudo 失败必须走 elif 警告分支，不能裸跑触发 ERR 回滚'
  );
  assert.match(source, /下次开机不会自启/, '警告要说明后果与手动补救命令');
});

test('deploy.sh 调用 verify-deployment-target.mjs（C7 强校验真实接入，不是摆设）', () => {
  const sh = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(sh, /verify-deployment-target[.]mjs/, 'deploy.sh 应调用校验脚本');
  assert.match(sh, /DEPLOY_REPOSITORY/, 'deploy.sh 应支持 --repository 透传');
});

// 2026-11-06 内存复盘：缺 ffmpeg 时视觉链路会把原图直传（一次最多 6×12MiB≈96MiB
// 请求体），在 1.6G 内存的实例上足以触发持续读盘。两个脚本的职责必须分开：
//   deploy-all.sh（有 root、交互）→ 尽力安装；
//   deploy.sh（自动更新以服务账号非交互调用，拿不到 root）→ 只检查 + 告警，绝不失败。
test('ffmpeg：deploy-all 尽力安装，deploy.sh 只检查不阻断', () => {
  const all = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  const one = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');

  // deploy.sh：只告警，exit 码不受影响
  assert.match(one, /command -v ffmpeg >\/dev\/null 2>&1/, 'deploy.sh 要探测 ffmpeg');
  assert.match(one, /Warning: ffmpeg not found/, '缺 ffmpeg 要给出可见警告');
  assert.doesNotMatch(
    one,
    /command -v ffmpeg >\/dev\/null 2>&1\s*\|\|\s*\{[^}]*exit 1/,
    'deploy.sh 不能因为缺 ffmpeg 退出非 0：自动更新会把它当成部署失败并触发自停'
  );
  assert.doesNotMatch(one, /apt-get install[^\n]*ffmpeg/, 'deploy.sh 没有 root，不允许装包');

  // deploy-all.sh：真正尝试安装，三个包管理器都要覆盖
  assert.match(all, /ensure_ffmpeg\(\)/);
  assert.match(all, /apt-get install -y ffmpeg/);
  assert.match(all, /dnf install -y ffmpeg/, 'RHEL 系要覆盖');
  assert.match(all, /pacman -S --noconfirm ffmpeg/, 'Arch 系要覆盖');
  assert.match(all, /^\s*ensure_ffmpeg\s*$/m, '安装步骤要真的被调用，不能只有定义');
  // 装不上不能让整个部署失败
  assert.match(all, /could not install ffmpeg/);
});
