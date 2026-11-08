// UserPromptSubmit 钩子：记录用户输入，并按模式注入额度摘要、编排提示和 Claude 额度节流
import fs from "node:fs";
import {
  RELAY_SCRIPT, ULW_RE, MENTION_RE, loadConfig, getMode, readQuotaRows, claudeThrottle,
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
  // 复核铁令（用户定的，任何模式、任何档位都带上）：用户把所有交付都视为主管出品
  lines.push(
    "[复核铁令] 不管派出多少个子任务（Codex、agy、Grok、Agent 子代理），每一个结果主管都要亲自复核后才能交付，不能只抽查、不能原样转述：可写的逐个看 diff、自己跑测试或构建；结论类的回到代码或数据里核对。用户把所有交付都视为主管出品、由主管认可。复核没做完不报完成，汇报写清每个子任务核了什么。",
  );
  // 自动模式按 Claude 剩余额度追加一档；0 档不追加。原「省 Claude」提示并入 2 档
  if (mode === "auto") {
    const t = claudeThrottle(cfg, rows);
    // 质量底线：任何档位都不放松，节流只减少主管亲自执行的部分
    const qualityFloor = "质量优先，节流不降标准：节流只减少主管亲自执行的部分，子任务结果的复核一个都不能省；员工都不擅长、或需要本会话上下文才能判断的活，主管自己做。";
    if (t.level >= 1) lines.push(`[质量底线] ${qualityFloor}`);
    if (t.level === 1) {
      const who = t.richHelpers?.length ? `（其他家充足：${t.richHelpers.join("、")}）` : "";
      lines.push(
        `[节流] Claude 额度只剩 ${fmtPct(t.remaining)}${who}。主管只做：理解需求、拆任务、写派单、验收、汇报。读代码超过 2 个文件、排查、实现、审查、需要看代码才能回答的问题，都外派（阅读 / 快速问答类派给额度最充足的模型）。派单和汇报都写短。`,
      );
    } else if (t.level === 2) {
      lines.push(
        `⚠️ Claude 自身额度只剩 ${fmtPct(t.remaining)}：进入省 Claude 状态——执行类的活（读代码、排查、实现、审查、修补）尽量外派，主管专注拆解、写清派单和严格验收；汇报写短但结论要完整。低于 5% 时建议用户用 /codex:transfer 交接，不要降低标准硬做。`,
      );
    }
  }
  lines.push(`relay 脚本：node "${RELAY_SCRIPT}"`);
  lines.push(`额度：\n${compactStatus(cfg, rows)}`);

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") } }),
  );
}

try {
  main();
} catch {
  // 钩子出错不能影响正常对话
}
