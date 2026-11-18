// ai-relay 模型清单与额度池默认模型：解析各家 CLI 模型列表、缓存（6 小时）、按规则归池、设置默认模型
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadSecrets, poolOfModel, providerPools, resolveBin } from "./lib.mjs";

export const MODEL_CACHE_TTL_MS = 6 * 3600_000;
export const NEW_MODEL_WINDOW_MS = 7 * 24 * 3600_000;
export const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

export function modelsCachePath(stateDir) {
  return path.join(stateDir, "models-cache.json");
}

export function loadModelsCache(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(modelsCachePath(stateDir), "utf8"));
  } catch {
    return null;
  }
}

export function cacheIsStale(cache, now = Date.now()) {
  if (!cache || typeof cache !== "object" || !cache.updatedAt || !cache.providers) return true;
  const ts = Date.parse(cache.updatedAt);
  return Number.isNaN(ts) || now - ts >= MODEL_CACHE_TTL_MS;
}

export const isModelsCacheExpired = cacheIsStale;

export function isModelNew(firstSeen, now = Date.now()) {
  if (typeof firstSeen !== "string" || !firstSeen) return false;
  const ts = Date.parse(firstSeen);
  return !Number.isNaN(ts) && now - ts < NEW_MODEL_WINDOW_MS;
}

// 解析 ~/.codex/config.toml 顶层的 model = "..."（出现在第一个 [section] 之前）
export function parseCodexDefault(tomlText) {
  if (!tomlText) return null;
  for (const raw of String(tomlText).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const m = line.match(/^model\s*=\s*["']([^"']+)["']/);
    if (m) return m[1].trim() || null;
  }
  return null;
}

// 1. Codex：`codex debug models` 输出 JSON {"models":[{"slug","display_name","visibility","priority",...}]}
//    只取 visibility == "list" 的，按 priority 升序
export function parseCodexModels(text, configToml = "") {
  let data;
  try {
    data = JSON.parse(String(text || "").trim());
  } catch {
    throw new Error("codex debug models 输出不是有效 JSON");
  }
  if (!Array.isArray(data?.models)) {
    throw new Error("codex debug models 缺少 models 数组");
  }
  const models = data.models
    .filter((m) => m && m.visibility === "list" && typeof m.slug === "string" && m.slug.trim())
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => {
      const id = m.slug.trim();
      const label = typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : id;
      return { id, label };
    });
  if (!models.length) {
    throw new Error("codex debug models 没有返回可用模型");
  }
  return { cliDefault: parseCodexDefault(configToml), models };
}

// 2. agy：`agy models` 第一行可能是 Fetching available models...（或含 \r 的加载帧），之后每行 <id>\t<显示名>（或空格分隔）
export function parseAgyModels(text) {
  const clean = String(text || "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const models = [];
  const seen = new Set();
  for (const raw of clean.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line || /fetching available models/i.test(line)) continue;
    const m = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\t+|\s+)(.+)$/);
    if (!m) continue;
    const id = m[1].trim();
    const label = m[2].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: label || id });
  }
  if (!models.length) {
    throw new Error("agy models 没有返回可识别的模型");
  }
  return { cliDefault: null, models };
}

// 3. Grok：`grok models` 输出 Default model: <id> 及 Available models: 下的 - / * 列表
export function parseGrokModels(text) {
  const clean = String(text || "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  let cliDefault = null;
  const models = [];
  const seen = new Set();
  for (const raw of clean.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const defMatch = line.match(/^Default model:\s*(\S+)/i);
    if (defMatch) {
      cliDefault = defMatch[1].trim();
      continue;
    }
    const itemMatch = line.match(/^([-*])\s+(.+)$/);
    if (!itemMatch) continue;
    const isStar = itemMatch[1] === "*";
    let id = itemMatch[2].replace(/\s*\(default\)\s*$/i, "").trim();
    if (!id || seen.has(id)) continue;
    if (isStar && !cliDefault) cliDefault = id;
    seen.add(id);
    models.push({ id, label: id });
  }
  if (!models.length) {
    throw new Error("grok models 没有返回可识别的模型");
  }
  return { cliDefault, models };
}

// 按厂商配置将模型归入额度池：
//   - 只有一个额度池的厂商：全部归该池
//   - 多额度池厂商：按 poolRules [["正则", "pool"], ...] 顺序取第一个命中的，都不命中为 null
export function assignPool(prov, modelId) {
  if (!prov || !modelId) return null;
  const pools = providerPools(prov);
  if (pools.length === 1) return pools[0];
  if (pools.length === 0) return null;
  for (const rule of prov.poolRules || []) {
    if (!Array.isArray(rule) || rule.length < 2) continue;
    const [pattern, pool] = rule;
    if (new RegExp(pattern, "i").test(modelId)) return pool;
  }
  return null;
}

function readCodexConfigToml() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    return fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return "";
  }
}

function execCliAsync(bin, args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out);
    };
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(new Error(`命令超时（>${Math.round(timeoutMs / 1000)}s）`));
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
        finish(new Error((stderr || stdout || `退出码 ${code}`).trim().slice(0, 200)));
      } else {
        finish(null, stdout);
      }
    });
  });
}

// OpenAI 兼容的 GET /v1/models：取 data[].id。测试可以传入解析好的对象。
export function parseOpenAiHttpModels(text) {
  let data = text;
  if (typeof text === "string") {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("模型列表不是有效 JSON");
    }
  }
  const rows = Array.isArray(data?.data) ? data.data : [];
  const models = [];
  const seen = new Set();
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  if (!models.length) throw new Error("接口没有返回模型");
  return { cliDefault: null, models };
}

// 请求 {baseUrl}/v1/models。fetchImpl 留给测试替换，默认用全局 fetch。密钥只放在请求头里。
export async function fetchOpenAiModelList(baseUrl, apiKey, { fetchImpl, timeoutMs = 60_000 } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("当前环境不能发 HTTP 请求");
  const root = String(baseUrl || "").replace(/\/+$/, "");
  if (!root) throw new Error("没有配置接口地址");
  const url = `${root}/v1/models`;
  const ctrl = typeof AbortController === "undefined" ? null : new AbortController();
  const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: ctrl?.signal,
    });
    if (!res?.ok) {
      throw new Error(res?.status ? `获取模型列表失败：HTTP ${res.status}` : "获取模型列表失败");
    }
    if (typeof res.text === "function") return await res.text();
    if (typeof res.json === "function") return JSON.stringify(await res.json());
    throw new Error("获取模型列表失败：没有响应正文");
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`命令超时（>${Math.round(timeoutMs / 1000)}s）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseByFormat(format, stdout) {
  if (format === "codex-json") return parseCodexModels(stdout, readCodexConfigToml());
  if (format === "agy-table") return parseAgyModels(stdout);
  if (format === "grok-list") return parseGrokModels(stdout);
  if (format === "openai-http") return parseOpenAiHttpModels(stdout);
  throw new Error(`不支持的模型列表格式 ${format}`);
}

async function loadCliModels(name, prov, probeDir, timeoutMs) {
  const binName = prov.cli?.bin || (prov.via === "codex-plugin" ? "codex" : null);
  const bin = binName ? resolveBin(binName) : null;
  if (!bin) throw new Error(`找不到 ${binName || name} 命令`);
  const stdout = await execCliAsync(bin, prov.modelList.cmd || [], { cwd: probeDir, timeoutMs });
  return parseByFormat(prov.modelList.format, stdout);
}

async function loadOpenAiHttpModels(name, prov, opts) {
  const secretName = prov.endpoint?.secret;
  if (!secretName) throw new Error(`还没有密钥。请运行 relay provider key ${name}`);
  const secrets = opts.secrets ?? loadSecrets();
  const key = secrets?.[secretName];
  if (typeof key !== "string" || !key) throw new Error(`还没有密钥。请运行 relay provider key ${name}`);
  const baseUrl = String(prov.endpoint?.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("没有配置接口地址");
  const body = await fetchOpenAiModelList(baseUrl, key, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
  return parseByFormat("openai-http", body);
}

// 提取缓存里某厂商已有模型的首次出现时间映射；首次被拉取的厂商返回 null
function buildPrevFirstSeenMap(prevCache, name) {
  const prev = prevCache?.providers?.[name];
  const prevModels = Array.isArray(prev?.models) ? prev.models : [];
  if (!prevModels.length) return null;
  const map = new Map();
  // 升级前的老缓存没有 firstSeen 字段：把当时已有的模型记为很早以前，避免全标成新模型
  for (const m of prevModels) {
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const seen = typeof m.firstSeen === "string" && m.firstSeen ? m.firstSeen : EPOCH_ISO;
    map.set(m.id, seen);
  }
  if (prev?.firstSeen && typeof prev.firstSeen === "object") {
    for (const [id, seen] of Object.entries(prev.firstSeen)) {
      if (id && typeof seen === "string" && seen && !map.has(id)) {
        map.set(id, seen);
      }
    }
  }
  return map.size ? map : null;
}

// 补齐模型条目的 firstSeen、isNew、unpooled，并把新模型排在前面（其余保持原顺序）
function enrichAndSortModels(models, prov, now) {
  if (!Array.isArray(models)) return [];
  const enriched = models.map((m) => {
    let pool = m.pool !== undefined ? m.pool : (prov ? assignPool(prov, m.id) : null);
    // 缓存里记的「未归池」按当前规则重算：用户刚用 provider pool-rule 指定的池不用等下次拉清单才生效。
    // 自定义接口的模型带 enabled 字段，未启用的本来就该不归池，不重算
    if (pool === null && prov && m.enabled === undefined) pool = assignPool(prov, m.id);
    const firstSeen = typeof m.firstSeen === "string" && m.firstSeen ? m.firstSeen : EPOCH_ISO;
    const isNew = isModelNew(firstSeen, now);
    const row = {
      ...m,
      pool,
      firstSeen,
      isNew,
    };
    if (pool === null) row.unpooled = true;
    else delete row.unpooled;
    return row;
  });
  const newOnes = enriched.filter((m) => m.isNew);
  const oldOnes = enriched.filter((m) => !m.isNew);
  return [...newOnes, ...oldOnes];
}

// 并行拉取所有配置了 modelList 的厂商模型清单，写入 models-cache.json
// 某家失败时保留它上次的模型列表，并标 ok:false 和 error
export async function refreshModels(cfg, opts = {}) {
  const { stateDir, now = Date.now(), timeoutMs = 60_000 } = opts;
  const prevCache = loadModelsCache(stateDir);
  const isoNow = new Date(now).toISOString();
  const probeDir = path.join(stateDir, "probe");
  fs.mkdirSync(probeDir, { recursive: true });

  const entries = Object.entries(cfg?.providers || {}).filter(([, prov]) => prov && prov.modelList);
  const results = await Promise.all(
    entries.map(async ([name, prov]) => {
      const prev = prevCache?.providers?.[name];
      const prevSeenMap = buildPrevFirstSeenMap(prevCache, name);
      try {
        const parsed = prov.modelList.format === "openai-http"
          ? await loadOpenAiHttpModels(name, prov, { ...opts, timeoutMs })
          : await loadCliModels(name, prov, probeDir, timeoutMs);
        const allow = new Set(Object.values(prov.pools || {}).flat().filter((id) => id && id !== "default"));
        const markEnabled = prov.modelList.format === "openai-http";
        const firstSeenMap = prevSeenMap ? Object.fromEntries(prevSeenMap) : {};
        const rawModels = parsed.models.map((m) => {
          const enabled = allow.has(m.id);
          const pool = markEnabled ? (enabled ? assignPool(prov, m.id) : null) : assignPool(prov, m.id);
          // 某厂商第一次被拉取时全部记为老模型；否则沿用上次 firstSeen，首次出现记为当前时间
          const firstSeen = prevSeenMap ? (prevSeenMap.get(m.id) || isoNow) : EPOCH_ISO;
          firstSeenMap[m.id] = firstSeen;
          const row = {
            id: m.id,
            label: m.label || m.id,
            // 没进白名单的模型不归池，避免被当成可以派的模型
            pool,
            firstSeen,
          };
          if (markEnabled) row.enabled = enabled;
          return row;
        });
        const models = enrichAndSortModels(rawModels, prov, now);
        return [
          name,
          {
            ok: true,
            error: null,
            fetchedAt: isoNow,
            cliDefault: parsed.cliDefault ?? null,
            firstSeen: firstSeenMap,
            models,
          },
        ];
      } catch (e) {
        const fallbackModels = enrichAndSortModels(prev?.models || [], prov, now);
        const fallbackFirstSeen = prevSeenMap ? Object.fromEntries(prevSeenMap) : {};
        return [
          name,
          {
            ok: false,
            error: String(e.message || e).slice(0, 200),
            fetchedAt: prev?.fetchedAt || null,
            cliDefault: prev?.cliDefault ?? null,
            firstSeen: fallbackFirstSeen,
            models: fallbackModels,
          },
        ];
      }
    }),
  );

  const cache = {
    updatedAt: isoNow,
    stale: false,
    providers: Object.fromEntries(results),
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modelsCachePath(stateDir), JSON.stringify(cache, null, 2) + "\n");
  return cache;
}

// 读取模型清单缓存：不带 refresh 且缓存没过期时直接返回缓存；过期、无缓存或指定 refresh 时重新拉取，
// 这样不点刷新也能在 6 小时内看到新模型。allowStale 为真时过期也先返回旧缓存（附 stale: true），由调用方决定何时刷新
export async function getModels(cfg, opts = {}) {
  const { stateDir, refresh = false, allowStale = false, now = Date.now() } = opts;
  if (!refresh) {
    const cache = loadModelsCache(stateDir);
    if (cache && typeof cache === "object" && cache.updatedAt && cache.providers && typeof cache.providers === "object" && (allowStale || !cacheIsStale(cache, now))) {
      const stale = cacheIsStale(cache, now);
      const providers = {};
      for (const [name, entry] of Object.entries(cache.providers)) {
        if (!entry || typeof entry !== "object") continue;
        const prov = cfg?.providers?.[name];
        providers[name] = {
          ...entry,
          models: enrichAndSortModels(entry.models || [], prov, now),
        };
      }
      return {
        ...cache,
        stale,
        providers,
      };
    }
  }
  return refreshModels(cfg, { ...opts, stateDir, now });
}

// 查找具体模型所属的额度池：先查配置的 pools，再查模型清单缓存里归属了额度池的模型
export function findModelPool(prov, provName, modelId, modelsCache) {
  if (!prov || !modelId) return null;
  const fromCfg = poolOfModel(prov, modelId);
  if (fromCfg) return fromCfg;
  const cached = modelsCache?.providers?.[provName]?.models;
  if (Array.isArray(cached)) {
    const hit = cached.find((m) => m.id === modelId);
    if (hit) return hit.pool ?? assignPool(prov, hit.id);
  }
  return null;
}

// 校验并设置某厂商某额度池的默认模型（修改 cfg.providers[name].defaultModels）
export function setProviderDefaultModel(cfg, name, pool, modelId, modelsCache) {
  if (!name || !pool || !modelId) {
    throw new Error("用法：provider model <厂商> <额度池> <模型id|default>");
  }
  const prov = cfg?.providers?.[name];
  if (!prov || prov.self) {
    throw new Error(`未知厂商 ${name}`);
  }
  const pools = providerPools(prov);
  if (!pools.includes(pool)) {
    throw new Error(`厂商 ${name} 没有额度池 ${pool}（可选：${pools.join(", ")}）`);
  }
  if (modelId === "default") {
    if (pools.length > 1) {
      throw new Error(`${name} 有多个额度池，必须为每个额度池设置具体默认模型，不能设为 default`);
    }
    if (prov.defaultModels) {
      delete prov.defaultModels[pool];
      if (!Object.keys(prov.defaultModels).length) delete prov.defaultModels;
    }
    return { provider: name, pool, model: null };
  }

  const inCfgPool = (prov.pools?.[pool] || []).filter((m) => m !== "default").includes(modelId);
  const cachedList = modelsCache?.providers?.[name]?.models || [];
  const cachedHit = cachedList.find((m) => m.id === modelId);
  const cachedPool = cachedHit ? (cachedHit.pool ?? assignPool(prov, cachedHit.id)) : null;
  const inCachePool = !!cachedHit && cachedPool === pool;

  if (!inCfgPool && !inCachePool) {
    if (cachedHit && cachedPool !== pool) {
      throw new Error(`模型 ${modelId} 属于额度池 ${cachedPool || "未归池"}，不属于 ${name}/${pool}`);
    }
    throw new Error(`模型 ${modelId} 不在 ${name}/${pool} 的模型清单或配置中`);
  }

  if (!prov.defaultModels) prov.defaultModels = {};
  prov.defaultModels[pool] = modelId;
  return { provider: name, pool, model: modelId };
}

// 为 relay providers --json 构建每个厂商的 modelPools 字段
// 主模型（self）和没有模型清单配置的厂商，返回空数组
export function buildModelPools(cfg, name, prov) {
  if (!prov || prov.self || !prov.modelList) return [];
  const pools = providerPools(prov);
  const allowCliDefault = pools.length <= 1;
  return pools.map((pool) => {
    const followRoles = [];
    const fixedRoles = [];
    for (const [role, entries] of Object.entries(cfg?.routes || {})) {
      for (const entry of entries || []) {
        const [pName, pPool, rModel] = entry.split(":");
        if (pName !== name || pPool !== pool) continue;
        if (rModel === "default") {
          if (!followRoles.includes(role)) followRoles.push(role);
        } else if (rModel) {
          fixedRoles.push({ role, model: rModel });
        }
      }
    }
    return {
      pool,
      label: prov.poolLabels?.[pool] || pool,
      current: prov.defaultModels?.[pool] || null,
      allowCliDefault,
      followRoles,
      fixedRoles,
    };
  });
}
