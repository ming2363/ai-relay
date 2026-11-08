// PostToolUse 钩子：
//   Codex 子代理结束后补全外派记录（完成 / 失败），并提醒主模型验收后记录结论
//   自动模式下统计主模型亲手改动的行数（含 Bash 写入），写得多时提醒考虑外派（只是提醒，不是限制）
//   自动模式下统计主模型读文件次数，额度紧张且读得多时提醒外派
//   Bash 里的 relay self / relay run 记下这一轮的分工
import fs from "node:fs";
import { helpRequestOf } from "./brief.mjs";
import path from "node:path";
import {
  RELAY_SCRIPT, JOBS_DIR, ensureStateDir, appendHistory, getMode, loadConfig,
  readSelfEdits, writeSelfEdits, editedLines, readHistory, gitSnapshot,
  diffSnapshots, checkOutOfScope, readQuotaRows, claudeThrottle,
  isScratchPath, readBashSnap, clearBashSnap, resolveRepos, lineSnapshot, snapshotDelta,
  selfEditLimitMessage, bashWroteReminder, isRelayRunCommand,
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

// Bash 的 tool_response 可能是整段字符串，也可能是带 stdout 的对象
function bashOutputText(res) {
  if (typeof res === "string") return res;
  if (res && typeof res === "object" && typeof res.stdout === "string") return res.stdout;
  return responseToText(res);
}

// 取出 [relay-self] 那一行里的原因。面板直接显示这段文字。
function relaySelfReason(text) {
  const mark = "[relay-self] ";
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const at = trimmed.indexOf(mark);
    if (at === -1) continue;
    return trimmed.slice(at + mark.length).trim();
  }
  return "";
}

async function handlePostBash(input) {
  if (input.agent_id || getMode() !== "auto" || !input.session_id) return;
  const sessionId = String(input.session_id);
  const command = String(input.tool_input?.command || "");
  const stat = readSelfEdits(sessionId);
  const isRelay = command.includes("relay.mjs");
  if (isRelay && !stat.decision) {
    const reason = relaySelfReason(bashOutputText(input.tool_response));
    if (reason) {
      stat.decision = "self";
      stat.selfReason = reason;
      stat.bashPending = false;
    } else if (isRelayRunCommand(command)) {
      stat.decision = "dispatch";
      stat.bashPending = false;
    }
  }
  let delta = 0;
  const before = readBashSnap(sessionId);
  if (before) {
    try {
      const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
      // 只对比前快照里的仓库，并以当时的 HEAD 为基准：中途新纳入的仓库原有改动不算，命令里的提交也不算改动
      const heads = before.heads && typeof before.heads === "object" ? before.heads : null;
      const repos = heads ? Object.keys(heads) : resolveRepos(sessionId, stat, cwd, command);
      delta = snapshotDelta(before, await lineSnapshot(cwd, repos, heads || undefined));
    } catch {
      delta = 0;
    }
    clearBashSnap(sessionId);
  }
  if (delta > 0) {
    stat.lines += delta;
    if (!stat.decision) stat.bashPending = true;
  }
  let limit = 40;
  try {
    limit = loadConfig().selfEditMaxLines || 40;
  } catch {}
  const warn = selfEditLimitMessage(stat, limit);
  writeSelfEdits(sessionId, stat);
  const parts = [];
  if (delta > 0 && !stat.decision) parts.push(bashWroteReminder(delta));
  if (warn) parts.push(warn);
  if (parts.length) context(parts.join("\n"));
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const tool = String(input.tool_name || "");

  if (tool === "Bash") return handlePostBash(input).catch(() => {});

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
    // 写在临时目录、计划或会话 memory 里的不是项目代码，不计入
    const target = String(input.tool_input?.file_path || input.tool_input?.notebook_path || "");
    if (isScratchPath(target)) return;
    stat.lines += editedLines(tool, input.tool_input);
    const warn = selfEditLimitMessage(stat, limit);
    writeSelfEdits(input.session_id, stat);
    if (warn) context(warn);
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
  let msg = `[ai-relay] Codex 外派记录 id：${input.tool_use_id}。亲自复核（逐个看 diff、自己跑测试，或回到代码核对结论）并按验收标准核对后记录结论：node "${RELAY_SCRIPT}" verdict ${input.tool_use_id} pass|partial|fail -- <一句话说明>`;
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
