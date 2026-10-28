# 每日长期记忆（Daily Memory）

> 状态：Phase 1（默认关闭）。设计稿见
> [`requirements/human-like-memory.md`](requirements/human-like-memory.md) 与
> [`requirements/daily-memory.md`](requirements/daily-memory.md)。

每天固定时刻把**前一天**群聊/私聊里值得长期保留的内容抽出来，写入独立的
`data/memory/daily-memory.sqlite`。目标是“重要的事记得准、日常的事记得大概”，
而不是把所有聊天都存成知识库。

## 它能做什么

- **选择性编码**：只提炼会话约定/暗号、决定、群规、重要事件、人物关键事实；琐事不写。
- **保真度分层**：
  - `verbatim`：暗号、群规、决定、重要人物事实——逐字保留，不自动淡出；
  - `gist`：日常事件与一般事实——只留摘要，细节默认 30 天后淡出；
  - `transient`：低价值/一次性事件——短 TTL。
- **激活召回**：每轮按当前话题、参与者、重要度、近因、频率给记忆打分；固定约定始终注入，
  模糊记忆只在相关时出现。
- **隐私作用域**：`knowledge / chat / person / secret`。私聊学到的通用知识（例如
  “农在某些语境指王者荣耀”）可以在群里使用；私聊里的个人秘密不会跨会话出现。
- **可纠正**：merge/supersede 保留旧版本；模型不能删除，删除只由管理员执行。

## 开启

默认关闭。在 `config.json` 中设置：

```json
{
  "dailyMemory": {
    "enabled": true,
    "time": "04:10",
    "minMessages": 2,
    "maxChats": 20,
    "human": {
      "enabled": true,
      "gistDetailDays": 30,
      "activationMin": 0.25,
      "privacy": {
        "allowKnowledgeAcrossChats": true,
        "personUsableWhenAbsent": false
      }
    }
  }
}
```

只处理当前 `runtime.mode=active`、未暂停且在群/私聊白名单内的会话；后台任务不受
`isTimeActive` 限制（不发言）。每群每天最多一次模型调用。

也可以通过控制台接口手动触发：

```bash
# 状态（开关、下次运行、最近任务、条目统计）
curl -H "Cookie: qq_agent_token=..." http://127.0.0.1:3210/api/daily-memory/status

# 跑指定日期/会话（force=true 时即使已完成也重跑，upsert 不产生重复）
curl -X POST -H "Cookie: qq_agent_token=..." -H "content-type: application/json" \
  -d '{"day":"2026-10-01","force":true}' \
  http://127.0.0.1:3210/api/daily-memory/run

# 条目 / 召回记录 / 每日总结
GET  /api/daily-memory/entries?chatKey=group:123&status=active
GET  /api/daily-memory/entries/:id
GET  /api/daily-memory/recall-log?chatKey=group:123&limit=50
GET  /api/daily-memory/summaries?chatKey=group:123
GET  /api/daily-memory/chats

# 管理动作
POST /api/daily-memory/entries/:id/pin        # 固定为精确记忆
POST /api/daily-memory/entries/:id/forget     # {hard:true} 才物理删除
POST /api/daily-memory/entries/:id/privacy    # {privacyScope, subjectUserId}
POST /api/daily-memory/consolidate            # {chatKey?}
POST /api/daily-memory/prune                  # 按保留期清理
```

## 模型怎么用

- 每轮提示词注入 `【长期记忆】`：固定约定/决定 + 与本轮相关的模糊记忆。
- 标 `（模糊）` 的是 gist，只能当背景，不能补全细节。
- 标 `（只用不说）` / `（仅本会话）` 的条目只能影响行为，不能向群友复述或透露来源。
- 需要按关键词/某人/某类查时，模型可调用 `memory_lookup`；默认只返回摘要，
  `includeContent=true` 才返回未淡出的细节。

## 数据与运维

- 数据库：`data/memory/daily-memory.sqlite`（目录 0700、文件 0600；不启用 WAL，
  与现有整目录备份一致）。
- 每日巩固：强度衰减、gist 细节淡出、transient 到期、召回日志清理（30 天）。
- `memory_recall_log` 记录最近 30 天“哪些记忆被召回、分数与命中方式”，用于排查
  “为什么忘了/为什么突然提起”。
- 失败（模型不可用、坏 JSON）只把当天任务标 `failed`/`interrupted`，不阻塞聊天；
  下次定时/手动运行会重试。

## Phase 1/2 边界

- 不做 embedding/向量召回；先走结构化作用域 + FTS/关键词 + 激活分数。
- 不做聊天内实时抽取；暗号等当天要用的内容仍由模型 `memory_append` 或当轮上下文处理。
- 持久化配置：控制台「设置 → 记忆 → 每日长期记忆」已接入开关、运行时间、最少消息、会话上限、
  模糊记忆开关、细节保留天数、召回阈值与跨会话知识开关。
- 会话记忆页已接入长期记忆列表、固定为精确、忘记、修改隐私作用域与最近召回记录。
- 旧人物印象（`data/memory/people/<QQ>.json`）继续独立运行；长期事实与印象在注入时去重。
- 目录级 L1 概览、`memory_dirs` 与抽象级 embedding 属于 Phase 3。
