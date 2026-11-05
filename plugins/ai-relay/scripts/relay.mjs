#!/usr/bin/env node
// ai-relay 命令行：查看额度、切换模式、按路由挑选模型、调用官方 CLI 执行任务
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  RELAY_SCRIPT, JOBS_DIR, MODES, PLUGIN_ROOT, STATE_DIR, ROLE_TEXT, isEnabled, loadConfig, quotaSource, readHistory, getMode, setMode, readQuotaRows, poolStatus,
  providerPools, poolOfModel, fmtPool, fmtTime, resolveBin, ensureStateDir,
  allJobRecords, setVerdict, VERDICTS, recordPick, pickReason, capsOf, fullAccessOn, fullAccessSupported, cleanup, storageUsage, RETENTION_DAYS,
  runningWriters, scopesOverlap, normScope, isPathInScope, withWriteLock, gitSnapshot,
  parseGitStatusPath, parseGitStatusPaths, diffSnapshots, checkOutOfScope, workspaceRoot,
} from "./lib.mjs";
import { refreshCache, refreshGrok, loadCache } from "./quota.mjs";
import { scoreRoute } from "./score.mjs";
import {
  BRIEF_TEMPLATE, checkBrief, roleOfBrief, buildDispatchPrompt, readSharedContext, writeSharedContext, clearSharedContext,
  attachJobs, gitDiff, projectContext, scopeOfBrief, needsOfBrief, helpRequestOf,
} from "./brief.mjs";

// 按打分选模型：擅长度 × 额度（含快到期加成）× 历史可靠度（含验收结论）× 速度
// write / target / workspace 原样传给打分，缺了就不做沙箱检查
// needs 是这次要的能力（web / exec），缺的厂商由打分跳过
function route(cfg, rows, role, only, { write, target, workspace, needs } = {}) {
  return scoreRoute(cfg, rows, role, { only, history: allJobRecords(), write, target, workspace, needs });
}

const OUTPUT_CAP = 20000;
const CODEX_PLUGIN_ID = "codex@openai-codex";

function parseArgs(argv) {
  const opts = { _: [] };
  const valueFlags = new Set(["--role", "--model", "--cwd", "--prompt-file", "--timeout", "--provider", "--json-spec", "--preset", "--claude-json", "--limit", "--with", "--scope", "--target", "--needs"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      opts.text = argv.slice(i + 1).join(" ");
      break;
    }
    if (valueFlags.has(a)) opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    else if (a.startsWith("--")) opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true;
    else opts._.push(a);
  }
  return opts;
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// --needs web,exec。只认这两项，顺序固定，方便和打分里的文案对齐
function parseNeedsFlag(raw) {
  if (!raw || raw === true) return [];
  const wanted = new Set(String(raw).split(/[,，]/).map((s) => s.trim().toLowerCase()).filter(Boolean));
  return ["web", "exec"].filter((k) => wanted.has(k));
}

function missingNeedLabels(caps, needs) {
  if (!needs?.length) return [];
  const labels = [];
  if (needs.includes("web") && caps?.web !== true) labels.push("联网");
  if (needs.includes("exec") && caps?.exec !== true) labels.push("执行命令");
  return labels;
}

// ---------- status ----------
function cmdStatus(opts) {
  const cfg = loadConfig();
  const rows = readQuotaRows(cfg);
  const mode = getMode();
  const pools = [];
  for (const [name, prov] of Object.entries(cfg.providers)) {
    for (const pool of providerPools(prov)) {
      pools.push({ name, label: prov.label, via: prov.via || (prov.self ? "self" : ""), enabled: isEnabled(prov), source: quotaSource(cfg, prov.quota.provider, pool), ...poolStatus(cfg, rows, prov.quota.provider, pool) });
    }
  }
  const picks = Object.keys(cfg.routes || {}).map((role) => route(cfg, rows, role));
  if (opts.json) {
    const sources = Object.fromEntries(Object.entries(loadCache(STATE_DIR).sources).map(([k, v]) => [k, { fetchedAt: v.fetchedAt, error: v.error }]));
    const thresholds = { min: cfg.minRemaining ?? 0.15, low: cfg.lowRemaining ?? 0.3 };
    console.log(JSON.stringify({ mode, quotaAvailable: !!rows, pools, picks, sources, thresholds }, null, 2));
    return;
  }
  const modeDesc = { off: "纯 Claude（不外派）", manual: "手动（点名才外派）", auto: "自动（主模型只拆解、派单、验收，执行尽量外派）" }[mode];
  console.log(`ai-relay 模式：${mode} — ${modeDesc}`);
  if (!rows) console.log("⚠️ 暂无额度数据：运行 relay quota 刷新");
  console.log("\n额度：");
  for (const p of pools) {
    const mark = p.enabled ? { ok: "🟢", low: "🟡", blocked: "🔴", unknown: "⚪" }[p.level] : "⏸";
    console.log(`  ${mark} ${p.label} [${p.name}/${p.pool}]  ${p.enabled ? fmtPool(p) : "已停用"}  （来源：${p.source}）`);
  }
  console.log("\n当前各类任务的首选：");
  for (const r of picks) {
    const c = r.choice;
    const desc = c ? `${c.provider}${c.model && c.model !== "default" ? " · " + c.model : ""}${c.via === "codex-plugin" ? "（走 Codex 官方插件）" : ""}  ${c.reason}` : "无可用（全部额度不足）";
    console.log(`  ${r.role.padEnd(13)} → ${desc}`);
  }
  console.log(`\n配置文件：${cfg._file}`);
}

// ---------- mode ----------
function togglePlugin(enable) {
  const claude = resolveBin("claude");
  if (!claude) return "未找到 claude 命令，Codex 插件开关需手动处理";
  try {
    execFileSync(claude, ["plugin", enable ? "enable" : "disable", CODEX_PLUGIN_ID], { encoding: "utf8", stdio: "pipe", timeout: 60000 });
    return `Codex 插件已${enable ? "启用" : "禁用"}`;
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message);
    // 已经是目标状态时 CLI 会报错，视为成功
    if (/already/i.test(msg)) return `Codex 插件已是${enable ? "启用" : "禁用"}状态`;
    return `Codex 插件切换失败：${msg.trim().slice(0, 200)}`;
  }
}

function cmdMode(opts) {
  const target = opts._[1];
  if (!target) {
    console.log(`当前模式：${getMode()}（可选：${MODES.join(" / ")}）`);
    return;
  }
  if (!MODES.includes(target)) {
    console.error(`未知模式 ${target}，可选：${MODES.join(" / ")}`);
    process.exit(2);
  }
  const prev = getMode();
  setMode(target);
  console.log(`ai-relay 模式：${prev} → ${target}`);
  if ((prev === "off") !== (target === "off") || opts.sync) {
    console.log(togglePlugin(target !== "off"));
    console.log("插件启停在新会话中完全生效；当前会话内 ai-relay 钩子已立即按新模式执行。");
  }
}

// --target 可能带 ~，先展开再变成绝对路径
function resolveTarget(p) {
  let s = String(p);
  if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

// ---------- pick ----------
function cmdPick(opts) {
  const role = opts._[1];
  const cfg = loadConfig();
  // 只有传了 --target 才解析工作区并交给打分；status 不走这里
  let extra = {};
  if (opts.target) {
    const sessionDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    extra = { write: !!opts.write, target: resolveTarget(opts.target), workspace: workspaceRoot(sessionDir) };
  }
  const needs = parseNeedsFlag(opts.needs);
  if (needs.length) extra.needs = needs;
  const r = route(cfg, readQuotaRows(cfg), role, opts.provider, extra);
  if (r.choice) recordPick(role, r);
  if (opts.json) return console.log(JSON.stringify(r, null, 2));
  if (!r.choice) {
    for (const s of r.skipped) console.log(`  跳过：${s.provider} / ${s.model}  ${s.why}  [${fmtPool(s.status)}]`);
    console.log(`角色 ${role} 没有可用模型（额度不足）`);
    process.exit(3);
  }
  const c = r.choice;
  console.log(`${role} → ${c.provider} / ${c.pool} / ${c.model}  [${fmtPool(c.status)}]`);
  console.log(`  理由：${c.reason}`);
  if (c.via === "codex-plugin") console.log("→ 用 Codex 官方插件执行：Agent 工具 subagent_type=codex:codex-rescue，prompt 按派单模板写（relay brief 查看）");
  else console.log(`→ relay run ${c.provider} --role ${role} --model ${c.model} --cwd <项目根> <<'RELAY_EOF' …派单… RELAY_EOF`);
  for (const a of r.alternatives) console.log(`  备选：${a.provider} / ${a.model}  [${fmtPool(a.status)}]  ${a.reason}`);
  for (const s of r.skipped) console.log(`  跳过：${s.provider} / ${s.model}  ${s.why}  [${fmtPool(s.status)}]`);
}

// ---------- run ----------
function buildCommand(cfg, job) {
  const prov = cfg.providers[job.provider];
  const cli = prov.cli;
  const bin = resolveBin(cli.bin);
  if (!bin) throw new Error(`找不到 ${cli.bin} 命令，请确认已安装并登录`);
  // 占位符只按整个参数匹配，避免任务文本里的 {model} 之类被误替换
  const vars = { "{prompt}": job.wrappedPrompt, "{model}": job.model, "{cwd}": job.cwd };
  const fill = (arr) => (arr || []).map((s) => (s in vars ? vars[s] : s));
  const args = [];
  if (job.model && job.model !== "default") args.push(...fill(cli.model));
  args.push(...fill(job.write ? cli.write : cli.read));
  if (cli.cwd) args.push(...fill(cli.cwd));
  // 员工最高权限（默认开）：不再逐个批准命令；安全靠派单里的硬性规则和事后的越界检查
  if (fullAccessOn(cfg, prov)) args.push(...fill(cli.fullAccess));
  args.push(...fill(cli.prompt));
  return { bin, args };
}

function jobPath(id, ext = "json") {
  return path.join(JOBS_DIR, `${id}.${ext}`);
}

function saveJob(job) {
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
}

function loadJob(id) {
  if (id === "last") {
    const files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json")).sort();
    if (!files.length) throw new Error("还没有任何任务");
    id = files[files.length - 1].replace(/\.json$/, "");
  }
  return JSON.parse(fs.readFileSync(jobPath(id), "utf8"));
}

function loadAnyJob(id) {
  if (id === "last") {
    const latest = allJobRecords(1)[0];
    if (!latest) throw new Error("找不到外派记录 last");
    id = latest.id;
  }
  let job;
  const file = jobPath(id);
  if (fs.existsSync(file)) {
    try {
      job = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
  }
  if (!job) {
    job = readHistory().find((x) => x.id === id);
  }
  if (!job) throw new Error(`找不到外派记录 ${id}`);
  let output = "";
  try {
    output = fs.readFileSync(jobPath(id, "log"), "utf8");
  } catch {}
  // 历史记录里还没写入 helpRequest 时（例如 Codex），从日志再抽一次，方便 result 提示主控
  return { ...job, output, helpRequest: job.helpRequest || helpRequestOf(output) };
}

// 真正执行 CLI（前台或后台 worker 共用）
function executeJob(job) {
  const cfg = loadConfig();
  let bin, args;
  try {
    ({ bin, args } = buildCommand(cfg, job));
  } catch (e) {
    // 启动前就失败（找不到命令等）：记为失败，免得一直占着"运行中"挡住后续可写任务
    Object.assign(job, { status: "failed", finishedAt: new Date().toISOString(), error: String(e.message || e) });
    saveJob(job);
    throw e;
  }
  const before = gitSnapshot(job.cwd);
  const res = spawnSync(bin, args, {
    cwd: job.cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: (cfg.jobTimeoutMinutes || 30) * 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const after = gitSnapshot(job.cwd);
  const output = (res.stdout || "") + (res.stderr ? `\n[stderr]\n${res.stderr}` : "");
  fs.writeFileSync(jobPath(job.id, "log"), output);
  job.exitCode = res.status;
  job.status = res.error?.code === "ETIMEDOUT" ? "timeout" : res.status === 0 ? "done" : "failed";
  job.finishedAt = new Date().toISOString();
  if (before !== null && after !== null) {
    job.changedFiles = diffSnapshots(before, after);
  }
  if (job.write && job.changedFiles?.length) {
    const out = checkOutOfScope(job.changedFiles, job.scope, job.cwd);
    if (out.length) {
      job.outOfScope = out;
    }
  }
  // 两个 CLI 在权限被拒时仍可能返回退出码 0，这里单独标出
  job.permissionDenied = /permission required|auto-denied|cannot (ask|prompt) for/i.test(output);
  // 权限被拒后中断、没有产出：即使退出码为 0 也算失败
  if (job.status === "done" && job.permissionDenied && !(res.stdout || "").trim()) job.status = "failed";
  // 日志落盘后再抽协助请求，result / jobs 都能读到同一份
  job.helpRequest = helpRequestOf(output);
  saveJob(job);
  return job;
}

function printJob(job) {
  const modelText = job.model && job.model !== "default" ? " / " + job.model : "";
  const exitText = job.exitCode !== undefined ? `（退出码 ${job.exitCode}）` : "";
  const head = [
    `任务 ${job.id} · ${job.provider}${modelText} · ${job.role || "未注明角色"} · ${job.write ? "可写" : "只读"} · 状态 ${job.status}${exitText}`,
    `目录：${job.cwd}`,
  ];
  if (job.provider !== "codex") {
    if (job.changedFiles?.length) {
      head.push(`git 工作区变化：\n  ${job.changedFiles.join("\n  ")}`);
      if (!job.write) head.push("⚠️ 只读任务却改动了文件，请检查！");
    } else if (job.write && job.status === "done") {
      head.push("⚠️ 可写任务结束，但 git 工作区没有新变化（不是 git 仓库时无法检测）");
    }
    if (job.outOfScope?.length) head.push(`⚠️ 改动超出写入范围：\n  ${job.outOfScope.join("\n  ")}`);
    if (job.permissionDenied) head.push("⚠️ 执行中有操作因权限被拒（多为终端命令），结果可能不完整，请核对输出末尾的 stderr");
  }
  console.log(head.join("\n"));
  if (job.helpRequest) {
    console.log(`\n⚠️ 对方请求主控协助：\n${job.helpRequest}\n请决定：自己用工具完成后用 --with 带上结果重派，或改派有能力的模型，或请用户处理。`);
  }
  let out = job.output;
  if (out === undefined) {
    try {
      out = fs.readFileSync(jobPath(job.id, "log"), "utf8");
    } catch {
      out = "";
    }
  }
  if (out) {
    const shown = out.length > OUTPUT_CAP ? "…（前文已省略，完整日志见下方路径）\n" + out.slice(-OUTPUT_CAP) : out;
    console.log("\n----- 输出 -----\n" + shown.trim());
  }
  console.log(`\n完整日志：${jobPath(job.id, "log")}`);
  if (job.status !== "running" && !job.verdict) console.log(`验收后记录结论：node "${RELAY_SCRIPT}" verdict ${job.id} pass|partial|fail -- <一句话说明>`);
  if (job.verdict) console.log(`验收结论：${job.verdict}${job.verdictNote ? "（" + job.verdictNote + "）" : ""}`);
}

function cmdRun(opts) {
  const cfg = loadConfig();
  const mode = getMode();
  if (mode === "off" && !opts.force) {
    console.error("ai-relay 当前为 off（纯 Claude）模式，不外派。需要时先执行 /ai-relay:relay manual");
    process.exit(4);
  }
  let task = opts.text || "";
  if (opts.promptFile) task = fs.readFileSync(opts.promptFile, "utf8");
  if (!task.trim()) task = readStdin();
  if (!task.trim()) throw new Error("没有任务内容：用 -- <文本>、--prompt-file 或标准输入传入");
  // 派单必须写清目标和验收标准：对方看不到主会话，缺了只能靠猜
  const missing = checkBrief(task);
  if (missing.length) {
    console.error(`ai-relay 错误：派单缺少「${missing.join("」「")}」段落，已退回。按下面的模板补全后再派：\n\n${BRIEF_TEMPLATE}`);
    process.exit(2);
  }
  const role = opts.role || roleOfBrief(task);
  if (!role || !cfg.routes?.[role]) throw new Error(`请用 --role 或派单首行"角色：xxx"注明角色，可选：${Object.keys(cfg.routes || {}).join(", ")}`);
  // --needs 优先；否则从派单「需要的能力」读。空数组表示不按能力筛选
  const needs = opts.needs ? parseNeedsFlag(opts.needs) : needsOfBrief(task);

  let provName = opts._[1];
  const rows = readQuotaRows(cfg);
  let model = opts.model;
  let pool;
  let reason = "";

  if (!provName || provName === "auto") {
    // 可写任务按目标目录判断沙箱：Codex 写不到项目外的目录时自动跳过
    const target = path.resolve(opts.cwd || process.cwd());
    const workspace = workspaceRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const r = route(cfg, rows, role, undefined, { needs, write: !!opts.write, target, workspace });
    // 首选是 Codex 时不悄悄改派：Codex 要走 Agent 工具（官方插件），交给主管去派
    if (!opts.model && !opts.skipCodex && r.choice?.via === "codex-plugin") {
      recordPick(role, r);
      console.error(`首选是 Codex（${r.choice.reason}）。请用 Agent 工具 subagent_type=codex:codex-rescue 把这张派单交给它；确有理由不用 Codex 时，加 --skip-codex 改派第二名。`);
      process.exit(3);
    }
    // 只考虑能由 ai-relay 直接调用的候选
    const c = [r.choice, ...r.alternatives].find((x) => x && x.via === "relay" && (!opts.model || x.model === opts.model));
    if (!c) {
      if (opts.model) {
        console.error(`模型 ${opts.model} 在角色 ${role} 下不可用或额度不足`);
        process.exit(3);
      }
      const first = r.choice;
      console.error(first?.via === "codex-plugin" ? "首选是 Codex：请用 Agent 工具 subagent_type=codex:codex-rescue 执行" : `角色 ${role} 没有可用模型（额度不足）`);
      process.exit(3);
    }
    provName = c.provider;
    model = c.model;
    pool = c.pool;
    reason = c === r.choice ? pickReason(r) : opts.model ? `指定模型 ${opts.model}；${c.reason}` : `主管选择跳过 ${r.choice.provider}（--skip-codex），改用 ${c.provider}；${c.reason}`;
  }

  const prov = cfg.providers[provName];
  if (!prov) throw new Error(`未知提供方 ${provName}，可选：${Object.keys(cfg.providers).join(", ")}`);
  const missingNeeds = missingNeedLabels(capsOf(cfg, prov), needs);
  if (missingNeeds.length) {
    console.error(`${provName} 不具备：${missingNeeds.join("、")}；需要这项能力的部分请改派，或由主控先完成后把结果写进背景`);
    process.exit(3);
  }
  if (!isEnabled(prov)) {
    console.error(`${provName} 已在 ai-relay 面板中停用，不外派。需要时在面板「厂商」页启用，或执行 relay provider enable ${provName}`);
    process.exit(3);
  }
  if (prov.via === "codex-plugin") {
    console.error("Codex 走官方插件：请用 Agent 工具 subagent_type=codex:codex-rescue（或 /codex:rescue），审查用 /codex:review");
    process.exit(3);
  }
  if (prov.via !== "relay") throw new Error(`${provName} 不能由 ai-relay 调用`);

  if (!reason) {
    // 主模型点名了厂商：仍记下这个厂商在该角色下的打分，便于事后对照
    const r = route(cfg, rows, role, provName, { needs });
    const same = [r.choice, ...r.alternatives].find((x) => x && (!model || x.model === model));
    if (!model && r.choice) ({ model, pool } = r.choice);
    reason = `主模型指定 ${provName}${same ? `；${same.reason}` : ""}`;
  }
  if (!model) {
    console.error(`${provName} 在角色 ${role} 下没有可用模型（不在路由或额度不足）；可用 --model 指定该厂商的模型`);
    process.exit(3);
  }
  pool = pool || poolOfModel(prov, model);
  if (!pool) throw new Error(`模型 ${model} 不在 ${provName} 的配置里，可选：${Object.values(prov.pools).flat().join(", ")}`);

  const st = poolStatus(cfg, rows, prov.quota.provider, pool);
  if (st.level === "blocked" && !opts.force) {
    console.error(`${provName}/${pool} 额度不足：${fmtPool(st)}。可换模型或加 --force 强制`);
    process.exit(3);
  }

  const cwd = path.resolve(opts.cwd || process.cwd());
  let scope = null;
  if (opts.write) {
    if (opts.scope && String(opts.scope).trim()) {
      scope = String(opts.scope)
        .split(",")
        .map((s) => normScope(cwd, s.trim()))
        .filter(Boolean);
    } else if (task.includes("写入范围")) {
      const bScope = scopeOfBrief(task);
      if (!bScope || !bScope.length) {
        console.error("ai-relay 错误：写入范围段落没有解析出任何路径");
        process.exit(2);
      }
      scope = bScope.map((s) => normScope(cwd, s));
    } else {
      scope = ["."];
    }
    if (!scope || !scope.length) {
      scope = ["."];
    }
  }

  // 接力材料：前序外派的结果、当前 git diff
  const withJobs = String(opts.with || "").split(",").map((x) => x.trim()).filter(Boolean).map((id) => loadAnyJob(id));
  ensureStateDir();
  const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${provName}-${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id, provider: provName, pool, model, role, reason, write: !!opts.write, cwd, task,
    scope,
    withJobs: withJobs.map((j) => j.id),
    wrappedPrompt: buildDispatchPrompt({
      task, cwd, write: !!opts.write, role,
      shared: readSharedContext(STATE_DIR, cwd),
      attachments: withJobs.length ? attachJobs(withJobs) : null,
      diff: opts.diff ? gitDiff(cwd) : null,
      caps: capsOf(cfg, prov),
    }),
    status: "running", startedAt: new Date().toISOString(), quotaAtStart: fmtPool(st),
  };

  if (opts.write) {
    let conflict = null;
    withWriteLock(cwd, () => {
      const writers = runningWriters(cwd, Date.now(), cfg.jobTimeoutMinutes || 30);
      conflict = writers.find((w) => scopesOverlap(w.scope, scope, cwd));
      if (!conflict) {
        saveJob(job);
      }
    });
    if (conflict) {
      const confScope = Array.isArray(conflict.scope) && conflict.scope.length ? conflict.scope.join(",") : (conflict.scope || ".");
      console.error(`与正在运行的可写任务 ${conflict.id}（${conflict.provider}，范围 ${confScope}）写入范围重叠：等它结束，或缩小写入范围后再派`);
      process.exit(6);
    }
  } else {
    saveJob(job);
  }

  if (opts.background) {
    const child = spawn(process.execPath, [RELAY_SCRIPT, "_worker", id], { detached: true, stdio: "ignore", cwd });
    job.pid = child.pid;
    saveJob(job);
    child.unref();
    console.log(`已后台启动任务 ${id}（${provName} / ${model}，${role}，${job.write ? "可写" : "只读"}）`);
    console.log(`分派理由：${reason}`);
    console.log(`等待结果：node "${RELAY_SCRIPT}" wait ${id}`);
    console.log(`查看结果：node "${RELAY_SCRIPT}" result ${id}`);
    return;
  }
  printJob(executeJob(job));
}

function cmdWorker(opts) {
  const job = loadJob(opts._[1]);
  job.pid = process.pid;
  saveJob(job);
  executeJob(job);
}

function cmdJobs(opts) {
  const jobs = allJobRecords(Number(opts.limit || 15));
  if (opts.json) return console.log(JSON.stringify(jobs, null, 2));
  if (!jobs.length) return console.log("还没有外派记录");
  const st = { running: "进行中", done: "完成", failed: "失败", timeout: "超时", cancelled: "已取消" };
  for (const j of jobs) {
    const when = fmtTime(Date.parse(j.startedAt));
    const model = j.model && j.model !== "default" ? `/${j.model}` : "";
    const verdict = j.verdict ? { pass: "验收通过", partial: "部分通过", fail: "验收不通过" }[j.verdict] : "未验收";
    console.log(`${when}  ${(st[j.status] || j.status).padEnd(4)}  ${verdict}  ${j.provider}${model}  ${j.role || "-"}  ${j.write ? "可写" : "只读"}  ${String(j.task || "").replace(/\s+/g, " ").slice(0, 50)}`);
  }
}

// 刷新自带额度缓存；--claude-json 由状态插件传入当前会话的 Claude 额度
async function cmdQuota(opts) {
  const cfg = loadConfig();
  const agy = Object.values(cfg.providers).find((p) => p.quota?.provider === "antigravity" && isEnabled(p));
  const agyBin = agy?.cli?.bin ? resolveBin(agy.cli.bin) : null;
  const claudeLimits = opts.claudeJson ? JSON.parse(opts.claudeJson) : null;
  let cache = refreshCache({ stateDir: STATE_DIR, claudeLimits, agyBin, force: !!opts.force });
  // Grok 要联网查 grok.com，单独异步刷新；厂商停用时不查
  if (cfg.providers.grok && isEnabled(cfg.providers.grok)) cache = await refreshGrok({ stateDir: STATE_DIR, force: !!opts.force });
  if (opts.json) return console.log(JSON.stringify(cache.sources, null, 2));
  const name = { claude: "Claude（插件读取当前会话）", codex: "Codex（本地会话记录）", agy: "Antigravity（agy /usage）", grok: "Grok（grok.com 计费接口，用 CLI 登录令牌）" };
  for (const [k, v] of Object.entries(cache.sources)) {
    console.log(`${name[k] || k}：${v.error ? `失败 — ${v.error}` : `${v.rows.length} 个窗口`}，更新于 ${v.fetchedAt ? fmtTime(v.fetchedAt) : "从未"}`);
  }
  if (!cache.sources.claude) console.log("Claude：等状态插件刷新（打开桌面端或终端会话即可）");
  if (cache.sources.grok?.error) console.log("Grok 自查失败时，装了 AIQuota5h 会沿用它的数据");
}

async function cmdWait(opts) {
  const ids = opts._.slice(1);
  if (ids.length <= 1) {
    const id = ids[0];
    const deadline = Date.now() + Number(opts.timeout || 540) * 1000;
    let job = loadJob(id);
    while (job.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      job = loadJob(job.id);
    }
    if (job.status === "running") {
      console.log(`任务 ${job.id} 仍在运行，可稍后再执行 wait 或 result`);
      return;
    }
    printJob(job);
    return;
  }
  const deadline = Date.now() + Number(opts.timeout || 540) * 1000;
  let jobs = ids.map((id) => loadJob(id));
  while (jobs.some((j) => j.status === "running") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    jobs = jobs.map((j) => (j.status === "running" ? loadJob(j.id) : j));
  }
  for (let i = 0; i < jobs.length; i++) {
    if (i > 0) console.log("==========");
    const j = jobs[i];
    if (j.status === "running") {
      console.log(`任务 ${j.id} 仍在运行`);
    } else {
      printJob(j);
    }
  }
}

function cmdCancel(opts) {
  const job = loadJob(opts._[1]);
  if (job.status !== "running") return console.log(`任务 ${job.id} 状态为 ${job.status}，无需取消`);
  try {
    process.kill(-job.pid, "SIGTERM");
  } catch {
    try { process.kill(job.pid, "SIGTERM"); } catch {}
  }
  job.status = "cancelled";
  saveJob(job);
  console.log(`已取消任务 ${job.id}`);
}

// ---------- 派单包：模板、共享背景、验收 ----------
function cmdBrief(opts) {
  if (opts.context) {
    // 预览自动附上的项目上下文和共享背景
    const cwd = path.resolve(opts.cwd || process.cwd());
    console.log(projectContext(cwd));
    const shared = readSharedContext(STATE_DIR, cwd);
    console.log(shared ? `\n共享背景（${fmtTime(shared.updatedAt)} 写入）：\n${shared.text}` : "\n共享背景：无");
    return;
  }
  console.log(BRIEF_TEMPLATE);
}

function cmdContext(opts) {
  const sub = opts._[1] || "show";
  const cwd = path.resolve(opts.cwd || process.cwd());
  if (sub === "set") {
    const text = opts.text || readStdin();
    if (!text.trim()) throw new Error("共享背景为空：用标准输入或 -- <文本> 传入");
    const file = writeSharedContext(STATE_DIR, cwd, text);
    return console.log(`已写入 ${cwd} 的共享背景（6 小时内同目录的派单自动附上）：${file}`);
  }
  if (sub === "clear") return console.log(clearSharedContext(STATE_DIR, cwd) ? "已清除共享背景" : "没有共享背景");
  const shared = readSharedContext(STATE_DIR, cwd);
  console.log(shared ? `${cwd}（${fmtTime(shared.updatedAt)} 写入）：\n${shared.text}` : `${cwd} 没有共享背景`);
}

function cmdVerdict(opts) {
  const [, id, verdict] = opts._;
  if (!id || !VERDICTS.includes(verdict)) throw new Error(`用法：relay verdict <任务 id|last> ${VERDICTS.join("|")} -- <一句话说明>`);
  let realId = id;
  if (id === "last") {
    const target = allJobRecords().find((j) => j.status !== "running");
    if (!target) throw new Error("还没有已完成的外派记录");
    realId = target.id;
  }
  const j = setVerdict(realId, verdict, opts.text || "");
  console.log(`已记录 ${realId}（${j.provider}）的验收结论：${verdict}${opts.text ? "（" + opts.text + "）" : ""}`);
}

// ---------- 历史数据：占用与清理 ----------
function cmdClean(opts) {
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const before = storageUsage();
  if (opts.json && !opts.run) return console.log(JSON.stringify({ ...before, retentionDays: RETENTION_DAYS }, null, 2));
  const removed = cleanup();
  const after = storageUsage();
  console.log(`数据目录：${STATE_DIR}`);
  console.log(`清理前 ${kb(before.total)} → 清理后 ${kb(after.total)}，删除 ${removed} 个过期文件`);
  for (const [k, v] of Object.entries(after.parts)) console.log(`  ${k.padEnd(18)} ${kb(v)}`);
  console.log(`保留天数：外派日志 ${RETENTION_DAYS.jobs} 天、对话 ${RETENTION_DAYS.rounds} 天、提问记录 ${RETENTION_DAYS.prompts} 天、共享背景 ${RETENTION_DAYS.context} 天（每天自动清理一次）`);
}

// ---------- 厂商管理 ----------
const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;

function loadPresets() {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "config", "presets.json"), "utf8"));
}

// 写回用户配置：先留一份 .bak，再整体写入
function saveConfig(cfg) {
  const file = cfg._file;
  const data = { ...cfg };
  delete data._file;
  fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function providerRoles(cfg, name) {
  return Object.entries(cfg.routes || {})
    .filter(([, entries]) => entries.some((e) => e.startsWith(`${name}:`)))
    .map(([role]) => role);
}

function cmdProviders(opts) {
  const cfg = loadConfig();
  const list = Object.entries(cfg.providers).map(([name, prov]) => {
    const bin = prov.cli?.bin || (prov.via === "codex-plugin" ? "codex" : prov.self ? "claude" : "");
    return {
      name,
      label: prov.label || name,
      via: prov.via || (prov.self ? "self" : ""),
      enabled: isEnabled(prov),
      // 主控 Claude 不能停用或删除；Codex 走官方插件，只能停用不能删除
      canDisable: !prov.self,
      canRemove: !prov.self && prov.via !== "codex-plugin",
      canTest: prov.via === "relay",
      bin,
      binFound: bin ? !!resolveBin(bin) : false,
      models: Object.values(prov.pools || {}).flat(),
      roles: providerRoles(cfg, name),
      note: prov.note || "",
      // 最高权限开关：只有配了 cli.fullAccess 的员工能开关
      fullAccess: {
        supported: fullAccessSupported(prov),
        enabled: fullAccessOn(cfg, prov),
        note: prov.self ? "主模型的权限在输入框的模式菜单里设置" : prov.via === "codex-plugin" ? "由 Codex 插件固定为只能写当前项目的沙箱" : fullAccessSupported(prov) ? "" : "这家没有配置最高权限参数",
      },
    };
  });
  if (opts.json) {
    console.log(JSON.stringify({ providers: list, roles: Object.keys(cfg.routes || {}).map((r) => ({ key: r, text: ROLE_TEXT[r] || r })), presets: loadPresets() }, null, 2));
    return;
  }
  for (const p of list) {
    const state = p.via === "self" ? "主控" : p.enabled ? "启用" : "已停用";
    const cli = p.bin ? `${p.bin}${p.binFound ? "" : "（未安装）"}` : "";
    console.log(`${p.name.padEnd(12)} ${state.padEnd(4)}  ${p.label}  ${cli}  角色：${p.roles.map((r) => ROLE_TEXT[r] || r).join("、") || "—"}`);
  }
}

function setEnabled(name, enabled) {
  const cfg = loadConfig();
  const prov = cfg.providers[name];
  if (!prov) throw new Error(`未知厂商 ${name}`);
  if (prov.self) throw new Error("主控 Claude 不能停用；想只用 Claude 请切到「纯 Claude」模式");
  if (enabled) delete prov.enabled;
  else prov.enabled = false;
  saveConfig(cfg);
  console.log(`${prov.label || name} 已${enabled ? "启用" : "停用"}${enabled ? "" : "，之后的任务不会再派给它"}`);
}

// 最高权限开关：开 = 命令不再逐个审批（员工能执行命令）；关 = 只能改文件
function setFullAccess(name, value) {
  if (!["on", "off"].includes(value)) throw new Error("用法：provider access <名称> on|off");
  const cfg = loadConfig();
  const prov = cfg.providers[name];
  if (!prov) throw new Error(`未知厂商 ${name}`);
  if (!fullAccessSupported(prov)) throw new Error(`${prov.label || name} 不支持最高权限开关`);
  prov.fullAccessEnabled = value === "on";
  saveConfig(cfg);
  console.log(`${prov.label || name} 最高权限已${value === "on" ? "开启：执行命令不再逐个审批" : "关闭：只能改文件，不能执行命令"}`);
}

// 新增厂商：spec 来自面板表单（JSON），或 --preset 加少量覆盖参数
function cmdProviderAdd(opts) {
  const presets = loadPresets();
  let spec = opts.jsonSpec ? JSON.parse(opts.jsonSpec) : {};
  const preset = presets[spec.preset || opts.preset || "custom"];
  if (!preset) throw new Error(`未知模板 ${spec.preset || opts.preset}，可选：${Object.keys(presets).join(", ")}`);
  const name = String(spec.name || opts._[2] || "").trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new Error("标识只能用小写字母、数字和短横线，以字母开头，2–24 个字符，例如 kimi");
  const cfg = loadConfig();
  if (cfg.providers[name]) throw new Error(`已存在名为 ${name} 的厂商，换个标识或先删除旧的`);
  const bin = String(spec.bin || preset.bin || "").trim();
  if (!bin || /\s/.test(bin)) throw new Error("命令不能为空，也不能带空格（参数请填在下面的参数栏）");
  const splitArgs = (v, fallback) => (v === undefined ? fallback : Array.isArray(v) ? v : String(v).trim() ? String(v).trim().split(/\s+/) : []);
  const cli = {
    bin,
    prompt: splitArgs(spec.promptArgs, preset.cli.prompt),
    model: splitArgs(spec.modelArgs, preset.cli.model),
    read: splitArgs(spec.readArgs, preset.cli.read),
    write: splitArgs(spec.writeArgs, preset.cli.write),
    cwd: preset.cli.cwd,
  };
  if (!cli.prompt.includes("{prompt}")) throw new Error("提示参数里必须有 {prompt} 占位，例如 -p {prompt}");
  const models = splitArgs(typeof spec.models === "string" ? spec.models.replace(/[,，]/g, " ") : spec.models, preset.models);
  const roles = (spec.roles || preset.roles).filter((r) => cfg.routes?.[r]);
  cfg.providers[name] = {
    label: String(spec.label || preset.label || name).trim(),
    via: "relay",
    quota: { provider: name, pools: [name] },
    cli,
    pools: { [name]: models.length ? models : ["default"] },
    // 模板自带的风险提示随厂商保存，自定义模板的说明文字不保存
    ...(preset.note && preset !== presets.custom ? { note: preset.note } : {}),
  };
  // 新厂商排在各角色路由末尾：额度未知，先让已知额度的厂商顶上
  for (const r of roles) cfg.routes[r].push(`${name}:${name}:${models[0] || "default"}`);
  saveConfig(cfg);
  const found = resolveBin(bin);
  console.log(`已添加 ${cfg.providers[name].label}（${name}），参与：${roles.map((r) => ROLE_TEXT[r] || r).join("、") || "暂不参与自动路由"}`);
  if (!found) console.log(`⚠️ 本机还没找到 ${bin} 命令${preset.install ? `。安装：${preset.install}` : "，请先安装并登录"}`);
}

function cmdProviderRemove(opts) {
  const name = opts._[2];
  const cfg = loadConfig();
  const prov = cfg.providers[name];
  if (!prov) throw new Error(`未知厂商 ${name}`);
  if (prov.self) throw new Error("主控 Claude 不能删除");
  if (prov.via === "codex-plugin") throw new Error("Codex 走官方插件，不能删除，只能停用");
  delete cfg.providers[name];
  for (const r of Object.keys(cfg.routes || {})) cfg.routes[r] = cfg.routes[r].filter((e) => !e.startsWith(`${name}:`));
  saveConfig(cfg);
  console.log(`已删除 ${prov.label || name}，并从所有角色路由中移除（旧配置备份在 ${cfg._file}.bak）`);
}

// 试运行：在空目录里只读跑一句话，确认命令装好、已登录、参数正确
function cmdProviderTest(opts) {
  const name = opts._[2];
  const cfg = loadConfig();
  const prov = cfg.providers[name];
  if (!prov) throw new Error(`未知厂商 ${name}`);
  if (prov.via !== "relay") throw new Error(prov.via === "codex-plugin" ? "Codex 走官方插件，请用 /codex:setup 检查" : "主控 Claude 无需试运行");
  const cwd = path.join(STATE_DIR, "probe");
  fs.mkdirSync(cwd, { recursive: true });
  const model = Object.values(prov.pools || {}).flat()[0] || "default";
  const started = Date.now();
  let result;
  try {
    const { bin, args } = buildCommand(cfg, { provider: name, model, write: false, cwd, wrappedPrompt: "这是连通性测试：不要读写任何文件，不要执行命令，只回复两个字：在线" });
    const res = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: Number(opts.timeout || 120) * 1000, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${res.stdout || ""}${res.stderr ? `\n${res.stderr}` : ""}`.trim();
    const timedOut = res.error?.code === "ETIMEDOUT";
    result = { ok: res.status === 0 && !timedOut && !!(res.stdout || "").trim(), exitCode: res.status, timedOut, seconds: Math.round((Date.now() - started) / 1000), output: out.slice(-400) };
  } catch (e) {
    result = { ok: false, exitCode: null, timedOut: false, seconds: 0, output: e.message };
  }
  if (opts.json) {
    console.log(JSON.stringify(result));
    if (!result.ok) process.exit(5);
    return;
  }
  console.log(`${result.ok ? "✅ 可用" : "❌ 失败"}（${result.timedOut ? "超时" : `退出码 ${result.exitCode}`}，${result.seconds} 秒）\n${result.output}`);
  if (!result.ok) process.exit(5);
}

function cmdProvider(opts) {
  const sub = opts._[1];
  switch (sub) {
    case "enable": return setEnabled(opts._[2], true);
    case "disable": return setEnabled(opts._[2], false);
    case "add": return cmdProviderAdd(opts);
    case "remove": return cmdProviderRemove(opts);
    case "test": return cmdProviderTest(opts);
    case "access": return setFullAccess(opts._[2], opts._[3]);
    default: throw new Error("用法：provider enable|disable|remove|test <名称>，provider access <名称> on|off，或 provider add --json-spec '<JSON>' / provider add <名称> --preset kimi");
  }
}

function help() {
  console.log(`用法：node relay.mjs <命令>
  status [--json]                 查看模式、各家额度、各类任务首选
  mode [off|manual|auto]          查看或切换模式（off 会同时禁用 Codex 插件）
  pick <角色> [--write --target 目录] [--needs web,exec]   按打分挑选模型（擅长度 × 额度 × 可靠度 × 速度），并给出理由
                                  要写的目录在当前项目外时传 --target，写不到的厂商（如 Codex）会被跳过
                                  --needs 只在具备这些能力的厂商里选（web 联网，exec 执行命令，逗号分隔）
  providers [--json]              列出厂商：启用状态、命令是否已安装、参与哪些角色
  provider enable|disable <名称>   启用 / 停用某厂商（停用后路由与外派都跳过它）
  provider add <名称> --preset kimi|qwen|custom   新增厂商（面板里用 --json-spec）
  provider remove <名称>           删除厂商并移出所有路由（配置先备份为 .bak）
  provider test <名称>             只读试运行一句话，确认命令可用
  run <厂商名|auto> --role r [--model m] [--write] [--scope 路径1,路径2] [--background] [--cwd 目录] [--with id1,id2] [--diff] [--force] [--needs web,exec] [-- 派单]
                                  调用官方 CLI 执行任务；派单走标准输入或 --prompt-file，必须含「目标」「验收标准」
                                  自动附上项目上下文和共享背景；--with 附前序结果，--diff 附当前改动
                                  auto 的首选是 Codex 时会停下，提示用 Agent 工具交给 Codex；加 --skip-codex 才改派第二名
                                  可写任务按写入范围并行，范围重叠会被拒绝
                                  --needs 指定所需能力（web 联网，exec 执行命令）；省略时从派单「需要的能力」读取。点名厂商若缺少能力会拒绝
  brief [--context --cwd 目录]     派单模板；--context 预览会自动附上的项目上下文和共享背景
  context set|show|clear [--cwd 目录]   本次任务的共享背景（同目录 6 小时内的派单自动附上）
  verdict <id|last> pass|partial|fail [-- 说明]   记录验收结论，影响以后的可靠度打分
  clean [--json]                  清理过期的历史数据并显示磁盘占用（平时每天自动清理一次）
  quota [--force] [--json]        刷新自带额度（Claude 由状态插件提供，Codex 读本地记录，agy 跑 /usage）
  jobs [--json] [--limit n]       外派记录（含 Codex 子代理）
  wait <id…> | result <id|last> | cancel <id>`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let cmd = opts._[0];
  // /ai-relay:relay 命令的入口：无参数看状态，参数是模式名就切换模式
  if (cmd === "cli") {
    opts._.shift();
    cmd = opts._[0] || "status";
    if (MODES.includes(cmd)) {
      opts._.unshift("mode");
      cmd = "mode";
    }
  }
  try {
    switch (cmd) {
      case "status": return cmdStatus(opts);
      case "mode": return cmdMode(opts);
      case "pick": return cmdPick(opts);
      case "brief": return cmdBrief(opts);
      case "context": return cmdContext(opts);
      case "verdict": return cmdVerdict(opts);
      case "clean": return cmdClean(opts);
      case "providers": return cmdProviders(opts);
      case "provider": return cmdProvider(opts);
      case "run": return cmdRun(opts);
      case "_worker": return cmdWorker(opts);
      case "jobs": return cmdJobs(opts);
      case "quota": return await cmdQuota(opts);
      case "wait": return await cmdWait(opts);
      case "result": return printJob(loadAnyJob(opts._[1] || "last"));
      case "cancel": return cmdCancel(opts);
      default: return help();
    }
  } catch (e) {
    console.error(`ai-relay 错误：${e.message}`);
    process.exit(1);
  }
}

main();
