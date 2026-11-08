// ai-relay 公共库：配置、模式、额度读取、路由选择
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cachedRows } from "./quota.mjs";

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RELAY_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "relay.mjs");
export const STATE_DIR = process.env.AI_RELAY_HOME || path.join(os.homedir(), ".claude", "ai-relay");
export const JOBS_DIR = path.join(STATE_DIR, "jobs");
export const MODES = ["off", "manual", "auto"];

const expandHome = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

export function ensureStateDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(path.join(STATE_DIR, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(STATE_DIR, "locks"), { recursive: true });
}

// Bash 的 PreToolUse 只把当前会话落到这里，不改命令。
// relay 建任务时认领：自动模式下只回 updatedInput 可能被拒绝，所以不能靠改写命令传递会话。
export const PENDING_DISPATCH_DIR = path.join(STATE_DIR, "pending-dispatch");
const PENDING_CLAIM_MS = 30_000;
const PENDING_KEEP_MS = 5 * 60_000;

// 写一条待认领记录。sessionId 为空则不写。返回记录路径。
export function writePendingDispatch({ sessionId, cwd, at = Date.now() } = {}) {
  const id = String(sessionId ?? "").trim();
  if (!id) return null;
  fs.mkdirSync(PENDING_DISPATCH_DIR, { recursive: true });
  const body = JSON.stringify({ sessionId: id, cwd: typeof cwd === "string" ? cwd : "", at });
  for (let i = 0; i < 5; i++) {
    const name = `${at}-${crypto.randomBytes(4).toString("hex")}.json`;
    const file = path.join(PENDING_DISPATCH_DIR, name);
    const tmp = path.join(PENDING_DISPATCH_DIR, `.${name}.tmp`);
    try {
      fs.writeFileSync(tmp, body, { flag: "wx" });
      fs.renameSync(tmp, file);
      return file;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new Error("写待认领记录失败");
}

// 认领 30 秒内的一条记录：cwd 与 matchCwd 相同的优先，否则取最新。
// 认领后立刻删除，避免被下一个任务再用。超过 5 分钟的顺手删掉。
// 没有可认领的记录时返回空串。
export function claimPendingDispatch(matchCwd, now = Date.now()) {
  if (!fs.existsSync(PENDING_DISPATCH_DIR)) return "";
  const target = String(matchCwd ?? "");
  const fresh = [];
  for (const name of fs.readdirSync(PENDING_DISPATCH_DIR)) {
    const full = path.join(PENDING_DISPATCH_DIR, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!name.endsWith(".json")) {
      if (now - st.mtimeMs > PENDING_KEEP_MS) {
        try { fs.unlinkSync(full); } catch {}
      }
      continue;
    }
    let rec = null;
    try {
      rec = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {}
    const at = Number(rec?.at);
    if (!rec || !Number.isFinite(at) || now - at > PENDING_KEEP_MS) {
      try { fs.unlinkSync(full); } catch {}
      continue;
    }
    if (now - at <= PENDING_CLAIM_MS) fresh.push({ full, rec, at });
  }
  const matched = fresh.filter((item) => String(item.rec.cwd ?? "") === target);
  const pool = (matched.length ? matched : fresh).slice().sort((a, b) => b.at - a.at || (a.full < b.full ? 1 : -1));
  for (const item of pool) {
    const holding = `${item.full}.${process.pid}.claiming`;
    try {
      fs.renameSync(item.full, holding);
    } catch {
      continue;
    }
    let sessionId = "";
    try {
      sessionId = String(JSON.parse(fs.readFileSync(holding, "utf8")).sessionId ?? "").trim();
    } catch {}
    try { fs.unlinkSync(holding); } catch {}
    if (sessionId) return sessionId;
  }
  return "";
}

// 用户配置放在 ~/.claude/ai-relay/providers.json，首次运行从插件默认配置复制，插件升级不会覆盖
export function loadConfig() {
  ensureStateDir();
  const userFile = path.join(STATE_DIR, "providers.json");
  if (!fs.existsSync(userFile)) {
    fs.copyFileSync(path.join(PLUGIN_ROOT, "config", "providers.default.json"), userFile);
  }
  const cfg = JSON.parse(fs.readFileSync(userFile, "utf8"));
  if (migrateModelFields(cfg)) {
    // 升级写回前留一份 .bak，写失败不影响本次使用
    try {
      fs.copyFileSync(userFile, `${userFile}.bak`);
      fs.writeFileSync(userFile, JSON.stringify(cfg, null, 2) + "\n");
    } catch {}
  }
  // 超时配置：idleTimeoutMin 默认 20 分钟；maxRuntimeMin 默认 240 分钟。
  // 旧配置 jobTimeoutMinutes 是"总时长 30 分钟一刀切"，正是新规则要取代的，不再沿用其值
  if (cfg.idleTimeoutMin === undefined) {
    cfg.idleTimeoutMin = 20;
  }
  if (cfg.maxRuntimeMin === undefined) {
    cfg.maxRuntimeMin = 240;
  }
  cfg.jobTimeoutMinutes = cfg.maxRuntimeMin;
  cfg._file = userFile;
  return cfg;
}

// 旧配置升级（默认模型功能之前复制的用户配置不含这些字段）：
// 内置厂商缺少的模型清单字段从默认配置补齐；某厂商本次刚补上 defaultModels 时，
// 把路由里与池默认模型相同的条目改写成 default（解析结果不变，之后才会跟随用户选的默认模型）。
// 只在补字段的那一次改写路由，避免以后改了默认模型又把单独指定的条目吞掉
export function migrateModelFields(cfg, def) {
  if (!def) {
    try {
      def = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "config", "providers.default.json"), "utf8"));
    } catch {
      return false;
    }
  }
  let changed = false;
  const freshDefaults = new Set();
  for (const [name, dp] of Object.entries(def.providers || {})) {
    const p = cfg.providers?.[name];
    if (!p) continue;
    for (const key of ["modelList", "poolRules", "poolLabels", "defaultModels"]) {
      if (dp[key] === undefined || p[key] !== undefined) continue;
      p[key] = structuredClone(dp[key]);
      changed = true;
      if (key === "defaultModels") freshDefaults.add(name);
    }
  }
  for (const [role, route] of Object.entries(cfg.routes || {})) {
    if (!Array.isArray(route)) continue;
    cfg.routes[role] = route.map((entry) => {
      const parts = entry.split(":");
      const [prov, pool, model] = parts;
      if (!freshDefaults.has(prov) || model === "default") return entry;
      if (cfg.providers[prov].defaultModels?.[pool] !== model) return entry;
      parts[2] = "default";
      changed = true;
      return parts.join(":");
    });
  }
  return changed;
}

export function getMode() {
  try {
    const m = fs.readFileSync(path.join(STATE_DIR, "mode"), "utf8").trim();
    return MODES.includes(m) ? m : "manual";
  } catch {
    return "manual";
  }
}

export function setMode(mode) {
  ensureStateDir();
  fs.writeFileSync(path.join(STATE_DIR, "mode"), mode + "\n");
}

// 额度来源：先用 ai-relay 自己获取的缓存（quota.mjs），缺的再从 AIQuota5h 的本地库补（目前只有 Grok 需要）
// 两边都没有数据时返回 null
export function readQuotaRows(cfg) {
  const own = cachedRows(STATE_DIR).map((r) => ({ ...r, src: "自带" }));
  // 按窗口合并：自带数据缺的窗口（例如 Claude Code 没报给插件的 5h 窗口）才用 AIQuota5h 补
  const have = new Set(own.map((r) => `${r.provider}|${r.pool_id}|${r.window_key}`));
  const aiq = (readAiQuotaRows(cfg) || [])
    .filter((r) => !have.has(`${r.provider}|${r.pool_id}|${r.window_key}`))
    .map((r) => ({ ...r, src: "AIQuota5h" }));
  const rows = [...own, ...aiq];
  return rows.length ? rows : null;
}

// 每个额度池的数据来自哪里，供状态展示：自带、AIQuota5h、自带+AIQuota5h、无
export function quotaSource(cfg, provider, pool) {
  const srcs = new Set((readQuotaRows(cfg) || []).filter((r) => r.provider === provider && r.pool_id === pool).map((r) => r.src));
  if (!srcs.size) return "无";
  return ["自带", "AIQuota5h"].filter((s) => srcs.has(s)).join("+");
}

// AIQuota5h 的本地库（可选）：只读查询；库不存在或查询失败时返回 null
let aiqMemo;
function readAiQuotaRows(cfg) {
  if (aiqMemo !== undefined) return aiqMemo;
  const db = expandHome(cfg.quotaDb);
  if (!db || !fs.existsSync(db)) return (aiqMemo = null);
  const sql =
    "select provider, pool_id, window_key, remaining_fraction, reset_at, allowance, updated_at from windows";
  try {
    const out = execFileSync("sqlite3", ["-readonly", "-json", `file:${db}?mode=ro`, sql], {
      encoding: "utf8",
      timeout: 5000,
    });
    return (aiqMemo = out.trim() ? JSON.parse(out) : []);
  } catch {
    return (aiqMemo = null);
  }
}

// 计算某个额度池的状态：level = ok | low | blocked | unknown
export function poolStatus(cfg, rows, quotaProvider, pool, now = Date.now()) {
  const wins = (rows || []).filter((r) => r.provider === quotaProvider && r.pool_id === pool);
  if (!wins.length) return { provider: quotaProvider, pool, level: "unknown", windows: [], remaining: null };
  const staleMs = (cfg.staleMinutes || 15) * 60_000;
  const windows = wins.map((w) => {
    const resetPassed = w.reset_at && w.reset_at <= now;
    let remaining = typeof w.remaining_fraction === "number" ? w.remaining_fraction : null;
    if (w.allowance === "exhausted" && !resetPassed) remaining = 0;
    // 已过重置点但面板还没刷新，按已重置处理
    if (resetPassed) remaining = 1;
    return { key: w.window_key, remaining, resetAt: w.reset_at || null, resetPassed, stale: now - w.updated_at > staleMs, source: w.src || null };
  });
  const known = windows.filter((w) => w.remaining !== null);
  const remaining = known.length ? Math.min(...known.map((w) => w.remaining)) : null;
  let level = "unknown";
  if (remaining !== null) {
    level = remaining < cfg.minRemaining ? "blocked" : remaining < cfg.lowRemaining ? "low" : "ok";
  }
  const limiting = known.find((w) => w.remaining === remaining);
  return {
    provider: quotaProvider,
    pool,
    level,
    remaining,
    windows,
    stale: windows.some((w) => w.stale),
    limitingResetAt: limiting ? limiting.resetAt : null,
  };
}

// 厂商是否启用：没写 enabled 视为启用；主控 Claude 永远启用
export function isEnabled(prov) {
  return !!prov && (prov.self || prov.enabled !== false);
}

export function providerPools(prov) {
  if (prov.quota?.pools) return prov.quota.pools;
  return Object.keys(prov.pools || {});
}

// Claude 自身额度分档，供自动模式节流：
//   0 正常或额度未知；1 低于 claudeThrottleBelow（默认 0.5）；2 低于 claudeConserveBelow（默认 0.2）
// remaining 是主模型各额度池、各窗口剩余比例的最小值
// 1 档且有员工的某个额度池剩余 ≥ 0.5 时，附上这些员工的显示名 richHelpers
export function claudeThrottle(cfg, rows) {
  const self = Object.values(cfg.providers || {}).find((p) => p && p.self);
  let remaining = null;
  if (self?.quota) {
    const known = providerPools(self)
      .map((pool) => poolStatus(cfg, rows, self.quota.provider, pool).remaining)
      .filter((r) => r !== null);
    if (known.length) remaining = Math.min(...known);
  }
  const conserveBelow = cfg.claudeConserveBelow ?? 0.2;
  const throttleBelow = cfg.claudeThrottleBelow ?? 0.5;
  let level = 0;
  if (remaining !== null) {
    if (remaining < conserveBelow) level = 2;
    else if (remaining < throttleBelow) level = 1;
  }
  const out = { level, remaining };
  if (level !== 1) return out;
  const richHelpers = [];
  for (const [name, prov] of Object.entries(cfg.providers || {})) {
    if (!prov || prov.self || !isEnabled(prov) || !prov.quota) continue;
    const rich = providerPools(prov).some((pool) => {
      const r = poolStatus(cfg, rows, prov.quota.provider, pool).remaining;
      return r !== null && r >= 0.5;
    });
    if (rich) richHelpers.push(prov.label || name);
  }
  if (richHelpers.length) out.richHelpers = richHelpers;
  return out;
}

// 某模型属于哪个额度池
export function poolOfModel(prov, model) {
  for (const [pool, models] of Object.entries(prov.pools || {})) {
    if (models.includes(model)) return pool;
  }
  return null;
}

// 解析实际模型：model 为 default 且 defaultModels[pool] 有值时返回该值，否则原样返回
export function resolveModel(cfg, provName, pool, model) {
  if (model === "default") {
    const def = cfg?.providers?.[provName]?.defaultModels?.[pool];
    if (def) return def;
  }
  return model;
}

// 按路由表挑选：额度充足的按顺序优先，其次额度未知，再次额度偏低；耗尽的剔除
export function pickRoute(cfg, rows, role, { only } = {}) {
  const route = cfg.routes?.[role];
  if (!route) throw new Error(`未知角色 ${role}，可选：${Object.keys(cfg.routes || {}).join(", ")}`);
  const tiers = { ok: [], unknown: [], low: [] };
  const skipped = [];
  for (const entry of route) {
    const [provName, pool, model] = entry.split(":");
    if (only && provName !== only) continue;
    const prov = cfg.providers[provName];
    // 已停用的厂商不参与路由
    if (!isEnabled(prov)) continue;
    const st = poolStatus(cfg, rows, prov.quota.provider, pool);
    const cand = { provider: provName, pool, model, via: prov.via, status: st };
    if (st.level === "blocked") skipped.push(cand);
    else tiers[st.level].push(cand);
  }
  const ordered = [...tiers.ok, ...tiers.unknown, ...tiers.low];
  return { role, choice: ordered[0] || null, alternatives: ordered.slice(1), skipped };
}

export function fmtPct(x) {
  return x === null || x === undefined ? "?" : `${Math.round(x * 100)}%`;
}

export function fmtTime(ms) {
  if (!ms) return "?";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const WINDOW_LABEL = { "5h": "5h", weekly: "周" };

export function fmtPool(st) {
  if (st.level === "unknown") return "额度未知";
  // 窗口固定顺序：5h 在前、周在后
  const order = (k) => (k === "5h" ? 0 : k === "weekly" ? 1 : 2);
  const parts = [...st.windows]
    .sort((a, b) => order(a.key) - order(b.key))
    .map((w) => `${WINDOW_LABEL[w.key] || w.key} ${fmtPct(w.remaining)}`)
    .join(" · ");
  const flag = st.level === "blocked" ? ` 耗尽/过低(${fmtTime(st.limitingResetAt)} 重置)` : st.level === "low" ? " 偏低" : "";
  return parts + flag + (st.stale ? " [数据过期]" : "");
}

// 额度摘要，每个额度池一行，供钩子注入上下文
// 剩得多、而且快重置的窗口：不用就作废，提示优先用
const WINDOW_HOURS = { "5h": 5, weekly: 168 };
export function expiringHint(st, now = Date.now()) {
  if (st.level === "blocked" || st.level === "unknown") return "";
  const hits = (st.windows || []).filter((w) => {
    if (w.remaining === null || w.remaining < 0.5 || !w.resetAt || w.resetPassed) return false;
    const total = WINDOW_HOURS[w.key] || 24;
    return (w.resetAt - now) / 3600_000 < total / 3;
  });
  if (!hits.length) return "";
  hits.sort((a, b) => a.resetAt - b.resetAt);
  const w = hits[0];
  const h = ((w.resetAt - now) / 3600_000).toFixed(1);
  return `（${WINDOW_LABEL[w.key] || w.key} 还剩 ${fmtPct(w.remaining)}，${h} 小时后重置，优先用掉）`;
}

export function compactStatus(cfg, rows) {
  if (!rows) return "额度数据暂缺（打开 ai-relay 面板或运行 relay quota 刷新）";
  const parts = [];
  for (const [name, prov] of Object.entries(cfg.providers)) {
    if (!isEnabled(prov)) {
      parts.push(`  - ${name}：已停用（不要派给它）`);
      continue;
    }
    for (const pool of providerPools(prov)) {
      const st = poolStatus(cfg, rows, prov.quota.provider, pool);
      const label = providerPools(prov).length > 1 ? `${name}/${pool}` : name;
      parts.push(`  - ${label}：${fmtPool(st)}${expiringHint(st)}`);
    }
  }
  return parts.join("\n");
}

// 查找 CLI 可执行文件：配置里的绝对路径 > PATH > 常见安装目录
export function resolveBin(bin) {
  if (path.isAbsolute(bin)) return fs.existsSync(bin) ? bin : null;
  const dirs = [
    ...(process.env.PATH || "").split(":"),
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const d of dirs) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// 记录每个会话最近一条用户输入，供 PreToolUse 钩子判断用户是否点名
export function savePrompt(sessionId, prompt) {
  if (!sessionId) return;
  ensureStateDir();
  fs.writeFileSync(path.join(STATE_DIR, "prompts", `${sessionId}.txt`), String(prompt || "").slice(0, 4000));
  // 每条新消息重新统计主模型亲手改动的行数、读文件次数，以及这一轮的分工决定。
  // repos 用 null 表示还没扫过仓库；空数组表示扫过但没有，避免和「未扫描」混在一起。
  fs.writeFileSync(selfEditFile(sessionId), JSON.stringify({
    lines: 0,
    warned: false,
    reads: 0,
    readWarned: false,
    decision: null,
    selfReason: "",
    bashPending: false,
    repos: null,
  }));
  // 每天自动清理一次历史数据
  cleanupIfDue();
}

// ---------- 历史数据清理：所有数据都在 STATE_DIR（~/.claude/ai-relay），按保留天数删除 ----------
export const RETENTION_DAYS = { prompts: 7, jobs: 30, rounds: 14, context: 7, history: 30 };
const CLEAN_STAMP = () => path.join(STATE_DIR, ".last-clean");

// 距上次清理超过一天才清理，避免每条消息都扫目录
export function cleanupIfDue(now = Date.now()) {
  try {
    const last = Number(fs.readFileSync(CLEAN_STAMP(), "utf8")) || 0;
    if (now - last < 86_400_000) return null;
  } catch {}
  return cleanup(now);
}

// 清理过期数据，返回删掉的文件数；清理本身出错不影响正常使用
export function cleanup(now = Date.now()) {
  let removed = 0;
  const prune = (dir, days) => {
    if (!fs.existsSync(dir)) return;
    const cutoff = now - days * 86_400_000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= cutoff) continue;
        if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.unlinkSync(p);
        removed++;
      } catch {}
    }
  };
  prune(path.join(STATE_DIR, "prompts"), RETENTION_DAYS.prompts);
  prune(JOBS_DIR, RETENTION_DAYS.jobs);
  prune(path.join(STATE_DIR, "rounds"), RETENTION_DAYS.rounds);
  prune(path.join(STATE_DIR, "context"), RETENTION_DAYS.context);
  // 残留的写入锁（正常几秒内就释放）、试运行目录里的临时文件，一天前的都删
  prune(path.join(STATE_DIR, "locks"), 1);
  prune(path.join(STATE_DIR, "probe"), 1);
  // Codex 外派记录是追加写的单个文件：只保留近 30 天的条目
  const hist = path.join(STATE_DIR, "history.jsonl");
  try {
    const cutoff = now - RETENTION_DAYS.history * 86_400_000;
    const keep = new Set(readHistory().filter((h) => (Date.parse(h.startedAt) || now) >= cutoff).map((h) => h.id));
    const lines = fs.readFileSync(hist, "utf8").split("\n").filter((l) => {
      try {
        return l.trim() && keep.has(JSON.parse(l).id);
      } catch {
        return false;
      }
    });
    fs.writeFileSync(hist, lines.length ? lines.join("\n") + "\n" : "");
  } catch {}
  try {
    fs.writeFileSync(CLEAN_STAMP(), String(now));
  } catch {}
  return removed;
}

// 各类数据占用的磁盘空间（字节）
export function storageUsage() {
  const size = (p) => {
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory()) return st.size;
      return fs.readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0);
    } catch {
      return 0;
    }
  };
  const names = ["jobs", "prompts", "rounds", "context", "history.jsonl", "quota-cache.json", "providers.json"];
  return { total: size(STATE_DIR), parts: Object.fromEntries(names.map((n) => [n, size(path.join(STATE_DIR, n))])) };
}

// 外派记录：Codex 子代理由钩子记在 history.jsonl（relay 自己的任务在 jobs/ 目录）
export function appendHistory(entry) {
  ensureStateDir();
  fs.appendFileSync(path.join(STATE_DIR, "history.jsonl"), JSON.stringify(entry) + "\n");
}

// 合并同一 id 的开始 / 结束两条记录
export function readHistory() {
  let text = "";
  try {
    text = fs.readFileSync(path.join(STATE_DIR, "history.jsonl"), "utf8");
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      byId.set(e.id, { ...(byId.get(e.id) || {}), ...e });
    } catch {}
  }
  return [...byId.values()];
}

export function loadPrompt(sessionId) {
  try {
    return fs.readFileSync(path.join(STATE_DIR, "prompts", `${sessionId}.txt`), "utf8");
  } catch {
    return "";
  }
}

export const ULW_RE = /(^|[\s，。,.!！?？:：])(ulw|ultrawork)(?=$|[\s，。,.!！?？:：])/i;
// 角色的中文名，供面板和提示使用
export const ROLE_TEXT = {
  implement: "实现", debug: "排查", review: "审查", read: "阅读",
  deep: "深度推理", quick: "快速问答", "claude-backup": "Claude 替补",
};

// 用户输入里是否点名了某个已配置厂商（含后来新增的，如 kimi、qwen）
export function mentionsProvider(cfg, text) {
  const t = String(text || "").toLowerCase();
  return Object.entries(cfg.providers || {}).some(([name, prov]) => !prov.self && name.length >= 3 && t.includes(name.toLowerCase()));
}

export const MENTION_RE = /(codex|grok|agy|antigravity|gemini|多模型|外派|派给|交给|让\s*(codex|grok|gemini)|\/ask|rescue|ai-relay)/i;

// ---------- 外派台账：记录、验收结论、分派理由 ----------

// 所有外派记录：relay 调用的（agy、Grok、新增厂商）+ 钩子记下的 Codex 子代理，按开始时间倒序
export function allJobRecords(limit = Infinity) {
  ensureStateDir();
  const relayJobs = fs.readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8"));
        return {
          id: j.id, provider: j.provider, model: j.model, role: j.role || null, write: !!j.write, status: j.status,
          startedAt: j.startedAt, finishedAt: j.finishedAt || null, task: j.task, cwd: j.cwd,
          changedFiles: j.changedFiles?.length || 0, reason: j.reason || "", verdict: j.verdict || null, verdictNote: j.verdictNote || "",
          scope: j.scope ?? null,
          pid: j.pid ?? null,
          helpRequest: j.helpRequest || "",
          // 发起这次外派的 Claude 会话；旧任务没有，jobs --json 就不带这个字段
          ...(typeof j.sessionId === "string" && j.sessionId.trim() ? { sessionId: j.sessionId.trim() } : {}),
          ...(j.usage ? { usage: j.usage } : {}),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const codexJobs = readHistory().map((h) => ({
    changedFiles: Array.isArray(h.changedFiles) ? h.changedFiles.length : (h.changedFiles || 0),
    finishedAt: null, role: null, reason: "", verdict: null, verdictNote: "",
    ...h,
    scope: h.scope ?? null,
    outOfScope: h.outOfScope ?? null,
    helpRequest: h.helpRequest || "",
  }));
  return [...relayJobs, ...codexJobs]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
}

// 会话工作区根：git 仓库取仓库根，不是仓库时就是目录本身。Codex 沙箱只能写这个根里面
export function workspaceRoot(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return out;
  } catch {}
  return path.resolve(dir);
}

// child 是否在 parent 里面（含 parent 自身）
export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------- 写入范围与并行冲突检查 ----------

export function normScope(cwd, p) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  let s = String(p ?? "");
  s = s.replace(/\\/g, "/");
  if (path.isAbsolute(s) || (typeof p === "string" && path.isAbsolute(p))) {
    s = path.relative(root, p).replace(/\\/g, "/");
  }
  s = path.posix.normalize(s);
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+$/, "");
  if (!s || s === "." || s.startsWith("..") || path.isAbsolute(s)) {
    return ".";
  }
  return s;
}

function singleScopeOverlaps(p1, p2) {
  if (!p1 || !p2 || p1 === "." || p2 === ".") return true;
  if (p1 === p2) return true;
  if (p1.startsWith(p2 + "/")) return true;
  if (p2.startsWith(p1 + "/")) return true;
  return false;
}

export function scopesOverlap(a, b, cwd) {
  const toList = (x) => (!x ? ["."] : Array.isArray(x) ? (x.length === 0 ? ["."] : x) : [String(x)]);
  const normA = toList(a).map((p) => normScope(cwd, p));
  const normB = toList(b).map((p) => normScope(cwd, p));
  if (normA.includes(".") || normB.includes(".")) return true;
  for (const pa of normA) {
    for (const pb of normB) {
      if (singleScopeOverlaps(pa, pb)) return true;
    }
  }
  return false;
}

export function isPathInScope(filePath, scope, cwd) {
  if (!scope || !Array.isArray(scope) || scope.length === 0) return true;
  const normList = scope.map((s) => normScope(cwd, s));
  if (normList.includes(".")) return true;
  const normFile = normScope(cwd, filePath);
  if (normFile === ".") return normList.includes(".");
  return normList.some((s) => normFile === s || normFile.startsWith(s + "/"));
}

export function runningWriters(cwd, now = Date.now(), maxMinutes = 240) {
  const targetCwd = path.resolve(cwd);
  const maxMs = maxMinutes * 60_000;
  return allJobRecords().filter((r) => {
    if (r.status !== "running") return false;
    if (!r.write) return false;
    if (path.resolve(r.cwd || "") !== targetCwd) return false;
    const startMs = Date.parse(r.startedAt);
    if (Number.isNaN(startMs)) return false;
    const elapsed = now - startMs;
    if (elapsed < -60_000 || elapsed > maxMs) return false;
    if (r.pid) {
      try {
        process.kill(r.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") return false;
      }
    }
    return true;
  });
}

export function withWriteLock(cwd, fn) {
  ensureStateDir();
  const locksDir = path.join(STATE_DIR, "locks");
  fs.mkdirSync(locksDir, { recursive: true });
  const key = crypto.createHash("sha1").update(path.resolve(cwd || process.cwd())).digest("hex").slice(0, 12);
  const lockDir = path.join(locksDir, `${key}.lock`);
  const deadline = Date.now() + 5000;
  let acquired = false;
  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > 30_000) {
          try {
            fs.rmSync(lockDir, { recursive: true, force: true });
          } catch {}
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  if (!acquired) {
    throw new Error("写入锁繁忙");
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {}
  }
}

// ---------- Git 快照与改动检测 ----------

export function parseGitStatusPaths(line) {
  if (!line || typeof line !== "string") return [];
  const p = line.slice(3).trim();
  if (!p) return [];
  let splitIdx = -1;
  let inQuote = false;
  for (let i = 0; i <= p.length - 4; i++) {
    if (p[i] === '"' && (i === 0 || p[i - 1] !== '\\')) {
      inQuote = !inQuote;
    } else if (!inQuote && p.slice(i, i + 4) === " -> ") {
      splitIdx = i;
      break;
    }
  }
  const clean = (s) => {
    s = s.trim();
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    s = s.replace(/\\"/g, '"');
    while (s.startsWith("./")) s = s.slice(2);
    return s.replace(/\/+$/, "");
  };
  if (splitIdx !== -1) {
    const src = clean(p.slice(0, splitIdx));
    const dst = clean(p.slice(splitIdx + 4));
    return [src, dst].filter(Boolean);
  }
  const single = clean(p);
  return single ? [single] : [];
}

export function parseGitStatusPath(line) {
  const paths = parseGitStatusPaths(line);
  return paths.length ? paths[paths.length - 1] : "";
}

export function gitSnapshot(cwd) {
  try {
    const raw = execFileSync("git", ["-C", cwd, "-c", "core.quotePath=false", "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = raw.split("\n").filter(Boolean);
    const files = {};
    for (const line of lines) {
      for (const p of parseGitStatusPaths(line)) {
        if (!files[p]) {
          try {
            const st = fs.statSync(path.resolve(cwd, p));
            files[p] = `${st.size}:${st.mtimeMs}`;
          } catch {
            files[p] = "missing";
          }
        }
      }
    }
    return { lines, files };
  } catch {
    return null;
  }
}

export function diffSnapshots(before, after) {
  if (!before || !after) return [];
  const beforeLines = new Set(before.lines || []);
  const changed = [];
  for (const line of (after.lines || [])) {
    if (!beforeLines.has(line)) {
      changed.push(line);
    } else {
      const paths = parseGitStatusPaths(line);
      const modified = paths.some((p) => {
        const bFp = before.files?.[p];
        const aFp = after.files?.[p];
        return bFp !== undefined && aFp !== undefined && bFp !== aFp;
      });
      if (modified) {
        changed.push(line);
      }
    }
  }
  return changed;
}

export const changedFilesFromSnapshots = diffSnapshots;
export const computeChangedFiles = diffSnapshots;

export function checkOutOfScope(changedFiles, scope, cwd) {
  const out = [];
  for (const l of changedFiles || []) {
    const paths = parseGitStatusPaths(l);
    for (const p of paths) {
      if (p && !isPathInScope(p, scope, cwd) && !out.includes(p)) {
        out.push(p);
      }
    }
  }
  return out;
}

// 获取工作区被修改文件的最新修改时间（只看 git 已跟踪或新增文件的 mtime，限 limit 个以内，超出跳过返回 0）
export function getWorkspaceActivityMtime(cwd, limit = 2000) {
  if (!cwd) return 0;
  try {
    const raw = execFileSync("git", ["-C", cwd, "-c", "core.quotePath=false", "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = raw.split("\n").filter(Boolean);
    const paths = new Set();
    for (const line of lines) {
      for (const p of parseGitStatusPaths(line)) {
        paths.add(p);
      }
    }
    if (paths.size === 0 || paths.size > limit) return 0;
    let maxMtime = 0;
    const now = Date.now();
    for (const p of paths) {
      try {
        const full = path.resolve(cwd, p);
        const st = fs.statSync(full);
        const mtime = Math.min(st.mtimeMs, now);
        if (mtime > maxMtime) maxMtime = mtime;
      } catch {}
    }
    return maxMtime;
  } catch {
    return 0;
  }
}

// 验收结论写回记录：pass 通过 / partial 部分通过 / fail 不通过；会影响以后给这个模型打的可靠度
export const VERDICTS = ["pass", "partial", "fail"];
export function setVerdict(id, verdict, note = "") {
  if (!VERDICTS.includes(verdict)) throw new Error(`验收结论只能是 ${VERDICTS.join(" / ")}`);
  const at = new Date().toISOString();
  const file = path.join(JOBS_DIR, `${id}.json`);
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(j, { verdict, verdictNote: note, verdictAt: at });
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return j;
  }
  const h = readHistory().find((x) => x.id === id);
  if (!h) throw new Error(`找不到外派记录 ${id}（relay jobs 可查看 id）`);
  appendHistory({ id, verdict, verdictNote: note, verdictAt: at });
  return { ...h, verdict, verdictNote: note };
}

// 最近一次 relay pick 的结果：Codex 走 Agent 工具，钩子从这里取分派理由
const PICK_TTL_MS = 15 * 60_000;
export function recordPick(role, pick) {
  ensureStateDir();
  const file = path.join(STATE_DIR, "last-pick.json");
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  all[role] = { at: Date.now(), provider: pick.choice?.provider || null, reason: pick.choice?.reason || "", skipped: (pick.skipped || []).map((s) => `${s.provider}/${s.model}：${s.why}`) };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

export function lastPick(role, now = Date.now()) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "last-pick.json"), "utf8"))[role];
    return p && now - p.at < PICK_TTL_MS ? p : null;
  } catch {
    return null;
  }
}

// 分派理由的完整文字：选中的打分 + 跳过的原因
export function pickReason(pick) {
  const c = pick.choice;
  if (!c) return "";
  const skipped = (pick.skipped || []).map((s) => `${s.provider}${s.model && s.model !== "default" ? "/" + s.model : ""} ${s.why}`);
  return `${c.reason || ""}${skipped.length ? `；跳过 ${skipped.join("、")}` : ""}`;
}

// ---------- 主模型亲手改动与读文件的统计（自动模式下用来提醒外派） ----------
function selfEditFile(sessionId) {
  return path.join(STATE_DIR, "prompts", `${sessionId}.edits.json`);
}

function bashSnapFile(sessionId) {
  return path.join(STATE_DIR, "prompts", `${sessionId}.bashsnap.json`);
}

// 不算项目代码：临时目录、会话 memory、计划草稿。不拦截，也不计行数。
const SCRATCH_PATH_RE = /^(\/private)?\/tmp\/|^\/var\/folders\//;

export function isScratchPath(filePath) {
  const raw = String(filePath || "");
  if (!raw) return false;
  if (SCRATCH_PATH_RE.test(raw)) return true;
  let abs = raw;
  if (raw.startsWith("~/")) abs = path.join(os.homedir(), raw.slice(2));
  if (!path.isAbsolute(abs)) return false;
  const norm = path.normalize(abs);
  const home = os.homedir();
  const plans = path.join(home, ".claude", "plans");
  if (norm === plans || norm.startsWith(plans + path.sep)) return true;
  const projects = path.join(home, ".claude", "projects") + path.sep;
  if (!norm.startsWith(projects)) return false;
  const parts = norm.slice(projects.length).split(path.sep);
  return parts.length >= 2 && parts[1] === "memory";
}

// 缺字段补默认值。reposKnown 只留在内存里：false 表示文件里还没有仓库缓存。
export function readSelfEdits(sessionId) {
  const blank = () => ({
    lines: 0,
    warned: false,
    reads: 0,
    readWarned: false,
    decision: null,
    selfReason: "",
    bashPending: false,
    repos: [],
    reposKnown: false,
  });
  try {
    const data = JSON.parse(fs.readFileSync(selfEditFile(sessionId), "utf8"));
    if (typeof data.lines !== "number") data.lines = 0;
    if (typeof data.warned !== "boolean") data.warned = false;
    if (typeof data.reads !== "number") data.reads = 0;
    if (typeof data.readWarned !== "boolean") data.readWarned = false;
    if (data.decision !== "self" && data.decision !== "dispatch") data.decision = null;
    if (typeof data.selfReason !== "string") data.selfReason = "";
    if (typeof data.bashPending !== "boolean") data.bashPending = false;
    if (Array.isArray(data.repos)) {
      data.repos = data.repos.filter((p) => typeof p === "string");
      data.reposKnown = true;
    } else {
      data.repos = [];
      data.reposKnown = false;
    }
    return data;
  } catch {
    return blank();
  }
}

export function writeSelfEdits(sessionId, data) {
  if (!sessionId || !data) return;
  ensureStateDir();
  const out = { ...data };
  // 还没扫过仓库时写 null，避免下一次把「未扫描」当成「扫过且没有」
  if (out.reposKnown === false) out.repos = null;
  delete out.reposKnown;
  fs.writeFileSync(selfEditFile(sessionId), JSON.stringify(out));
}

export function readBashSnap(sessionId) {
  try {
    const data = JSON.parse(fs.readFileSync(bashSnapFile(sessionId), "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

export function writeBashSnap(sessionId, snap) {
  if (!sessionId) return;
  ensureStateDir();
  fs.writeFileSync(bashSnapFile(sessionId), JSON.stringify(snap && typeof snap === "object" ? snap : {}));
}

export function clearBashSnap(sessionId) {
  if (!sessionId) return;
  try {
    fs.unlinkSync(bashSnapFile(sessionId));
  } catch {}
}

// relay.mjs 后面紧跟的子命令是 run。原因文字里碰巧出现 “ run ” 不算。
export function isRelayRunCommand(command) {
  return /relay\.mjs["']?\s+run(?:\s|$)/.test(String(command || ""));
}

// 自动模式下，第一次改项目代码前还没定分工时的拒绝理由
export function divisionReason() {
  return `[ai-relay 自动模式] 这一轮第一次改项目代码前，先定分工：成块的实现派给员工（relay pick implement，再 relay run 或 Codex 子代理）；确认自己做更合适，就先运行 node "${RELAY_SCRIPT}" self "<一句话原因>"，再继续改。原因会显示在面板这一轮的详情里。`;
}

// Bash 已经改了项目代码、但这一轮还没定分工
export function bashWroteReminder(delta) {
  return `[ai-relay 自动模式] 刚才的 Bash 已改了项目代码 ${delta} 行，这一轮还没定分工。下一步改动前必须先定：成块的实现派给员工（relay pick implement，再 relay run 或 Codex 子代理）；确认自己做更合适，就先运行 node "${RELAY_SCRIPT}" self "<一句话原因>"，再继续改。原因会显示在面板这一轮的详情里。`;
}

// 超过上限时记 warned 并返回提醒；没超过返回空串
export function selfEditLimitMessage(stat, limit) {
  const max = limit || 40;
  if (!stat || stat.warned || !(stat.lines > max)) return "";
  stat.warned = true;
  return `[ai-relay 自动模式] 这一轮你已亲手写了 ${stat.lines} 行。如果后面还有成块的实现，考虑交给更合适的员工模型（relay pick implement）；自己做更合适的，汇报时说明原因即可。`;
}

// ---------- Bash 写入的行数：改前改后各拍一次 git 快照，用差值计入亲手改动 ----------
const SNAP_GIT_TIMEOUT_MS = 400;
const FIND_REPO_MAX = 20;
const FIND_DIR_MAX = 400;
const UNTRACKED_MAX = 200;
const UNTRACKED_BYTES = 1024 * 1024;
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "target", "dist", "build"]);

function gitText(args, timeoutMs = SNAP_GIT_TIMEOUT_MS) {
  return execFileSync("git", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
    },
  });
}

// 异步版：快照时各仓库的 git 调用并行跑，仓库多时（如十几个子仓库的工作区）不至于把每次 Bash 拖慢太多
function gitTextAsync(args, timeoutMs = SNAP_GIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function countTextLines(text) {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.charCodeAt(text.length - 1) !== 10) n++;
  return n;
}

// 未跟踪文件按行数计。超过 1MB 或含空字节（当二进制）的跳过，返回 null。
function untrackedLineCount(full) {
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > UNTRACKED_BYTES) return null;
  if (st.size === 0) return 0;
  let fd;
  try {
    fd = fs.openSync(full, "r");
    const probeLen = Math.min(st.size, 8192);
    const probe = Buffer.alloc(probeLen);
    fs.readSync(fd, probe, 0, probeLen, 0);
    if (probe.includes(0)) return null;
    if (st.size <= 8192) return countTextLines(probe.toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  try {
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return null;
    return countTextLines(buf.toString("utf8"));
  } catch {
    return null;
  }
}

// cwd 自己所在的仓库；不在仓库里时，向下最多 3 层找含 .git 的目录，最多 20 个。
export function findRepos(cwd) {
  if (!cwd || typeof cwd !== "string") return [];
  let dir = cwd;
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    return [];
  }
  try {
    const top = gitText(["-C", dir, "rev-parse", "--show-toplevel"], 250).trim();
    if (top) return [top];
  } catch {}
  const found = [];
  const queue = [{ dir, depth: 0 }];
  let scanned = 0;
  while (queue.length && found.length < FIND_REPO_MAX && scanned < FIND_DIR_MAX) {
    const cur = queue.shift();
    if (cur.depth >= 3) continue;
    let entries;
    try {
      entries = fs.readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    scanned++;
    for (const ent of entries) {
      if (found.length >= FIND_REPO_MAX) break;
      if (!ent.isDirectory() || SKIP_DIR_NAMES.has(ent.name)) continue;
      const full = path.join(cur.dir, ent.name);
      let isRepo = false;
      try {
        isRepo = fs.existsSync(path.join(full, ".git"));
      } catch {}
      if (isRepo) {
        found.push(full);
        continue;
      }
      if (cur.depth + 1 < 3) queue.push({ dir: full, depth: cur.depth + 1 });
    }
  }
  return found;
}

// 命令里 cd 进去的目录（绝对路径、~ 开头或相对 cwd），用来把这条命令要去的仓库提前纳入快照
export function cdTargets(command, cwd) {
  const out = [];
  if (typeof command !== "string") return out;
  const re = /(?:^|[\s;&|(])cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/g;
  let m;
  while ((m = re.exec(command))) {
    let p = m[1] ?? m[2] ?? m[3] ?? "";
    if (!p || p === "-" || p.includes("$")) continue;
    if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
    else if (!path.isAbsolute(p)) {
      if (!cwd) continue;
      p = path.resolve(cwd, p);
    }
    out.push(p);
  }
  return out;
}

function insideAny(dir, roots) {
  return roots.some((r) => dir === r || dir.startsWith(r + path.sep));
}

// 这次 Bash 要盯的仓库：本轮已知的 + 项目根目录下的 + 当前目录所在的 + 命令里 cd 进去的。
// 多仓库工作区里一轮会在几个仓库之间来回切，不能只看本轮第一条命令所在的仓库。
// 新发现的仓库并入 edits.json，本轮后面的命令直接复用。
export function resolveRepos(sessionId, stat, cwd, command) {
  const known = stat?.reposKnown && Array.isArray(stat.repos) ? stat.repos : [];
  const repos = [...known];
  const dirs = [process.env.CLAUDE_PROJECT_DIR, cwd, ...cdTargets(command, cwd)].filter((d) => typeof d === "string" && d);
  for (const dir of dirs) {
    if (insideAny(path.resolve(dir), repos)) continue;
    for (const r of findRepos(dir)) if (!repos.includes(r)) repos.push(r);
  }
  if (stat && (!stat.reposKnown || repos.length !== known.length)) {
    stat.repos = repos;
    stat.reposKnown = true;
    writeSelfEdits(sessionId, stat);
  }
  return repos;
}

// 文件签名：行数不变但内容改了（比如改一行还没提交的新增行）时靠它发现
function fileSig(full) {
  try {
    const st = fs.statSync(full);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
}

// base 是对比的提交：前快照用当时的 HEAD；后快照沿用前快照的 HEAD，
// 这样命令里 git commit 让改动从工作区进了提交，行数不会被当成又改了一遍。
async function snapshotRepo(root, base) {
  const files = {};
  const args = ["-C", root, "-c", "core.quotePath=false"];
  const head = base || (await gitTextAsync([...args, "rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
  const [numstat, listing] = await Promise.all([
    (head ? gitTextAsync([...args, "diff", "--numstat", head]) : Promise.reject(new Error("no head")))
      .catch(() => gitTextAsync([...args, "diff", "--numstat"]))
      .catch(() => ""),
    gitTextAsync([...args, "ls-files", "--others", "--exclude-standard"]).catch(() => ""),
  ]);
  for (const line of numstat.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const tab2 = tab < 0 ? -1 : line.indexOf("\t", tab + 1);
    if (tab <= 0 || tab2 < 0) continue;
    const addedRaw = line.slice(0, tab);
    const deletedRaw = line.slice(tab + 1, tab2);
    const file = line.slice(tab2 + 1);
    if (!file) continue;
    const added = addedRaw === "-" ? 0 : Number(addedRaw) || 0;
    const deleted = deletedRaw === "-" ? 0 : Number(deletedRaw) || 0;
    const n = added + deleted;
    const full = path.join(root, file);
    if (n > 0) files[full] = { n, sig: fileSig(full) };
  }
  const untracked = listing.split("\n").filter(Boolean);
  const capped = untracked.length > UNTRACKED_MAX ? untracked.slice(0, UNTRACKED_MAX) : untracked;
  for (const rel of capped) {
    const full = path.join(root, rel);
    if (files[full] !== undefined) continue;
    const n = untrackedLineCount(full);
    if (n > 0) files[full] = { n, sig: fileSig(full) };
  }
  return { head, files };
}

// repos 是仓库根目录列表，不传时现发现；bases 是 { 仓库: 对比提交 }，后快照传前快照的 heads。
// 返回 Promise<{ heads: { 仓库: 提交 }, files: { 绝对路径: { n: 行数, sig } } }>
export async function lineSnapshot(cwd, repos, bases) {
  const roots = (Array.isArray(repos) ? repos : findRepos(cwd)).filter(Boolean);
  const parts = await Promise.all(
    roots.map((root) => snapshotRepo(root, bases?.[root]).then((r) => [root, r]).catch(() => [root, null])),
  );
  const heads = {};
  const files = {};
  for (const [root, r] of parts) {
    if (!r) continue;
    heads[root] = r.head;
    Object.assign(files, r.files);
  }
  return { heads, files };
}

// 兼容旧格式：快照可以直接是 { 路径: 行数 }
function snapFiles(snap) {
  if (!snap || typeof snap !== "object") return {};
  return snap.files && typeof snap.files === "object" ? snap.files : snap;
}

// 两边都出现的文件取行数差的绝对值；行数没变但签名变了，算改了 1 行；只在一边出现的，另一边按 0。
export function snapshotDelta(before, after) {
  const b = snapFiles(before);
  const a = snapFiles(after);
  const norm = (v) => (v && typeof v === "object" ? { n: Number(v.n) || 0, sig: v.sig } : { n: Number(v) || 0 });
  let sum = 0;
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const x = norm(b[key]);
    const y = norm(a[key]);
    const d = Math.abs(y.n - x.n);
    if (d > 0) sum += d;
    else if (key in b && key in a && x.sig && y.sig && x.sig !== y.sig) sum += 1;
  }
  return sum;
}

// 一次编辑工具调用新写入的行数
export function editedLines(toolName, input) {
  const count = (t) => (t ? String(t).split("\n").length : 0);
  if (toolName === "Edit") return count(input?.new_string);
  if (toolName === "MultiEdit") return (input?.edits || []).reduce((n, e) => n + count(e.new_string), 0);
  if (toolName === "Write") return count(input?.content);
  if (toolName === "NotebookEdit") return count(input?.new_source);
  return 0;
}

// 实际能力：配置里的 caps，加上"员工最高权限"开关打开（默认开）时，配了 cli.fullAccess 的厂商也能执行命令。
// 只在内存里计算，不写回配置，关掉开关就恢复原样
export function workerFullAccess(cfg) {
  return cfg?.workerFullAccess !== false;
}

// 某家员工是否以最高权限运行：支持（配了 cli.fullAccess）且开关打开；厂商自己的 fullAccessEnabled 优先于全局开关
export function fullAccessSupported(prov) {
  return !prov?.self && (prov?.cli?.fullAccess || []).length > 0;
}

export function fullAccessOn(cfg, prov) {
  if (!fullAccessSupported(prov)) return false;
  return typeof prov.fullAccessEnabled === "boolean" ? prov.fullAccessEnabled : workerFullAccess(cfg);
}

export function capsOf(cfg, prov) {
  const full = fullAccessOn(cfg, prov);
  return { web: prov?.caps?.web === true, exec: prov?.caps?.exec === true || full };
}
