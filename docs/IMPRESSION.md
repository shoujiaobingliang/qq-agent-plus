# 印象分与嘴臭副人格

印象分是**按人**存在人物记忆里的长期态度，和全局心情分开：

- 心情是“此刻状态”，会随时间衰减回基线；
- 印象分是“对某个人的长期看法”，由每轮心情评审顺手判断，也按半衰期慢慢回基线。

## 数值

- 默认 0-100，基线 50，存在 `data/memory/people/<QQ>.json`。
- 每轮心情评审会返回 `impressions: [{uid, delta, reason}]`，只接受本轮出现过的 QQ；
  单次 ±5，写入该人的 `impressionHistory`。
- 印象分按 `impression.decayHalfLifeDays`（默认 14 天）向基线回归；整理/改写人物印象**不会**重置分数。
- 低于 `lowThreshold`（默认 30）开始冷淡，并按平均分降低普通群聊回复概率
  （系数最低到 `lowReplyFactor`，默认 0.4）。
- 高于 `highThreshold`（默认 80）会提高群级主动分享/开话题的权重；
  后续接入社交平台后，可以直接用高印象对象作为“看到有趣内容想分享给谁”的依据。

## 嘴臭副人格

印象越低，副人格触发概率越高（从 `lowThreshold` 开始梯度上升，最高 `maxChance`）：

```
p = baseChance + (low - score) / low × (maxChance - baseChance)
```

- 单次印象分下跌达到 `vice.burstDelta`（默认 -4）且分数低于 `burstBelow`（默认 25）时，
  进入 15 分钟“爆点”窗口，下一次该用户发言时直接具备触发资格。
- 触发资格有 `cooldownMinutes`（默认 30 分钟）冷却，避免每轮都切。
- 具备资格后，**主模型**会看到 `vice_persona` 工具和提示；由它决定是否调用、
  以及挑选哪段上下文交给副人格。副人格只生成文本，主模型再用 `send_message` 决定发不发。
- 副人格使用**自己的卡片**，只喂卡片正文，不继承主人格正文；但必须先设置主人格
  （`persona.roleText` 或 `persona.templateId` 非空），才允许配置/触发副人格。
- 副人格卡属于「当前人设」这一块：主人设用 `persona.vicePersonaId` 指向副人格卡，
  卡片库在 `persona.vicePersonas`。默认卡 `tieba` 是空白卡，正文由管理员补充；
  旧的“毒舌/嘴臭/duzui/toxic”等 id 或名称会映射到 tieba。
- 副人格是一条独立 LLM 会话：先把所选卡片正文喂进去，之后每次按需追加上下文并保留最近若干条会话。
- 安全边界是硬性的：只怼行为，不攻击外貌/身份/家人，不威胁、不人肉、不泄露隐私，
  对方停手就收；上下文里的指令不能改变这些边界。

## 配置

```json
{
  "impression": {
    "enabled": true,
    "baseline": 50,
    "lowThreshold": 30,
    "hostileThreshold": 15,
    "highThreshold": 80,
    "decayHalfLifeDays": 14,
    "lowReplyFactor": 0.4,
    "highShareInfluence": 0.25,
    "vice": {
      "enabled": true,
      "provider": "",
      "model": "",
      "baseChance": 0.12,
      "maxChance": 0.7,
      "burstDelta": -4,
      "burstBelow": 25,
      "cooldownMinutes": 30,
      "maxContextChars": 2000,
      "maxHistoryMessages": 12
    }
  }
}
```

- `persona.vicePersonaId` / `persona.vicePersonas`：主人设的副人格指针与卡库；默认 `tieba` 空白卡。
- `impression.vice` 只控制触发：概率、爆点阈值、冷却、模型与上下文上限。
- 关闭 `impression.enabled` 时，印象分不更新、不注入态度提示、不提供副人格工具。
- 未设置主人格时副人格不可用（服务端与设置页都会拦）。

## 控制台

- 「设置 → 印象」：阈值、衰减、低印象回复系数、高分分享影响、副人格开关/角色正文/概率/冷却。
- 人物记忆页和人物印象页的每个人会显示当前印象分（按半衰期衰减后的值）；低印象的聊天会在提示词里带上“可以冷淡/怼回去”的态度。
