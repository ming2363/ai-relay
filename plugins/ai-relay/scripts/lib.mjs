// ai-relay 公共库：配置、模式、额度读取、路由选择
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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

// 用户配置放在 ~/.claude/ai-relay/providers.json，首次运行从插件默认配置复制，插件升级不会覆盖
export function loadConfig() {
  ensureStateDir();
  const userFile = path.join(STATE_DIR, "providers.json");
  if (!fs.existsSync(userFile)) {
    fs.copyFileSync(path.join(PLUGIN_ROOT, "config", "providers.default.json"), userFile);
  }
  const cfg = JSON.parse(fs.readFileSync(userFile, "utf8"));
  cfg._file = userFile;
  return cfg;
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

// 某模型属于哪个额度池
export function poolOfModel(prov, model) {
  for (const [pool, models] of Object.entries(prov.pools || {})) {
    if (models.includes(model)) return pool;
  }
  return null;
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
  // 每条新消息重新统计主模型亲手改动的行数
  fs.writeFileSync(selfEditFile(sessionId), JSON.stringify({ lines: 0, warned: false }));
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

export function runningWriters(cwd, now = Date.now(), maxMinutes = 30) {
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

// ---------- 主模型亲手改动的统计（自动模式下用来提醒外派） ----------
function selfEditFile(sessionId) {
  return path.join(STATE_DIR, "prompts", `${sessionId}.edits.json`);
}

export function readSelfEdits(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(selfEditFile(sessionId), "utf8"));
  } catch {
    return { lines: 0, warned: false };
  }
}

export function writeSelfEdits(sessionId, data) {
  if (!sessionId) return;
  ensureStateDir();
  fs.writeFileSync(selfEditFile(sessionId), JSON.stringify(data));
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
