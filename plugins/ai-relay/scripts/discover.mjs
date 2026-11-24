// ai-relay 新模型自动发现与接入：探测厂商新模型、归池、联网调研能力、增量写入配置、日志与精确撤销
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  RELAY_SCRIPT,
  STATE_DIR,
  ROLE_TEXT,
  isEnabled,
  loadConfig,
  poolOfModel,
  providerPools,
  resolveModel,
  fmtTime,
  withFileLock,
  writeFileAtomic,
} from "./lib.mjs";
import { assignPool, getModels } from "./models.mjs";
import { TIER_TEXT } from "./score.mjs";

export const DISCOVER_INTERVAL_MS = 6 * 3600_000;
// 调研失败或校验未通过的家族冷却时长：默认 24 小时内不反复调研同一家族
export const DISCOVER_FAIL_COOLDOWN_MS = 24 * 3600_000;
const DISCOVER_LOCK_STALE_MS = 15 * 60_000;
export const DEFAULT_ROLES = ["implement", "debug", "review", "read", "deep", "quick", "claude-backup"];
export const VALID_TIERS = ["light", "mid", "strong"];

// 思考档位后缀从高到低，与 score.mjs 保持一致
const EFFORT_ORDER = ["xhigh", "high", "medium", "low"];
const EFFORT_SUFFIX_RE = /-(xhigh|high|medium|low)$/i;

// 非独立对话模型家族的排除规则（例如 Antigravity 的 gemini-pro-orchestrator* / Orchestrator (...) 编排器）
const EXCLUDED_MODEL_PATTERNS = [/(?:^|[^a-z0-9])orchestrator(?:$|[^a-z0-9])/i];

// Antigravity 官方分组名到额度池的已知映射（与 quota.mjs 保持一致）
const KNOWN_GROUP_POOLS = {
  "gemini models": "gemini",
  "claude and gpt models": "claude-gpt",
  "gemini 4 argon": "gemini-argon",
};

export const DISCOVER_HELP = `用法：node relay.mjs models discover [选项]
  models discover [--force] [--background] [--json]
                  探测各厂商是否有新模型：先按 poolRules / AIQuota5h 分组归池，
                  再派只读联网任务调研档位、看图能力与各角色擅长度，增量写入 providers.json
                  （默认 6 小时内不重复运行；首次运行只把当前模型记为已知，不做接入）
  models discover --list [--json]
                  列出历史自动接入记录（含记录 id 与撤销状态）
  models discover --undo <记录id> [--json]
                  精确撤销指定记录对 providers.json 所做的改动（写入前备份 .bak）
  models discover --help
                  显示本帮助`;

const expandHome = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

export function discoverStatePath(stateDir = STATE_DIR) {
  return path.join(stateDir, "discover-state.json");
}

export function discoverLogPath(stateDir = STATE_DIR) {
  return path.join(stateDir, "discover-log.jsonl");
}

export function discoverLockPath(stateDir = STATE_DIR) {
  return path.join(stateDir, "discover.lock");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

// 检查是否已有正在运行的 discover 进程；陈旧或已退出的锁视为未运行
export function runningDiscoverLock(stateDir = STATE_DIR, now = Date.now()) {
  const file = discoverLockPath(stateDir);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const startedAt = Number(data?.startedAt);
    const pid = Number(data?.pid);
    if (Number.isFinite(startedAt) && now - startedAt < DISCOVER_LOCK_STALE_MS && pidAlive(pid)) {
      return { pid, startedAt };
    }
  } catch {
    return null;
  }
  return null;
}

// 尝试抢占运行锁（wx 原子建文件）；失败时返回占用者信息，成功返回释放函数
function acquireDiscoverLock(stateDir, now = Date.now()) {
  const file = discoverLockPath(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }));
      } finally {
        fs.closeSync(fd);
      }
      return {
        ok: true,
        release: () => {
          try {
            fs.unlinkSync(file);
          } catch {}
        },
      };
    } catch (err) {
      if (err?.code !== "EEXIST") return { ok: true, release: () => {} };
      const active = runningDiscoverLock(stateDir, now);
      if (active) return { ok: false, active };
      // 锁已陈旧或对应进程已死，清掉后再抢一次
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
  return { ok: false, active: runningDiscoverLock(stateDir, now) || { pid: null, startedAt: now } };
}

export function loadDiscoverState(stateDir = STATE_DIR) {
  try {
    const data = JSON.parse(fs.readFileSync(discoverStatePath(stateDir), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export function saveDiscoverState(stateDir, state) {
  const file = discoverStatePath(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  withFileLock(file, () => {
    writeFileAtomic(file, JSON.stringify(state, null, 2) + "\n");
  });
}

// 追加一条记录到 discover-log.jsonl（支持接入记录和撤销记录）
export function appendDiscoverLog(stateDir, entry) {
  const file = discoverLogPath(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  withFileLock(file, () => {
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  });
}

// 读取 discover-log.jsonl 并合并撤销状态，返回接入记录列表（按写入顺序）
export function readDiscoverLog(stateDir = STATE_DIR) {
  const file = discoverLogPath(stateDir);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records = [];
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    if (obj.type === "undo") {
      const target = byId.get(obj.id);
      if (target) {
        target.undone = true;
        target.undoneAt = obj.undoneAt || null;
      }
      continue;
    }
    if (!obj.id) continue;
    const rec = { ...obj, undone: !!obj.undone };
    records.push(rec);
    byId.set(rec.id, rec);
  }
  return records;
}

// 按调用选项解析配置和配置文件路径，确保隔离 stateDir 的测试不会误读或误改用户真实配置
function resolveConfigTarget(opts = {}) {
  const stateDir = opts.stateDir || STATE_DIR;
  if (opts.cfg) {
    const configFile = opts.configFile || opts.cfg._file || null;
    return { cfg: opts.cfg, configFile, fromDisk: false };
  }
  if (opts.configFile) {
    const cfg = JSON.parse(fs.readFileSync(opts.configFile, "utf8"));
    cfg._file = opts.configFile;
    return { cfg, configFile: opts.configFile, fromDisk: true };
  }
  if (stateDir !== STATE_DIR) {
    const localFile = path.join(stateDir, "providers.json");
    if (!fs.existsSync(localFile)) {
      throw new Error(`找不到配置文件：${localFile}`);
    }
    const cfg = JSON.parse(fs.readFileSync(localFile, "utf8"));
    cfg._file = localFile;
    return { cfg, configFile: localFile, fromDisk: true };
  }
  const cfg = loadConfig();
  return { cfg, configFile: cfg._file, fromDisk: true };
}

// 写回配置文件：先备份 .bak，再原子写入（与 relay.mjs 的 saveConfig 保持一致）
export function saveConfigWithBackup(cfg, configFile) {
  const file = configFile || cfg?._file;
  if (!file) throw new Error("无法确定配置文件路径");
  const data = { ...cfg };
  delete data._file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withFileLock(file, () => {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.bak`);
    }
    writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
  });
}

// 提取模型家族前缀（去掉 -low/-medium/-high/-xhigh 后缀）
export function modelFamily(modelId) {
  return String(modelId || "").replace(EFFORT_SUFFIX_RE, "");
}

// 统一生成「厂商:家族」小写键，用于撤销记录与失败冷却索引
function familyKey(provider, family) {
  return `${String(provider || "").trim()}:${String(family || "").trim().toLowerCase()}`;
}

// 判断清单条目是否应排除在自动发现之外（非独立模型家族，如编排器 orchestrator）
export function isExcludedDiscoverModel(model) {
  const id = typeof model === "string" ? model : String(model?.id || "");
  const label = typeof model === "string" ? "" : String(model?.label || "");
  return EXCLUDED_MODEL_PATTERNS.some((re) => re.test(id) || (label && re.test(label)));
}

// 判断某模型在当前厂商配置下是否已归入任一有效额度池（配置 pools 显式收录，或命中单池/poolRules）
export function isModelPooled(prov, modelId) {
  if (!prov || !modelId) return false;
  const validPools = providerPools(prov);
  if (!validPools.length) return false;
  const validSet = new Set(validPools);
  const inPools = poolOfModel(prov, modelId);
  if (inPools && validSet.has(inPools)) return true;
  const byRule = assignPool(prov, modelId);
  if (byRule && validSet.has(byRule)) return true;
  return false;
}

// 从 discover-log.jsonl 收集被用户 --undo 撤销过的家族键，避免自动重新接入
function collectUndoneFamilyKeys(stateDir) {
  const keys = new Set();
  for (const rec of readDiscoverLog(stateDir)) {
    if (rec?.undone && rec.provider && rec.family) {
      keys.add(familyKey(rec.provider, rec.family));
    }
  }
  return keys;
}

// 读取仍处于失败冷却期内的家族记录，自动丢弃已过期或格式异常的条目
function loadActiveFailedFamilies(state, now, cooldownMs) {
  const raw = state?.failedFamilies;
  const active = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return active;
  for (const [key, item] of Object.entries(raw)) {
    const ts = item?.at ? Date.parse(item.at) : NaN;
    if (!Number.isFinite(ts)) continue;
    if (cooldownMs > 0 && now - ts < cooldownMs) {
      active[key] = { at: item.at, reason: String(item.reason || "") };
    }
  }
  return active;
}

// 思考档位排序权重：xhigh(0) > high(1) > medium(2) > low(3) > 无后缀(4)
function effortRank(modelId) {
  const m = String(modelId || "").match(EFFORT_SUFFIX_RE);
  if (!m) return EFFORT_ORDER.length;
  const idx = EFFORT_ORDER.indexOf(m[1].toLowerCase());
  return idx >= 0 ? idx : EFFORT_ORDER.length;
}

// 按思考档从高到低排序变体列表（保留相同权重时的原顺序）
export function sortVariantsDesc(models) {
  return [...(models || [])]
    .map((m, i) => ({ m, i, r: effortRank(typeof m === "string" ? m : m.id) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.m);
}

// 选出家族内最高思考档模型 id
export function pickHighestVariant(models) {
  const sorted = sortVariantsDesc(models);
  if (!sorted.length) return "";
  const first = sorted[0];
  return typeof first === "string" ? first : first.id;
}

export function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normName(text) {
  return String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// 为显示名生成匹配候选：原样 > 去掉思考档括号 > 去掉任意末尾括号
export function labelCandidates(label) {
  const raw = String(label || "").trim();
  if (!raw) return [];
  const list = [];
  const push = (s) => {
    const n = normName(s);
    if (n && !list.includes(n)) list.push(n);
  };
  push(raw);
  push(raw.replace(/\s*\((?:xhigh|high|medium|low)\)\s*$/i, ""));
  push(raw.replace(/\s*\([^)]*\)\s*$/, ""));
  return list;
}

// 根据单个 group 的 displayName / buckets / poolLabels 推断所属额度池
function inferGroupPool(group, validPools, poolLabels = {}) {
  const validSet = validPools?.length ? new Set(validPools) : null;
  const allow = (p) => !!p && (!validSet || validSet.has(p));

  const displayNorm = normName(group?.displayName);
  if (displayNorm && KNOWN_GROUP_POOLS[displayNorm] && allow(KNOWN_GROUP_POOLS[displayNorm])) {
    return KNOWN_GROUP_POOLS[displayNorm];
  }
  for (const [pool, lbl] of Object.entries(poolLabels || {})) {
    if (displayNorm && normName(lbl) === displayNorm && allow(pool)) return pool;
  }
  // 从 buckets[].bucketId 推断：按池名长度降序匹配前缀，避免 gemini 误匹配 gemini-argon
  const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
  const sortedPools = [...(validPools || [])].sort((a, b) => b.length - a.length);
  for (const b of buckets) {
    const bid = String(b?.bucketId || "").toLowerCase();
    if (!bid) continue;
    for (const pool of sortedPools) {
      const lp = pool.toLowerCase();
      if (bid === lp || bid.startsWith(`${lp}-`)) return pool;
    }
    if ((bid.startsWith("3p-") || bid === "3p") && allow("claude-gpt")) return "claude-gpt";
  }
  return null;
}

// 解析 AIQuota5h pool_snapshots 表行，返回 [{ pool, models: [规范名...], modelIds: [id...] }]
// 兼容真实数据库（每行 raw_summary 含全部 groups）以及单行单组的简化数据结构
export function parseAiQuotaSnapshots(rows, validPools = [], poolLabels = {}) {
  const byPool = new Map();
  const validSet = validPools?.length ? new Set(validPools) : null;
  const ensure = (pool) => {
    if (!pool || (validSet && !validSet.has(pool))) return null;
    if (!byPool.has(pool)) byPool.set(pool, { pool, models: new Set(), modelIds: new Set() });
    return byPool.get(pool);
  };

  const parsedRows = (Array.isArray(rows) ? rows : []).map((r) => {
    let summary = r?.raw_summary;
    if (typeof summary === "string") {
      try {
        summary = JSON.parse(summary);
      } catch {
        summary = null;
      }
    }
    let modelIds = r?.models_json;
    if (typeof modelIds === "string") {
      try {
        modelIds = JSON.parse(modelIds);
      } catch {
        modelIds = [];
      }
    }
    const groups = Array.isArray(summary?.groups) ? summary.groups : [];
    return {
      poolId: r?.pool_id || r?.pool || null,
      modelIds: Array.isArray(modelIds) ? modelIds.filter((x) => typeof x === "string") : [],
      groups,
    };
  });

  // 判断不同行是否共用同一份全量 groups 列表（真实 AIQuota5h 每行都带完整 groups）
  const sigs = new Set(
    parsedRows
      .filter((r) => r.groups.length > 0)
      .map((r) => r.groups.map((g) => normName(g?.displayName)).join("|")),
  );
  const sharedGroupsAcrossRows = parsedRows.filter((r) => r.groups.length > 1).length > 1 && sigs.size === 1;

  for (const r of parsedRows) {
    const bucket = ensure(r.poolId);
    if (bucket) {
      for (const id of r.modelIds) bucket.modelIds.add(id);
    }
    for (const g of r.groups) {
      let pool = inferGroupPool(g, validPools, poolLabels);
      // 无法从 group 本身推断时，仅在各行独立（非多行重复全量 groups）时回退使用该行的 pool_id
      if (!pool && !sharedGroupsAcrossRows && r.poolId) {
        pool = r.poolId;
      }
      const target = ensure(pool);
      if (!target) continue;
      const desc = String(g?.description || "");
      const m = desc.match(/models\s+within\s+this\s+group\s*:\s*([^\r\n]+)/i);
      if (m) {
        for (const rawItem of m[1].split(/[,，、]/)) {
          const cleaned = rawItem.trim().replace(/\.$/, "").trim();
          const n = normName(cleaned);
          if (n) target.models.add(n);
        }
      }
      const disp = normName(g?.displayName);
      if (disp) target.models.add(disp);
    }
  }

  return [...byPool.values()].map((item) => ({
    pool: item.pool,
    models: [...item.models],
    modelIds: [...item.modelIds],
  }));
}

// 标准化注入或查询返回的 AIQuota5h 分组数据，统一转为 [{ pool, models, modelIds }]
function normalizeQuotaGroups(raw, validPools, poolLabels) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    if (raw.some((x) => x && (x.raw_summary !== undefined || x.pool_id !== undefined))) {
      return parseAiQuotaSnapshots(raw, validPools, poolLabels);
    }
    return raw
      .filter((x) => x && typeof x.pool === "string")
      .map((x) => ({
        pool: x.pool,
        models: (Array.isArray(x.models) ? x.models : []).map(normName).filter(Boolean),
        modelIds: (Array.isArray(x.modelIds) ? x.modelIds : []).filter((id) => typeof id === "string"),
      }));
  }
  if (typeof raw === "object") {
    return Object.entries(raw).map(([pool, list]) => ({
      pool,
      models: (Array.isArray(list) ? list : []).map(normName).filter(Boolean),
      modelIds: [],
    }));
  }
  return [];
}

// 从本地 AIQuota5h SQLite 库只读读取某厂商的分组快照；库不存在或查询失败时返回 []
export function readAiQuotaPoolGroups(cfg, quotaProvider, validPools = [], poolLabels = {}) {
  const db = expandHome(cfg?.quotaDb || "~/Library/Application Support/AIQuota5h/state.sqlite");
  if (!db || !fs.existsSync(db)) return [];
  if (!/^[a-z0-9_-]+$/i.test(String(quotaProvider || ""))) return [];
  const sql = `select provider, pool_id, models_json, raw_summary from pool_snapshots where provider = '${quotaProvider}'`;
  try {
    const out = execFileSync("sqlite3", ["-readonly", "-json", `file:${db}?mode=ro`, sql], {
      encoding: "utf8",
      timeout: 5000,
    });
    const rows = out.trim() ? JSON.parse(out) : [];
    return parseAiQuotaSnapshots(rows, validPools, poolLabels);
  } catch {
    return [];
  }
}

// 用家族模型变体的显示名或 id 与 AIQuota5h 分组匹配，返回命中的池名或 null
export function matchPoolFromGroups(variants, family, groups, validPools = []) {
  if (!Array.isArray(groups) || !groups.length) return null;
  const validSet = validPools?.length ? new Set(validPools) : null;
  const familyLower = String(family || "").toLowerCase();

  // 先按 modelIds 精确/同家族匹配
  for (const g of groups) {
    if (validSet && !validSet.has(g.pool)) continue;
    for (const id of g.modelIds || []) {
      if (variants.some((v) => v.id === id) || modelFamily(id).toLowerCase() === familyLower) {
        return g.pool;
      }
    }
  }

  // 再按显示名候选（原样 > 去思考档括号 > 去末尾括号）匹配
  const candidates = [];
  for (const v of variants) {
    for (const c of labelCandidates(v.label)) {
      if (!candidates.includes(c)) candidates.push(c);
    }
  }
  for (const cand of candidates) {
    for (const g of groups) {
      if (validSet && !validSet.has(g.pool)) continue;
      if ((g.models || []).includes(cand)) return g.pool;
    }
  }
  return null;
}

// 为新家族归池：先用 assignPool（单池或 poolRules），不中再查 AIQuota5h 分组
export async function resolveFamilyPool(prov, provName, family, variants, cfg, opts = {}) {
  const validPools = providerPools(prov);
  if (!validPools.length) return { pool: null, source: null };

  // 1. 先走 assignPool（单池直接返回唯一池，多池按 poolRules 顺序匹配）
  for (const v of variants) {
    const p = assignPool(prov, v.id);
    if (p && validPools.includes(p)) {
      return { pool: p, source: validPools.length === 1 ? "singlePool" : "poolRules" };
    }
  }

  // 2. 多池厂商未命中 poolRules 时，尝试 AIQuota5h 分组匹配
  if (validPools.length > 1) {
    const quotaProvider = prov.quota?.provider || provName;
    let rawGroups;
    if (typeof opts.readQuotaPools === "function") {
      rawGroups = await opts.readQuotaPools(provName, quotaProvider, cfg);
    } else if (opts.quotaGroups !== undefined) {
      rawGroups = opts.quotaGroups;
    } else {
      rawGroups = readAiQuotaPoolGroups(cfg, quotaProvider, validPools, prov.poolLabels);
    }
    const groups = normalizeQuotaGroups(rawGroups, validPools, prov.poolLabels);
    const matched = matchPoolFromGroups(variants, family, groups, validPools);
    if (matched) {
      return { pool: matched, source: "aiquota" };
    }
  }

  // 3. 兜底：若同家族已有变体被手动加入某个有效额度池，沿用该池
  for (const v of variants) {
    const p = poolOfModel(prov, v.id);
    if (p && validPools.includes(p)) {
      return { pool: p, source: "existingPool" };
    }
  }

  return { pool: null, source: null };
}

// 构造派给联网调研员工的只读派单
export function buildResearchBrief({ provider, providerLabel, family, variants, pool, roles = DEFAULT_ROLES }) {
  const variantLines = variants
    .map((v) => `- ${v.id}${v.label && v.label !== v.id ? `（${v.label}）` : ""}`)
    .join("\n");
  const roleLines = roles.map((r) => `- ${r}（${ROLE_TEXT[r] || r}）`).join("\n");
  const fitsExample = Object.fromEntries(roles.map((r) => [r, 0.7]));

  return `角色：deep
难度：中等

## 目标
联网调研厂商 ${providerLabel || provider}（${provider}）的新模型家族「${family}」，判断它的综合档位、是否支持看图，以及对各派单角色的擅长度评分，并只输出一个合法 JSON 对象。

## 背景
ai-relay 发现新模型家族需要自动评估接入：
- 厂商：${provider}（${providerLabel || provider}）
- 额度池：${pool}
- 家族前缀：${family}
- 发现的模型变体：
${variantLines}

档位定义：
- light：轻量/快速/低成本模型，适合简单改动和快速问答
- mid：常规主力模型，适合中等难度实现、审查和排查
- strong：旗舰/顶级推理与编程模型，适合困难、跨模块设计和疑难排查

角色列表（均需给出 0 到 1 之间的数字评分，越擅长越高，低于 0.5 表示不适合该角色）：
${roleLines}

## 需要的能力
联网

## 约束
- 只读调研，不要修改任何文件。
- 必须联网核实该模型家族的官方发布信息、基准定位和视觉支持情况，不得臆测。
- 最终输出必须且只能包含一个合法 JSON 对象（可用 \`\`\`json 代码块包裹），不要包含第二个 JSON 对象。
- 字段定义：
  - family：字符串，填 "${family}"
  - tier：只能是 "light"、"mid" 或 "strong"
  - vision：布尔值 true 或 false（是否支持图像输入/看图）
  - fits：对象，必须包含上述全部角色键，每个值为 0 到 1 的数字
  - evidence：字符串数组，至少 1 条真实可访问的 http/https 资料链接
  - reason：一句话中文总结定位与评分依据

JSON 示例：
\`\`\`json
${JSON.stringify({ family, tier: "mid", vision: true, fits: fitsExample, evidence: ["https://example.com/model"], reason: "一句话定位与依据" }, null, 2)}
\`\`\`

## 验收标准
- 输出可被 JSON.parse 解析的单个 JSON 对象，且所有必填字段类型、范围与链接格式全部合法。`;
}

// 从员工原始输出中提取 JSON 对象（支持纯 JSON、```json 围栏、或文本中内嵌的 JSON 对象）
export function extractJsonObject(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text) return null;

  // 如果包含 relay printJob 的输出包装，优先截取「----- 输出 -----」到「完整日志：」之间
  const outMark = "----- 输出 -----";
  const outIdx = text.indexOf(outMark);
  if (outIdx >= 0) {
    let inner = text.slice(outIdx + outMark.length);
    const logIdx = inner.indexOf("\n完整日志：");
    if (logIdx >= 0) inner = inner.slice(0, logIdx);
    text = inner.trim();
  }

  // 1. 直接解析整段文本
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}

  const pickBest = (list) => {
    // 优先取含 family 或 tier 键的最后一个合法对象，否则取最后一个合法对象
    for (let i = list.length - 1; i >= 0; i--) {
      if ("family" in list[i] || "tier" in list[i]) return list[i];
    }
    return list.length ? list[list.length - 1] : null;
  };

  // 2. 提取 markdown ```json ... ``` 或 ``` ... ``` 代码块
  const fenceObjs = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fenceObjs.push(parsed);
    } catch {}
  }
  const fromFence = pickBest(fenceObjs);
  if (fromFence) return fromFence;

  // 3. 括号平衡扫描提取顶层 JSON 对象
  const scanObjs = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) scanObjs.push(parsed);
          } catch {}
          start = -1;
        }
      }
    }
  }
  return pickBest(scanObjs);
}

// 严格校验员工调研 JSON；任何字段缺失或取值非法直接拒绝，不猜测兜底
export function validateResearchResult(raw, { expectedFamily, requiredRoles = DEFAULT_ROLES } = {}) {
  const data = extractJsonObject(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "调研输出不是合法 JSON 对象" };
  }

  if (typeof data.family !== "string" || !data.family.trim()) {
    return { ok: false, error: "缺少合法的 family 字段" };
  }
  if (expectedFamily) {
    const normFam = (s) => String(s || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
    if (normFam(data.family) !== normFam(expectedFamily)) {
      return { ok: false, error: `family 不匹配：期望 ${expectedFamily}，收到 ${data.family}` };
    }
  }

  if (typeof data.tier !== "string" || !VALID_TIERS.includes(data.tier)) {
    return { ok: false, error: `tier 取值非法（必须是 ${VALID_TIERS.join("/")}），收到：${String(data.tier)}` };
  }

  if (typeof data.vision !== "boolean") {
    return { ok: false, error: `vision 必须是布尔值，收到：${typeof data.vision}` };
  }

  if (!data.fits || typeof data.fits !== "object" || Array.isArray(data.fits)) {
    return { ok: false, error: "缺少合法的 fits 对象" };
  }
  const fitKeys = Object.keys(data.fits);
  if (!fitKeys.length) {
    return { ok: false, error: "fits 不能为空" };
  }
  for (const role of requiredRoles) {
    if (!Object.prototype.hasOwnProperty.call(data.fits, role)) {
      return { ok: false, error: `fits 缺少角色 ${role}` };
    }
  }
  const cleanFits = {};
  for (const [role, val] of Object.entries(data.fits)) {
    if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 1) {
      return { ok: false, error: `fits.${role} 必须是 0–1 之间的数字，收到：${String(val)}` };
    }
    cleanFits[role] = val;
  }

  if (!Array.isArray(data.evidence) || data.evidence.length === 0) {
    return { ok: false, error: "evidence 必须是非空 URL 数组" };
  }
  const cleanEvidence = [];
  for (const item of data.evidence) {
    if (typeof item !== "string" || !/^https?:\/\/\S+$/i.test(item.trim())) {
      return { ok: false, error: `evidence 包含非法链接：${String(item)}` };
    }
    cleanEvidence.push(item.trim());
  }

  if (typeof data.reason !== "string" || !data.reason.trim()) {
    return { ok: false, error: "缺少非空的 reason 字段" };
  }

  return {
    ok: true,
    value: {
      family: expectedFamily || data.family.trim(),
      tier: data.tier,
      vision: data.vision,
      fits: cleanFits,
      evidence: cleanEvidence,
      reason: data.reason.trim(),
    },
  };
}

// 默认调研实现：通过 relay run auto --role deep --needs web 派一个只读联网调研任务
export function defaultResearchModel({ provider, providerLabel, family, variants, pool, roles, stateDir = STATE_DIR, timeoutMs = 300_000 }) {
  const probeDir = path.join(stateDir, "probe");
  fs.mkdirSync(probeDir, { recursive: true });
  const brief = buildResearchBrief({ provider, providerLabel, family, variants, pool, roles });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out);
    };

    const child = spawn(
      process.execPath,
      [RELAY_SCRIPT, "run", "auto", "--role", "deep", "--level", "中等", "--needs", "web", "--skip-codex", "--cwd", probeDir],
      {
        cwd: probeDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, AI_RELAY_HOME: stateDir },
      },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      finish(new Error(`调研任务超时（>${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error((stderr || stdout || `调研派单退出码 ${code}`).trim().slice(0, 300)));
      } else {
        finish(null, stdout);
      }
    });

    child.stdin.write(brief);
    child.stdin.end();
  });
}

// 判断某角色路由里是否已有同一厂商、同一家族的条目（支持解析 default 到 defaultModels）
function routeHasFamily(cfg, routeEntries, provName, family) {
  const targetFam = String(family || "").toLowerCase();
  for (const entry of routeEntries || []) {
    const [eProv, ePool, eModel] = String(entry || "").split(":");
    if (eProv !== provName) continue;
    const resolved = resolveModel(cfg, eProv, ePool, eModel);
    if (modelFamily(resolved).toLowerCase() === targetFam) return true;
  }
  return false;
}

// 将一个已归池、已调研通过的新家族增量写入 cfg（只增不改不删，不覆盖用户已有项），返回足够精确回滚的 changes 对象
export function applyFamilyToConfig(cfg, { provider, family, pool, poolSource, variants, bestModel, research }) {
  const prov = cfg?.providers?.[provider];
  if (!prov) throw new Error(`未知厂商 ${provider}`);

  const changes = {
    poolRule: null,
    poolRulesCreated: false,
    poolsAdded: [],
    poolCreated: false,
    modelTierKey: null,
    modelTierValue: null,
    modelTiersCreated: false,
    modelCapsAdded: [],
    modelCapsCreated: false,
    routesAdded: [],
  };

  // 1. 若通过 AIQuota5h 归池，补一条家族关键字 → 池的 poolRules 规则
  if (poolSource === "aiquota") {
    const pattern = escapeRegex(family);
    if (!Array.isArray(prov.poolRules)) {
      prov.poolRules = [];
      changes.poolRulesCreated = true;
    }
    const exists = prov.poolRules.some((r) => Array.isArray(r) && String(r[0]).toLowerCase() === pattern.toLowerCase());
    if (!exists) {
      prov.poolRules.unshift([pattern, pool]);
      changes.poolRule = [pattern, pool];
    }
  }

  // 2. 家族所有思考档加入 pools[pool]（按思考档从高到低，已有跳过）
  if (!prov.pools || typeof prov.pools !== "object") prov.pools = {};
  if (!Array.isArray(prov.pools[pool])) {
    prov.pools[pool] = [];
    changes.poolCreated = true;
  }
  const orderedIds = sortVariantsDesc(variants).map((v) => (typeof v === "string" ? v : v.id));
  for (const id of orderedIds) {
    if (!prov.pools[pool].includes(id)) {
      prov.pools[pool].push(id);
      changes.poolsAdded.push(id);
    }
  }

  // 3. cfg.modelTiers["厂商:家族前缀*"] = tier（已有不覆盖）
  const tierKey = `${provider}:${family}*`;
  if (!cfg.modelTiers || typeof cfg.modelTiers !== "object" || Array.isArray(cfg.modelTiers)) {
    cfg.modelTiers = {};
    changes.modelTiersCreated = true;
  }
  const hasTier = Object.keys(cfg.modelTiers).some((k) => k.toLowerCase() === tierKey.toLowerCase());
  if (!hasTier) {
    cfg.modelTiers[tierKey] = research.tier;
    changes.modelTierKey = tierKey;
    changes.modelTierValue = research.tier;
  } else if (changes.modelTiersCreated) {
    delete cfg.modelTiers;
    changes.modelTiersCreated = false;
  }

  // 4. vision 写 provider.modelCaps（逐变体写入，已有该模型的 vision 配置则不覆盖）
  const hadModelCaps = !!(prov.modelCaps && typeof prov.modelCaps === "object" && !Array.isArray(prov.modelCaps));
  if (!hadModelCaps) {
    prov.modelCaps = {};
    changes.modelCapsCreated = true;
  }
  for (const id of orderedIds) {
    const existing = prov.modelCaps[id];
    if (existing && typeof existing.vision === "boolean") continue;
    const createdEntry = !existing;
    if (!existing) prov.modelCaps[id] = {};
    prov.modelCaps[id].vision = research.vision;
    changes.modelCapsAdded.push({ model: id, cap: "vision", value: research.vision, createdEntry });
  }
  if (changes.modelCapsCreated && changes.modelCapsAdded.length === 0) {
    delete prov.modelCaps;
    changes.modelCapsCreated = false;
  }

  // 5. 对 fits >= 0.5 的角色往 routes 追加 "厂商:池:最高思考档:fit"（fit 夹在 0.4–0.95）；已有同家族条目不加
  const highest = bestModel || pickHighestVariant(orderedIds);
  for (const [role, rawFit] of Object.entries(research.fits || {})) {
    if (rawFit < 0.5) continue;
    const list = cfg.routes?.[role];
    if (!Array.isArray(list)) continue;
    if (routeHasFamily(cfg, list, provider, family)) continue;
    const clampedFit = Math.round(Math.min(0.95, Math.max(0.4, rawFit)) * 100) / 100;
    const entry = `${provider}:${pool}:${highest}:${clampedFit}`;
    list.push(entry);
    changes.routesAdded.push({ role, entry });
  }

  const hasChanges = !!(
    changes.poolRule
    || changes.poolsAdded.length
    || changes.modelTierKey
    || changes.modelCapsAdded.length
    || changes.routesAdded.length
  );
  return { changes, hasChanges };
}

// 按日志记录里的 changes 精确撤销对 cfg 所做的改动，不碰用户原有或其他记录加的条目
export function revertChangesFromConfig(cfg, record) {
  const { provider, pool, changes = {} } = record || {};
  const prov = cfg?.providers?.[provider];
  const removed = {
    poolRule: false,
    pools: [],
    modelTier: false,
    modelCaps: [],
    routes: [],
  };

  if (prov) {
    // 1. 撤销 poolRule
    if (Array.isArray(changes.poolRule) && Array.isArray(prov.poolRules)) {
      const [pat, targetPool] = changes.poolRule;
      const idx = prov.poolRules.findIndex((r) => Array.isArray(r) && r[0] === pat && r[1] === targetPool);
      if (idx >= 0) {
        prov.poolRules.splice(idx, 1);
        removed.poolRule = true;
      }
      if (changes.poolRulesCreated && prov.poolRules.length === 0) {
        delete prov.poolRules;
      }
    }

    // 2. 撤销 pools[pool] 加入的变体
    if (Array.isArray(changes.poolsAdded) && changes.poolsAdded.length && Array.isArray(prov.pools?.[pool])) {
      for (const id of changes.poolsAdded) {
        const idx = prov.pools[pool].indexOf(id);
        if (idx >= 0) {
          prov.pools[pool].splice(idx, 1);
          removed.pools.push(id);
        }
      }
      if (changes.poolCreated && prov.pools[pool].length === 0) {
        delete prov.pools[pool];
      }
    }

    // 3. 撤销 modelCaps 写入的 vision
    if (Array.isArray(changes.modelCapsAdded) && prov.modelCaps && typeof prov.modelCaps === "object") {
      for (const item of changes.modelCapsAdded) {
        const capEntry = prov.modelCaps[item.model];
        if (!capEntry || typeof capEntry !== "object") continue;
        if (Object.prototype.hasOwnProperty.call(capEntry, item.cap)) {
          delete capEntry[item.cap];
          removed.modelCaps.push(item.model);
        }
        if (Object.keys(capEntry).length === 0) {
          delete prov.modelCaps[item.model];
        }
      }
      if (changes.modelCapsCreated && Object.keys(prov.modelCaps).length === 0) {
        delete prov.modelCaps;
      }
    }
  }

  // 4. 撤销 modelTiers 条目
  if (changes.modelTierKey && cfg?.modelTiers && Object.prototype.hasOwnProperty.call(cfg.modelTiers, changes.modelTierKey)) {
    delete cfg.modelTiers[changes.modelTierKey];
    removed.modelTier = true;
    if (changes.modelTiersCreated && Object.keys(cfg.modelTiers).length === 0) {
      delete cfg.modelTiers;
    }
  }

  // 5. 撤销 routes 追加的条目
  if (Array.isArray(changes.routesAdded)) {
    for (const item of changes.routesAdded) {
      const list = cfg?.routes?.[item.role];
      if (!Array.isArray(list)) continue;
      const idx = list.indexOf(item.entry);
      if (idx >= 0) {
        list.splice(idx, 1);
        removed.routes.push(item);
      }
    }
  }

  const changed = !!(
    removed.poolRule
    || removed.pools.length
    || removed.modelTier
    || removed.modelCaps.length
    || removed.routes.length
  );
  return { removed, changed };
}

// 判断一个厂商是否应参与自动模型发现（排除主控、已停用、按量白名单自定义接口）
function shouldDiscoverProvider(prov) {
  if (!prov || prov.self || !isEnabled(prov)) return false;
  if (prov.modelList?.format === "openai-http" || prov.endpoint) return false;
  return true;
}

// 生成人类可读的结果摘要
export function formatDiscoverSummary(result) {
  if (!result) return "";
  if (result.skipped && result.reason === "running") {
    return `已有新模型探测任务在运行${result.pid ? `（PID ${result.pid}）` : ""}，本次跳过`;
  }
  if (result.skipped && result.reason === "throttled") {
    const when = result.lastRunAt ? fmtTime(Date.parse(result.lastRunAt)) : "刚才";
    return `距上次探测不足 6 小时（上次：${when}），已跳过；加 --force 可立即探测`;
  }
  if (result.initial) {
    return `首次探测：已将当前 ${result.knownCount || 0} 个模型（${result.providerCount || 0} 家厂商）记为已知，未修改配置`;
  }

  const lines = [];
  const added = result.added || [];
  const unpooled = result.unpooled || [];
  const failed = result.failed || [];

  if (!added.length && !unpooled.length && !failed.length) {
    return "未发现新模型";
  }

  if (added.length) {
    lines.push(`已接入 ${added.length} 个新模型家族：`);
    for (const item of added) {
      const tierLabel = TIER_TEXT[item.tier] || item.tier;
      const visionLabel = item.vision ? "可看图" : "不可看图";
      const rolesText = (item.routesAdded || []).length
        ? item.routesAdded.map((r) => `${ROLE_TEXT[r.role] || r.role}(${r.entry.split(":")[3]})`).join("、")
        : "无新增角色路由";
      lines.push(`  - ${item.provider} / ${item.family}（池：${item.pool}，最高档：${item.bestModel}，${tierLabel}，${visionLabel}）`);
      lines.push(`    角色：${rolesText}`);
      if (item.reason) lines.push(`    依据：${item.reason}`);
      if (item.evidence?.length) lines.push(`    证据：${item.evidence.join(" , ")}`);
      if (item.id) lines.push(`    记录：${item.id}（撤销：relay models discover --undo ${item.id}）`);
    }
  }

  if (unpooled.length) {
    lines.push(`未归池（未接入）${unpooled.length} 个：`);
    for (const u of unpooled) {
      lines.push(`  - ${u.provider} / ${u.family}（变体：${(u.variants || []).join("、")}）`);
    }
  }

  if (failed.length) {
    lines.push(`调研失败（未接入）${failed.length} 个：`);
    for (const f of failed) {
      lines.push(`  - ${f.provider} / ${f.family}：${f.reason}`);
    }
  }

  return lines.join("\n");
}

function makeRecordId(provider, now) {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = crypto.randomBytes(2).toString("hex");
  return `disc-${stamp}-${provider}-${rand}`;
}

// 主流程：探测新模型、归池、联网调研、增量应用并记录状态与日志
export async function discoverModels(opts = {}) {
  const stateDir = opts.stateDir || STATE_DIR;
  const now = opts.now ?? Date.now();
  const isoNow = new Date(now).toISOString();
  const force = !!opts.force;
  const intervalMs = opts.intervalMs ?? DISCOVER_INTERVAL_MS;

  const state = loadDiscoverState(stateDir);
  const lastRunMs = state?.lastRunAt ? Date.parse(state.lastRunAt) : NaN;
  if (!force && Number.isFinite(lastRunMs) && now - lastRunMs < intervalMs) {
    const res = {
      at: isoNow,
      skipped: true,
      reason: "throttled",
      lastRunAt: state.lastRunAt,
      nextRunAt: new Date(lastRunMs + intervalMs).toISOString(),
      lastResult: state.lastResult || null,
    };
    res.summary = formatDiscoverSummary(res);
    return res;
  }

  const lock = acquireDiscoverLock(stateDir, now);
  if (!lock.ok) {
    const res = {
      at: isoNow,
      skipped: true,
      reason: "running",
      pid: lock.active?.pid || null,
      lastResult: state?.lastResult || null,
    };
    res.summary = formatDiscoverSummary(res);
    return res;
  }

  try {
    return await runDiscoverWithLock({ stateDir, now, isoNow, state, opts });
  } finally {
    lock.release();
  }
}

async function runDiscoverWithLock({ stateDir, now, isoNow, state, opts }) {
  const { cfg, configFile, fromDisk } = resolveConfigTarget(opts);
  const getModelsFn = opts.getModels || ((c, o) => getModels(c, o));
  const cache = await getModelsFn(cfg, { stateDir, refresh: true, now });

  // 首次运行：仅把当前所有模型记为已知，不做调研与接入
  const isFirstRun = !state || state.initialized !== true || !state.known || typeof state.known !== "object";
  if (isFirstRun) {
    const known = {};
    let knownCount = 0;
    let providerCount = 0;
    for (const [provName, entry] of Object.entries(cache?.providers || {})) {
      const prov = cfg.providers?.[provName];
      if (!shouldDiscoverProvider(prov)) continue;
      if (entry?.ok === false && (!Array.isArray(entry.models) || entry.models.length === 0)) continue;
      const ids = new Set();
      for (const m of entry?.models || []) {
        if (m?.id) ids.add(m.id);
      }
      for (const id of Object.values(prov.pools || {}).flat()) {
        if (id && id !== "default") ids.add(id);
      }
      known[provName] = [...ids];
      knownCount += ids.size;
      providerCount += 1;
    }
    const result = {
      at: isoNow,
      initial: true,
      skipped: false,
      knownCount,
      providerCount,
      added: [],
      unpooled: [],
      failed: [],
    };
    result.summary = formatDiscoverSummary(result);
    saveDiscoverState(stateDir, {
      version: 1,
      initialized: true,
      lastRunAt: isoNow,
      known,
      lastResult: result,
    });
    return result;
  }

  // 非首次运行：按厂商找出新模型与未归池模型，按家族去重
  const known = {};
  for (const [k, list] of Object.entries(state.known || {})) {
    known[k] = Array.isArray(list) ? [...new Set(list.filter((x) => typeof x === "string"))] : [];
  }

  const failCooldownMs = opts.failCooldownMs ?? DISCOVER_FAIL_COOLDOWN_MS;
  const failedFamilies = loadActiveFailedFamilies(state, now, failCooldownMs);
  const undoneFamilyKeys = collectUndoneFamilyKeys(stateDir);

  const unpooled = [];
  const failed = [];
  const pendingApply = [];
  const researchFn = opts.research || defaultResearchModel;
  const requiredRoles = Object.keys(cfg.routes || {}).length ? Object.keys(cfg.routes) : DEFAULT_ROLES;

  for (const [provName, entry] of Object.entries(cache?.providers || {})) {
    const prov = cfg.providers?.[provName];
    if (!shouldDiscoverProvider(prov)) continue;
    if (entry?.ok === false) continue;

    const allModels = Array.isArray(entry?.models) ? entry.models.filter((m) => m && typeof m.id === "string" && m.id) : [];

    // 某厂商之前从未记录过基线（例如新增厂商或首次拉取失败）：建立该厂商基线，不把老模型全当新模型
    if (!Object.prototype.hasOwnProperty.call(known, provName)) {
      const baseIds = new Set(allModels.map((m) => m.id));
      for (const id of Object.values(prov.pools || {}).flat()) {
        if (id && id !== "default") baseIds.add(id);
      }
      known[provName] = [...baseIds];
      continue;
    }

    // 过滤非模型家族条目（如 orchestrator 编排器），避免当作家族去归池或调研
    const discoverableModels = allModels.filter((m) => !isExcludedDiscoverModel(m));
    const knownSet = new Set(known[provName]);
    const hasValidPools = providerPools(prov).length > 0;
    // 候选条件：不在 known 里的新模型，或尚未归入任何额度池的模型（即使已在 known 里）
    const candidateModels = discoverableModels.filter(
      (m) => !knownSet.has(m.id) || (hasValidPools && !isModelPooled(prov, m.id)),
    );
    if (!candidateModels.length) continue;

    // 按家族去重：同一个家族只归池和调研一次
    const familyOrder = [];
    const familyCandidateMap = new Map();
    for (const m of candidateModels) {
      const fam = modelFamily(m.id);
      if (!familyCandidateMap.has(fam)) {
        familyOrder.push(fam);
        familyCandidateMap.set(fam, []);
      }
      familyCandidateMap.get(fam).push(m);
    }

    for (const family of familyOrder) {
      const famKey = familyKey(provName, family);
      // 已被用户 --undo 撤销的家族不再自动重新接入
      if (undoneFamilyKeys.has(famKey)) continue;
      // 调研失败或校验未通过且仍在冷却期内的家族，不反复调研
      if (Object.prototype.hasOwnProperty.call(failedFamilies, famKey)) continue;

      const familyVariants = sortVariantsDesc(discoverableModels.filter((m) => modelFamily(m.id) === family));
      const variantIds = familyVariants.map((m) => m.id);
      const bestModel = pickHighestVariant(familyVariants);

      // 1. 归池
      const { pool, source: poolSource } = await resolveFamilyPool(prov, provName, family, familyVariants, cfg, opts);
      if (!pool) {
        unpooled.push({
          provider: provName,
          family,
          variants: variantIds,
          reason: "poolRules 与 AIQuota5h 分组均未匹配到额度池",
        });
        continue;
      }

      // 2. 联网调研（按家族只调一次）
      let rawResearch;
      try {
        rawResearch = await researchFn({
          provider: provName,
          providerLabel: prov.label || provName,
          family,
          variants: familyVariants,
          pool,
          roles: requiredRoles,
          stateDir,
          timeoutMs: opts.researchTimeoutMs,
        });
      } catch (e) {
        const reason = `调研执行失败：${String(e.message || e).slice(0, 200)}`;
        failed.push({
          provider: provName,
          family,
          pool,
          variants: variantIds,
          reason,
        });
        failedFamilies[famKey] = { at: isoNow, reason };
        continue;
      }

      // 3. 严格校验调研 JSON
      const validated = validateResearchResult(rawResearch, { expectedFamily: family, requiredRoles });
      if (!validated.ok) {
        const reason = `调研结果非法：${validated.error}`;
        failed.push({
          provider: provName,
          family,
          pool,
          variants: variantIds,
          reason,
        });
        failedFamilies[famKey] = { at: isoNow, reason };
        continue;
      }

      pendingApply.push({
        provider: provName,
        family,
        famKey,
        pool,
        poolSource,
        variants: familyVariants,
        newIds: variantIds,
        bestModel,
        research: validated.value,
      });
    }
  }

  // 4. 调研全部完成后统一在最新配置上应用、备份并落盘，避免调研期间用户对配置的改动被覆盖，也确保 .bak 为本轮运行前快照
  const added = [];
  if (pendingApply.length) {
    const applyAll = (targetCfg) => {
      const logs = [];
      let dirty = false;
      for (const item of pendingApply) {
        const { changes, hasChanges } = applyFamilyToConfig(targetCfg, item);
        const set = new Set(known[item.provider] || []);
        for (const id of item.newIds) set.add(id);
        known[item.provider] = [...set];
        delete failedFamilies[item.famKey];
        if (!hasChanges) continue;
        dirty = true;
        const id = makeRecordId(item.provider, now);
        logs.push({
          id,
          at: isoNow,
          provider: item.provider,
          family: item.family,
          pool: item.pool,
          poolSource: item.poolSource,
          bestModel: item.bestModel,
          variants: item.variants.map((m) => m.id),
          research: item.research,
          changes,
        });
      }
      return { logs, dirty };
    };

    let logs = [];
    if (configFile) {
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      withFileLock(configFile, () => {
        const targetCfg = fromDisk && fs.existsSync(configFile)
          ? JSON.parse(fs.readFileSync(configFile, "utf8"))
          : cfg;
        const res = applyAll(targetCfg);
        logs = res.logs;
        if (res.dirty) {
          if (fs.existsSync(configFile)) {
            fs.copyFileSync(configFile, `${configFile}.bak`);
          }
          const data = { ...targetCfg };
          delete data._file;
          writeFileAtomic(configFile, JSON.stringify(data, null, 2) + "\n");
        }
      });
    } else {
      const res = applyAll(cfg);
      logs = res.logs;
    }

    for (const logRecord of logs) {
      appendDiscoverLog(stateDir, logRecord);
      added.push({
        id: logRecord.id,
        provider: logRecord.provider,
        family: logRecord.family,
        pool: logRecord.pool,
        poolSource: logRecord.poolSource,
        bestModel: logRecord.bestModel,
        variants: logRecord.variants,
        tier: logRecord.research.tier,
        vision: logRecord.research.vision,
        roles: logRecord.changes.routesAdded.map((r) => r.role),
        routesAdded: logRecord.changes.routesAdded,
        evidence: logRecord.research.evidence,
        reason: logRecord.research.reason,
      });
    }
  }

  const result = {
    at: isoNow,
    initial: false,
    skipped: false,
    added,
    unpooled,
    failed,
  };
  result.summary = formatDiscoverSummary(result);

  const nextState = {
    version: 1,
    initialized: true,
    lastRunAt: isoNow,
    known,
    ...(Object.keys(failedFamilies).length ? { failedFamilies } : {}),
    lastResult: result,
  };
  saveDiscoverState(stateDir, nextState);

  return result;
}

// 精确撤销某一条自动接入记录
export function undoDiscover(recordId, opts = {}) {
  const id = String(recordId || "").trim();
  if (!id) throw new Error("用法：relay models discover --undo <记录id>");
  const stateDir = opts.stateDir || STATE_DIR;
  const now = opts.now ?? Date.now();
  const isoNow = new Date(now).toISOString();

  const records = readDiscoverLog(stateDir);
  const record = records.find((r) => r.id === id);
  if (!record) throw new Error(`找不到自动接入记录 ${id}（用 relay models discover --list 查看记录 id）`);
  if (record.undone) throw new Error(`记录 ${id} 已在 ${record.undoneAt || "之前"} 撤销过`);

  const { cfg, configFile } = resolveConfigTarget(opts);
  const { removed, changed } = revertChangesFromConfig(cfg, record);
  if (changed && configFile) {
    saveConfigWithBackup(cfg, configFile);
  }

  appendDiscoverLog(stateDir, {
    type: "undo",
    id,
    undoneAt: isoNow,
    removed,
  });

  return {
    id,
    provider: record.provider,
    family: record.family,
    undoneAt: isoNow,
    changed,
    removed,
  };
}

export function listDiscoverRecords(opts = {}) {
  const stateDir = opts.stateDir || STATE_DIR;
  return readDiscoverLog(stateDir);
}

export function formatDiscoverList(records) {
  if (!records.length) return "还没有新模型自动接入记录";
  const lines = [];
  for (const r of records) {
    const when = r.at ? fmtTime(Date.parse(r.at)) : "?";
    const status = r.undone ? "已撤销" : "已生效";
    const tier = TIER_TEXT[r.research?.tier] || r.research?.tier || "?";
    const roles = (r.changes?.routesAdded || []).map((x) => ROLE_TEXT[x.role] || x.role).join("、") || "无";
    lines.push(`${r.id}  [${status}]  ${when}  ${r.provider}/${r.family}  池:${r.pool}  ${tier}  角色:${roles}`);
  }
  return lines.join("\n");
}

// CLI 子命令入口：relay models discover [--force] [--background] [--json] | --list | --undo <id> | --help
export async function cmdModelsDiscover(opts) {
  if (opts.help || opts._.includes("-h")) {
    console.log(DISCOVER_HELP);
    return;
  }

  if (opts.list) {
    const records = listDiscoverRecords({ stateDir: STATE_DIR });
    if (opts.json) {
      console.log(JSON.stringify({ records }, null, 2));
    } else {
      console.log(formatDiscoverList(records));
    }
    return;
  }

  if (Object.prototype.hasOwnProperty.call(opts, "undo")) {
    const id = typeof opts.undo === "string" ? opts.undo : "";
    if (!id) throw new Error("用法：relay models discover --undo <记录id>");
    const res = undoDiscover(id, { stateDir: STATE_DIR });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`已撤销记录 ${res.id}（${res.provider} / ${res.family}）`);
    }
    return;
  }

  if (opts.background) {
    const active = runningDiscoverLock(STATE_DIR);
    if (active) {
      const runningRes = { at: new Date().toISOString(), skipped: true, reason: "running", pid: active.pid };
      runningRes.summary = formatDiscoverSummary(runningRes);
      if (opts.json) console.log(JSON.stringify(runningRes, null, 2));
      else console.log(runningRes.summary);
      return;
    }
    // 非 --force 时先做一次节流检查，避免无效拉起后台进程
    if (!opts.force) {
      const state = loadDiscoverState(STATE_DIR);
      const lastRunMs = state?.lastRunAt ? Date.parse(state.lastRunAt) : NaN;
      if (Number.isFinite(lastRunMs) && Date.now() - lastRunMs < DISCOVER_INTERVAL_MS) {
        const skipped = {
          at: new Date().toISOString(),
          skipped: true,
          reason: "throttled",
          lastRunAt: state.lastRunAt,
          nextRunAt: new Date(lastRunMs + DISCOVER_INTERVAL_MS).toISOString(),
          lastResult: state.lastResult || null,
        };
        skipped.summary = formatDiscoverSummary(skipped);
        if (opts.json) console.log(JSON.stringify(skipped, null, 2));
        else console.log(skipped.summary);
        return;
      }
    }
    const args = [RELAY_SCRIPT, "models", "discover", ...(opts.force ? ["--force"] : [])];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    if (opts.json) {
      console.log(JSON.stringify({ started: true, background: true, pid: child.pid }, null, 2));
    } else {
      console.log(`已在后台启动新模型探测（PID ${child.pid}）`);
    }
    return;
  }

  const res = await discoverModels({ stateDir: STATE_DIR, force: !!opts.force });
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(res.summary);
  }
}
