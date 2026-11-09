// PreToolUse 钩子：按模式和额度拦截对 Codex 子代理的调用；
// Bash 里执行 relay run 时，把当前会话记成待认领记录，供面板按会话归外派；
// 自动模式下，第一次改项目代码前还没定分工就拒绝（不改写命令）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ULW_RE, MENTION_RE, STATE_DIR, loadConfig, getMode, readQuotaRows, poolStatus,
  loadPrompt, fmtPool, isEnabled, appendHistory, lastPick, runningWriters, scopesOverlap,
  normScope, withWriteLock, gitSnapshot, workspaceRoot, isInside, writePendingDispatch,
  readSelfEdits, writeSelfEdits, isScratchPath, divisionReason, resolveRepos, lineSnapshot, writeBashSnap,
  isRelayRunCommand,
} from "./lib.mjs";
import { BRIEF_TEMPLATE, checkBrief, roleOfBrief, levelOfBrief, buildDispatchPrompt, readSharedContext, scopeOfBrief, needsOfBrief, codexFlagsOf } from "./brief.mjs";
import { modelTier, tierAllowed, levelEffort, LEVEL_TEXT, TIER_TEXT } from "./score.mjs";
import { loadModelsCache } from "./models.mjs";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
// codex-companion 认的推理强度
const CODEX_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

// Codex 不写 --model 时实际会用的模型：先读 Codex 自己的 config.toml（最准），读不到再用模型缓存里的命令行默认
function codexDefaultModel() {
  try {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break; // 只看顶层，进了 [段落] 就停
      const m = line.match(/^\s*model\s*=\s*["']([^"']+)["']/);
      if (m) return m[1];
    }
  } catch {}
  return loadModelsCache(STATE_DIR)?.providers?.codex?.cliDefault || null;
}

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
  // 难度必填：决定能用 Codex 的哪个模型、推理强度多高
  const level = levelOfBrief(brief);
  if (!level) {
    return deny(`[ai-relay] 派给 Codex 的派单没写难度，已退回。在「角色」下一行写「难度：简单|中等|困难」。先用 relay pick <角色> --level <难度> 看该派谁、用哪个模型`);
  }
  // 模型：派单里写的 --model 优先；没写就用刚才 relay pick 选中的 Codex 模型；都没有就是 Codex 自己的默认模型。
  // 最后实际用哪个都钉在第一行，检查的和跑的是同一个
  const flags = codexFlagsOf(brief);
  if (flags.conflict.length) {
    return deny(`[ai-relay] 派给 Codex 的 prompt 里 ${flags.conflict.map((k) => `--${k}`).join("、")} 写了不同的值，已退回。只写一次，放在第一行`);
  }
  const fitsFor = () => (prov?.pools?.codex || []).filter((m) => m !== "default" && tierAllowed(level, modelTier(cfg, "codex", m)));
  const pick = lastPick(role);
  const pickModel = !flags.model && pick?.provider === "codex" && pick.level === level && pick.model && pick.model !== "default" ? pick.model : null;
  const usedModel = flags.model || pickModel || codexDefaultModel();
  if (!usedModel && level !== "easy") {
    const fits = fitsFor();
    return deny(`[ai-relay] 读不到 Codex 的默认模型，没法判断档位够不够${LEVEL_TEXT[level]}任务，已退回。在 prompt 第一行写 --model <模型>${fits.length ? `，可选：${fits.join("、")}` : ""}`);
  }
  const tier = usedModel ? modelTier(cfg, "codex", usedModel) : "mid";
  if (!tierAllowed(level, tier)) {
    const fits = fitsFor();
    return deny(`[ai-relay] Codex 的 ${usedModel} 是${TIER_TEXT[tier]}模型，接不了${LEVEL_TEXT[level]}任务，已退回。在 prompt 第一行写 --model <模型>${fits.length ? `，可选：${fits.join("、")}` : ""}`);
  }
  // 推理强度跟难度走：简单 low、中等 medium、困难 high；派单里写了 --effort 就用写的，但取值要是 Codex 认的
  if (flags.effort && !CODEX_EFFORTS.has(flags.effort)) {
    return deny(`[ai-relay] --effort ${flags.effort} 不是 Codex 认的推理强度，可选：${[...CODEX_EFFORTS].join(" / ")}`);
  }
  const effort = flags.effort || levelEffort(level);
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
    model: usedModel || "default",
    effort,
    role,
    level,
    // 只有这次用的正是 pick 选的模型，才沿用 pick 的打分理由
    reason: `${pickModel ? `${pick.reason}${Array.isArray(pick.skipped) && pick.skipped.length ? `；跳过 ${pick.skipped.join("、")}` : ""}` : flags.model ? `主模型指定 Codex ${flags.model}` : "主模型指定 Codex"}；用 ${usedModel || "Codex 默认模型"}（${TIER_TEXT[tier]}），推理强度 ${effort}`,
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
    task: flags.rest,
    cwd,
    write,
    role,
    shared: readSharedContext(STATE_DIR, cwd),
    caps: prov?.caps || { web: false, exec: false },
  });
  process.stdout.write(
    JSON.stringify({
      // 运行参数放在第一行：codex-rescue 只把开头的 --model / --effort 当运行参数，埋在正文里会被当成任务文字
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...input.tool_input, prompt: `${[usedModel ? `--model ${usedModel}` : "", `--effort ${effort}`, ...flags.others].filter(Boolean).join(" ")}\n\n${packed}` },
      },
    }),
  );
}

try {
  main();
} catch {
  // 钩子出错时放行，不影响正常使用
}
