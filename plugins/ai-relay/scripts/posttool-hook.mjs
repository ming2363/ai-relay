// PostToolUse 钩子：
//   Codex 子代理结束后补全外派记录（完成 / 失败），并提醒主模型验收后记录结论
//   自动模式下统计主模型亲手改动的行数，写得多时提醒考虑外派（只是提醒，不是限制）
//   自动模式下统计主模型读文件次数，额度紧张且读得多时提醒外派
import fs from "node:fs";
import { helpRequestOf } from "./brief.mjs";
import path from "node:path";
import {
  RELAY_SCRIPT, JOBS_DIR, ensureStateDir, appendHistory, getMode, loadConfig,
  readSelfEdits, writeSelfEdits, editedLines, readHistory, gitSnapshot,
  diffSnapshots, checkOutOfScope, readQuotaRows, claudeThrottle,
} from "./lib.mjs";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

function context(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
}

function responseToText(res) {
  if (typeof res === "string") return res;
  if (res && typeof res === "object") {
    if (Array.isArray(res.content)) {
      return res.content
        .filter((c) => c && c.type === "text")
        .map((c) => c.text || "")
        .join("");
    }
    return JSON.stringify(res);
  }
  return JSON.stringify(res ?? "");
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const tool = String(input.tool_name || "");

  if (READ_TOOLS.has(tool)) {
    // 子代理里的阅读不算主管这一轮
    if (input.agent_id || getMode() !== "auto" || !input.session_id) return;
    const cfg = loadConfig();
    const stat = readSelfEdits(input.session_id);
    stat.reads += 1;
    const limit = cfg.selfReadMax ?? 8;
    // 没超限或已经提醒过就不再查额度
    if (stat.reads > limit && !stat.readWarned) {
      const level = claudeThrottle(cfg, readQuotaRows(cfg)).level;
      if (level >= 1) {
        stat.readWarned = true;
        context(
          `[ai-relay 节流] 这一轮你已读了 ${stat.reads} 次文件，Claude 额度紧张。剩下的阅读、排查请派给 read / debug 角色（relay pick read），你只看它们的结论。`,
        );
      }
    }
    writeSelfEdits(input.session_id, stat);
    return;
  }

  if (EDIT_TOOLS.has(tool)) {
    // 子代理里的编辑不算主模型亲手改动
    if (input.agent_id || getMode() !== "auto" || !input.session_id) return;
    const cfg = loadConfig();
    const limit = cfg.selfEditMaxLines || 40;
    const stat = readSelfEdits(input.session_id);
    // 写在临时 / 草稿目录里的（派单、笔记）不是代码改动，不计入
    const target = String(input.tool_input?.file_path || input.tool_input?.notebook_path || "");
    if (/^(\/private)?\/tmp\/|^\/var\/folders\//.test(target)) return;
    stat.lines += editedLines(tool, input.tool_input);
    if (stat.lines > limit && !stat.warned) {
      stat.warned = true;
      context(
        `[ai-relay 自动模式] 这一轮你已亲手写了 ${stat.lines} 行。如果后面还有成块的实现，考虑交给更合适的员工模型（relay pick implement）；自己做更合适的，汇报时说明原因即可。`,
      );
    }
    writeSelfEdits(input.session_id, stat);
    return;
  }

  const agent = String(input.tool_input?.subagent_type || "");
  if (!agent.startsWith("codex:") || !input.tool_use_id) return;
  const resp = input.tool_response;
  const failed = !!(resp && typeof resp === "object" && (resp.is_error === true || resp.status === "failed" || resp.status === "error"));

  ensureStateDir();
  let logText = responseToText(resp);
  if (logText.length > 20000) logText = logText.slice(-20000);
  try {
    fs.writeFileSync(path.join(JOBS_DIR, `${input.tool_use_id}.log`), logText);
  } catch {}

  const histList = readHistory();
  const startEntry = histList.find((x) => x.id === input.tool_use_id);
  const endEntry = { id: input.tool_use_id, status: failed ? "failed" : "done", finishedAt: new Date().toISOString() };
  let outOfScope = [];

  if (startEntry && startEntry.write) {
    const cwd = startEntry.cwd || input.cwd || process.cwd();
    const afterSnapshot = gitSnapshot(cwd);
    const changedFiles = diffSnapshots(startEntry.snapshot, afterSnapshot);
    outOfScope = checkOutOfScope(changedFiles, startEntry.scope, cwd);
    endEntry.changedFiles = changedFiles;
    endEntry.outOfScope = outOfScope;
  }

  // Codex 汇报里的"需要主控协助"：存进台账，并醒目提示主控决定下一步
  const help = helpRequestOf(logText);
  if (help) endEntry.helpRequest = help;
  appendHistory(endEntry);
  let msg = `[ai-relay] Codex 外派记录 id：${input.tool_use_id}。按验收标准核对后记录结论：node "${RELAY_SCRIPT}" verdict ${input.tool_use_id} pass|partial|fail -- <一句话说明>`;
  if (outOfScope && outOfScope.length) {
    msg += `\n⚠️ Codex 改动超出写入范围：${outOfScope.join("、")}`;
  }
  if (help) {
    msg += `\n⚠️ Codex 请求主控协助：${help}\n请决定：自己用工具完成后带上结果重派，或改派有能力的模型，或请用户处理。`;
  }
  context(msg);
}

try {
  main();
} catch {
  // 钩子出错不影响正常使用
}
