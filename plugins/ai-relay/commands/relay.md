---
description: 查看多模型额度与当前模式，或切换模式（off 纯 Claude / manual 手动 / auto 自动），也可查看外派任务 jobs、result <id>
argument-hint: "[status|off|manual|auto|jobs|result <id>|cancel <id>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/relay.mjs" cli $ARGUMENTS`

把上面的命令输出原样展示给用户，不要做额外操作，也不要外派任何任务。
