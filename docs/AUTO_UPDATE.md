# GitHub 自动更新部署

## 运行边界

自动更新由主进程之外的两个 systemd 用户单元执行：

```text
qq-agent-linux-update.timer
  -> qq-agent-linux-update.service
  -> scripts/auto-update.mjs
  -> deploy.sh
```

timer 每小时唤醒一次，应用配置中的 `intervalHours` 决定是否已到达实际检查时间。
默认每 6 小时检查一次，功能默认关闭。更新器不复用聊天会话，也不调用模型。

## 更新依据：已发布的 Release 与本地版本

更新提示与部署目标均以 GitHub 上**已发布的 Release** 为准。branch 上新增提交不触发更新，
以避免部署未经发布的中间状态：

1. 读取仓库最新的 Release，草稿与预发布均不计入。仓库尚无 Release 时不提示、不更新。
2. 以**版本号**判断方向：比较部署目录 `package.json` 的版本与该 Release 的 tag。

   | 版本关系 | 行为 |
   | --- | --- |
   | 本地版本 < Release 版本 | 提示新版本，部署目标为该 tag 的提交 |
   | 本地版本 = Release 版本 | 提示“已是最新”，不回退 |
   | 本地版本 > Release 版本 | 提示“已是最新”，不回退 |

   版本号按语义化规则比较（`v` 前缀与构建元数据忽略，预发布按 semver 排序）。版本相等
   也按“已是最新”处理：版本没升、提交却领先 Release 的手工部署不会被回退成 tag。
3. 版本号解析不了（非标准安装）时才退回 GitHub compare 判定方向；比较接口不可用时不提示、
   不部署，等待下次检查，不推测方向，以避免部署错误版本。compare 响应包含 diff，跨版本
   可达 1MB 以上，因此单独放宽到 4MB / 60 秒。
4. 没有任何部署基线（`deployed-revision` 与状态里的 `currentRevision` 都为空）时保持既有行为：
   控制台仅作说明、不弹窗，但「立即更新」与自动更新会直接安装最新 Release —— 即使本地版本
   相同或更高。经 `deploy.sh` 从非 git 源码树安装会写入 `source-<UTC>`，它不是空值：本版按
   本地版本判定，不受影响。
5. 仍停在旧版本的实例无法自动跨过较大的版本区间（旧代码受 512KB compare 上限影响）；其中基线为
   `source-…` 的压缩包安装是另一种失败：旧代码拿非 SHA 基址去调比较接口，得到 `compare-failed`。
   这两类都需要手工执行一次部署脚本；升到本版后按本地版本判定，`source-…` 不再需要特殊处理。

发布流程：推送 `v*` tag 触发 `.github/workflows/release.yml`，该工作流先执行与 CI 相同的检查，
再创建**草稿** Release。确认无误并发布后，控制台的“发现新版本”弹窗与自动更新才会识别该版本。

## 配置

```json
{
  "autoUpdate": {
    "enabled": false,
    "ownerUin": "",
    "repository": "",
    "repositoryPinned": false,
    "branch": "main",
    "intervalHours": 6,
    "networkRetries": 4,
    "retryBaseMs": 1500,
    "retryMaxMs": 15000,
    "connectivityTimeoutSeconds": 20,
    "fetchTimeoutSeconds": 300,
    "forceHttp11": true,
    "disableOnFailure": true,
    "snowluma": {
      "enabled": false,
      "image": "",
      "followBaseline": true
    }
  }
}
```

- 仓库只接受 GitHub HTTPS 地址。
- `repository` 留空（或仍是旧版写死的上游默认值）时，按**当前部署来源**解析：`.deployment.json` → 当前 checkout 的 `git origin` → `package.json` → 最后才回落到上游。从 fork 部署时默认检查 fork，而不是上游；`QQ_AGENT_REPOSITORY` 可显式覆盖。
- 在控制页显式修改并保存目标仓库后 `repositoryPinned=true`，后续不再跟随部署来源；把仓库清空再保存可恢复跟随。
- 分支名经过格式校验，默认 `main`；控制页可直接修改目标仓库和分支。
- 已有安装如果 `.deployment.json` 里还是上游地址，第一次在控制页保存 fork 仓库即可；自动更新发起的部署会按控制台设置执行，并在成功后把记录同步到 fork。
- `networkRetries` 为网络操作失败后的额外重试次数，范围 0-10。
- 重试采用指数退避：从 `retryBaseMs` 开始，最多增长到 `retryMaxMs`。
- `connectivityTimeoutSeconds` 控制轻量连通性预检超时；`fetchTimeoutSeconds` 控制实际 Git 拉取超时。
- `forceHttp11=true` 时 Git 使用 HTTP/1.1，并设置低速保护，可规避部分 HTTP/2 / GnuTLS 链路抖动。
- `disableOnFailure=true` 保持既有行为：更新失败后暂停后续自动更新；关闭时失败仅记录并告警，后续周期继续尝试。
- 管理员 QQ 必须位于私聊白名单；单独的“测试 GitHub 连通性”不要求配置管理员。
- 控制台“控制 -> 更新部署”可保存网络策略、测试连通性、立即手动更新、暂停或恢复自动更新。
- `snowluma.enabled`：协议端（SnowLuma）自身的自动更新开关（默认关，每 6 小时比一次基线）。
- `snowluma.followBaseline`（**默认开**）：**协议端随本体版本对齐** —— 部署新版本后、主服务
  以新代码启动时，若新版带的协议端基线比当前镜像高就自动升级一次；基线没变（发版没动协议端）
  时不会有任何动作。设了 `snowluma.image`（自定义镜像）的机器永不被自动动到（锁版本优先）。

## 更新流程

1. 使用 `data/update-repository.git` 作为持久 bare 仓库，保留 Git 对象缓存。
2. 先执行目标仓库与目标分支的 `git ls-remote` 轻量连通性测试；失败时按配置重试。
3. 连通性正常后读取最新已发布 Release，并按上一节的标准判断方向；没有可部署的版本时记录“已是最新”并结束。
4. 浅拉取该 Release 的 tag（`refs/tags/<tag>:refs/tags/<tag>`），解析出它指向的提交；
   与 `data/deployed-revision` 相同则记录“已是最新”并结束。`git fetch` 同样按配置重试。
5. 将目标提交检出到 `data/update-work/` 的临时目录。
6. 在独立临时数据目录中执行 `npm ci --omit=dev`（与更新器实际部署的依赖面一致：eslint 等
   devDeps 不装，测试需要 devDeps 的用例按约定自带缺件跳过），然后按 CI 同一套**门禁全清单**
   校验候选代码：全部
   `node:test` 单元测试、`test/local/run.mjs` 与四个回归 harness（提示词 / 渲染 / 滚动 / 用量
   端到端）、关键语法检查，最后 `node src/ops.js scan --strict`；不读取或修改生产数据。
   `npm ci` 使用 `--prefer-offline` 优先复用 npm cache，并把同一组重试参数传给 npm 的 fetch 层。
   有失败项时，错误信息直接列出**失败的用例名与断言原因**（`failureDetail()`），不再截取输出结尾。
   CI 与发布闸门另有一步「按 unit 的加固环境复跑」（`NoNewPrivileges` + `umask 0077` +
   `DOCKER_HOST` 指向不可访问的假套接字 + `npm prune --omit=dev` 的无 devDeps 依赖面），
   把"只在门禁环境里才失败"的用例挡在发布之前 —— 2026-10-10 的两次「升级装不上」（sudo 回退
   用例读真实 /proc、巡检用例读真实 docker 套接字）都属于这一类。
7. 调用目标提交中的 `deploy.sh`。部署脚本创建代码快照、保留数据和凭据、重装依赖、
   校验 systemd 单元、启动服务并检查 `/healthz`。
8. 成功后记录目标提交（`currentRevision`）与 Release tag（`targetVersion`）；失败时由 `deploy.sh` 恢复旧代码和服务。

`deploy.sh` 会同时安装和校验更新 service/timer，并在部署失败时恢复旧单元及原启用状态。

**协议端随版本对齐（2026-10-09）**：协议端基线（`SNOWLUMA_BASELINE_IMAGE`）是代码常量，只随
本体的新版本到达机器 —— 所以"部署新版本后主服务带新代码重启"是看到新基线的唯一时刻。届时
控制台会做一次对齐（仍走"改 .env → pull → up → 等就绪 → 失败自动回滚"这套，数据卷不动）；
基线没变（发版没动协议端）或用户设了自定义镜像（`snowluma.image`）时不会有任何动作，也可以
用 `snowluma.followBaseline=false` 显式关掉。该动作同样要求服务进程能直连 docker.sock
（见 [LINUX.md](LINUX.md) 的「控制台里更新协议端报 docker 权限不足」）。

## 两条下载通道：git 与 API + 源码包

部分网络环境下，到 `github.com` 的 **git 通道**不可用：TCP 可以建立连接，
但 `ls-remote` 会持续阻塞直至超时，而 `api.github.com` 与 `codeload.github.com` 可以正常访问。
该情况下无需手动升级：

1. `git ls-remote` 连通性预检失败后，再通过 GitHub API 探测同一仓库与分支
   （`GET /repos/<owner>/<repo>/commits/<branch>`）。该请求同样失败才判定为不可达，错误与告警逻辑不变。
2. 确定待部署的 Release 后，通过 API 将 tag 解析为 commit（`/commits/<tag>` → `sha`），
   再从 `codeload.github.com/<owner>/<repo>/tar.gz/<sha>` 下载该提交的源码包，
   使用系统 `tar` 解压到工作目录，并去掉压缩包顶层目录。
3. 两条通道均为 HTTPS，均以 GitHub 给出的 commit sha 为锚点，后续步骤
   （`npm ci` → 单元测试 → `deploy.sh`）完全一致；`deploy.sh` 通过
   `QQ_AGENT_SOURCE_REVISION` 记录版本，不依赖工作目录中存在 `.git`。
4. 解析 tag 与获取源码均**先尝试首选通道，失败后切换另一条**：git 可用时使用 git，
   git 不可用时改用 API，API 中途失败时回退 git（回退到 git 获取源码时先 `fetch` 该 tag
   再 `checkout`，因为 API 解析出的提交对象不在本地缓存中）。两条通道均不可用时，
   状态中的错误会同时包含两条通道的原因，不会只保留最后一条。
5. 重试策略对两条通道均生效，次数与退避沿用前述 `autoUpdate` 配置：
   API 探测、tag 解析、源码包下载各自进行退避重试；`4xx`（429 除外）判定为不可重试，不进行无效等待。
6. 源码包在下载过程中累计计算大小，上限为 64 MiB，超限立即断开；默认基地址必须为 HTTPS，
   以防止默认地址被代理或镜像降级为明文。
7. `QQ_AGENT_CODELOAD` 可覆盖 codeload 基地址，供测试桩或自建镜像使用，普通部署无需设置。
   该变量与 `QQ_AGENT_GITHUB_API` 的信任级别不同：后者仅修改只读查询地址，
   前者修改的是**会由 `deploy.sh` 执行的源码来源**。该变量不得接入配置或控制台。
   覆盖成 `http://` 时还必须显式再设 `QQ_AGENT_CODELOAD_ALLOW_INSECURE=1` 才会放行明文——
   等于书面确认"允许从该地址执行代码"，默认拒绝。
8. 本次实际使用的通道记录在 `data/auto-update.json` 的 `transport` 与
   `connectivity.transport`（`git` / `api`）中，控制页的连通性一行同样显示通道名。

## 连通性测试

控制页中的“测试 GitHub 连通性”会提交一个独立的 `probe` 请求：

- 先通过 Git transport（`git ls-remote`）检查目标仓库与分支；git 通道不可用时自动改用
  GitHub API 探测同一分支，两条通道均失败才判定为不可达。
- 适用 HTTP/1.1、超时、重试与指数退避设置。
- 不执行 `git fetch`、`npm ci`、测试或部署。
- 测试失败不会修改自动更新开关，也不会发送部署失败告警。
- 结果保存在 `data/auto-update.json` 的 `connectivity` 字段中，控制页可查看尝试次数、耗时、
  实际通道（`transport`）、目标 revision 和错误。

## 失败策略

检查、测试或部署失败都会在 `data/auto-update.json` 保存失败阶段、脱敏错误和目标提交，并在服务可用且协议端（OneBot）已连接后向管理员发送一次通知。

`disableOnFailure=true` 时：

1. 将 `autoUpdate.enabled` 持久化为 `false`。
2. `autoDisabled=true`，timer 后续唤醒时不再继续部署。
3. 管理员核对后可从控制页恢复自动更新。

`disableOnFailure=false` 时：

1. 自动更新开关保持原状。
2. `autoDisabled=false`，下一个检查周期仍会继续尝试。
3. 告警会明确说明自动更新保持启用，不会误报为“已停止”。

通知发送失败分两种（`src/auto-update.js` 按 `beforeWrite` 判定）：

- **确定没发出去**（协议端未连接等）：保留 pending，等 Agent 启动或协议端重连后继续发送；
- **结果未知**（发送超时、业务拒绝等）：不自动重发，只记 `deliveryUnknown: true` 与错误原因
  （项目规则：结果未知不外发重试），需要人工在控制台确认。
- **发送途中崩溃/重启**：发送前通知会先以"结果未知"状态落盘（`pending=false`），重启后
  不会重发同一条；此时 `notification.error` 为空，部署失败原因看状态里的 `error` 字段。

两种都不会因告警失败再次触发部署，也不会递归创建异常。

“没有新 Release”“本地版本不低于最新 Release”“无法判定方向”均不计为失败：不发送告警、
不触发 `disableOnFailure`，仅在状态文件与控制页“更新部署”面板中说明原因。

## 状态与运维

状态文件：

```text
data/auto-update.json          # 状态、连通性、updateNotice（弹窗判定结果）、ignoredVersion
data/auto-update-request.json  # 一次性请求（manual / scheduled / probe）
data/deployed-revision         # 当前部署的 git 提交，deploy.sh 写入
```

`updateNotice` 中 `reason` 的取值：`no-release`（尚无 Release）、`ahead-of-release`（本地版本不低于最新 Release）、
`unknown-deployed`（没有 `deployed-revision` 基线）、`compare-failed`（版本号无法解析且比较失败）、
`unreachable`（无法连接 GitHub）、`unconfigured`（未配置仓库）。仅当 `available=true` 时弹窗，
`version` 为待部署的 Release tag。

判定使用的 GitHub API 默认为 `api.github.com`；仅测试桩或自建镜像需要设置 `QQ_AGENT_GITHUB_API` 覆盖该地址。

接口：

```text
GET  /api/auto-update/status
PUT  /api/auto-update/settings
POST /api/auto-update/run
POST /api/auto-update/pause
POST /api/auto-update/resume
POST /api/auto-update/notify-pending
GET  /api/auto-update/check
POST /api/auto-update/ignore
```

高级网络配置由控制页通过通用 `/api/config` 持久化；连通性测试使用一次性的 `probe` 请求，不引入额外常驻服务。

命令：

```bash
manage.sh update-status
manage.sh update-now --confirm
manage.sh update-pause --confirm
manage.sh update-resume --confirm
```
