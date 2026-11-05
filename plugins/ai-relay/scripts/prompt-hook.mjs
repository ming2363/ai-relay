// UserPromptSubmit 钩子：记录用户输入，并按模式注入额度摘要与编排提示
import fs from "node:fs";
import {
  RELAY_SCRIPT, ULW_RE, MENTION_RE, loadConfig, getMode, readQuotaRows, poolStatus,
  compactStatus, savePrompt, fmtPct, mentionsProvider,
} from "./lib.mjs";

function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const prompt = String(input.prompt || "");
  savePrompt(input.session_id, prompt);

  const mode = getMode();
  if (mode === "off") return;

  const cfg = loadConfig();
  const ulw = ULW_RE.test(prompt);
  const mention = MENTION_RE.test(prompt) || mentionsProvider(cfg, prompt);
  if (!ulw && !mention && mode !== "auto") return;

  const rows = readQuotaRows(cfg);
  const lines = [];
  if (ulw) {
    lines.push("[ai-relay] 用户用 ulw 触发了多模型编排：先调用 Skill「ai-relay:orchestrate」，严格按其流程执行。");
  } else if (mode === "auto") {
    lines.push(
      "[ai-relay 自动模式] 你是主管（主模型），其他模型是员工。大方向：统筹拆解、派发、核验和汇报，也可以自己干活；具体谁做什么按任务具体分析，方法见 Skill「ai-relay:orchestrate」。",
      "倾向于外派：成块的阅读、实现、排查、独立审查，能并行的子任务，别家更擅长或额度更充足的活。倾向于自己做：小改动、纯问答、外派往返不划算的、涉及密钥等敏感内容的、需要 Claude 专属工具的。汇报时说清谁做了什么、为什么这样分工。",
      "Claude 专属工具（浏览器、你已登录的网站、Word/Excel/PPT、文档连接器、MCP、需要用户确认的操作）外派模型用不了：这部分你先做，把结果写进派单背景再派其余部分。各家员工能不能联网、执行命令看厂商能力和最高权限开关（relay providers 可查），派单里用「## 需要的能力」写明，选人时会自动筛选；它们汇报里的「需要主控协助」由你决定下一步。",
    );
  } else {
    lines.push("[ai-relay] 用户提到了其他模型/外派。外派方法见 Skill「ai-relay:orchestrate」，只做用户点名的那部分。");
  }
  lines.push(`relay 脚本：node "${RELAY_SCRIPT}"`);
  lines.push(`额度：\n${compactStatus(cfg, rows)}`);

  const claude = cfg.providers.claude;
  if (claude && rows) {
    const st = poolStatus(cfg, rows, claude.quota.provider, claude.quota.pools[0]);
    if (st.remaining !== null && st.remaining < (cfg.claudeConserveBelow || 0.2)) {
      lines.push(`⚠️ Claude 自身额度只剩 ${fmtPct(st.remaining)}：进入省 Claude 状态——你只做拆解与审核，执行全部外派；低于 5% 时提醒用户用 /codex:transfer 交接。`);
    }
  }

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") } }),
  );
}

try {
  main();
} catch {
  // 钩子出错不能影响正常对话
}
