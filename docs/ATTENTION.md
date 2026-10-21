# 注意力层（模型决定要不要回）

- 状态：已实现，默认关闭
- 配置：`trigger.mode = "probability" | "hybrid"`

## 它解决什么

原来的概率触发只做一次随机：命中就整轮跑主模型，不命中就标记已读。
`hybrid` 模式把普通群聊的“要不要回”交给一个低成本判定模型：

```
普通群聊新消息
→ 注意力判定（ignore / peek / reply）
→ ignore：标记已读，不跑主模型
→ peek：再读一段上下文后重新判定（最多一次）
→ reply：带着模型选择的历史条数跑主回复
```

以下情况**跳过注意力、直接必回**：

- 被 @
- 命中关键词
- 引用机器人
- 私聊
- 失败批次重试

## 配置

```json
"trigger": {
  "mode": "hybrid",
  "attention": {
    "provider": "",
    "model": "",
    "contextMessages": 20,
    "maxInputChars": 4000,
    "timeoutMs": 2500,
    "maxCallsPerDay": 300,
    "minConfidence": 0.55,
    "fallbackToProbability": true,
    "defaultContextCount": 40
  }
}
```

- `provider` / `model` 留空 = 跟随聊天模型；也可以指向 `providers` 里的专用小模型。
- `maxCallsPerDay`：判定调用每日上限；`0` 表示不调用（此时行为取决于 `fallbackToProbability`）。
- `minConfidence`：低于该置信度的 `reply` 视为不确定，按 `fallbackToProbability` 处理。
- `fallbackToProbability`：判定失败/超时/低置信度时回落到原来的概率；关闭则直接忽略。
- `defaultContextCount`：判定 `reply` 没给 `readCount` 时，主回复读多少条历史。

## 成本与安全

- 判定调用计入每日用量台账，受每日预算、时间控制、暂停/观察模式约束。
- 判定输入只带最近消息、本批新消息、交接摘要和短人设，不带工具表、表情清单。
- 判定结果按批次缓存 2 分钟，重试/重复唤醒不重复计费。
- 判定失败不会影响主流程；最多回落到概率或忽略。
- 只在「传统触发」模式生效；参与者续接/完整生命周期已有自己的模型判断。

## 观测

后台日志会输出：

```
[attention] group:123 不回复（ignore/0.9：别人闲聊），5 条已读
```

主回复的触发原因会显示为 `注意力判定：<reason>` 或 `注意力回退概率`。

## 限制

- 判定模型仍可能误判；必回规则是硬编码的，不会交给判定模型。
- `peek` 最多一次，避免无限深读和成本失控。
- 注意力层不做长期记忆；人物印象/交接仍由现有记忆模块负责。
