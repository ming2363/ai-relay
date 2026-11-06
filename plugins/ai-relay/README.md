# ai-relay 使用说明

在 Claude 里按额度调度你的 AI 会员。Claude 是主控，其他模型通过各自的**官方 CLI** 干活：

| 会员 | 调用方式 |
|---|---|
| ChatGPT Plus（Codex） | OpenAI 官方插件 `codex@openai-codex` |
| Antigravity Pro | ai-relay → 官方 `agy` |
| SuperGrok | ai-relay → 官方 `grok` |
| 额度数据 | 自带获取：Claude 读当前会话、Codex 读本地会话记录、agy 跑 `/usage`、Grok 用 CLI 登录令牌查 grok.com 计费接口；哪家自查失败时，装了 AIQuota5h 就沿用它的数据（可选） |

## 三档模式

| 命令 | 模式 | 效果 |
|---|---|---|
| `/ai-relay:relay off` | 纯 Claude | 禁用 Codex 插件，钩子不注入任何内容，外派全部拦截 |
| `/ai-relay:relay manual` | 手动（默认） | Claude 自己干，你点名才外派 |
| `/ai-relay:relay auto` | 自动 | Claude 当主管，统筹拆解、派发、核验和汇报，也自己干活；其他模型当员工，按任务具体分工 |

插件启用或禁用要在**新会话**里才完全生效；钩子的拦截在当前会话立即生效。

## 常用操作

| 想做的事 | 怎么说 / 输入 |
|---|---|
| 看四家额度和各类任务首选 | `/ai-relay:relay` |
| 让 Codex 干活 | 直接说"让 codex 实现 …"，或 `/codex:rescue …` |
| Codex 审查当前改动 | `/codex:review`、`/codex:adversarial-review` |
| 交给 Antigravity / Grok / 新增的厂商 | 直接说"让 grok 审查 …"，或 `/ai-relay:ask grok --role review …` |
| 看额度、启停或增删厂商 | 点输入框底栏的 `ai-relay · 模式` 按钮，或 `/relay-bar` |
| 指定模型 | `/ai-relay:ask agy --model claude-opus-5-5-high …` |
| 允许改文件 | 加 `--write`（默认只读） |
| 大任务后台跑 | 加 `--bg` |
| 全力多模型编排 | 在需求前加 `ulw`，例如 `ulw 给报表模块加按月导出` |
| Claude 额度快用完 | `/codex:transfer`，在 Codex 里 `codex resume <id>` 接着做 |
| 查看外派任务 | 面板「对话」页，或 `/ai-relay:relay jobs`、`/ai-relay:relay result <id>` |
| 记录验收结论 | `relay verdict <id> pass\|partial\|fail -- 说明` |

## 分派方法论（v2）

完整规则在 `skills/orchestrate/SKILL.md`，要点如下。

**1. 分工。** 自动模式下，主模型是主管，其他模型是员工。主管统筹拆解、派发、核验和汇报，也可以自己干活；具体谁做什么按任务分析。成块的、能并行的、别家更擅长的倾向外派；小事、需要 Claude 专属工具的、敏感的倾向自己做。主管亲手写得多时，钩子会提醒考虑外派，只是提醒，不是限制。

**2. 派给谁：质量优先打分。** `relay pick <角色>` 给出首选、备选、跳过的模型和各自的理由。分数是五项的加权几何平均，权重可以在 `scoreWeights` 里调：

| 项 | 权重 | 怎么算 |
|---|---|---|
| 擅长度 | 3 | 路由表里越靠前越高；可用第 4 段直接指定 |
| 可靠度 | 3 | 历史成败加上验收结论，同角色的记录权重更高 |
| 额度 | 0.25（最低） | 剩得多且快重置的加分；低于 15% 硬跳过 |
| 速度 | 0.5 | 历史耗时越长越低 |
| 负载 | 0.5 | 该厂商在跑的任务越多越低，让并行任务分散到不同厂商 |

**并行。** 子任务边界清楚时可以同时派：
- 只读任务随便并行；
- 可写任务要在派单里写「## 写入范围」，范围不重叠的可以同时跑，重叠的会被拒绝，跑完会检查有没有越界改动；
- 用 `relay wait <id1> <id2> …` 一次等全部结束。

**3. 上下文：派单包。** 外派的模型看不到对话，派单包分四层：

| 层 | 内容 | 谁准备 |
|---|---|---|
| 项目上下文 | 目录、git 分支与未提交改动、AGENTS.md 等规则文件 | 自动附上 |
| 共享背景 | 这件事已定的事实、决定、用户偏好 | 主控用 `relay context set` 写一次，同目录 6 小时内自动附上 |
| 派单正文 | 目标 / 背景 / 相关文件 / 约束 / 验收标准 / 交付格式 | 主控写；缺「目标」或「验收标准」会被退回，模板用 `relay brief` 查看 |
| 接力材料 | `--with <id>` 附前序结果，`--diff` 附当前改动 | 按需添加 |

派给 Codex 的 prompt，由钩子自动补上同样的项目上下文和共享背景。

**4. 验收闭环。** 每次外派结束，主控按验收标准核对，然后执行 `relay verdict <id> pass|partial|fail -- 说明`。这个结论会计入以后的可靠度。不简单的改动，必须再派另一家厂商做审查。

**5. 员工最高权限（每家单独开关，默认开）。** agy 和 Grok 执行命令不再逐个审批，可以自己跑测试。约束靠派单里自动附上的三样东西：
- 硬性规则：git 只读、库和服务器只在授权时只读、密钥可读不外露、只改写入范围内的文件；
- 你的全局规则 `~/.claude/CLAUDE.md`；
- 你的本地技能清单。

另外跑完会检查有没有越界改动。每家可以单独开关：面板「厂商」页的"开启 / 关闭最高权限"按钮，或 `relay provider access <名称> on|off`。

### 角色与默认路由

| 角色 | 路由表顺序（决定擅长度） |
|---|---|
| implement 实现 | Codex → Gemini Argon → Grok → agy·Claude Sonnet → Gemini Flash |
| debug 排查 | Codex → Grok → Gemini Argon → agy·Claude Opus → Gemini Flash |
| review 审查 | Grok → Gemini Argon → Gemini Flash → Codex |
| read 大量阅读 | Gemini Flash → Argon → Grok |
| deep 深度推理 | Argon → agy·Claude Opus → Codex |
| quick 简单问答 | Gemini Flash → Grok |
| claude-backup 替 Claude | agy·Claude Opus → Argon → Codex |

实际选谁要看打分。Claude 自身 5 小时额度低于 20% 时，验收中的小修补也改为外派。

### 默认模型

- 路由条目 `provider:pool:model[:fit]` 中 `model` 为 `default` 时，取该额度池的默认模型；写了具体模型 id 的条目不受影响（如 `implement` 的 `claude-sonnet-5-5-high`、`read` 的 `gemini-4-argon-medium`、`quick` 的 `gemini-3.8-flash-medium`）。
- 默认模型存在 `~/.claude/ai-relay/providers.json` 的 `providers.<名称>.defaultModels.<额度池>`。单池厂商（Codex、Grok）未设时不传模型参数、跟随 CLI 默认；多池厂商（agy）每个额度池必须指定默认模型。
- 命令与面板：可在面板「厂商」页切换，或用 `relay models [--refresh]` 从官方 CLI 拉取最新模型清单（缓存 24 小时）、`relay provider model <厂商> <额度池> <模型id|default>` 设置默认模型。

## 增删会员 / 启用停用

**推荐用面板**：点输入框底栏的 `ai-relay · 模式` 按钮（或输入 `/relay-bar`），切到「厂商」页：

- **停用 / 启用**：停用后，自动派活、`relay pick` 和点名外派都会跳过该厂商；Codex 停用后，钩子会拦截 codex 子代理。主控 Claude 不能停用，想只用 Claude 请切到「纯 Claude」模式。
- **新增**：点「＋ 新增厂商」，选模板（Kimi Code CLI / Qwen Code / 自定义），填标识、显示名、命令、模型和参与角色后保存。新厂商排在所选角色的路由末尾。前提是它有官方 CLI，且支持非交互调用；本机还没装时会提示安装方法。
- **试运行**：在空目录里只读跑一句话，确认命令已安装、已登录、参数正确（会消耗一点额度）。
- **删除**：要点两次确认；会同时从所有角色路由中移除，旧配置备份为 `providers.json.bak`。Codex 走官方插件，只能停用不能删除。

命令行等价操作：`relay providers`、`relay provider enable|disable|remove|test <名称>`、`relay provider add <名称> --preset kimi`。

Gemini 会员不需要新增：Google 已停止 Gemini CLI 的个人版（实测返回"请迁移到 Antigravity"），会员额度统一走 Antigravity，也就是 agy 里的 Gemini 3.8 Flash 和 Gemini 4 Argon。

新厂商的额度暂时显示"额度未知"（各家查询方式不同，需要单独接入），调度时排在额度充足的厂商之后、额度偏低的厂商之前。

也可以直接编辑 `~/.claude/ai-relay/providers.json`（插件升级不会覆盖），阈值在这里调：`minRemaining`（默认 0.15）、`lowRemaining`（0.3）、`claudeConserveBelow`（0.2）。

## 已知限制（实测）

- agy / Grok 在无人值守模式下能不能执行终端命令，取决于该厂商的「最高权限」开关（默认开）。关掉时命令会被拒绝，它们只读写文件，测试由主管来跑。Codex 不受这个开关影响，在官方插件固定的沙箱里执行命令。
- Grok 在 `-p` 模式下的默认权限会直接改文件，因此只读任务固定加 `--permission-mode plan`（已内置）。
- Grok 较慢，单次 10–70 秒。
- 任务超时按活动判断：每 60 秒检查终端输出、会话日志与工作区改动，连续 20 分钟无活动判定卡死；总时长 4 小时兜底。可用 `--idle-timeout` 与 `--max-runtime` 调整。
- 额度缓存由状态插件每分钟刷新（agy、Grok 每 5 分钟查一次）；也可手动运行 `relay quota`。Grok 的官方 CLI 没有查额度的命令，relay 用 Grok CLI 的登录令牌直接查 grok.com 的计费接口（令牌只在本机内存里使用，过期时不会自己刷新）；查不到时，装了 AIQuota5h 就沿用它的数据。
- 外派记录：面板「对话」页按对话轮次列出每轮的主模型、Claude 子代理、Codex 和 relay 外派，每轮回答下方也会写一行"本轮模型"；只看外派列表可用 `relay jobs`。

## 数据与清理

- 所有数据都在本机 `~/.claude/ai-relay/`：
  - 配置：`providers.json`、`mode`；
  - 额度缓存：`quota-cache.json`；
  - 外派日志：`jobs/`，保留 30 天；
  - 对话记录：`rounds/`，保留 14 天；
  - 提问记录：`prompts/`，保留 7 天；
  - 共享背景：`context/`，保留 7 天。
- 每天自动清理一次过期数据；`relay clean` 可以随时手动清理，并显示占用的空间。
- 完全卸载：`claude plugin uninstall ai-relay@ai-relay`，再删除 `~/.claude/ai-relay/`。
