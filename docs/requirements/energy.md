# 精力系统（本项目适配版）：需求与实现方案

> 本文是 `docs/requirements/energy.md` 的项目适配版。原始方案是通用的“拟人精力”数学模型；
> 本文按 qq-agent-plus 的实际架构（事件驱动、真实时钟、LLM 决策、`mood.json` 持久化）
> 做了裁剪和映射。**审批通过后再实施。**
>
> **实施状态（2026-10-26）**：P0 纯模型完成；P1 shadow 接线完成（只计算/记录，不参与任何行为决策）；
> P2（把 `E_obs/S` 接入回复/主动/休息决策）待开始。

## 一、目标与范围

### 目标

把当前“单一精力值 + 固定/疲劳消耗”升级为**多时间尺度的拟人精力模型**：

- 即时精力 `E`：短时间尺度，决定此刻能不能集中精神；
- 睡眠压力 `S`：长时间尺度，决定有多困、多想休息；
- 昼夜相位 `φ`：真实 24 小时节律，制造“午后低谷/傍晚回升”；
- 对外观测精力 `E_obs`：由 `E/S/φ` 合成，专门喂给决策层和提示词。

核心效果：

- 精力随时间/活动下降，**连续活跃越久下降越快**（`S` 累积 + `E` 消耗）；
- 会出现“精神不错但很困”（`E` 不低、`S` 高）和“很累但睡不着”（`E` 低、`S` 不高）两种真实状态；
- 睡觉按实际睡眠时长恢复，睡满整晚接近满状态，晚睡/早醒自然少恢复；
- 精力只调制行为概率与语气，**不改变角色设定、事实判断、安全边界**。

### 非目标（v1 不做）

- 不做游戏引擎式的压缩昼夜（`T_day=24min`）；本项目用真实 24h。
- 不做 `H` 唤醒度/情绪强度（字段预留，v2 再评估）。
- 不做完整 softmax 动作选择器；v1 映射到现有概率系数，softmax 只作为 v2 候选。
- 不做按人设随机参数种子；v1 全局一套参数，v2 再加 persona 偏移。
- 不把“打字速度/错误率”硬造出来；v1 只映射到提示词、回复概率、主动频率、句长。
- 不保留旧 `energyDrainPerHour` / `energyFatigueRampHours` 与新模型并行计算。

## 二、与现有系统的关系

### 保留

- `mood`（心情）：情绪轴，继续走现有评审/事件逻辑，不与精力合并。
- `rest`（睡觉/摸鱼）、`take_break`、23:30–07:30 作息建议（不自动拦截）、管理员叫醒。
- `mood.json` 作为运行状态文件；控制台 `/api/mood`、`/api/status` 的现有展示。
- 提示词不向用户暴露分数、不提及精力系统的边界。

### 替换

当前精力相关逻辑：

- `MoodManager.#energyDrain()` / `energyDrainPerHour`
- `MoodManager.#fatigueRamp()` / `energyFatigueRampHours`
- `lastSleepAt` 的连续清醒疲劳
- `decayMood()` 里的精力单向消耗
- `finishDueRest()` 里的固定 `sleepEnergyGain` / 作息“向 100 补齐”

全部由新 `energy-model` 取代。**旧参数在新模型启用后忽略**，避免双倍扣减。

### 新增

- `src/core/energy-model.js`：纯状态/动力学/观测/迁移，不读配置、不落盘。
- `src/core/energy-runtime.js`（或并入 `MoodManager`）：tick、活动采样、持久化适配。
- `mood.json` 的 `energyModel` 字段（见“持久化”）。
- 控制台诊断：`E`、`S`、`φ`、`E_obs`、当前消耗速率、最近 tick。

## 三、状态模型

### 状态量

```text
x = [E, S, φ]        v1
x = [E, S, φ, H]     v2（H 预留）
```

| 符号 | 含义 | 值域 | 时间常数 | 说明 |
|---|---|---|---|---|
| `E` | 即时精力 | `[E_MIN, 1]`，`E_MIN=0.02` | `τ_E≈10min` | 动力学内部值 |
| `S` | 睡眠压力/疲劳 | `[0,1]` | `τ_S≈8h` | 高 = 很困 |
| `φ` | 昼夜相位 | `[0,2π)` | `T_day=1440min` | 真实本地时间 |
| `H` | 唤醒度（v2） | `[0,1]` | `τ_H≈20min` | v1 不参与 |

### 外部输入

- `a(t)∈[0,1]`：当前活动强度（见第四节）。
- `u_sleep(t)∈{0,1}`：是否处于睡觉（`rest.kind==='sleep'`）；摸鱼不算。
- `e_k`：离散事件（被夸、被骂、连续工具调用等）→ 先只影响 `mood`，v1 不直接脉冲 `E/S`。

### 观测值

```text
E_obs = clip(E * (1 + β * cos φ) - η * S, 0, 1)
```

- `E_obs` 用于决策、提示词、控制台；
- `E` 只在动力学内部流转；
- 对外仍暴露 0–100 的 `energy` 兼容字段：`energy = round(E_obs * 100)`。

### 相位定义

`φ=0` 对应本地时间 **16:00**（下午精力峰值）：

```text
φ = 2π * ((localMinutes - 960) mod 1440) / 1440
```

因此 `cos φ` 在 16:00 为 +1、04:00 为 -1，形成“下午高、凌晨低”的观测节律。

## 四、活动强度 `a(t)`：以深度思考 Token 为主

### 4.1 为什么改

原方案用“消息率”估活动强度，但消息触发条件不同：一条短消息可能触发一次很重的深度思考，
十条闲聊可能一次模型都没调。用消息数会把两者算反。

本项目最贴近“认知负荷”的现成信号是**模型每次调用的思考 Token**。单位时间产生的思考 Token
越多，说明当前越费脑，精力消耗应越快；这与消息条数、触发方式无关。

### 4.2 主信号：思考 Token 速率

每次主模型调用结束后记录一条样本：

```text
tokens = usage.completion_tokens_details.reasoning_tokens   // 最精确：只算思考
      || usage.completion_tokens                            // 兜底：总输出 token（通常都有）
      || estimate((reasoning_content || content).length)    // usage 完全缺失时的最后兜底

rate    = Σ tokens(最近 windowMinutes) / windowMinutes
a_think = clip(rate / thinkFullTokensPerMinute, 0, 1)
```

- **优先** `usage.completion_tokens_details.reasoning_tokens`；项目在
  `src/core/providers.js` 已经读取这个字段，说明至少部分渠道可用。
- **兜底用 `usage.completion_tokens`（总输出 token）**：这是 OpenAI 兼容接口最稳定的字段，
  项目当前 `session.callUsage` 已经在记录它。它包含可见输出 + 思考 Token，作为“这次调用干了多少活”
  的代理足够用；代价是会把普通长回复也算进去，`thinkFullTokensPerMinute` 要按这个口径校准。
- **不要用 `total_tokens` 兜底**：它包含 prompt/上下文，长上下文会让“没怎么思考”也显得很高。
- 连 `usage` 都没有时，才用 `reasoning_content`/`content` 长度估算
  （`tokens ≈ ceil(chars / estimateCharsPerToken)`，默认 `1.5` 字符/token）。
- **只统计主对话与回复纠正**（`purpose: 'chat' | 'reply-correction'`）；
  心情评审、记忆整理、每日说说、空间互动等后台调用默认不计，避免后台任务把人格精力吃掉。
  需要时再给 `backgroundWeight`（默认 0）。

### 4.3 辅助信号（只做兜底）

```text
a_session = sessionActive ? 1 : 0
a_tool    = clip(toolCalls(最近 window) / toolFullRate, 0, 1)

a_raw = wThink  * a_think
      + wSession* a_session
      + wTool   * a_tool

a = EMA(a_raw, emaMinutes)
```

默认：`wThink=0.7, wSession=0.2, wTool=0.1`。
`mode='thinking'` 时 `wThink=1`、其余为 0；`mode='hybrid'` 用默认权重。
辅助信号只解决“思考 Token 缺失/为 0”时的下限，不按消息条数直接算强度。

### 4.4 采集点与字段

| 采集点 | 现有位置 | 要加的东西 |
|---|---|---|
| 主对话调用 | `orchestrator.js` 主循环 `chatCompletionWithRetry` 之后 | 记录 `reasoningTokens`、`completionTokens`、`durationMs`、`purpose` |
| 回复纠正 | `orchestrator.js` 的 `reply-correction` 调用 | 同上 |
| 工具调用 | 工具执行完成处 | `EnergyModel.recordToolCall(at)` |
| 会话活跃 | session start/end | `EnergyModel.recordSessionActive(at)` |
| 调用用量 | `session.callUsage` | 新增 `reasoningTokens` 字段，方便控制台/调试 |

实现建议：

- `EnergyModel.noteThinking({ at, reasoningTokens, completionTokens, durationMs, purpose })`
  维护最近 `windowMinutes` 的样本环形缓冲；
- tick 时计算 `rate` 和 `a`，不依赖数据库全表扫描；
- 单次调用时长按 `durationMs` 折算速率；拿不到时长时按最小 30 秒处理；
- 单次异常大的调用可设 `maxTokensPerCall` 上限（默认 20000），防止一次失控调用长时间把 `a` 顶满；
- 进程重启后样本缓冲为空，`a` 从 0 开始，避免把停机时间误算成高活动。

### 4.5 注意事项

- 不同模型/渠道的 reasoning token 统计口径不同（有的只给 completion，有的给 reasoning_tokens，
  有的只在 `reasoning_content` 里留文本）。`thinkFullTokensPerMinute` 要按实际渠道校准；
- 关闭 thinking 时 `a_think` 会接近 0，此时靠 `a_session` 兜底；不能把“没开思考”误判为“没干活”；
- 思考 Token 是**认知负荷**，不包含“处理很多条消息”这种社交疲劳；如果以后发现连续闲聊不累，
  再提高 `wSession` 或加一个很小的消息率项，但不要再用消息数做主轴。


## 五、动力学与 tick

### 连续形式

```text
dS/dt = γ * a - δ * u_sleep * S
R(S)  = 1 - α * S
dE/dt = k_r * u_sleep * R(S) * (1 - E) - k_c * a * E - k_s * S
dφ/dt = 2π / T_day
```

> **本项目适配点**：恢复项乘了 `u_sleep`。这是为了保留现有规则“只有睡觉能涨精力”：
> 白天即使空闲，`E` 也不会靠 `k_r` 自动回升；只有 `rest.kind==='sleep'` 时才恢复。
> 如果以后想允许“白天休息也能小幅回精力”，再把 `u_sleep` 拆成 `u_sleep + u_rest`。

### 离散 tick（半隐式欧拉）

固定 tick `Δt = tickSeconds/60` 分钟；先更新 `S`，再更新 `E`：

```text
S' = clip(S + (γ*a - δ*u_sleep*S) * Δt, 0, 1)
E' = clip(E + (k_r*u_sleep*(1 - α*S')*(1 - E) - k_c*a*E - k_s*S') * Δt, E_MIN, 1)
φ' = (φ + 2π*Δt/T_day) mod 2π
```

- 使用半隐式 + clip，任意 `Δt` 下稳定；
- 进程长时间停机后补算：把 `now - lastTickAt` 拆成不超过 **60 秒**的子步，避免大 `Δt` 的近似误差；
- 停机期间：
  - 若持久化的 `rest.kind==='sleep'`，按 `u_sleep=1` 补算；
  - 否则按 `a=0`、`u_sleep=0` 补算（进程没运行 = 没在聊天，但不强制定为睡觉）；
- tick 频率：复用现有休息 ticker（30 秒）；也可以按事件懒补算，但**必须**同时记录 `lastTickAt`。

### 休息与恢复

- `u_sleep=1` 时 `S` 按 `δ` 衰减，`E` 通过 `k_r(1-αS)(1-E)` 恢复；
- `u_sleep=0` 时恢复项为 0，`E` 只减不增（符合“只有睡觉能涨精力”）；
- 睡满整晚（8h）在默认参数下 `S` 接近 0、`E` 接近 1；
- 晚睡/早醒按实际睡眠时长自然少恢复；
- **兼容现有“睡满整晚恢复到 100”**：作息睡眠结算时，若实际睡眠比例 ≥ 0.99，将 `E` 直接置 1、`S` 置 0；部分睡眠保留 ODE 结果（按比例）。
- 手动 `take_break` 睡眠同样走 ODE，不再额外加固定 `sleepEnergyGain`；
- 摸鱼 `slack` 不设 `u_sleep`，疲劳继续累积，只恢复心情。

### 作息建议（不是硬拦截）

作息窗口是**建议**，不是到点自动暂停：

- 到 `sleepAt` 时**不自动**调用 `startScheduledSleep`、不拦截消息、不强行改 `rest`；
- 在下一次模型请求的**用户提示词**里注入一条“作息建议”（`mood-prompt.js` 的【当前心情】块，**不进 system/persona**）：到点了，建议睡觉；如果还在聊/还有事，可以继续熬夜；
  - 原因：作息窗口是动态状态，放进 system/persona 会改 `promptPrefixHash`、关闭生命周期线程并破坏前缀缓存（与 `docs/MOOD.md` 的心情块同一口径）；
- **只有模型自己调用 `take_break({kind:'sleep'})` 才进入硬暂停**；
- 模型决定睡时：**先按人设用 `send_message` 回一句**（如“晚安，我先去睡了”），再调用 `take_break(kind=sleep)`；
  本轮有人说话但还没回时，`take_break` 会拒绝并要求先回一句；没有对话对象（主动唤醒/管理员操作）可以直接睡；
- 在作息窗口内模型调用 `take_break(kind=sleep)` 时：
  - 允许绕过 `maxMoodForRest` / `maxEnergyForRest` 门槛；
  - 默认睡到 `wakeAt`（不是固定 90 分钟），总时长按窗口计算；
  - 睡满窗口 `E→1/S→0`，提前醒按 ODE 比例恢复；
- 模型不睡：消息照常处理，精力/疲劳继续累积；系统不强制叫醒、不强制拦截；
- `allowStayUp` 不再表示“允许/禁止”，改为“是否注入作息建议”（默认 true）；
- 当前代码里的 `#tickRest` 是“到点自动 hard sleep”，需要按本节改成“只注建议”；这是 P2 的改动，P0 不做行为变更。

> 这样安排的原因：作息是人格建议，不是系统级静音。半夜有人找、或机器人自己还想聊，应该由模型根据
> `E_obs/S` 和上下文决定睡不睡；系统只负责提醒和结算，不替它做“立刻离线”的决定。

## 六、观测层与现有 0–100 兼容

- 内部一律用 `E/S/φ`（0–1）；
- 对 UI、`/api/status`、`mood-prompt.js` 暴露：
  - `energy`：`E_obs * 100` 的兼容值；
  - `energyLabel`：沿用现有档位（疲惫/没精神/正常/有活力/亢奋）；
  - 新增 `fatigue`：`S * 100`、`fatigueLabel`（清醒/有点困/很困/撑不住）。
- 决策阈值全部基于 `E_obs`，不要直接拿 `E` 做阈值（这是“看起来不累却去休息”的根源）。

## 七、决策耦合（v1 映射，不做完整 softmax）

### 映射到现有系数

| 现有位置 | v1 规则 |
|---|---|
| `MoodManager.frequencyFactor()` | `clamp(1 + f*(2*E_obs-1), 0.6, 1.4)`，`f=frequencyInfluence` |
| `attentionMinConfidence(base)` | `base + (0.5 - E_obs)*f + slackBias` |
| `proactiveProbability(base)` | `base * frequencyFactor()`；休息中为 0 |
| `proactiveIntervalFactor()` | `1 - f*(2*E_obs-1)*0.5`，夹 0.75–1.25 |
| `followUpEnergyOk()` | `E_obs >= followUpMinEnergy/100` |
| `take_break` 建议 | `S >= restSuggestS`（默认 0.75）或 `E_obs < 0.25` |
| 作息建议 | 到 `sleepAt` 只在提示词里建议睡觉；是否睡由模型调用 `take_break` 决定，系统不自动拦截消息 |
| 提示词语气 | `mood-prompt.js` 用 `E_obs` + `S` 生成“精神/困倦”描述 |

### 可选 v2：薄策略 softmax

只对策略动作 `{回复, 跳过, 主动开话题, 休息}` 做 softmax：

```text
U_i = base_i*(0.3+0.7*E_obs) - cost_i*(1-E_obs) + 1_rest*λ*S + 1_same*μ
P(i) = softmax(U_i / τ)
```

- `τ` 随 `S` 升高而增大（累了决策更模糊）；
- 仍然不接管 LLM 的文本生成，只影响“要不要回复/要不要主动/要不要休息”；
- v1 先用现有系数，避免大规模改决策链。

## 八、表现层

v1 只做低风险映射：

- `mood-prompt.js` 增加 `E_obs/S` 描述，例如“精神还行，但有点困”；
- 回复概率、主动频率、补话阈值按第七节调整；
- 句长建议：`E_obs` 低时提示“短句、少开新话题”；
- 打字指示器延迟、语音/表情频率：v2 可接，v1 不改；
- 不向用户报分数、不提及系统。

## 九、持久化与迁移

### `mood.json` v2

```json
{
  "version": 2,
  "mood": 55,
  "moodUpdatedAt": 1234567890,
  "energyModel": {
    "E": 0.55,
    "S": 0.3,
    "phase": 1.2,
    "lastTickAt": 1234567890,
    "activity": { "msg": [], "tool": [], "lastSessionAt": 0 }
  },
  "energy": 55,
  "energyLabel": "正常",
  "rest": null,
  "history": [],
  "daily": {}
}
```

- `energy` / `energyLabel` 是**兼容派生字段**，每次写盘时由 `E_obs` 更新；旧控制台/提示词无需改。
- `mood` 字段保持原样；`mood` 的衰减逻辑不动。
- `history` / `daily` 可继续记录 `energyDelta`，但值来自 `E_obs` 变化。

### v1 → v2 迁移

首次读取旧 `mood.json` 时：

```text
E = clamp(old.energy / 100, E_MIN, 1)
awakeHours = (now - (old.lastSleepAt || now)) / 3600000
S = clamp(max(1 - E, awakeHours / 16), 0, 1)
phase = 2π * ((localMinutes - 960) mod 1440) / 1440
lastTickAt = now
```

- 旧 `energyDrainPerHour` / `energyFatigueRampHours` 在新模型启用后忽略；
- 迁移只写回一次，保留 `mood`、`rest`、`history`、`daily`；
- 若新模型 `enabled=false`，回退到旧精力逻辑（保留一个版本周期），并记录一条日志。

## 十、配置

```json
{
  "mood": {
    "energyModel": {
      "enabled": true,
      "tickSeconds": 30,
      "kr": 0.020,
      "kc": 0.012,
      "ks": 0.015,
      "gamma": 0.0035,
      "delta": 0.010,
      "alpha": 0.7,
      "beta": 0.15,
      "eta": 0.3,
      "dayMinutes": 1440,
      "phaseOffsetMinutes": 960,
      "eMin": 0.02,
      "activity": {
        "mode": "hybrid",
        "windowMinutes": 10,
        "thinkFullTokensPerMinute": 2000,
        "estimateCharsPerToken": 1.5,
        "maxTokensPerCall": 20000,
        "wThink": 0.7,
        "wSession": 0.2,
        "wTool": 0.1,
        "toolFullRate": 3,
        "emaMinutes": 5,
        "includePurposes": ["chat", "reply-correction"],
        "backgroundWeight": 0
      },
      "decision": {
        "followUpMinEobs": 0.25,
        "restSuggestS": 0.75,
        "scheduledFullSleepRatio": 0.99
      },
      "schedule": {
        "enabled": true,
        "sleepAt": "23:30",
        "wakeAt": "07:30",
        "allowStayUp": true
      }
    }
  }
}
```

- 所有参数在 `config-legacy.js` 中夹到安全区间；
- v1 控制台只暴露：启用/关闭、tick、`kr/kc/ks/gamma/delta`、`β/η`、活动权重、`followUpMinEobs`、`restSuggestS`；
- 其余高级参数只写在 `config.json`，避免设置页过载。

## 十一、控制台与可观测性

- 心情面板增加：
  - 精力（`E_obs` 0–100）与困倦（`S` 0–100）；
  - 当前活动强度 `a`、当前消耗速率、最近 tick；
  - 最近变化里显示 `E_obs`/`S`，不显示用户 QQ。
- `/api/mood` 返回 `energyModel: { E, S, phase, Eobs, rate }`（只读）。
- **Shadow 模式**：`energyModel.shadow=true` 时只计算/记录，不参与任何决策；控制台显示新旧对照。建议先跑 3–7 天，再切行为。

## 十二、测试与验收

### 单元测试

- 动力学稳定性：`Δt=0.5min`、`Δt=60min`、8h 补算不发散、不越界；
- `E_MIN` 地板、`clip`、`S` 饱和；
- 睡眠恢复：8h 睡眠 `E→1`、`S→0`；4h 睡眠恢复约一半（按 ODE）；
- 昼夜相位：16:00 `E_obs` 最高、04:00 最低；
- 观测层：`E=1,S=1` 时 `E_obs` 被压低；`E=0.5,S=0` 时随 `φ` 波动；
- 活动强度：`reasoning_tokens` 优先、`completion_tokens` 兜底、`content/reasoning_content` 长度最后兜底；
- 思考 Token 窗口/EMA：一次 8K 思考不会让 `a` 永久顶满；窗口过期后回落；
- `maxTokensPerCall` 上限、`includePurposes` 过滤、后台调用不计；
- 迁移：旧 `mood.json` 可读、字段默认、写回 v2；
- 决策系数：`E_obs` 降低时回复/主动概率单调下降；`S` 升高时休息建议增加。

### 集成/验收

- 满睡 8h 后：`E_obs ≥ 0.9`、`S ≤ 0.1`；
- 从满状态醒 16h：`E_obs` 在 0.55–0.80（按最终调参定）；
- 连续清醒 24h：`E_obs < 0.5`；36h：`< 0.2`；
- 作息建议：到 `sleepAt` 不自动进入 `rest`、不拦截消息；下一次模型请求带建议文案；
- 模型在窗口内调用 `take_break(sleep)` 可绕过低状态门槛，并默认睡到 `wakeAt`；
- 本轮有人说话但还没发消息时，`take_break(sleep)` 被拒绝；先 `send_message` 后允许；
- 进程重启：`lastTickAt` 正确补算，不出现“重启即满血/重启即累死”；
- Shadow 期间行为与现状逐字/逐概率一致；
- 关闭 `energyModel.enabled` 可回退旧精力逻辑。

## 十三、分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | `energy-model.js` 纯模型 + 单元测试 + shadow 日志；不改行为 | 1–2 天 |
| P1 | `mood.json` v2 迁移、思考 Token 采样、惰性补算（读写触发，复用 30s rest ticker）、shadow 对照 | 1–2 天 |
| P2 | `E_obs/S` 接入回复/注意力/主动/补话/休息建议；保留开关 | 1–2 天 |
| P3 | 提示词、控制台、`/api/mood` 诊断字段；参数页 | 1 天 |
| P4 | 用 shadow 数据调参、移除旧精力模型、更新文档与测试 | 1 天 |

总计 **4–6 天**。P0–P1 完成前不要切换行为。

## 十四、风险与回滚

- **参数不匹配**：`k_r/k_c/k_s/γ/δ` 直接决定日周期；必须先 shadow 对照，不要凭感觉上线。
- **活动强度失真**：`a(t)` 估计过低会“永远不累”，过高会“整天疲惫”；EMA 窗口和权重需用真实群数据校准。
- **思考 Token 不可得**：不是所有渠道都返回 `reasoning_tokens`；优先用 `completion_tokens` 兜底，`content/reasoning_content` 长度只做最后兜底，并按渠道校准 `thinkFullTokensPerMinute`。
- **双算**：旧 `energyDrainPerHour`/`energyFatigueRampHours` 必须停用；否则一天掉两次。
- **停机补算**：大 `Δt` 必须拆子步；否则重启后状态跳变。
- **时区/昼夜**：`phase` 用服务器本地时间；跨时区部署需显式配置 `timezone`（v2）。
- **回滚**：`mood.energyModel.enabled=false` 回到旧精力逻辑；`shadow=true` 只观测不影响行为；`mood.json` 保留兼容 `energy` 字段。

## 十五、待审批的默认决策

以下按本项目情况先定为方案默认值，审批时请确认或修改：

1. **真实 24h 昼夜**，不做压缩时间。
2. **v1 不做 `H` 唤醒度**。
3. **v1 不做完整 softmax**，只映射现有概率系数。
4. **活动强度以深度思考 Token 为主**（单位时间思考 Token 越多强度越大）；缺失时用 `completion_tokens`（总输出 token）兜底，content 长度只做最后兜底；会话/工具仍做小权重兜底，消息条数不再作为主轴。
5. **新模型替换旧精力逻辑**（`energyDrainPerHour` / `energyFatigueRampHours` 停用），`mood` 心情保留。
6. **作息是建议，不自动拦截**：到 23:30 只在提示词里建议睡觉；只有模型自己调用 `take_break(kind=sleep)` 才进入硬暂停，不睡则消息照常处理。
7. **睡满整晚** `E→1/S→0`；部分睡眠按 ODE 比例恢复。
8. **参数先全局一套**，persona 偏移放 v2。
9. **先 shadow 3–7 天**，再切换行为。

审批通过后，按 P0 → P4 实施；P0 只新增纯模型和日志，不改现有聊天行为。
