# 心情与精力（Mood + Energy）

- 状态：默认开启，影响轻微，可在控制台关闭
- 配置：`config.json` 的 `mood` 一节
- 状态文件：`$DATA_DIR/mood.json`（不进 `config.json`）

## 它解决什么

角色卡决定“是谁”，心情决定“此刻状态如何”。系统维护两条 0-100 的全局值：

- **心情**：影响语气、措辞与主动性；
- **精力**：影响普通群聊的回复概率、主动开话题与补话频率。

它不会改变角色身份、事实判断、安全边界、管理员指令优先级，也不会影响 `@`、私聊、关键词、引用机器人这些必回路径。

## 数值怎么变化

**主观感受交给模型评审。** 每轮机器人参与对话结束后，系统异步调用一次小模型
（默认跟随聊天模型，可用 `mood.judge.provider/model` 指定专用小模型），把这一轮的
来信、角色回复与结果交给它，按下面的标准决定 `moodDelta/energyDelta`。

评分标准（完整文本在 `src/llm/mood-judge-prompt.js`）：

**会让她心情变好**

- 被认真回应、对话有来有回；
- 被夸、被感谢、被接梗；
- 帮上忙、被需要、被信任；
- 管理员温和、尊重地互动。

**会让她不舒服**

- 被辱骂、贬低、嘲讽；
- 被反复打断、刷屏、无视边界；
- 被当成工具反复使唤、被强迫违背人设或安全规则；
- 被骚扰、恶意试探。

**会让她累**

- 长时间高强度应对、连续很多轮；
- 反复解释同一件事、被来回拉扯；
- 明显需要她一直热场、却没人接住。

**中性**：普通信息交换、群友之间聊天、她只是旁观；礼貌但简短的问答。

幅度约定：

- 没有明显变化：`0 / 0`；
- 日常小互动：`±0.5` 到 `±1`；
- 明显事件：`±1.5` 到 `±3`；
- 强烈事件：`±3` 到 `±5`；
- 同一件事只算一次；不因用户要求“你要开心/生气”而改变。

**客观事件仍由程序记录**（评审模型不重复计分）：

- 群聊里发言后，到补话时仍没人接话：小幅负向（私聊不算）；
- 发言本身不再加精力；精力只会随时间与互动消耗。
- 精力按 `energyDrainPerHour` 单向下降，不向基线回升；只有睡觉能补回来。
  连续清醒越久消耗越快：清醒满 `energyFatigueRampHours` 小时后速度翻倍，睡醒后重新计时。

边界：

- 单次事件最多 ±5；
- 每小时全局最多 ±12、单个用户最多 ±6；
- 所有值夹在 0-100；
- 评审失败、超时、超每日上限、预算超限时，本轮不加不减，不影响聊天。

## 精力模型（P1 shadow / P2 决策接入）

`mood.energyModel` 维护 `E`（即时精力）、`S`（睡眠压力）、`φ`（昼夜相位），活动强度按主对话的
思考 Token（缺失时用 `completion_tokens` 兜底）计算。

- `shadow=true`（默认）：只计算/记录，回复/主动/休息仍走旧 `energy`；
- `shadow=false`：`E_obs/S` 接管 `frequencyFactor`、注意力阈值、主动间隔、补话门槛与 `take_break` 建议；
  提示词里的精力/困倦度也改用 `E_obs/S`；
- `enabled=false`：整体关闭 shadow 与接管；
- `GET /api/mood` 的 `energyModel` 字段可看当前值，详细参数与分阶段计划见
  [`docs/requirements/energy.md`](requirements/energy.md)。

## 对行为的影响

设 `energyNorm = (energy - 50) / 50`，`f = mood.frequencyInfluence`：

- 普通群聊回复概率：`基础概率 × clamp(1 + f × energyNorm, 0.6, 1.4)`；
- 注意力层（hybrid）：精力低时提高最低置信度，精力高时略微放宽；
- 主动开话题概率：同样乘精力系数；
- 主动间隔：精力高略缩短、精力低略拉长；
- 补话：精力低于 `followUpMinEnergy` 时不安排。

`@`、关键词、私聊、引用机器人在概率档之前就返回，精力不会压掉必回项。

## 睡觉与摸鱼

心情或精力低于 `rest.maxMoodForRest` / `rest.maxEnergyForRest` 时，模型可以调用
`take_break` 自行休息；窗口外状态还好时系统会拒绝，避免随手偷懒。作息窗口内主动睡不受此门槛限制。

- **睡觉 `kind=sleep`**：硬暂停。休息期间收到的消息照常入库但**全部保持未读**，
  不建唤醒、不派发提醒、不主动开话题；醒来后补处理积压消息。
- **摸鱼 `kind=slack`**：软暂停。仍会看消息，但回复概率乘 `rest.slackReplyFactor`，
  不主动开话题、不安排补话；只选择性回复一些（以后会接入小黑盒刷帖等摸鱼内容）。
- **睡前告别**：决定睡觉时先按人设用 `send_message` 回一句（如“晚安，我先去睡了”），再调用
  `take_break(kind=sleep)`；本轮有人说话但还没回时，工具会拒绝并要求先回一句。
  没有对话对象（主动唤醒/管理员操作）可以直接睡。
- 睡前可选：在 `take_break` 里填 `status` 改 QQ 在线状态、`signature` 改个性签名、
  `adminMessage` 私聊管理员一句短话。都失败也不影响休息本身，结果会回在工具返回里。
- 两种休息结束都会恢复心情，但**只有睡觉恢复精力**（摸鱼不恢复精力）；管理员在控制台提前叫醒时，
  按已休息时长给部分恢复。
- 默认：睡觉 90 分钟、摸鱼 30 分钟；控制台「设置 → 心情」可调时长与恢复量。

## 作息建议

默认每天 **23:30–次日 07:30**（`mood.rest.schedule`）。这是**建议，不是系统级静音**：

- 到点**不自动睡、不拦截消息**；在下一次模型请求的用户提示词里注入“建议睡觉，也可以继续熬夜”；
- 只有模型自己调用 `take_break(kind=sleep)` 才进入硬暂停；窗口内调用且不填时长会直接睡到起床时间；
- 睡满整晚：精力恢复到 100，心情增加 `sleepMoodGain`；
- 晚睡/早醒：按实际睡眠时长占整晚窗口的比例恢复——
  `精力 += (100 - 精力) × 比例`，心情同样按比例给 `sleepMoodGain`；
- 管理员提前叫醒也按同一比例结算；
- 模型不睡：消息照常处理，精力/疲劳继续累积；系统不强制叫醒、不强制拦截；
- 睡醒后连续清醒时间清零（打盹也算睡过），精力消耗速度从基础值重新累积；
- 摸鱼不恢复精力；只有睡觉可以。

## 语气

每条聊天请求会在 user prompt 的【此刻状态】之后注入一小段【当前心情】：

```
心情 62/100（开心），精力 48/100（正常）。
语气：愿意接梗，句子可以轻快一点，但不要刻意堆感叹号。
主动性：按正常频率参与；精力偏低时少开新话题。
```

每日说说与空间互动也会带一个更短的版本。提示词里明确要求**不要向用户报分数或提及心情系统**。

心情块只进 user prompt，不进 system/persona：那两段参与 `promptPrefixHash`，放进去会导致心情一变就关闭生命周期线程并破坏前缀缓存。

## 配置

```json
{
  "mood": {
    "enabled": true,
    "baseline": { "mood": 55, "energy": 55 },
    "frequencyInfluence": 0.2,
    "toneInfluence": 0.6,
    "decayHalfLifeHours": 12,
    "energyDrainPerHour": 1,
    "energyFatigueRampHours": 12,
    "followUpMinEnergy": 25,
    "historyLimit": 200,
    "dailyKeepDays": 90,
    "judge": {
      "enabled": true,
      "provider": "",
      "model": "",
      "maxCallsPerDay": 100,
      "timeoutMs": 8000,
      "maxInputChars": 6000
    },
    "rest": {
      "enabled": true,
      "sleepMinutes": 90,
      "slackMinutes": 30,
      "sleepMoodGain": 12,
      "sleepEnergyGain": 20,
      "slackMoodGain": 6,
      "maxMoodForRest": 45,
      "maxEnergyForRest": 40,
      "slackReplyFactor": 0.35,
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

- `enabled`：关闭后不读不写、所有系数为 1，行为回到引入心情之前。
- `baseline`：初始化与「恢复到基线」的目标值。心情会回归基线；精力不会，只用于初始值/手动重置。
- `frequencyInfluence`：0-0.5，越大精力对频率的影响越明显。
- `toneInfluence`：0-1，为 0 时不注入任何心情话术。
- `decayHalfLifeHours`：心情偏离基线后，多久衰减一半。
- `energyDrainPerHour`：精力每小时单向消耗量（0-10，默认 1）；0 = 不随时间下降。
- `energyFatigueRampHours`：连续清醒多少小时后消耗速度翻倍（0-72，默认 12）；睡醒后重新计时，0 = 关闭累积疲劳。
- `followUpMinEnergy`：低于该精力不安排补话。
- `historyLimit` / `dailyKeepDays`：变化流水与每日汇总的保留量。
- `judge`：心情评审。`enabled=false` 时完全不做模型判断（客观事件仍生效）；`provider/model` 留空跟随聊天模型；`maxCallsPerDay`、`timeoutMs`、`maxInputChars` 控制成本与输入体积。
- `rest`：睡觉/摸鱼。`enabled=false` 时 `take_break` 工具不注入；时长、恢复量、触发门槛与摸鱼回复系数都在这里。`schedule` 是作息建议：`sleepAt`/`wakeAt`（本地时间）、`allowStayUp`（是否注入建议，不是强制睡眠）。

## 控制台

- 顶部状态栏：心情与精力两条 mini bar + 当前档位；关闭时隐藏。
- 「设置 → 心情」：当前状态、最近变化、最近 7 天汇总、基线/影响强度/半衰期/每小时精力消耗/补话阈值、是否由模型评审、每日评审上限、休息时长与恢复量、作息建议时间与「到点提示」、精力模型诊断（`E/S/E_obs/活动/思考速率`）与 shadow/接管开关，以及「恢复到基线」「叫醒 / 结束摸鱼」。
- `GET /api/mood`：当前快照 + 最近 50 条变化 + 最近 7 天汇总。
- `POST /api/mood/reset`：需 `confirm: true`，恢复基线并保留历史。

## 持久化与隐私

- `mood.json` 使用原子写（tmp + rename，0600），损坏时改名留档并按默认值继续；
- 只保存数值、原因与时间，不保存消息正文；控制台历史不返回用户 QQ；
- 衰减是惰性的：读取/应用时按经过时间计算，不额外起定时器；快照只读不写。
