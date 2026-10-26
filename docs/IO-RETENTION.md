# IO 降低与保留期

## 背景

长时间运行在云盘上时，容易出现 IOPS 异常：会话 JSON 每 2 秒整份重写、SQLite 每条消息
`FULL` fsync、控制台 15 秒轮询全量解析会话文件、Docker 日志无轮转。这里集中收敛。

## 保留期配置

`config.json` 的 `store`：

```json
{
  "messageRetentionDays": 7,
  "sessionRetentionDays": 7,
  "sessionPersistIntervalMs": 10000,
  "sqliteSynchronous": "NORMAL"
}
```

- `messageRetentionDays`：聊天消息与已关闭线程的 transcript/检查点保留天数；默认 7，`0` = 不按时间删除。
  只删除 `state='acked'/'failed'` 的消息，**pending/leased/held 不删**。
- `sessionRetentionDays`：`data/sessions/*.json` 运行留档保留天数；默认 7，`0` = 不按时间删除。
  运行中/等待中的会话不会被删。
- `sessionPersistIntervalMs`：运行中会话 JSON 的落盘间隔；默认 10000ms，夹在 2~60 秒。
- `sqliteSynchronous`：`NORMAL`（默认，低 IOPS）或 `FULL`（更严格的掉电持久化）。
  WAL 下 `NORMAL` 仍能扛应用崩溃。

控制台：**设置 → 聊天设置 → 存储与清理**。

## 调度

- 进程启动时清一次（`ChatStore` 构造、`SessionRegistry` 构造）。
- 常驻期间由 `core/ledger-retention.js` 每日跑一次（与身份/关系/异常/运行台账共用同一个调度器）。
- 单次清理失败只记日志，下一天重试，不影响进程。

## 已做的 IO 优化

- `/api/status` 的今日 token 统计改为只读 `usage-today.json` + 内存运行会话；
  成本明细仍走带缓存的会话汇总，但目录签名不再被运行中的 rewrite 打穿。
- `usage-today.json` 改为内存累加、15 秒批量落盘；停服时 `sessions.flushUsage()` 强制刷盘。
- 运行中会话 JSON 默认 10 秒落盘一次，去掉每次写盘的 `chmod`。
- `messages.sqlite` 默认 `synchronous=NORMAL`（WAL）。
- SnowLuma 容器增加 Docker 日志轮转（`20m × 3`）。
- **媒体处理不再整包进内存**（2026-10-26 复盘）：图片/视频/音频改为流式落盘，
  单次上限图片 12MiB（超大图 32MiB）、视频 32MiB、音频 64MiB；GIF/视频/普通图片先经
  ffmpeg 降采样成小 JPEG 再进内存/base64。媒体任务全局串行（同一时刻只跑一个），
  并在 `MemAvailable < 96MB`（音频等大媒体 `< 128MB`）时直接跳过。ffmpeg 限 `-threads 2`，
  启动时清理 `/tmp/qq-media-*`、`/tmp/qq-ffmpeg-*`、`/tmp/qa-audio-*` 等残留目录。

## 注意

- `messageRetentionDays=7` 会删除 7 天前的已读消息：引用旧消息、翻更早历史、金句墙等会受影响。
- 延长保留期会增加磁盘与清理时间；繁忙群建议同时设置 `store.maxMessagesPerChat`。
- 需要严格掉电持久化时把 `sqliteSynchronous` 改回 `FULL`，但 IOPS 会回升。
- 超过上述媒体上限的图片/视频/音频会看不到画面（会明确报错）；这是为了避免
  在内存紧张的机器上因一次大缓冲把整机拖进读盘抖动。
