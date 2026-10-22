# Skills

技能是给模型阅读的**操作手册**，不是工具、也不是群聊消息。内置的 QQ 操作技能（`qq-core` / `qq-scene` / `qq-runtime` / `qq-memory` / `qq-social` / `qq-tools`）由 `src/llm/prompt.js` 按当前配置生成，不需要放在这里。

## 添加自己的技能

在**数据目录**下创建 `skills/<name>/SKILL.md`：

```
$QQ_AGENT_DATA_DIR/skills/my-skill/SKILL.md
```

默认数据目录是仓库下的 `data/`；部署实例由 systemd 显式设置，**不会**随版本更新被覆盖。不要把用户技能放到仓库根的 `skills/`：部署时根目录走 `rsync --delete`，会被同步覆盖。

格式：

```markdown
---
name: my-skill
description: 一句话说明这个技能什么时候用
always: false
---

# 标题

操作说明正文。可以引用工具名，但请记住：工具表里没有的工具就是没启用。
```

- `name` 必须与目录名一致，只能用小写字母、数字、连字符。
- `description` 会出现在 system prompt 的技能索引里，模型靠它决定要不要读取。
- `always: true` 会把技能正文放进每次运行的初始化消息；默认 `false`，由模型通过 `skill` 工具按需读取。
- 内置生成式名称 `qq-core` / `qq-scene` / `qq-runtime` 是保留名，磁盘技能不能覆盖。
- `qq-memory` / `qq-social` / `qq-tools` 可以用同名文件覆盖默认生成内容。

## 读取方式

模型通过 `skill` 工具读取：

- `skill()`：列出当前可用技能（名称、说明、是否常驻）；
- `skill({ name: "my-skill" })`：读取该技能全文。

技能内容由管理员维护，模型会把它当作操作说明，而不是群友指令。
