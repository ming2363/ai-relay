---
description: 把一个任务交给 Antigravity（agy）或 Grok 的官方 CLI 执行，Claude 负责核验结果
argument-hint: "<厂商名|auto> --role implement|debug|review|read|deep|quick|claude-backup] [--model 模型] [--write] [--bg] 任务描述"
allowed-tools: Bash(node:*), Bash(git:*), Read, Grep, Glob
---

用户请求：$ARGUMENTS

按以下步骤执行：

1. 解析参数：第一个词是提供方（agy / grok / auto；auto 必须带 --role），其后的 `--role` `--model` `--write` `--bg` 是控制参数，剩下的是任务描述。用户若要 Codex，改用 `/codex:rescue`，不要走这里。
2. 按派单模板（`relay.mjs brief` 查看）把任务整理成**自包含**的派单：首行写"角色：xxx"，下一行写"难度：简单|中等|困难"（按任务实际难度判断：简单的会派给便宜、额度多的模型，困难的只派强模型），必须有「目标」和「验收标准」两段（缺任何一项都会被退回）。对方看不到本会话，本会话里已经确定的事实和用户偏好写进「背景」，或先用 `relay.mjs context set` 存为共享背景。不要放入密钥或 .env 内容。
3. 用 Bash 调用（任务文本走 heredoc，不要拼进命令行）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/relay.mjs" run <提供方> [--role ...] [--model ...] [--write] [--background] --cwd "<当前项目根目录>" <<'RELAY_EOF'
<整理后的任务>
RELAY_EOF
```

   - 用户给了 `--bg`，或任务明显较大（多文件改动、大量阅读）：加 `--background`，随后执行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/relay.mjs" wait <任务id>`（Bash 超时设为 600000）。
   - 没有 `--write` 就是只读。
   - 脚本报额度不足时，把提示告诉用户，并给出 `relay.mjs pick <角色>` 推荐的替代，不要擅自加 `--force`。
4. 复核结果（铁令，不能省）：外派输出只是证据，不是结论，用户把交付视为你出品。可写任务要逐个看 `git diff`、自己运行测试或构建；只读结论要回到引用的文件或数据里核对，不能只抽查或原样转述。
5. 记录验收结论：`node "${CLAUDE_PLUGIN_ROOT}/scripts/relay.mjs" verdict <任务id> pass|partial|fail -- <一句话说明>`，它会影响以后给该模型打的可靠度分。
6. 向用户汇报：谁做了什么（提供方/模型）、为什么选它、你的核验结果和验收结论、发现的问题、下一步建议。
