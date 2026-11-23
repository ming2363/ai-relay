#!/usr/bin/env node
// ai-relay 命令行：查看额度、切换模式、按路由挑选模型、调用官方 CLI 执行任务
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  RELAY_SCRIPT, JOBS_DIR, MODES, PLUGIN_ROOT, STATE_DIR, ROLE_TEXT, isEnabled, loadConfig, quotaSource, readHistory, getMode, setMode, readQuotaRows, poolStatus,
  providerPools, poolOfModel, resolveModel, fmtPool, fmtTime, resolveBin, ensureStateDir,
  hasProviderKey, loadSecrets, maskSecretValue, normalizeBaseUrl, saveSecrets, secretsPath,
  allJobRecords, setVerdict, VERDICTS, recordPick, pickReason, capsOf, fullAccessOn, fullAccessSupported, cleanup, storageUsage, RETENTION_DAYS,
  runningWriters, scopesOverlap, normScope, isPathInScope, withWriteLock, gitSnapshot, claimPendingDispatch,
  parseGitStatusPath, parseGitStatusPaths, diffSnapshots, checkOutOfScope, workspaceRoot,
  getWorkspaceActivityMtime, recordMeteredUsage, meteredUsedToday, meteredCapReached,
  lineSnapshot, snapshotDelta, maskSecrets, withoutOtherWriters, scopeLineSnapshot,
} from "./lib.mjs";
import { refreshCache, refreshGrok, loadCache, detectQuotaExhausted, markPoolExhausted, parseResetMs } from "./quota.mjs";
import { scoreRoute, parseLevel, modelTier, tierAllowed, CODEX_EFFORT, LEVEL_TEXT, TIER_TEXT } from "./score.mjs";
import {
  getModels, loadModelsCache, findModelPool, setProviderDefaultModel, buildModelPools,
} from "./models.mjs";
import { cmdModelsDiscover } from "./discover.mjs";
import { sampleQuotaHistory, lastCycles, workStats } from "./stats.mjs";
import { usageForJob, usageFromOutputJson, parseClaudeOutput, backfill, attachLiveUsage, getSessionActivityMtime } from "./usage.mjs";
import {
  BRIEF_TEMPLATE, checkBrief, roleOfBrief, levelOfBrief, buildDispatchPrompt, readSharedContext, writeSharedContext, clearSharedContext,
  attachJobs, gitDiff, projectContext, scopeOfBrief, needsWithImages, helpRequestOf, hasStepSpec, verifyOfBrief,
} from "./brief.mjs";

// 按打分选模型：擅长度 × 额度（含快到期加成）× 历史可靠度（含验收结论）× 速度
// write / target / workspace 原样传给打分，缺了就不做沙箱检查
// needs 是这次要的能力（web / exec），缺的厂商由打分跳过
// level 是任务难度，决定候选模型的最低档位和打分侧重；downgrade 为真时门槛降一档；默认换成额度池里最高的思考档，exactModel（点名了模型）时不换
// steps 为真且难度中等时（派单带合格的「## 步骤」规格），门槛同样降一档，轻档可接
// 按量计费厂商当天用量到上限后，自动选人把它从首选和备选移到跳过（点名厂商不拦）。
function route(cfg, rows, role, only, { write, target, workspace, needs, level, downgrade, steps, exactModel, excludeProviders } = {}) {
  if (only) return scoreRoute(cfg, rows, role, { only, history: allJobRecords(), write, target, workspace, needs, level, downgrade, steps, exactModel });
  const r = scoreRoute(cfg, rows, role, { history: allJobRecords(), write, target, workspace, needs, level, downgrade, steps, exactModel, excludeProviders });
  const capped = new Set();
  const keep = [];
  for (const cand of [r.choice, ...r.alternatives]) {
    if (!cand) continue;
    if (meteredCapReached(cfg, cand.provider)) {
      capped.add(cand.provider);
      r.skipped.push({
        provider: cand.provider,
        pool: cand.pool,
        model: cand.model,
        routeModel: cand.routeModel,
        via: cand.via,
        status: cand.status,
        why: "今日按量用量已到上限",
      });
    } else {
      keep.push(cand);
    }
  }
  r.choice = keep[0] || null;
  r.alternatives = keep.slice(1);
  // 上限到顶的厂商，其余候选同样不参与（无论它在 ordered 里出现与否，scoreRoute 已经把 candidate 都放进了 choice/alternatives）
  r.skipped = r.skipped.filter((s) => !capped.has(s.provider) || s.why === "今日按量用量已到上限");
  return r;
}

const LEVEL_HELP = "难度必填：派单里写一行「难度：简单|中等|困难」，或加 --level 简单|中等|困难。简单：照样子改、补注释、整理资料，派便宜、额度多的轻档；中等：常规实现和排查；困难：跨模块设计、疑难排查，只派强档";

// 没选出模型时的说明：先列每条跳过原因；只有够档位的模型全是因为额度被跳过时，才提示降级
export function noModelText(role, level, skipped) {
  const lines = skipped.map((s) => `  跳过：${s.provider} / ${s.model}  ${s.why}`);
  const fit = skipped.filter((s) => !s.tierTooLow);
  const low = skipped.some((s) => s.tierTooLow);
  const tail = low && fit.every((s) => s.why === "额度耗尽或过低")
    ? `角色 ${role}、难度${LEVEL_TEXT[level]}没有可用模型：够档位的${fit.length ? "都没额度" : "一个都没有"}。由主管自己做，或确认降一档也能做好时加 --downgrade "<原因>"`
    : `角色 ${role}${level ? `、难度${LEVEL_TEXT[level]}` : ""}没有可用模型，原因见上面每一条`;
  return [...lines, tail].join("\n");
}

// 档位不够时的退回说明；steps 为真（派单带合格的步骤规格）时补充说明轻档可接
function tierRefusal(level, provName, model, tier, steps = false) {
  const stepNote = steps && level === "medium" ? "这张派单带了合格的「## 步骤」规格，轻档也可以接，检查步骤小节后重试" : "";
  return `${provName} / ${model} 是${TIER_TEXT[tier]}模型，接不了${LEVEL_TEXT[level]}任务。换更强的模型；没有可用的就由主管自己做，或确认降一档也能做好时加 --downgrade "<原因>"${stepNote ? `。${stepNote}` : ""}`;
}

// 中等任务没有候选时的提示：用 steps 再打一次分，列出届时可接的轻档候选，
// 并说明把任务写成「## 步骤」规格后可以派给它们
function stepsHintText(cfg, rows, role, extra, only) {
  const r = route(cfg, rows, role, only, { ...extra, steps: true });
  const lights = [r.choice, ...r.alternatives].filter((c) => c && c.tier === "light");
  const lines = ["", "轻档候选（现在因档位不够被跳过）："];
  for (const c of lights) lines.push(`  ${c.provider} / ${c.model}  [${quotaText(cfg, c.provider, c.status)}]  ${c.reason}`);
  if (!lights.length) lines.push("  （没有：轻档也都没额度或已停用）");
  lines.push("把任务写成「## 步骤」规格（至少 2 步，每步点到具体文件）后可以派给它们：中等任务带合格的步骤规格时轻档可接，relay pick 加 --steps 可预览。");
  return lines.join("\n");
}

const OUTPUT_CAP = 20000;
const CODEX_PLUGIN_ID = "codex@openai-codex";

function parseArgs(argv) {
  const opts = { _: [] };
  const valueFlags = new Set(["--role", "--model", "--cwd", "--prompt-file", "--timeout", "--provider", "--json-spec", "--preset", "--claude-json", "--limit", "--with", "--scope", "--target", "--needs", "--idle-timeout", "--max-runtime", "--verdict", "--level", "--downgrade", "--add", "--remove", "--days", "--undo"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      opts.text = argv.slice(i + 1).join(" ");
      break;
    }
    // --downgrade 必须带原因；后面缺值或紧跟别的开关时记为 true，不吞掉下一个参数（由命令自己报错）
    if (a === "--downgrade" && (i + 1 >= argv.length || String(argv[i + 1]).startsWith("--"))) opts.downgrade = true;
    else if (valueFlags.has(a)) opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
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

// --needs web,exec,vision。顺序固定，方便和打分里的文案对齐
function parseNeedsFlag(raw) {
  if (!raw || raw === true) return [];
  const wanted = new Set(String(raw).split(/[,，]/).map((s) => s.trim().toLowerCase()).filter(Boolean));
  return ["web", "exec", "vision"].filter((k) => wanted.has(k));
}

function missingNeedLabels(caps, needs) {
  if (!needs?.length) return [];
  const labels = [];
  if (needs.includes("web") && caps?.web !== true) labels.push("联网");
  if (needs.includes("exec") && caps?.exec !== true) labels.push("执行命令");
  if (needs.includes("vision") && caps?.vision !== true) labels.push("看图");
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
      pools.push({
        name,
        label: prov.label,
        via: prov.via || (prov.self ? "self" : ""),
        enabled: isEnabled(prov),
        source: quotaSource(cfg, prov.quota.provider, pool),
        ...(prov.billing === "metered" ? { billing: "metered" } : {}),
        ...poolStatus(cfg, rows, prov.quota.provider, pool),
      });
    }
  }
  const picks = Object.keys(cfg.routes || {}).map((role) => route(cfg, rows, role));
  // 每次看状态顺手采样额度：检测到窗口重置就把上个周期结束时还剩多少记下来（面板每分钟会调一次）
  let cycles = {};
  try {
    sampleQuotaHistory(STATE_DIR, rows || []);
    cycles = lastCycles(STATE_DIR);
  } catch {}
  if (opts.json) {
    for (const p of pools) {
      const prov = cfg.providers[p.name];
      const qp = prov?.quota?.provider || p.name;
      const list = Object.entries(cycles)
        .filter(([k]) => k.startsWith(`${qp}|${p.pool}|`))
        .map(([, c]) => c);
      if (list.length) p.lastCycles = list;
    }
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
    console.log(`  ${mark} ${p.label} [${p.name}/${p.pool}]  ${p.enabled ? quotaText(cfg, p.name, p) : "已停用"}  （来源：${p.source}）`);
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
  console.log(`ai-relay 模式：${prev} → ${target}，从下一条消息起生效`);
  if (opts.sync) {
    console.log(togglePlugin(target !== "off"));
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
  const level = parseLevel(opts.level);
  if (!level) {
    console.error(`relay pick 需要 --level 简单|中等|困难。${LEVEL_HELP}`);
    process.exit(2);
  }
  extra.level = level;
  extra.downgrade = !!opts.downgrade;
  // --steps：预览"派单带合格的「## 步骤」规格"时的候选（只对中等任务生效，打分内部忽略其他难度）
  extra.steps = !!opts.steps;
  const r = route(cfg, readQuotaRows(cfg), role, opts.provider, extra);
  if (r.choice) recordPick(role, r);
  if (opts.json) return console.log(JSON.stringify(r, null, 2));
  if (!r.choice) {
    console.log(noModelText(role, level, r.skipped));
    // 中等任务一个候选都没有：按"带步骤规格"再打一次分，把届时能接的轻档列出来，提示主管补写「## 步骤」
    // 快问是简单问答，没有文件级步骤可写，不给步骤规格提示
    if (level === "medium" && !opts.steps && role !== "quick") console.log(stepsHintText(cfg, readQuotaRows(cfg), role, extra, opts.provider));
    process.exit(3);
  }
  const c = r.choice;
  console.log(`${role}（难度${LEVEL_TEXT[level]}）→ ${c.provider} / ${c.pool} / ${c.model}（${TIER_TEXT[c.tier]}）  [${quotaText(cfg, c.provider, c.status)}]`);
  console.log(`  理由：${c.reason}`);
  if (c.via === "codex-plugin") {
    const flags = [c.model && c.model !== "default" ? `--model ${c.model}` : "", `--effort ${CODEX_EFFORT}`].filter(Boolean).join(" ");
    console.log(`→ 用 Codex 官方插件执行：Agent 工具 subagent_type=codex:codex-rescue，prompt 第一行写「${flags}」，下面按派单模板写（relay brief 查看，含「难度：${LEVEL_TEXT[level]}」）。第一行不写时，钩子会按这次 pick 的结果补上`);
  } else {
    // 降级选出来的，派的时候也要带上同样的 --downgrade，否则会被档位检查退回
    const down = opts.downgrade ? ` --downgrade "${String(opts.downgrade === true ? "<原因>" : opts.downgrade).replace(/"/g, '\\"')}"` : "";
    console.log(`→ relay run ${c.provider} --role ${role} --model ${c.model}${down} --cwd <项目根> <<'RELAY_EOF' …派单（含「难度：${LEVEL_TEXT[level]}」）… RELAY_EOF`);
  }
  for (const a of r.alternatives) console.log(`  备选：${a.provider} / ${a.model}  [${quotaText(cfg, a.provider, a.status)}]  ${a.reason}`);
  for (const s of r.skipped) console.log(`  跳过：${s.provider} / ${s.model}  ${s.why}  [${quotaText(cfg, s.provider, s.status)}]`);
}

// 按量计费没有剩余比例。排序仍按额度未知处理，只把展示改成「按量计费」。
// relay status 对按量厂商多显示一行：按量计费 · 今日 N 万 token / 上限 M 万
function quotaText(cfg, providerName, st) {
  const prov = cfg.providers?.[providerName];
  if (prov?.billing === "metered") {
    if (st?.level !== "unknown") return fmtPool(st);
    const cap = Number(cfg.meteredDailyTokenCap ?? 20_000_000);
    const used = meteredUsedToday(providerName);
    const wan = (n) => {
      const v = n / 10_000;
      return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
    };
    return `按量计费 · 今日 ${wan(used)} 万 token / 上限 ${wan(cap)} 万`;
  }
  return fmtPool(st);
}

// ---------- run ----------
// 拼出命令行参数。fullAccessWriteOnly 的厂商：只读永远只用 read；可写在最高权限打开时用 fullAccess 换掉 write。
// 没有这个字段的厂商保持原来的顺序：read/write、cwd、再追加 fullAccess。
export function assembleArgs(cfg, job) {
  const prov = cfg.providers[job.provider];
  const cli = prov.cli;
  const actualModel = resolveModel(cfg, job.provider, job.pool || poolOfModel(prov, job.model), job.model);
  // 占位符只按整个参数匹配，避免任务文本里的 {model} 之类被误替换
  const vars = { "{prompt}": job.wrappedPrompt, "{model}": actualModel, "{cwd}": job.cwd };
  const fill = (arr) => (arr || []).map((s) => (s in vars ? vars[s] : s));
  const args = [];
  if (actualModel && actualModel !== "default") args.push(...fill(cli.model));
  // 每次都带的固定参数（如 Grok 的 --reasoning-effort xhigh：思考一律最高）
  args.push(...fill(cli.alwaysArgs));
  if (cli.fullAccessWriteOnly) {
    if (job.write && fullAccessOn(cfg, prov)) args.push(...fill(cli.fullAccess));
    else args.push(...fill(job.write ? cli.write : cli.read));
    if (cli.cwd) args.push(...fill(cli.cwd));
  } else {
    args.push(...fill(job.write ? cli.write : cli.read));
    if (cli.cwd) args.push(...fill(cli.cwd));
    // 员工最高权限（默认开）：不再逐个批准命令；安全靠派单里的硬性规则和事后的越界检查
    if (fullAccessOn(cfg, prov)) args.push(...fill(cli.fullAccess));
  }
  args.push(...fill(cli.prompt));
  return args;
}

export function buildCommand(cfg, job) {
  const cli = cfg.providers[job.provider].cli;
  const bin = resolveBin(cli.bin);
  if (!bin) throw new Error(`找不到 ${cli.bin} 命令，请确认已安装并登录`);
  return { bin, args: assembleArgs(cfg, job) };
}

function fillPlaceholder(text, vars) {
  let out = String(text);
  for (const [key, value] of Object.entries(vars)) {
    if (out === key) return value;
    if (out.includes(key)) out = out.split(key).join(value);
  }
  return out;
}

// 厂商配了 env / envUnset 时，在继承的环境上覆盖和删除。没配的厂商不传 env，行为和原来一样。
// 返回的 secret 只用于打码，不能写进任务文件。
export function resolveJobEnv(cfg, job, secrets) {
  const prov = cfg?.providers?.[job?.provider];
  const envSpec = prov?.env;
  const unsetSpec = prov?.envUnset;
  const hasEnv = !!envSpec && typeof envSpec === "object" && !Array.isArray(envSpec) && Object.keys(envSpec).length > 0;
  const hasUnset = Array.isArray(unsetSpec) && unsetSpec.length > 0;
  if (!hasEnv && !hasUnset) return { env: undefined, secret: "" };

  let secret = "";
  if (hasEnv && Object.values(envSpec).some((value) => String(value).includes("{secret}"))) {
    const secretName = prov?.endpoint?.secret || job.provider;
    secret = secrets?.[secretName] || "";
    if (!secret) throw new Error(`还没有密钥。请运行 relay provider key ${job.provider}`);
  }
  const env = { ...process.env };
  if (hasEnv) {
    const baseUrl = prov?.endpoint?.baseUrl || "";
    for (const [key, value] of Object.entries(envSpec)) {
      env[key] = fillPlaceholder(value, { "{baseUrl}": baseUrl, "{secret}": secret });
    }
  }
  if (hasUnset) {
    for (const key of unsetSpec) delete env[key];
  }
  return { env, secret };
}

function expectsJsonOutput(prov) {
  const prompt = prov?.cli?.prompt;
  if (!Array.isArray(prompt)) return false;
  for (let i = 0; i < prompt.length - 1; i++) {
    if (prompt[i] === "--output-format" && prompt[i + 1] === "json") return true;
  }
  return false;
}

// 只认带 result / is_error / usage 的对象。别的 JSON 原样当文本。
function claudeResultOf(stdout) {
  const data = parseClaudeOutput(stdout);
  if (!data) return null;
  if (!Object.prototype.hasOwnProperty.call(data, "result") && data.is_error !== true && !data.usage) return null;
  return data;
}

function jobPath(id, ext = "json", customDir = null) {
  return path.join(customDir || JOBS_DIR, `${id}.${ext}`);
}

function saveJob(job) {
  const dir = job._jobsDir || JOBS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jobPath(job.id, "json", dir), JSON.stringify(job, null, 2));
}

function loadJob(id, customDir = null) {
  const dir = customDir || JOBS_DIR;
  if (id === "last") {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    if (!files.length) throw new Error("还没有任何任务");
    id = files[files.length - 1].replace(/\.json$/, "");
  }
  return JSON.parse(fs.readFileSync(jobPath(id, "json", dir), "utf8"));
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

export function formatTimeoutReason(job) {
  if (job?.timeoutReason === "idle") {
    const min = job.idleTimeoutMin || 20;
    return `连续 ${min} 分钟无活动`;
  }
  if (job?.timeoutReason === "max") {
    return "超过总上限";
  }
  return "";
}

// 真正执行 CLI（前台或后台 worker 共用）
// ---------- 大改动自动初审 ----------
// 可写任务成功结束、改动行数到阈值（默认 150）、本身不是审查、自动模式、配置没关时，
// 后台派一个只读审查给另一家厂商，难度中等。主管仍要复核实现和初审两边、各记一次结论。

const REVIEW_DIFF_MAX = 60 * 1024;

// 只取这次任务改到的文件的 diff：已跟踪的对 HEAD 比，新建的整份列出。太长时截断并写明
export function changesDiff(cwd, changedFiles) {
  const tracked = new Set();
  const untracked = new Set();
  for (const line of Array.isArray(changedFiles) ? changedFiles : []) {
    const paths = parseGitStatusPaths(line);
    for (const p of paths) (String(line).startsWith("??") ? untracked : tracked).add(p);
  }
  const run = (args) => {
    // 快照里的路径相对仓库根：在仓库根执行，cwd 是子目录时也能对上
    const r = spawnSync("git", ["-C", workspaceRoot(cwd), "-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return r.stdout || "";
  };
  let out = tracked.size ? run(["diff", "HEAD", "--", ...tracked]) : "";
  for (const p of untracked) out += run(["diff", "--no-index", "--", "/dev/null", p]);
  out = out.trim();
  if (!out) return null;
  if (out.length > REVIEW_DIFF_MAX) {
    out = `${out.slice(0, REVIEW_DIFF_MAX)}\n\n（diff 太长，后面略。完整改动自己读这些文件：${[...tracked, ...untracked].join("、")}）`;
  }
  return out;
}

// 不做初审时返回 null（条件不满足，不必说明）或 { skipped: 原因 }（满足条件但做不了，要告诉主管）
export function autoReviewPlan(cfg, job, { mode = getMode(), rows } = {}) {
  if (!job?.write || job.status !== "done") return null;
  if (cfg.autoReview === false) return null;
  if (job.role === "review" || job.autoReviewOf) return null;
  const min = Number(cfg.autoReviewMinLines ?? 150);
  if (!Number.isFinite(job.changedLines) || job.changedLines < min) return null;
  if (mode !== "auto") return { skipped: `${mode === "off" ? "纯 Claude" : "手动"}模式不自动初审` };
  const r = route(cfg, rows === undefined ? readQuotaRows(cfg) : rows, "review", undefined, { level: "medium", excludeProviders: [job.provider] });
  // 只有 relay 能直接起的员工；Codex 要走 Agent 工具，relay 起不了
  const c = [r.choice, ...r.alternatives].find((x) => x && x.via === "relay" && x.provider !== job.provider);
  if (!c) return { skipped: "没有可用的审查员工（实现者以外的厂商都不可用或额度不足），未做初审" };
  return { candidate: c };
}

// 按计划建初审任务并后台启动。orig 要带 task（原派单）、output（原任务交回的结果）
export function startAutoReview(cfg, orig, { spawnWorker = true, mode, rows } = {}) {
  const plan = autoReviewPlan(cfg, orig, { mode, rows });
  if (!plan || plan.skipped) return plan;
  const c = plan.candidate;
  const prov = cfg.providers[c.provider];
  const files = [...new Set((orig.changedFiles || []).flatMap((l) => parseGitStatusPaths(l)))];
  const fence = "````";
  const task = `角色：review
难度：中等

## 目标
初审任务 ${orig.id}（${orig.provider}${orig.model && orig.model !== "default" ? " / " + orig.model : ""}）刚交付的改动，找出会让结果不对的问题：逻辑错误、漏改、和原派单要求不符、明显的回归。不挑代码风格。

## 背景
这是 ai-relay 在可写任务改动较大（${orig.changedLines} 行）时自动发起的只读初审，主管会逐条核对你的意见。原派单全文、它交回的结果、这次改动的 diff 都附在后面。

## 相关文件
${files.length ? files.map((f) => `- ${f}`).join("\n") : "- 见后附 diff"}

## 验收标准
- 每个问题写清 文件:行号、问题是什么、为什么是错的、建议怎么改；
- 对照原派单的验收标准逐条给出：满足 / 不满足 / 无法判断，并说明依据；
- 没发现问题就明确写"未发现问题"，不要凑数。

## 交付格式
结论（有没有必须修的问题）/ 问题清单 / 验收标准逐条核对`;
  const origOutput = String(orig.result || orig.output || "").trim();
  const attachments = [
    `### 原派单（任务 ${orig.id}）\n${fence}\n${String(orig.brief || orig.task || "（没有记录）").trim()}\n${fence}`,
    `### 原任务交回的结果\n${fence}\n${origOutput.length > 8000 ? origOutput.slice(-8000) : origOutput || "（没有输出）"}\n${fence}`,
  ].join("\n\n");
  const st = c.status || poolStatus(cfg, readQuotaRows(cfg), prov.quota?.provider || c.provider, c.pool);
  const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${c.provider}-${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id, provider: c.provider, pool: c.pool, model: c.model, role: "review", level: "medium",
    reason: `自动初审任务 ${orig.id}（改动 ${orig.changedLines} 行，排除实现者 ${orig.provider}）；${c.reason}`,
    write: false, cwd: orig.cwd, task, scope: null,
    withJobs: [orig.id],
    autoReviewOf: orig.id,
    ...(orig.sessionId ? { sessionId: orig.sessionId } : {}),
    wrappedPrompt: buildDispatchPrompt({
      task, cwd: orig.cwd, write: false, role: "review",
      shared: readSharedContext(STATE_DIR, orig.cwd),
      attachments,
      diff: changesDiff(orig.cwd, orig.changedFiles),
      caps: capsOf(cfg, prov, c.model),
    }),
    status: "running", startedAt: new Date().toISOString(), quotaAtStart: quotaText(cfg, c.provider, st),
  };
  if (orig._jobsDir) job._jobsDir = orig._jobsDir;
  saveJob(job);
  if (spawnWorker) {
    const child = spawn(process.execPath, [RELAY_SCRIPT, "_worker", id], { detached: true, stdio: "ignore", cwd: orig.cwd });
    job.pid = child.pid;
    saveJob(job);
    child.unref();
  }
  return { id, provider: c.provider, model: c.model };
}

// Codex 任务结束后由 posttool 钩子调用：relay _autoreview <任务id>，输出 JSON
function cmdAutoReview(opts) {
  const orig = loadAnyJob(opts._[1]);
  const res = startAutoReview(loadConfig(), orig) || {};
  console.log(JSON.stringify(res));
}

export async function executeJob(job, testOpts = {}) {
  const cfg = testOpts.cfg || loadConfig();
  const idleTimeoutMin = Number(job.idleTimeoutMin ?? cfg.idleTimeoutMin ?? 20);
  const maxRuntimeMin = Number(job.maxRuntimeMin ?? cfg.maxRuntimeMin ?? cfg.jobTimeoutMinutes ?? 240);
  const idleTimeoutMs = job.idleTimeoutMs ?? testOpts.idleTimeoutMs ?? (idleTimeoutMin * 60_000);
  const maxRuntimeMs = job.maxRuntimeMs ?? testOpts.maxRuntimeMs ?? (maxRuntimeMin * 60_000);
  const checkIntervalMs = job.checkIntervalMs ?? testOpts.checkIntervalMs ?? 60_000;

  job.idleTimeoutMin = idleTimeoutMin;
  job.maxRuntimeMin = maxRuntimeMin;

  let bin;
  let args;
  let spawnEnv;
  let taskSecret = "";
  try {
    const prov = cfg.providers?.[job.provider];
    const needsSecret = !!prov?.env && Object.values(prov.env).some((value) => String(value).includes("{secret}"));
    const secrets = testOpts.secrets || (needsSecret ? loadSecrets() : {});
    ({ env: spawnEnv, secret: taskSecret } = resolveJobEnv(cfg, job, secrets));
    if (testOpts.bin || job._bin) {
      bin = testOpts.bin || job._bin;
      args = testOpts.args || job._args || [];
    } else {
      ({ bin, args } = buildCommand(cfg, job));
    }
  } catch (e) {
    // 启动前就失败（找不到命令、没有密钥等）：记为失败，免得一直占着"运行中"挡住后续可写任务
    Object.assign(job, { status: "failed", finishedAt: new Date().toISOString(), error: String(e.message || e) });
    saveJob(job);
    throw e;
  }

  const before = gitSnapshot(job.cwd);
  // 可写任务的任务开始、结束各拍一次行数快照，结束时求差记录改动行数（失败时不记）
  let linesBefore = null;
  if (job.write) {
    try {
      linesBefore = await lineSnapshot(job.cwd);
    } catch {
      linesBefore = null;
    }
  }
  const spawnOpts = {
    cwd: job.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  };
  // 没配 env 的厂商不传，子进程继续继承当前环境
  if (spawnEnv) spawnOpts.env = spawnEnv;
  const child = spawn(bin, args, spawnOpts);

  // 员工 CLI 在自己的进程组里（detached）：relay 本身被结束（Ctrl-C、调用方超时 kill、relay cancel 杀 worker）时，
  // 先把员工进程组一起结束再退出，不留下继续改文件、耗额度的孤儿进程
  const onParentSignal = (sig) => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch {}
    }
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGTERM", onParentSignal);
  process.once("SIGINT", onParentSignal);
  child.once("close", () => {
    process.removeListener("SIGTERM", onParentSignal);
    process.removeListener("SIGINT", onParentSignal);
  });

  job.childPid = child.pid;
  if (!job.pid) job.pid = child.pid;
  saveJob(job);

  const startMs = Date.now();
  let lastOutputTime = startMs;
  let lastActivityTime = startMs;
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutLen = 0;
  let stderrLen = 0;
  const MAX_BUF = 64 * 1024 * 1024;

  child.stdout?.on("data", (chunk) => {
    lastOutputTime = Date.now();
    if (stdoutLen < MAX_BUF) {
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
    }
  });

  child.stderr?.on("data", (chunk) => {
    lastOutputTime = Date.now();
    if (stderrLen < MAX_BUF) {
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
    }
  });

  let timedOut = false;
  let timeoutReason = null;
  let killTimer = null;

  function terminateChild(reason) {
    if (timedOut) return;
    timedOut = true;
    timeoutReason = reason;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
    }
    killTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { process.kill(child.pid, "SIGKILL"); } catch {}
      }
    }, 2000);
    killTimer.unref?.();
  }

  function checkActivity() {
    const now = Date.now();
    // 1. 超过总时长上限
    if (now - startMs >= maxRuntimeMs) {
      terminateChild("max");
      return;
    }
    // 2. 取三者最新活动时间
    const t1 = lastOutputTime;
    const t2 = getSessionActivityMtime(job, testOpts);
    const t3 = getWorkspaceActivityMtime(job.cwd, 2000);
    const latest = Math.max(t1, t2 || 0, t3 || 0);
    if (latest > lastActivityTime) {
      lastActivityTime = latest;
    }
    // 3. 连续无活动超时
    if (now - lastActivityTime >= idleTimeoutMs) {
      terminateChild("idle");
      return;
    }
  }

  const checkInterval = setInterval(checkActivity, checkIntervalMs);
  checkInterval.unref?.();

  const maxTimer = setTimeout(() => {
    terminateChild("max");
  }, maxRuntimeMs);
  maxTimer.unref?.();

  const { code, signal, error } = await new Promise((resolve) => {
    let settled = false;
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: null, error: err });
      }
    });
    child.on("close", (exitCode, exitSignal) => {
      if (!settled) {
        settled = true;
        resolve({ code: exitCode, signal: exitSignal, error: null });
      }
    });
  });

  clearInterval(checkInterval);
  clearTimeout(maxTimer);
  if (killTimer) clearTimeout(killTimer);

  const after = gitSnapshot(job.cwd);
  const stdoutStr = Buffer.concat(stdoutChunks).toString("utf8");
  const stderrStr = Buffer.concat(stderrChunks).toString("utf8");
  const output = stdoutStr + (stderrStr ? `\n[stderr]\n${stderrStr}` : "");

  // 写回前重读一次磁盘：已被 relay cancel 标成 cancelled 的任务，不能被事后覆盖成 failed/done
  let cancelledOnDisk = false;
  try { cancelledOnDisk = loadJob(job.id, job._jobsDir)?.status === "cancelled"; } catch {}
  if (cancelledOnDisk) {
    job.exitCode = code;
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    // 取消前员工可能已经改了文件：留下改动清单，主管才能核对残留改动
    if (before !== null && after !== null) {
      job.changedFiles = withoutOtherWriters(job, diffSnapshots(before, after));
      const out = job.write && job.changedFiles?.length ? checkOutOfScope(job.changedFiles, job.scope, job.cwd) : [];
      if (out.length) job.outOfScope = out;
    }
    try { fs.writeFileSync(jobPath(job.id, "log", job._jobsDir), maskSecrets(maskSecretValue(output, taskSecret))); } catch {}
    saveJob(job);
    return job;
  }

  job.exitCode = code;
  if (timedOut) {
    job.status = "timeout";
    job.timeoutReason = timeoutReason;
  } else if (error) {
    job.status = "failed";
    job.error = String(error.message || error);
  } else {
    job.status = code === 0 ? "done" : "failed";
  }
  job.finishedAt = new Date().toISOString();

  const prov = cfg.providers?.[job.provider];
  let parsed = null;
  if (expectsJsonOutput(prov)) {
    parsed = claudeResultOf(stdoutStr);
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "result")) {
      job.result = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result);
    }
    if (parsed?.is_error === true && job.status === "done") {
      job.status = "failed";
      if (!job.error) job.error = "对方返回错误（is_error）";
    }
  }

  const usage = (parsed && usageFromOutputJson(parsed)) || usageForJob(job, testOpts);
  if (usage) job.usage = usage;
  // 按量计费厂商的任务结束后，把本次输入 + 输出 token 累计到当天用量里（供每日上限判断和 status 展示）
  if (cfg.providers?.[job.provider]?.billing === "metered" && usage && Number.isFinite(usage.input + usage.output)) {
    recordMeteredUsage(job.provider, usage.input + usage.output);
  }
  if (before !== null && after !== null) {
    job.changedFiles = withoutOtherWriters(job, diffSnapshots(before, after));
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
  if (job.status === "done" && job.permissionDenied && !stdoutStr.trim()) job.status = "failed";
  // 可写任务任务结束再拍一次行数快照，求差记改动行数（失败时不记）
  if (job.write && linesBefore) {
    try {
      const linesAfter = await lineSnapshot(job.cwd, Object.keys(linesBefore.heads || {}), linesBefore.heads);
      if (linesAfter && job.status === "done") {
        // 只数本任务写入范围内的行，并行任务改的不算进来（免得误触发初审、重复计工作量）
        job.changedLines = snapshotDelta(scopeLineSnapshot(linesBefore, job), scopeLineSnapshot(linesAfter, job));
      }
    } catch {}
  }
  // 可写、成功结束且派单带验证命令时：在任务目录里依次执行，记录退出码、耗时和输出的最后 40 行
  const verifyCmds = job.write && job.status === "done" ? verifyOfBrief(job.task) : [];
  if (verifyCmds.length && !testOpts.skipVerify) {
    const verifyTimeoutMs = Number(cfg.verifyTimeoutMin ?? 10) * 60_000;
    const results = [];
    for (const cmd of verifyCmds) {
      const startedMs = Date.now();
      const res = spawnSync("sh", ["-c", cmd], { cwd: job.cwd, encoding: "utf8", timeout: verifyTimeoutMs });
      const rawTail = `${res.stdout || ""}${res.stderr ? `\n${res.stderr}` : ""}`.trim();
      const tail = maskSecrets(maskSecretValue(rawTail.split("\n").slice(-40).join("\n"), taskSecret));
      const entry = { cmd, exitCode: res.status, ms: Date.now() - startedMs, tail };
      if (res.error?.code === "ETIMEDOUT") {
        entry.exitCode = null;
        entry.timedOut = true;
      } else if (res.error) {
        entry.exitCode = null;
      }
      results.push(entry);
    }
    job.verify = { ok: results.every((r) => r.exitCode === 0), results };
    if (!job.verify.ok) job.verifyFailed = true;
  }
  // 员工命令行报额度用完（额度接口可能还显示充足）：只在任务没成功时看标准错误和输出末尾，
  // 避免正常产出里碰巧写到 usage limit 之类的字样被误判。命中就把这个额度池临时记为用完 24 小时
  if (job.status !== "done" && detectQuotaExhausted(`${stderrStr}\n${stdoutStr.slice(-2000)}`)) {
    job.quotaExhausted = true;
    try {
      const qp = cfg.providers?.[job.provider]?.quota?.provider || job.provider;
      const resetAt = parseResetMs(`${stderrStr}\n${stdoutStr.slice(-2000)}`);
      if (job.pool) markPoolExhausted(testOpts.stateDir || STATE_DIR, qp, job.pool, Date.now(), 24, resetAt);
    } catch {}
  }
  // 写日志和结果前打掉本任务密钥的原值。标准错误留在日志里，结果只取 JSON 的 result。
  const maskedLog = maskSecrets(maskSecretValue(output, taskSecret));
  if (typeof job.result === "string") job.result = maskSecrets(maskSecretValue(job.result, taskSecret));
  if (typeof job.error === "string") job.error = maskSecrets(maskSecretValue(job.error, taskSecret));
  fs.writeFileSync(jobPath(job.id, "log", job._jobsDir), maskedLog);
  job.helpRequest = helpRequestOf(typeof job.result === "string" ? job.result : maskedLog);
  // 改动大的可写任务：后台起另一家厂商的只读初审，不等它结束
  try {
    const ar = startAutoReview(cfg, { ...job, output: maskedLog }, {
      spawnWorker: testOpts.autoReviewSpawn !== false,
      ...(testOpts.mode ? { mode: testOpts.mode } : {}),
      ...(testOpts.rows !== undefined ? { rows: testOpts.rows } : {}),
    });
    if (ar?.id) job.autoReviewId = ar.id;
    else if (ar?.skipped) job.autoReviewSkipped = ar.skipped;
  } catch (e) {
    job.autoReviewSkipped = `初审没能启动：${String(e.message || e).slice(0, 200)}`;
  }
  saveJob(job);
  return job;
}

export function printJob(job) {
  const modelText = job.model && job.model !== "default" ? " / " + job.model : "";
  const exitText = job.exitCode !== undefined && job.exitCode !== null ? `（退出码 ${job.exitCode}）` : "";
  const linesText = job.changedLines !== undefined && job.changedLines !== null ? ` · 改动 ${job.changedLines} 行` : "";
  let statusText = job.status;
  if (job.status === "timeout") {
    const reasonText = formatTimeoutReason(job);
    statusText = `timeout${reasonText ? `（${reasonText}）` : ""}`;
  }
  const head = [
    `任务 ${job.id} · ${job.provider}${modelText} · ${job.role || "未注明角色"}${job.level ? ` · 难度${LEVEL_TEXT[job.level] || job.level}` : ""} · ${job.write ? "可写" : "只读"}${linesText} · 状态 ${statusText}${exitText}`,
    `目录：${job.cwd}`,
  ];
  if (job.reworkOf) head.push(`返工第 ${job.reworkRound || 1} 次，原任务 ${job.reworkOf}`);
  if (job.status === "timeout") {
    const reasonDesc = formatTimeoutReason(job);
    head.push(`⚠️ 任务超时：${reasonDesc || "已达到运行上限"}`);
  }
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
  let out = typeof job.result === "string" ? job.result : job.output;
  if (out === undefined) {
    try {
      out = fs.readFileSync(jobPath(job.id, "log", job._jobsDir), "utf8");
    } catch {
      out = "";
    }
  }
  if (out) {
    const shown = out.length > OUTPUT_CAP ? "…（前文已省略，完整日志见下方路径）\n" + out.slice(-OUTPUT_CAP) : out;
    console.log("\n----- 输出 -----\n" + shown.trim());
  }
  if (job.verify?.results?.length) {
    console.log(`\n自动验证：${job.verify.ok ? "通过" : "未通过"}`);
    for (const r of job.verify.results) {
      const codeText = r.timedOut ? "超时" : `退出码 ${r.exitCode}`;
      console.log(`  ${r.cmd}\n    ${codeText}，${r.ms} ms`);
      if (!job.verify.ok && r.tail) console.log(r.tail.split("\n").map((l) => `    ${l}`).join("\n"));
    }
    if (!job.verify.ok) console.log(`可用 relay rework <id> -- <修改意见> 退回。`);
  }
  if (job.autoReviewId) {
    console.log(`\n自动初审：改动较大，已在后台派另一家厂商只读审查，任务 ${job.autoReviewId}。初审意见只是证据：实现和初审两边都要你复核、各记一次结论。等它：node "${RELAY_SCRIPT}" wait ${job.autoReviewId}`);
  } else if (job.autoReviewSkipped) {
    console.log(`\n自动初审：${job.autoReviewSkipped}`);
  }
  if (job.autoReviewOf) console.log(`（这是任务 ${job.autoReviewOf} 的自动初审）`);
  console.log(`\n完整日志：${jobPath(job.id, "log", job._jobsDir)}`);
  if (job.status !== "running" && !job.verdict) console.log(`验收后记录结论：node "${RELAY_SCRIPT}" verdict ${job.id} pass|partial|fail -- <一句话说明>`);
  if (job.verdict) console.log(`验收结论：${job.verdict}${job.verdictNote ? "（" + job.verdictNote + "）" : ""}`);
}

async function cmdRun(opts) {
  if (opts.help) {
    help();
    return;
  }
  const cfg = loadConfig();
  const idleTimeoutMin = opts.idleTimeout ? Number(opts.idleTimeout) : (cfg.idleTimeoutMin ?? 20);
  const maxRuntimeMin = opts.maxRuntime ? Number(opts.maxRuntime) : (cfg.maxRuntimeMin ?? cfg.jobTimeoutMinutes ?? 240);
  if (Number.isNaN(idleTimeoutMin) || idleTimeoutMin <= 0) {
    throw new Error("--idle-timeout 必须是正数（分钟）");
  }
  if (Number.isNaN(maxRuntimeMin) || maxRuntimeMin <= 0) {
    throw new Error("--max-runtime 必须是正数（分钟）");
  }
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
  const level = parseLevel(opts.level) || levelOfBrief(task);
  if (!level) {
    console.error(`ai-relay 错误：派单没写难度，已退回。${LEVEL_HELP}`);
    process.exit(2);
  }
  if (opts.downgrade === true) {
    console.error('ai-relay 错误：--downgrade 要写原因，例如 --downgrade "强档都没额度，这次改动只涉及单个文件"');
    process.exit(2);
  }
  const downgrade = opts.downgrade ? String(opts.downgrade) : "";
  // --needs 优先；否则从派单「需要的能力」读。空数组表示不按能力筛选
  const needs = opts.needs ? parseNeedsFlag(opts.needs) : needsWithImages(task);
  // 派单正文带合格的「## 步骤」规格时，中等任务可以交给轻档（打分和档位检查都放宽一档）
  const steps = hasStepSpec(task);

  let provName = opts._[1];
  const rows = readQuotaRows(cfg);
  let model = opts.model;
  let pool;
  let reason = "";

  if (!provName || provName === "auto") {
    // 可写任务按目标目录判断沙箱：Codex 写不到项目外的目录时自动跳过
    const target = path.resolve(opts.cwd || process.cwd());
    const workspace = workspaceRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    // 不传 exactModel：路由条目照常换到最高思考档参与选人；点名的模型按它自己的档位在后面过门槛
    const r = route(cfg, rows, role, undefined, { needs, write: !!opts.write, target, workspace, level, downgrade: !!downgrade, steps });
    // 首选是 Codex 时不悄悄改派：Codex 要走 Agent 工具（官方插件），交给主管去派
    if (!opts.model && !opts.skipCodex && r.choice?.via === "codex-plugin") {
      recordPick(role, r);
      const modelHint = `（Agent prompt 第一行写「${[r.choice.model && r.choice.model !== "default" ? `--model ${r.choice.model}` : "", `--effort ${CODEX_EFFORT}`].filter(Boolean).join(" ")}」）`;
      console.error(`首选是 Codex（${r.choice.reason}）。请用 Agent 工具 subagent_type=codex:codex-rescue 把这张派单交给它${modelHint}；确有理由不用 Codex 时，加 --skip-codex 改派第二名。`);
      process.exit(3);
    }
    // 只考虑能由 ai-relay 直接调用的候选
    // 点名的模型可以是同一家族的另一思考档（如 flash-low），同一家族、且在该额度池里就算匹配
    const family = (m) => String(m || "").replace(/-(xhigh|low|medium|high)$/, "");
    const inPool = (x) => (cfg.providers[x.provider]?.pools?.[x.pool] || []).includes(opts.model);
    const c = [r.choice, ...r.alternatives].find((x) => x && x.via === "relay" && (!opts.model || x.model === opts.model || x.routeModel === opts.model || (family(x.model) === family(opts.model) && inPool(x))));
    if (!c) {
      if (opts.model) {
        console.error(`模型 ${opts.model} 在角色 ${role} 下不可用或额度不足`);
        process.exit(3);
      }
      const first = r.choice;
      const modelHint = `（Agent prompt 第一行写「${[first?.model && first.model !== "default" ? `--model ${first.model}` : "", `--effort ${CODEX_EFFORT}`].filter(Boolean).join(" ")}」）`;
      console.error(first?.via === "codex-plugin"
        ? `首选是 Codex：请用 Agent 工具 subagent_type=codex:codex-rescue 执行${modelHint}`
        : noModelText(role, level, r.skipped));
      process.exit(3);
    }
    provName = c.provider;
    model = opts.model && opts.model !== c.routeModel ? opts.model : c.model;
    pool = c.pool;
    reason = c === r.choice ? pickReason(r) : opts.model ? `指定模型 ${opts.model}；${c.reason}` : `主管选择跳过 ${r.choice.provider}（--skip-codex），改用 ${c.provider}；${c.reason}`;
  }

  const prov = cfg.providers[provName];
  if (!prov) throw new Error(`未知提供方 ${provName}，可选：${Object.keys(cfg.providers).join(", ")}`);
  const concreteModel = opts.model || model;
  // 模型还没定（点名厂商、没写 --model）时只查联网和执行命令；能不能看图按模型定，选出模型后再查
  const earlyNeeds = concreteModel && concreteModel !== "default" ? needs : needs.filter((n) => n !== "vision");
  const missingNeeds = missingNeedLabels(capsOf(cfg, prov, concreteModel, { write: !!opts.write }), earlyNeeds);
  if (missingNeeds.length) {
    console.error(`${provName} 不具备：${missingNeeds.join("、")}；需要这项能力的部分请改派，或由主控先完成后把结果写进背景`);
    process.exit(3);
  }
  if (!isEnabled(prov)) {
    console.error(`${provName} 已在 ai-relay 面板中停用，不外派。需要时在面板「厂商」页启用，或执行 relay provider enable ${provName}`);
    process.exit(3);
  }
  if (prov.via === "codex-plugin") {
    const codexPool = providerPools(prov)[0];
    const codexModel = resolveModel(cfg, provName, codexPool, model || "default");
    const modelHint = `（Agent prompt 第一行写「${[codexModel && codexModel !== "default" ? `--model ${codexModel}` : "", `--effort ${CODEX_EFFORT}`].filter(Boolean).join(" ")}」）`;
    console.error(`Codex 走官方插件：请用 Agent 工具 subagent_type=codex:codex-rescue（或 /codex:rescue）${modelHint}，审查用 /codex:review`);
    process.exit(3);
  }
  if (prov.via !== "relay") throw new Error(`${provName} 不能由 ai-relay 调用`);

  if (!reason) {
    // 主模型点名了厂商：仍记下这个厂商在该角色下的打分，便于事后对照
    const r = route(cfg, rows, role, provName, { needs, level, downgrade: !!downgrade, steps, exactModel: !!model });
    const same = [r.choice, ...r.alternatives].find((x) => x && (!model || x.model === model || x.routeModel === model));
    if (!model && r.choice) ({ model, pool } = r.choice);
    else if (same && !pool) ({ model, pool } = same);
    reason = `主模型指定 ${provName}${same ? `；${same.reason}` : ""}`;
    // 这家在路由里一个都没选上：把每条跳过原因都列出来，不只报档位
    if (!model && !r.choice && r.skipped.length) {
      console.error(`ai-relay：${provName} 这次派不了\n${noModelText(role, level, r.skipped)}`);
      process.exit(3);
    }
  }
  if (!model) {
    console.error(`${provName} 在角色 ${role} 下没有可用模型（不在路由或额度不足）；可用 --model 指定该厂商的模型`);
    process.exit(3);
  }
  const modelsCache = loadModelsCache(STATE_DIR);
  pool = pool || findModelPool(prov, provName, model, modelsCache);
  if (!pool) {
    const cachedModels = (modelsCache?.providers?.[provName]?.models || []).filter((m) => m.pool).map((m) => m.id);
    const allowed = [...new Set([...Object.values(prov.pools || {}).flat(), ...cachedModels])];
    throw new Error(`模型 ${model} 不在 ${provName} 的配置里，可选：${allowed.join(", ")}`);
  }
  model = resolveModel(cfg, provName, pool, model);
  const missingNeedsAfter = missingNeedLabels(capsOf(cfg, prov, model, { write: !!opts.write }), needs);
  if (missingNeedsAfter.length) {
    console.error(`${provName} 不具备：${missingNeedsAfter.join("、")}；需要这项能力的部分请改派，或由主控先完成后把结果写进背景`);
    process.exit(3);
  }
  // 点名的厂商和模型也要过难度门槛：档位不够就退回，不悄悄派
  const tier = modelTier(cfg, provName, model);
  if (!tierAllowed(level, tier, !!downgrade, steps)) {
    console.error(`ai-relay：${tierRefusal(level, provName, model, tier, steps)}`);
    process.exit(3);
  }
  if (!reason.includes("难度")) reason = `难度${LEVEL_TEXT[level]}，它是${TIER_TEXT[tier]}；${reason}`;
  if (downgrade) reason = `${reason}；降级原因：${downgrade}`;

  const st = poolStatus(cfg, rows, prov.quota.provider, pool);
  if (st.level === "blocked" && !opts.force) {
    console.error(`${provName}/${pool} 额度不足：${quotaText(cfg, provName, st)}。可换模型或加 --force 强制`);
    process.exit(3);
  }

  if (opts.rework) reason = `返工（第 ${opts.rework.round} 次）：退回任务 ${opts.rework.of} 的原员工；${reason}`;

  const cwd = path.resolve(opts.cwd || process.cwd());
  let scope = null;
  if (opts.write) {
    if (opts.scope && String(opts.scope).trim()) {
      scope = (Array.isArray(opts.scope) ? opts.scope : String(opts.scope).split(","))
        .map((s) => normScope(cwd, String(s).trim()))
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
    id, provider: provName, pool, model, role, level, ...(downgrade ? { downgrade } : {}), reason, write: !!opts.write, cwd, task,
    scope,
    idleTimeoutMin,
    maxRuntimeMin,
    withJobs: withJobs.map((j) => j.id),
    ...(opts.rework ? { reworkOf: opts.rework.of, reworkRound: opts.rework.round } : {}),
    wrappedPrompt: buildDispatchPrompt({
      task, cwd, write: !!opts.write, role,
      shared: readSharedContext(STATE_DIR, cwd),
      attachments: withJobs.length ? attachJobs(withJobs) : null,
      diff: opts.diff ? gitDiff(cwd) : null,
      caps: capsOf(cfg, prov, model, { write: !!opts.write }),
    }),
    status: "running", startedAt: new Date().toISOString(), quotaAtStart: quotaText(cfg, provName, st),
  };

  // 真正落盘时才认领。写入范围冲突时任务不会创建，记录留给下一次。
  // 优先 cwd 与 CLAUDE_PROJECT_DIR（没有则用进程 cwd）相同的记录，没有就取 30 秒内最新一条。
  const persistNewJob = () => {
    // 认领不到（如返工命令没经过钩子）时沿用原任务的会话，工作量统计才归得到对应轮次
    const sessionId = claimPendingDispatch(process.env.CLAUDE_PROJECT_DIR || process.cwd()) || opts.sessionId || "";
    if (sessionId) job.sessionId = sessionId;
    saveJob(job);
    // 返工任务真正建好了，才给原任务记「退回返工」的结论；前面任何一步退回都不动原任务
    if (opts.rework?.verdict) setVerdict(opts.rework.of, opts.rework.verdict, opts.rework.note || "");
  };

  if (opts.write) {
    let conflict = null;
    withWriteLock(cwd, () => {
      const writers = runningWriters(cwd, Date.now(), maxRuntimeMin);
      conflict = writers.find((w) => scopesOverlap(w.scope, scope, cwd));
      if (!conflict) {
        persistNewJob();
      }
    });
    if (conflict) {
      const confScope = Array.isArray(conflict.scope) && conflict.scope.length ? conflict.scope.join(",") : (conflict.scope || ".");
      console.error(`与正在运行的可写任务 ${conflict.id}（${conflict.provider}，范围 ${confScope}）写入范围重叠：等它结束，或缩小写入范围后再派`);
      process.exit(6);
    }
  } else {
    persistNewJob();
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
  printJob(await executeJob(job));
}

// 返工：验收不通过时退回原员工接着改。沿用原任务的厂商、模型、角色、写入范围和目录，
// 派单 = 原派单 + 主管的修改意见，并附上它上一次交回的结果
async function cmdRework(opts) {
  const id = opts._[1];
  if (!id) throw new Error("用法：relay rework <任务 id|last> [--verdict partial|fail] [--background] -- <修改意见>");
  const orig = loadAnyJob(id);
  if (orig.status === "running") throw new Error(`任务 ${orig.id} 还在运行，等它结束、验收后再返工`);
  if (orig.verdict === "pass") throw new Error(`任务 ${orig.id} 已验收通过；确要返工，先用 relay verdict 改结论`);
  let feedback = opts.text || "";
  if (opts.promptFile) feedback = fs.readFileSync(opts.promptFile, "utf8");
  if (!feedback.trim()) feedback = readStdin();
  if (!feedback.trim()) throw new Error("没有修改意见：用 -- <意见>、--prompt-file 或标准输入传入，逐条写清哪里不合格、要改成什么");
  const prov = loadConfig().providers[orig.provider];
  if (!prov || prov.via !== "relay" || !orig.task) {
    throw new Error(`任务 ${orig.id}（${orig.provider}）不是 relay run 派出的，不能用 rework；Codex 任务请用 Agent 工具重新派给 codex:codex-rescue，prompt 里带上原派单、它上次的结果和修改意见`);
  }
  const verdict = orig.verdict || opts.verdict || "partial";
  if (!["partial", "fail"].includes(verdict)) throw new Error("--verdict 只能是 partial 或 fail");
  const level = parseLevel(opts.level) || orig.level || levelOfBrief(orig.task);
  if (!level) throw new Error(`原任务 ${orig.id} 没写难度，返工时用 --level 简单|中等|困难 指定`);
  const round = (orig.reworkRound || 0) + 1;
  const task = `${orig.task.trimEnd()}

## 返工意见（第 ${round} 次）
你上一次交付的结果（任务 ${orig.id}，附在后面的「前序结果」里）没有通过主管验收。在上一次的改动基础上继续修改：保留已经合格的部分，只按下面的意见改，不要从头重来。
${feedback.trim()}
`;
  return cmdRun({
    _: ["run", orig.provider],
    model: orig.model,
    role: orig.role,
    write: orig.write || undefined,
    scope: orig.write && Array.isArray(orig.scope) && orig.scope.length ? orig.scope : undefined,
    cwd: orig.cwd,
    with: orig.id,
    text: task,
    background: opts.background,
    idleTimeout: opts.idleTimeout || orig.idleTimeoutMin,
    maxRuntime: opts.maxRuntime || orig.maxRuntimeMin,
    force: opts.force,
    level,
    downgrade: opts.downgrade || orig.downgrade,
    sessionId: orig.sessionId,
    // 原任务没记结论的，等返工任务建好后记上：返工说明这一次没通过，计入这个员工的可靠度
    rework: { of: orig.id, round, verdict: orig.verdict ? null : verdict, note: `退回返工：${feedback.trim().split("\n")[0].slice(0, 80)}` },
  });
}

async function cmdWorker(opts) {
  const job = loadJob(opts._[1]);
  job.pid = process.pid;
  saveJob(job);
  await executeJob(job);
}

function cmdJobs(opts) {
  const jobs = allJobRecords(Number(opts.limit || 15));
  if (opts.json) {
    attachLiveUsage(jobs);
    return console.log(JSON.stringify(jobs, null, 2));
  }
  if (!jobs.length) return console.log("还没有外派记录");
  const st = { running: "进行中", done: "完成", failed: "失败", timeout: "超时", cancelled: "已取消" };
  for (const j of jobs) {
    const when = fmtTime(Date.parse(j.startedAt));
    const model = j.model && j.model !== "default" ? `/${j.model}` : "";
    const verdict = j.verdict ? { pass: "验收通过", partial: "部分通过", fail: "验收不通过" }[j.verdict] : "未验收";
    console.log(`${when}  ${(st[j.status] || j.status).padEnd(4)}  ${verdict}  ${j.provider}${model}  ${j.role || "-"}  ${j.write ? "可写" : "只读"}  ${String(j.task || "").replace(/\s+/g, " ").slice(0, 50)}`);
  }
}

// 近 N 天员工与主管的工作量：员工按可写外派的改动行数，主管按各轮亲手写的行数
function cmdStats(opts) {
  const days = opts.days === undefined ? 7 : Number(opts.days);
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days 要是正数");
  const jobs = allJobRecords();
  const rounds = [];
  const dir = path.join(STATE_DIR, "rounds");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
  for (const f of files) {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (Array.isArray(list)) rounds.push(...list);
    } catch {}
  }
  const s = workStats({ jobs, rounds, days });
  if (opts.json) return console.log(JSON.stringify(s, null, 2));
  const share = s.workerShare === null ? "" : `（占比 ${Math.round(s.workerShare * 100)}%）`;
  console.log(`近 ${days} 天：员工 ${s.workerLines} 行${share}，主管 ${s.selfLines} 行`);
  console.log(`改过代码的轮次 ${s.rounds.edited}，其中有可写外派的 ${s.rounds.withWriteDispatch}`);
  const byWorker = Object.entries(s.byWorker).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of byWorker) console.log(`  ${k}  ${n} 行`);
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
  const name = { claude: "Claude（插件读取当前会话）", codex: "Codex（官方 app-server 实时额度，失败时用本地会话记录）", agy: "Antigravity（agy /usage）", grok: "Grok（grok.com 计费接口，用 CLI 登录令牌）" };
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
  // 默认先完成先返回：有一个结束、且主管还没记结论，就交回去验收，不让它干等其他任务。--all 才等全部结束
  const fresh = () => jobs.filter((j) => j.status !== "running" && !j.verdict);
  const running = () => jobs.filter((j) => j.status === "running");
  const keepWaiting = () => running().length > 0 && (opts.all || fresh().length === 0);
  while (keepWaiting() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    jobs = jobs.map((j) => (j.status === "running" ? loadJob(j.id) : j));
  }
  if (opts.all) {
    for (let i = 0; i < jobs.length; i++) {
      if (i > 0) console.log("==========");
      const j = jobs[i];
      if (j.status === "running") console.log(`任务 ${j.id} 仍在运行`);
      else printJob(j);
    }
    return;
  }
  const done = fresh();
  done.forEach((j, i) => {
    if (i > 0) console.log("==========");
    printJob(j);
  });
  const lines = [];
  for (const j of jobs) {
    if (j.status !== "running" && j.verdict) lines.push(`任务 ${j.id} 已验收（${j.verdict}）`);
  }
  const rest = running();
  for (const j of rest) lines.push(`任务 ${j.id} 仍在运行`);
  if (lines.length) {
    if (done.length) console.log("==========");
    console.log(lines.join("\n"));
  }
  if (done.length && rest.length) {
    console.log(`\n先验收上面 ${done.length} 个：复核、记结论，不通过的用 relay rework <id> -- <修改意见> 退回原员工返工。`);
  }
  if (rest.length) {
    console.log(`还有 ${rest.length} 个在运行，验收完继续等：node "${RELAY_SCRIPT}" wait ${rest.map((j) => j.id).join(" ")}`);
  }
}

// 同步等待，供 cancel 这种短命命令使用
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 进程组（detached 启动的进程 pgid = pid）或单个进程是否还活着；无权限（EPERM）也算存在
function procAlive(pid) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch (e) {
      if (e.code === "EPERM") return true;
    }
  }
  return false;
}

// 向进程组发信号，进程组不存在时回退单进程；ESRCH 等错误忽略
function signalProc(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {
    try { process.kill(pid, sig); } catch {}
  }
}

// 先 SIGTERM，最多等 2 秒，仍活着再 SIGKILL
function terminateProc(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  signalProc(pid, "SIGTERM");
  const deadline = Date.now() + 2000;
  while (procAlive(pid) && Date.now() < deadline) sleepSync(50);
  if (procAlive(pid)) {
    signalProc(pid, "SIGKILL");
    const end = Date.now() + 1000;
    while (procAlive(pid) && Date.now() < end) sleepSync(50);
  }
}

function cmdCancel(opts) {
  const job = loadJob(opts._[1]);
  if (job.status !== "running") return console.log(`任务 ${job.id} 状态为 ${job.status}，无需取消`);
  // 先落盘 cancelled：前台模式下执行进程在员工 CLI 退出后会重读，看到 cancelled 就不覆盖
  job.status = "cancelled";
  saveJob(job);
  // 先杀 _worker 进程组，让它没机会在员工 CLI 退出后把状态写回成 failed/done；
  // 员工 CLI 在自己的进程组里，worker 死后不会跟着退出，再单独杀 childPid
  terminateProc(job.pid);
  if (job.childPid && job.childPid !== job.pid) terminateProc(job.childPid);
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

export function summarizeProvider(cfg, name, prov, secrets) {
  const bin = prov.cli?.bin || (prov.via === "codex-plugin" ? "codex" : prov.self ? "claude" : "");
  const item = {
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
    modelPools: buildModelPools(cfg, name, prov),
    roles: providerRoles(cfg, name),
    note: prov.note || "",
    // 最高权限开关：只有配了 cli.fullAccess 的员工能开关
    fullAccess: {
      supported: fullAccessSupported(prov),
      enabled: fullAccessOn(cfg, prov),
      note: prov.self ? "主模型的权限在输入框的模式菜单里设置" : prov.via === "codex-plugin" ? "由 Codex 插件固定为只能写当前项目的沙箱" : fullAccessSupported(prov) ? "" : "这家没有配置最高权限参数",
    },
    // 只报有没有密钥，不带出密钥原文，也不带出 endpoint.secret 这个名字里的值
    hasKey: hasProviderKey(prov, secrets),
    caps: capsOf(cfg, prov),
  };
  if (prov.billing) item.billing = prov.billing;
  if (prov.endpoint?.baseUrl) item.endpoint = { baseUrl: prov.endpoint.baseUrl };
  if (prov.modelCaps && typeof prov.modelCaps === "object") item.modelCaps = prov.modelCaps;
  else if (prov.endpoint) item.modelCaps = {};
  return item;
}

function cmdProviders(opts) {
  const cfg = loadConfig();
  const secrets = loadSecrets();
  const list = Object.entries(cfg.providers).map(([name, prov]) => summarizeProvider(cfg, name, prov, secrets));
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

const ENDPOINT_ROUTE_FIT = {
  implement: { mid: 0.75, light: 0.5 },
  review: { mid: 0.75, light: 0.5 },
  debug: { mid: 0.65 },
  deep: { mid: 0.65 },
  read: { light: 0.8, mid: 0.7 },
  quick: { light: 0.8 },
};
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function endpointModelTier(modelId) {
  // 自定义接口模型一律封顶中档：pro/-max 旗舰命名也不升强档，困难任务不派给它们（实测吃力）
  return /flash|lite/i.test(modelId) ? "light" : "mid";
}

function endpointModelsOf(spec, fallback) {
  const raw = spec.models === undefined ? fallback : spec.models;
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,，]+/);
  const models = [];
  for (const item of list) {
    const id = String(item ?? "").trim();
    if (!id || models.includes(id)) continue;
    if (!MODEL_ID_RE.test(id)) throw new Error(`模型 id 不合法：${id}`);
    models.push(id);
  }
  return models;
}

function buildEndpointEnv(preset, models) {
  const src = preset.env || {};
  const light = models.find((id) => endpointModelTier(id) === "light");
  const env = {
    ANTHROPIC_BASE_URL: src.ANTHROPIC_BASE_URL || "{baseUrl}",
    ANTHROPIC_API_KEY: src.ANTHROPIC_API_KEY || "{secret}",
  };
  if (light) env.ANTHROPIC_SMALL_FAST_MODEL = light;
  for (const [key, value] of Object.entries(src)) {
    if (key in env) continue;
    env[key] = value;
  }
  return env;
}

function pickEndpointDefault(models) {
  return models.find((id) => endpointModelTier(id) === "mid") || models[0] || null;
}

// 按白名单重写这一家的档位和路由。先清掉自己的旧条目再追加，重复添加不会叠出两份。
function rebuildEndpointRouting(cfg, name, models) {
  if (!cfg.modelTiers || typeof cfg.modelTiers !== "object" || Array.isArray(cfg.modelTiers)) cfg.modelTiers = {};
  for (const key of Object.keys(cfg.modelTiers)) {
    if (key.startsWith(`${name}:`)) delete cfg.modelTiers[key];
  }
  for (const id of models) cfg.modelTiers[`${name}:${id}`] = endpointModelTier(id);

  const lights = models.filter((id) => endpointModelTier(id) === "light");
  const mids = models.filter((id) => endpointModelTier(id) !== "light");
  for (const role of Object.keys(cfg.routes || {})) {
    cfg.routes[role] = (cfg.routes[role] || []).filter((entry) => !String(entry).startsWith(`${name}:`));
  }
  for (const [role, fit] of Object.entries(ENDPOINT_ROUTE_FIT)) {
    if (!Array.isArray(cfg.routes?.[role])) continue;
    const ordered = [];
    if (role === "read") {
      for (const id of lights) if (fit.light != null) ordered.push([id, fit.light]);
      for (const id of mids) if (fit.mid != null) ordered.push([id, fit.mid]);
    } else {
      for (const id of mids) if (fit.mid != null) ordered.push([id, fit.mid]);
      for (const id of lights) if (fit.light != null) ordered.push([id, fit.light]);
    }
    for (const [id, score] of ordered) cfg.routes[role].push(`${name}:${name}:${id}:${score}`);
  }
}

function syncEndpointSideFields(prov, pool, models) {
  const current = prov.defaultModels?.[pool];
  const next = current && models.includes(current) ? current : pickEndpointDefault(models);
  if (!prov.defaultModels) prov.defaultModels = {};
  if (next) prov.defaultModels[pool] = next;
  else delete prov.defaultModels[pool];
  if (prov.env && typeof prov.env === "object") {
    const light = models.find((id) => endpointModelTier(id) === "light");
    if (light) prov.env.ANTHROPIC_SMALL_FAST_MODEL = light;
    else delete prov.env.ANTHROPIC_SMALL_FAST_MODEL;
  }
}

function isEndpointPreset(name, preset) {
  return name === "endpoint" || preset?.kind === "endpoint";
}

function addEndpointProvider(cfg, spec, preset) {
  const name = String(spec.name || "").trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new Error("标识只能用小写字母、数字和短横线，以字母开头，2–24 个字符，例如 maas");
  if (cfg.providers[name]) throw new Error(`已存在名为 ${name} 的厂商，换个标识或先删除旧的`);
  if (!preset?.cli?.prompt?.includes("{prompt}")) throw new Error("自定义接口模板缺少 {prompt} 占位");
  const baseUrl = normalizeBaseUrl(spec.baseUrl);
  const models = endpointModelsOf(spec, []);
  if (!models.length) throw new Error("至少要填一个模型");
  const pool = name;
  const cli = structuredClone(preset.cli);
  cli.bin = preset.cli.bin || "claude";
  const known = preset?.knownModelCaps || {};
  const modelCaps = {};
  for (const m of models) {
    if (known[m]) {
      modelCaps[m] = structuredClone(known[m]);
    }
  }
  cfg.providers[name] = {
    label: String(spec.label || preset.label || name).trim() || name,
    via: "relay",
    billing: preset.billing || "metered",
    endpoint: { baseUrl, secret: name },
    quota: { provider: name, pools: [pool] },
    cli,
    env: buildEndpointEnv(preset, models),
    envUnset: Array.isArray(preset.envUnset) ? [...preset.envUnset] : ["ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"],
    pools: { [pool]: models },
    caps: structuredClone(preset.caps || { web: false, exec: false, vision: false }),
    modelCaps,
    modelList: structuredClone(preset.modelList || { format: "openai-http" }),
    ...(preset.note ? { note: preset.note } : {}),
  };
  syncEndpointSideFields(cfg.providers[name], pool, models);
  rebuildEndpointRouting(cfg, name, models);
  return cfg.providers[name];
}

// 新增厂商：spec 来自面板表单（JSON），或 --preset 加少量覆盖参数
function cmdProviderAdd(opts) {
  const presets = loadPresets();
  let spec = opts.jsonSpec ? JSON.parse(opts.jsonSpec) : {};
  const presetName = spec.preset || opts.preset || "custom";
  const preset = presets[presetName];
  if (!preset) throw new Error(`未知模板 ${presetName}，可选：${Object.keys(presets).join(", ")}`);
  if (isEndpointPreset(presetName, preset)) {
    const name = String(spec.name || opts._[2] || "").trim().toLowerCase();
    spec = { ...spec, name };
    const cfg = loadConfig();
    const prov = addEndpointProvider(cfg, spec, preset);
    saveConfig(cfg);
    const found = resolveBin(prov.cli.bin);
    console.log(`已添加 ${prov.label}（${name}）。按量计费，密钥还没写入配置。请运行 relay provider key ${name}`);
    if (!found) console.log(`⚠️ 本机还没找到 ${prov.cli.bin} 命令${preset.install ? `。${preset.install}` : ""}`);
    return;
  }
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
  if (cfg.modelTiers && typeof cfg.modelTiers === "object") {
    for (const key of Object.keys(cfg.modelTiers)) {
      if (key.startsWith(`${name}:`)) delete cfg.modelTiers[key];
    }
  }
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
  const firstPool = providerPools(prov)[0];
  const rawModel = Object.values(prov.pools || {}).flat()[0] || "default";
  const model = resolveModel(cfg, name, firstPool, rawModel);
  const started = Date.now();
  let result;
  try {
    const job = { provider: name, pool: firstPool, model, write: false, cwd, wrappedPrompt: "这是连通性测试：不要读写任何文件，不要执行命令，只回复两个字：在线" };
    const { env, secret } = resolveJobEnv(cfg, job, loadSecrets());
    const { bin, args } = buildCommand(cfg, job);
    const spawnOpts = { cwd, encoding: "utf8", timeout: Number(opts.timeout || 120) * 1000, stdio: ["ignore", "pipe", "pipe"] };
    if (env) spawnOpts.env = env;
    const res = spawnSync(bin, args, spawnOpts);
    const out = maskSecrets(maskSecretValue(`${res.stdout || ""}${res.stderr ? `\n${res.stderr}` : ""}`.trim(), secret));
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

function endpointPoolName(prov, name) {
  const pools = providerPools(prov);
  if (pools.length !== 1) throw new Error(`${name} 有多个额度池，不能用 provider models 改白名单`);
  return pools[0];
}

function assertEndpointProvider(prov, name) {
  if (prov?.modelList?.format === "openai-http" || prov?.endpoint) return;
  throw new Error(`${name} 不是自定义接口。默认模型用 provider model`);
}

// 查看或改自定义接口的模型白名单，并同步档位和路由
function cmdProviderModels(opts) {
  const name = opts._[2];
  if (!name) throw new Error("用法：provider models <厂商> [--add <模型id>] [--remove <模型id>]");
  const cfg = loadConfig();
  const prov = cfg.providers?.[name];
  if (!prov || prov.self) throw new Error(`未知厂商 ${name}`);
  assertEndpointProvider(prov, name);
  const pool = endpointPoolName(prov, name);
  if (!prov.pools) prov.pools = {};
  if (!Array.isArray(prov.pools[pool])) prov.pools[pool] = [];
  const adding = opts.add ? String(opts.add).trim() : "";
  const removing = opts.remove ? String(opts.remove).trim() : "";
  if (("add" in opts && !adding) || ("remove" in opts && !removing)) {
    throw new Error("用法：provider models <厂商> [--add <模型id>] [--remove <模型id>]");
  }
  if (!adding && !removing) {
    const models = prov.pools[pool].map((id) => ({ id, tier: endpointModelTier(id) }));
    if (opts.json) {
      console.log(JSON.stringify({ provider: name, models }, null, 2));
      return;
    }
    if (!models.length) return console.log(`${name} 还没有启用的模型`);
    for (const item of models) console.log(`${item.id}  ${item.tier === "light" ? "轻档" : "中档"}`);
    return;
  }
  const hadRemove = removing ? prov.pools[pool].includes(removing) : false;
  let models = prov.pools[pool].filter((id) => id && id !== removing);
  const presets = loadPresets();
  const known = presets?.endpoint?.knownModelCaps || {};
  if (adding) {
    if (!MODEL_ID_RE.test(adding)) throw new Error(`模型 id 不合法：${adding}`);
    if (!models.includes(adding)) models.push(adding);
    if (known[adding]) {
      if (!prov.modelCaps) prov.modelCaps = {};
      prov.modelCaps[adding] = structuredClone(known[adding]);
    }
  }
  if (removing) {
    if (prov.modelCaps && prov.modelCaps[removing]) {
      delete prov.modelCaps[removing];
    }
  }
  prov.pools[pool] = models;
  syncEndpointSideFields(prov, pool, models);
  rebuildEndpointRouting(cfg, name, models);
  saveConfig(cfg);
  if (adding) console.log(`${name} 已启用 ${adding}（${TIER_TEXT[endpointModelTier(adding)]}）`);
  if (removing) console.log(hadRemove ? `${name} 已移出 ${removing}` : `${name} 的白名单里没有 ${removing}`);
}

const KEY_FLAG_ALLOW = new Set(["_", "text", "clear", "stdin"]);

function assertNoKeyArgument(opts) {
  if (opts._.length > 3 || opts.text) {
    throw new Error("不能把密钥写在命令后面或参数里（会留在历史记录和进程列表里）。请运行 relay provider key <厂商>，在终端里输入，或加 --stdin 从标准输入读");
  }
  for (const key of Object.keys(opts)) {
    if (!KEY_FLAG_ALLOW.has(key)) {
      throw new Error("不能把密钥写在命令后面或参数里（会留在历史记录和进程列表里）。请运行 relay provider key <厂商>，在终端里输入，或加 --stdin 从标准输入读");
    }
  }
}

function readSecretInteractive(promptText) {
  return new Promise((resolve) => {
    process.stderr.write(promptText);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
    };
    const onData = (ch) => {
      if (ch === "\u0003") {
        cleanup();
        process.stderr.write("\n");
        process.exit(130);
      }
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        cleanup();
        process.stderr.write("\n");
        resolve(buf);
        return;
      }
      if (ch === "\u007f" || ch === "\b") {
        buf = Array.from(buf).slice(0, -1).join("");
        return;
      }
      if (ch.charCodeAt(0) < 32) return;
      buf += ch;
    };
    stdin.on("data", onData);
  });
}

function providerSecretName(prov, name) {
  return prov?.endpoint?.secret || name;
}

// 密钥只从终端或标准输入读。--clear 删除对应条目。
async function cmdProviderKey(opts) {
  const name = opts._[2];
  if (!name) throw new Error("用法：provider key <厂商> [--stdin] [--clear]");
  assertNoKeyArgument(opts);
  const cfg = loadConfig();
  const prov = cfg.providers?.[name];
  if (!prov || prov.self) throw new Error(`未知厂商 ${name}`);
  assertEndpointProvider(prov, name);
  const secretName = providerSecretName(prov, name);
  const secrets = loadSecrets();
  if (opts.clear) {
    if (Object.prototype.hasOwnProperty.call(secrets, secretName)) {
      delete secrets[secretName];
      if (Object.keys(secrets).length === 0) {
        try { fs.unlinkSync(secretsPath()); } catch {}
      } else {
        saveSecrets(secrets);
      }
      console.log(`已删除 ${name} 的密钥`);
    } else {
      console.log(`${name} 本来就没有密钥`);
    }
    return;
  }
  let secretText = "";
  if (opts.stdin) {
    secretText = readStdin().replace(/\r?\n$/, "");
    if (secretText.includes("\n") || secretText.includes("\r")) throw new Error("密钥里不能有换行");
  } else if (process.stdin.isTTY) {
    secretText = await readSecretInteractive(`请输入 ${name} 的密钥（不会回显）：`);
  } else {
    throw new Error("请在终端里运行 relay provider key <厂商>，或加 --stdin 从标准输入传入密钥");
  }
  secretText = secretText.trim();
  if (!secretText) throw new Error("没有读到密钥");
  secrets[secretName] = secretText;
  saveSecrets(secrets);
  console.log(`已保存 ${name} 的密钥`);
}

// 设置某厂商某额度池的默认模型
async function cmdProviderModel(opts) {
  const [, , name, pool, modelId] = opts._;
  const cfg = loadConfig();
  let modelsCache = loadModelsCache(STATE_DIR);
  const prov = cfg.providers?.[name];
  const inCfgPool = (prov?.pools?.[pool] || []).filter((m) => m !== "default").includes(modelId);
  if (prov && modelId && modelId !== "default" && !inCfgPool && !modelsCache?.providers?.[name]?.models?.length) {
    modelsCache = await getModels(cfg, { stateDir: STATE_DIR });
  }
  setProviderDefaultModel(cfg, name, pool, modelId, modelsCache);
  saveConfig(cfg);
  console.log(`${name} 默认模型 → ${modelId === "default" ? "跟随 CLI 默认" : modelId}（下一单起生效）`);
}

// 拉取或查看各厂商官方 CLI 的可用模型清单
function withEnabledMarks(cfg, cache) {
  const out = structuredClone(cache);
  for (const [name, entry] of Object.entries(out?.providers || {})) {
    const prov = cfg.providers?.[name];
    if (prov?.modelList?.format !== "openai-http" || !Array.isArray(entry?.models)) continue;
    const allow = new Set(Object.values(prov.pools || {}).flat());
    entry.models = entry.models.map((m) => ({ ...m, enabled: allow.has(m.id) }));
  }
  return out;
}

async function cmdModels(opts) {
  if (opts._[1] === "discover") return await cmdModelsDiscover(opts);
  const cfg = loadConfig();
  const cache = await getModels(cfg, { stateDir: STATE_DIR, refresh: !!opts.refresh });
  if (opts.json) return console.log(JSON.stringify(withEnabledMarks(cfg, cache), null, 2));
  console.log(`模型清单（更新于 ${cache.updatedAt || "从未"}）：`);
  for (const [name, p] of Object.entries(cache.providers || {})) {
    const prov = cfg.providers?.[name];
    const http = prov?.modelList?.format === "openai-http";
    const allow = http ? new Set(Object.values(prov?.pools || {}).flat()) : null;
    console.log(`\n${prov?.label || name} [${name}]：${p.ok ? `${p.models.length} 个模型` : `失败 — ${p.error}`}（CLI 默认：${p.cliDefault || "无"}）`);
    for (const m of p.models || []) {
      const def = m.pool && resolveModel(cfg, name, m.pool, "default") === m.id ? " ★默认" : "";
      const enabledText = allow ? (allow.has(m.id) ? " 已启用" : " 未启用") : "";
      console.log(`  - ${m.id}${m.label && m.label !== m.id ? ` (${m.label})` : ""}  [${m.pool || "未归池"}]${def}${enabledText}`);
    }
  }
}

// 回填历史外派任务的 token 用量
function cmdUsage(opts) {
  if (!opts.backfill) throw new Error("用法：relay usage --backfill [--redo] [--json]");
  const res = backfill({ redo: !!opts.redo });
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log(`回填完成：补上 ${res.filled} 条，匹配不到 ${res.unmatched} 条${res.skipped ? `（已有 usage 跳过 ${res.skipped} 条）` : ""}`);
  for (const item of res.items) {
    const u = item.usage;
    console.log(`  ${item.id} (${item.provider}) → input=${u.input}, output=${u.output}, cacheRead=${u.cacheRead}, total=${u.total}, source=${u.source}`);
  }
}

function cmdProviderCaps(opts) {
  const [, , name, modelId, capName, val] = opts._;
  if (!name || !modelId || !capName || !val) {
    throw new Error("用法：provider caps <厂商> <模型id> vision on|off");
  }
  if (capName !== "vision") {
    throw new Error(`暂不支持设置能力 ${capName}，目前仅支持 vision`);
  }
  const on = val === "on" ? true : val === "off" ? false : null;
  if (on === null) {
    throw new Error(`值必须是 on 或 off，收到：${val}`);
  }
  const cfg = loadConfig();
  const prov = cfg.providers?.[name];
  if (!prov) throw new Error(`未知厂商 ${name}`);
  if (!prov.modelCaps) prov.modelCaps = {};
  if (!prov.modelCaps[modelId]) prov.modelCaps[modelId] = {};
  prov.modelCaps[modelId][capName] = on;
  saveConfig(cfg);
  console.log(`已将 ${name} 的模型 ${modelId} 的 ${capName} 设置为 ${val}`);
}

// 给多额度池厂商的未归池模型指定额度池：在 poolRules 最前面加一条只匹配这个模型的规则
function cmdProviderPoolRule(opts) {
  const [, , name, modelId, pool] = opts._;
  if (!name || !modelId || !pool) throw new Error("用法：provider pool-rule <厂商> <模型id> <额度池>");
  if (!MODEL_ID_RE.test(modelId)) throw new Error(`模型 id 不合法：${modelId}`);
  const cfg = loadConfig();
  const prov = cfg.providers?.[name];
  if (!prov) throw new Error(`未知厂商 ${name}`);
  const pools = providerPools(prov);
  if (pools.length < 2) throw new Error(`${name} 只有一个额度池，模型都归它，不需要指定`);
  if (!pools.includes(pool)) throw new Error(`${name} 没有额度池 ${pool}，可选：${pools.join("、")}`);
  // 模型 id 只含字母数字和 ._-，转义点号就能精确匹配
  const pattern = `^${modelId.replace(/\./g, "\\.")}$`;
  const rules = (Array.isArray(prov.poolRules) ? prov.poolRules : []).filter((r) => !(Array.isArray(r) && r[0] === pattern));
  prov.poolRules = [[pattern, pool], ...rules];
  saveConfig(cfg);
  console.log(`${name} 的模型 ${modelId} 已归入额度池 ${pool}`);
}

async function cmdProvider(opts) {
  const sub = opts._[1];
  switch (sub) {
    case "enable": return setEnabled(opts._[2], true);
    case "disable": return setEnabled(opts._[2], false);
    case "add": return cmdProviderAdd(opts);
    case "remove": return cmdProviderRemove(opts);
    case "test": return cmdProviderTest(opts);
    case "access": return setFullAccess(opts._[2], opts._[3]);
    case "caps": return cmdProviderCaps(opts);
    case "pool-rule": return cmdProviderPoolRule(opts);
    case "model": return await cmdProviderModel(opts);
    case "models": return cmdProviderModels(opts);
    case "key": return await cmdProviderKey(opts);
    default: throw new Error("用法：provider enable|disable|remove|test <名称>，provider access <名称> on|off，provider caps <名称> <模型id> vision on|off，provider model <名称> <额度池> <模型id|default>，provider models <名称> [--add 模型] [--remove 模型]，provider key <名称> [--stdin] [--clear]，或 provider add --json-spec '<JSON>' / provider add <名称> --preset kimi|endpoint");
  }
}

// 钩子看到 stdout 里的 [relay-self] 行，才把原因写进当前会话。这里只负责打印。
function cmdSelf(opts) {
  const raw = opts.text != null ? String(opts.text) : opts._.slice(1).join(" ");
  let reason = raw.replace(/[\r\n]+/g, " ").replace(/[ \t]+/g, " ").trim();
  if (!reason) throw new Error("用法：relay self <原因>");
  const chars = Array.from(reason);
  if (chars.length > 200) reason = chars.slice(0, 200).join("");
  console.log(`[relay-self] ${reason}`);
  console.log("已记录，本轮可以继续自己改");
}

function help() {
  console.log(`用法：node relay.mjs <命令>
  status [--json]                 查看模式、各家额度、各类任务首选
  mode [off|manual|auto]          查看或切换模式（off 会同时禁用 Codex 插件）
  pick <角色> --level 简单|中等|困难 [--write --target 目录] [--needs web,exec] [--downgrade 原因] [--steps]
                                  按难度和打分挑选模型并给出理由：简单优先便宜、额度多的轻档，中等要中档以上，困难只派强档
                                  要写的目录在当前项目外时传 --target，写不到的厂商（如 Codex）会被跳过
                                  --needs 只在具备这些能力的厂商里选（web 联网，exec 执行命令，逗号分隔）
                                  --steps 预览"派单带合格的「## 步骤」规格"时的候选：中等任务的档位门槛降一档，轻档可接（其他难度无效）
  models [--refresh] [--json]     拉取或查看各厂商官方 CLI 的可用模型清单（缓存 6 小时，过期自动重新拉取）
  models discover [--force] [--background] [--json]
                                  探测各厂商新模型，自动归池、联网调研能力并增量写入配置（默认 6 小时节流）
  models discover --list [--json] | --undo <记录id>
                                  查看自动接入记录，或精确撤销指定记录对配置做的改动
  providers [--json]              列出厂商：启用状态、命令是否已安装、参与哪些角色、额度池默认模型
  provider enable|disable <名称>   启用 / 停用某厂商（停用后路由与外派都跳过它）
  provider model <名称> <额度池> <模型id|default>   设置某额度池的默认模型（单池厂商写 default 恢复跟随 CLI 默认）
  provider models <名称> [--add 模型id] [--remove 模型id]
                                  查看或修改自定义接口的模型白名单，并同步档位和路由
  provider caps <名称> <模型id> vision on|off
                                  设置某模型的看图能力
  provider pool-rule <名称> <模型id> <额度池>
                                  把多额度池厂商里没归池的模型指定到某个额度池
  stats [--days N] [--json]       近 N 天（默认 7）员工与主管的工作量：改动行数、有外派的轮次
  provider key <名称> [--stdin] [--clear]
                                  设置或删除自定义接口的密钥。只从终端（不回显）或 --stdin 读取，不能写在命令参数里
  provider add <名称> --preset kimi|qwen|custom|endpoint   新增厂商（面板里用 --json-spec；endpoint 需要 baseUrl 和 models）
  provider remove <名称>           删除厂商并移出所有路由和档位（配置先备份为 .bak）
  provider test <名称>             只读试运行一句话，确认命令可用
  run <厂商名|auto> --role r [--model m] [--write] [--scope 路径1,路径2] [--background] [--cwd 目录] [--with id1,id2] [--diff] [--force] [--needs web,exec] [--idle-timeout 分钟] [--max-runtime 分钟] [--level 难度] [--downgrade 原因] [-- 派单]
                                  调用官方 CLI 执行任务；派单走标准输入或 --prompt-file，必须含「目标」「验收标准」和「难度：简单|中等|困难」（或 --level）
                                  档位不够难度的模型会被退回；确认降一档也能做好时加 --downgrade "<原因>"
                                  自动附上项目上下文和共享背景；--with 附前序结果，--diff 附当前改动
                                  auto 的首选是 Codex 时会停下，提示用 Agent 工具交给 Codex；加 --skip-codex 才改派第二名
                                  可写任务按写入范围并行，范围重叠会被拒绝
                                  --needs 指定所需能力（web 联网，exec 执行命令）；省略时从派单「需要的能力」读取。点名厂商若缺少能力会拒绝
                                  --idle-timeout 覆盖无活动超时（默认 20 分钟）；--max-runtime 覆盖总运行时长上限（默认 240 分钟）
  brief [--context --cwd 目录]     派单模板；--context 预览会自动附上的项目上下文和共享背景
  context set|show|clear [--cwd 目录]   本次任务的共享背景（同目录 6 小时内的派单自动附上）
  verdict <id|last> pass|partial|fail [-- 说明]   记录验收结论，影响以后的可靠度打分
  rework <id|last> [--verdict partial|fail] [--level 难度] [--background] [-- 修改意见]
                                  验收不通过时退回原员工返工：沿用原厂商、模型、角色、写入范围和目录，附上原派单、上次结果和修改意见
                                  原任务没记结论时自动记为 partial（或 --verdict 指定）
  self <原因>                     记下这一轮为什么自己改项目代码（自动模式第一次改代码前必须先定分工）
  clean [--json]                  清理过期的历史数据并显示磁盘占用（平时每天自动清理一次）
  quota [--force] [--json]        刷新自带额度（Claude 由状态插件提供，Codex 读本地记录，agy 跑 /usage）
  usage --backfill [--redo] [--json]   从本机 CLI 会话日志回填历史外派任务（agy / Grok）的 token 用量
  jobs [--json] [--limit n]       外派记录（含 Codex 子代理）
  wait <id…> [--all] [--timeout 秒]   多个任务时有一个结束就返回，先验收它；--all 等全部结束
  result <id|last> | cancel <id>`);
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
      case "models": return await cmdModels(opts);
      case "brief": return cmdBrief(opts);
      case "context": return cmdContext(opts);
      case "verdict": return cmdVerdict(opts);
      case "clean": return cmdClean(opts);
      case "stats": return cmdStats(opts);
      case "providers": return cmdProviders(opts);
      case "provider": return await cmdProvider(opts);
      case "run": return await cmdRun(opts);
      case "rework": return await cmdRework(opts);
      case "_worker": return await cmdWorker(opts);
      case "_autoreview": return cmdAutoReview(opts);
      case "jobs": return cmdJobs(opts);
      case "quota": return await cmdQuota(opts);
      case "usage": return cmdUsage(opts);
      case "wait": return await cmdWait(opts);
      case "result": return printJob(loadAnyJob(opts._[1] || "last"));
      case "cancel": return cmdCancel(opts);
      case "self": return cmdSelf(opts);
      default: return help();
    }
  } catch (e) {
    console.error(`ai-relay 错误：${e.message}`);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) || path.basename(process.argv[1]) === "relay.mjs");
if (isDirectRun) {
  main();
}
