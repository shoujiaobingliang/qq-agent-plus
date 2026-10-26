// Linux 服务入口：node src/server.js
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './console/app.js';
import { installManualFriendReviewRoute } from './console/manual-friend-review-route.js';
import { installExperimentalMultimodalContextPilot } from './pilots/experimental-multimodal-context.js';
import { DATA_DIR } from './core/config.js';
import { assertSqliteAvailable } from './core/sqlite.js';
import { cleanupStaleMediaTempDirs } from './core/media-budget.js';
import { createLogger } from './core/logger.js';
import { createDailyRetentionScheduler } from './core/ledger-retention.js';

const log = createLogger('server');

let app = null;
// 台账保留期清理的每日调度（见 core/ledger-retention.js）。
// 三个台账的保留期 DELETE 原来只在各自构造函数里跑一次 —— 常驻不重启等于不执行。
let retentionScheduler = null;
process.on('unhandledRejection', (error) => {
  app?.captureIncident(error, {
    source: 'process',
    category: 'process',
    severity: 'critical',
    code: 'UNHANDLED_REJECTION'
  });
  log.error('[未处理异常]', error);
});
process.on('uncaughtException', (error) => {
  app?.captureIncident(error, {
    source: 'process',
    category: 'process',
    severity: 'critical',
    code: 'UNCAUGHT_EXCEPTION'
  });
  log.error('[未捕获异常]', error);
  process.exit(1);
});

/**
 * 上次部署是不是被中断了？
 *
 * deploy.sh 在停服务之前写 `$DATA_DIR/.deploy-in-progress`、健康检查通过后删掉。所以
 * 正常部署期间本进程也会看到这个标记 —— 判据是**标记里的 pid 还活着没有**：
 * 活着＝那次部署正在进行（正常，不吭声）；不在了（SIGKILL/OOM/掉电让 trap 没跑）
 * ＝代码可能半更新、服务可能被停过，这时才告警，并记一条异常（控制台「异常处理」能看到）。
 * 只告警不拦截：让人按快照决定，而不是让服务起不来。恢复步骤见 docs/LINUX.md。
 */
function reportInterruptedDeploy() {
  // 这段挂在 app.start() 的 then 后面，抛错会落进下游的 catch 直接 process.exit(1) ——
  // 一句告警不该有能力把服务带崩，所以整体兜住。
  try {
    const marker = path.join(DATA_DIR, '.deploy-in-progress');
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(marker, 'utf8'));
    } catch {
      return;   // 没有标记（或读不动）＝ 正常
    }
    const deployPid = Number(info?.pid) || 0;
    if (deployPid > 0) {
      try {
        process.kill(deployPid, 0);   // 还在跑：这是正常部署，别误报
        return;
      } catch (error) {
        // EPERM = 进程活着但不属于我（跨用户/平台差异）→ 同样按"还在跑"处理；
        // 只有 ESRCH 这类"确实不存在"才继续往下告警。
        if (error?.code === 'EPERM') return;
      }
    }
    const startedAt = Date.parse(String(info?.startedAt || ''));
    const when = Number.isFinite(startedAt)
      ? new Date(startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      : '时间未知';
    const snapshot = String(info?.snapshot || '').trim() || '（标记里没记快照，看 data/deploy-backups/ 里最新的一份）';
    log.warn('[部署] 检测到上次部署被中断（开始于 ' + when + '）：代码可能处于半更新状态，服务可能被停过。\n'
      + '  回滚快照：' + snapshot + '\n'
      + '  恢复步骤见 docs/LINUX.md「部署被中断后怎么恢复」；确认无误后删掉标记：' + marker);
    app?.captureIncident(new Error('上次部署被中断，代码可能处于半更新状态（详见服务日志）'), {
      source: 'deploy',
      category: 'deploy',
      severity: 'warning',
      code: 'DEPLOY_INTERRUPTED'
    });
  } catch (error) {
    log.warn('[部署] 中断标记检查失败（不影响启动）:', error?.message ?? error);
  }
}

// 启动最早期确认 node:sqlite 可用：缺内建模块时给人话指引，
// 而不是等 createApp 的存储层 import 链抛加载期裸栈（改进方案 C5/#11）。
assertSqliteAvailable();

// 清理上次被 SIGKILL/OOM 打断时留下的媒体临时文件（每个可能是几十 MB 的输入）。
// 正常路径都在 finally 里删；这里只兜异常退出，失败不影响启动。
try {
  const removed = cleanupStaleMediaTempDirs();
  if (removed > 0) log.info(`[media] 已清理 ${removed} 个残留临时目录`);
} catch { /* 不影响启动 */ }

// 仅安装一次薄包装；开关关闭时 multimodal-context commit 原样委托旧实现。
installExperimentalMultimodalContextPilot();

app = createApp();
installManualFriendReviewRoute(app);
app.start().then(() => {
  reportInterruptedDeploy();
  // 启动成功后再挂每日台账清理：1 小时 tick + 内存里的今日闸门（构造期已清过一轮，
  // 当天不重复）；跨重启由构造函数那一次兜底，所以闸门不需要落盘。
  // 放这里而不是各自模块里：进程生命周期只有 server.js 知道，
  // stop() 也能就近在下面的 shutdown() 里收干净。
  retentionScheduler = createDailyRetentionScheduler({
    targets: app.retentionPruneTargets(),
    log
  });
  retentionScheduler.start();
}).catch((error) => {
  log.error('[启动失败]', error);
  process.exit(1);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  retentionScheduler?.stop();
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  try { await app.stop(); process.exit(0); }
  catch (error) { log.error(error); process.exit(1); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
