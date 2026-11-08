// PreToolUse 钩子：按模式和额度拦截对 Codex 子代理的调用；
// Bash 里执行 relay run 时，把当前会话记成待认领记录，供面板按会话归外派；
// 自动模式下，第一次改项目代码前还没定分工就拒绝（不改写命令）
import fs from "node:fs";
import path from "node:path";
import {
  ULW_RE, MENTION_RE, STATE_DIR, loadConfig, getMode, readQuotaRows, poolStatus,
  loadPrompt, fmtPool, isEnabled, appendHistory, lastPick, runningWriters, scopesOverlap,
  normScope, withWriteLock, gitSnapshot, workspaceRoot, isInside, writePendingDispatch,
  readSelfEdits, writeSelfEdits, isScratchPath, divisionReason, resolveRepos, lineSnapshot, writeBashSnap,
  isRelayRunCommand,
} from "./lib.mjs";
import { BRIEF_TEMPLATE, checkBrief, roleOfBrief, levelOfBrief, buildDispatchPrompt, readSharedContext, scopeOfBrief, needsOfBrief } from "./brief.mjs";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// 不改命令（不回 updatedInput）。relay run 只落一条待认领记录。
// 自动模式、还没定分工、而且上一轮 Bash 已经改过项目代码时，拦住下一次非 relay 的 Bash。
function handleBash(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== "string") return;
  const sessionId = String(input.session_id ?? "").trim();
  const isRelay = command.includes("relay.mjs");
  if (isRelayRunCommand(command) && sessionId) {
    writePendingDispatch({
      sessionId,
      cwd: typeof input.cwd === "string" ? input.cwd : "",
    });
  }
  // 子代理里的调用不统计、不拦截
  if (input.agent_id || !sessionId || getMode() !== "auto") return;
  const stat = readSelfEdits(sessionId);
  if (!stat.decision && stat.bashPending && !isRelay) {
    deny(divisionReason());
    return;
  }
  // relay 自己的命令不拍快照，避免把脚本的输出和仓库扫描搅在一起
  if (isRelay) return;
  try {
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    const repos = resolveRepos(sessionId, stat, cwd, command);
    // 返回 Promise：进程等快照写完再退出；失败就不计这次 Bash 的行数
    return lineSnapshot(cwd, repos).then((snap) => writeBashSnap(sessionId, snap)).catch(() => {});
  } catch {}
}

// 自动模式第一次改项目代码前必须先定分工。临时目录和 memory / plans 不算项目代码。
function handleEditGate(input) {
  if (input.agent_id || getMode() !== "auto") return;
  const sessionId = String(input.session_id ?? "").trim();
  if (!sessionId) return;
  const target = String(input.tool_input?.file_path || input.tool_input?.notebook_path || "");
  if (isScratchPath(target)) return;
  const stat = readSelfEdits(sessionId);
  if (stat.decision) return;
  deny(divisionReason());
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }),
  );
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const tool = String(input.tool_name || "");
  if (tool === "Bash") return handleBash(input);
  if (EDIT_TOOLS.has(tool)) return handleEditGate(input);
  const agent = String(input.tool_input?.subagent_type || "");
  if (!agent.startsWith("codex:")) return;

  const mode = getMode();
  if (mode === "off") {
    return deny("[ai-relay] 当前为纯 Claude 模式（off），不外派给 Codex，请自己完成。用户可用 /ai-relay:relay manual 重新开启。");
  }

  const cfg = loadConfig();
  const prov = cfg.providers.codex;
  if (prov && !isEnabled(prov)) {
    return deny("[ai-relay] Codex 已在 ai-relay 面板中停用，不要派给 Codex，请自己完成或改派其他已启用的模型。");
  }

  const prompt = loadPrompt(input.session_id);
  if (mode === "manual" && !(MENTION_RE.test(prompt) || ULW_RE.test(prompt))) {
    return deny("[ai-relay] 手动模式：用户这轮没有点名 Codex，不要主动外派，请自己完成或先询问用户。");
  }

  const rows = readQuotaRows(cfg);
  if (prov && rows) {
    const st = poolStatus(cfg, rows, prov.quota.provider, prov.quota.pools[0]);
    if (st.level === "blocked") {
      return deny(`[ai-relay] Codex 额度不足（${fmtPool(st)}），已拦截。请运行 relay pick 选择其他模型，或告知用户。`);
    }
  }
  // 派单必须写清目标和验收标准：Codex 看不到主会话，缺了只能靠猜
  const brief = String(input.tool_input?.prompt || "");
  const missing = checkBrief(brief);
  if (missing.length) {
    return deny(`[ai-relay] 派给 Codex 的 prompt 缺少「${missing.join("」「")}」段落，已退回。按下面的模板补全后重新调用：\n\n${BRIEF_TEMPLATE}`);
  }
  const role = roleOfBrief(brief);
  const validRoles = Object.keys(cfg.routes || {});
  if (!role || !cfg.routes?.[role]) {
    return deny(`[ai-relay] 派给 Codex 的派单必须在首行注明"角色：xxx"，可选：${validRoles.join(", ")}`);
  }
  // 难度必填：Codex 是强档，简单的活应该交给便宜、额度多的模型，主管得先判断过
  if (!levelOfBrief(brief)) {
    return deny(`[ai-relay] 派给 Codex 的派单没写难度，已退回。在「角色」下一行写「难度：简单|中等|困难」。简单的活先用 relay pick <角色> --level 简单 看看有没有更便宜的模型`);
  }
  // 派单写了 Codex 做不到的能力就退回，避免它在断网沙箱里硬做或臆测
  const needs = needsOfBrief(brief);
  const codexCaps = prov?.caps || {};
  if (needs.includes("web") && codexCaps.web !== true) {
    return deny("[ai-relay] Codex 不具备：联网（沙箱默认断网）。需要联网的部分请先由主控完成或改派 Grok / agy，把结果写进派单背景");
  }
  if (needs.includes("exec") && codexCaps.exec !== true) {
    return deny("[ai-relay] Codex 不具备：执行命令。需要执行命令的部分请先由主控完成或改派有能力的模型，把结果写进派单背景");
  }
  const WRITE_ROLES = new Set(["implement", "debug", "claude-backup"]);
  const forceReadOnly = brief.split(/\r?\n/).some((line) => /^[ \t]*权限\s*[:：]\s*只读[ \t]*$/.test(line));
  const write = !forceReadOnly && WRITE_ROLES.has(role);
  const cwd = input.cwd || process.cwd();
  const pick = lastPick(role);
  const id = input.tool_use_id || `codex-${Date.now()}`;
  let scope = null;
  if (write) {
    const ws = workspaceRoot(cwd);
    let rawScope;
    if (brief.includes("写入范围")) {
      rawScope = scopeOfBrief(brief);
      if (!rawScope || !rawScope.length) {
        return deny("[ai-relay] 写入范围段落没有解析出任何路径");
      }
    } else {
      rawScope = ["."];
    }
    // 用原始路径判断：normScope 会把工作区外的绝对路径收成 "."，那样就拦不住
    for (const p of rawScope) {
      if (!isInside(path.resolve(cwd, p), ws)) {
        return deny(`[ai-relay] Codex 沙箱只能写 ${ws}，写入范围 ${p} 在外面。请改派其他模型：relay pick <角色> --write --target <目录>`);
      }
    }
    scope = rawScope.map((s) => normScope(cwd, s));
    if (!scope || !scope.length) {
      scope = ["."];
    }
  }

  const historyEntry = {
    id,
    provider: "codex",
    model: "default",
    role,
    level: levelOfBrief(brief),
    reason: pick?.provider === "codex" ? `${pick.reason}${pick.skipped.length ? `；跳过 ${pick.skipped.join("、")}` : ""}` : "主模型指定 Codex",
    write,
    scope,
    status: "running",
    startedAt: new Date().toISOString(),
    task: String(input.tool_input?.description || brief).slice(0, 300),
    cwd,
  };
  if (write) {
    const snapshot = gitSnapshot(cwd);
    if (snapshot) historyEntry.snapshot = snapshot;
  }

  if (write) {
    let conflict = null;
    try {
      withWriteLock(cwd, () => {
        const writers = runningWriters(cwd, Date.now(), cfg.jobTimeoutMinutes || 30);
        conflict = writers.find((w) => scopesOverlap(w.scope, scope, cwd));
        if (!conflict) {
          appendHistory(historyEntry);
        }
      });
    } catch (e) {
      return deny(`[ai-relay] ${e.message}`);
    }
    if (conflict) {
      const confScope = Array.isArray(conflict.scope) && conflict.scope.length ? conflict.scope.join(",") : (conflict.scope || ".");
      return deny(`与正在运行的可写任务 ${conflict.id}（${conflict.provider}，范围 ${confScope}）写入范围重叠：等它结束，或缩小写入范围后再派`);
    }
  } else {
    appendHistory(historyEntry);
  }
  // 检查都过了、记录也落了：这一轮算已经外派，后面主模型改代码不再拦
  const sessionId = String(input.session_id ?? "").trim();
  if (sessionId && !input.agent_id) {
    try {
      const stat = readSelfEdits(sessionId);
      if (!stat.decision) {
        stat.decision = "dispatch";
        stat.bashPending = false;
        writeSelfEdits(sessionId, stat);
      }
    } catch {}
  }
  // 和 relay 外派一样，自动附上项目上下文和共享背景；能不能跑命令由 caps.exec 决定
  const packed = buildDispatchPrompt({
    task: brief,
    cwd,
    write,
    role,
    shared: readSharedContext(STATE_DIR, cwd),
    caps: prov?.caps || { web: false, exec: false },
  });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, prompt: packed } },
    }),
  );
}

try {
  main();
} catch {
  // 钩子出错时放行，不影响正常使用
}
