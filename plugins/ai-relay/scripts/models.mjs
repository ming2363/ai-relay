// ai-relay 模型清单与额度池默认模型：解析各家 CLI 模型列表、缓存（24 小时）、按规则归池、设置默认模型
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { poolOfModel, providerPools, resolveBin } from "./lib.mjs";

export const MODEL_CACHE_TTL_MS = 24 * 3600_000;

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

export function isModelsCacheExpired(cache, now = Date.now()) {
  if (!cache || typeof cache !== "object" || !cache.updatedAt || !cache.providers) return true;
  const ts = Date.parse(cache.updatedAt);
  return Number.isNaN(ts) || now - ts >= MODEL_CACHE_TTL_MS;
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

function parseByFormat(format, stdout) {
  if (format === "codex-json") return parseCodexModels(stdout, readCodexConfigToml());
  if (format === "agy-table") return parseAgyModels(stdout);
  if (format === "grok-list") return parseGrokModels(stdout);
  throw new Error(`不支持的模型列表格式 ${format}`);
}

// 并行拉取所有配置了 modelList 的厂商模型清单，写入 models-cache.json
// 某家失败时保留它上次的模型列表，并标 ok:false 和 error
export async function refreshModels(cfg, { stateDir, now = Date.now(), timeoutMs = 60_000 } = {}) {
  const prevCache = loadModelsCache(stateDir);
  const isoNow = new Date(now).toISOString();
  const probeDir = path.join(stateDir, "probe");
  fs.mkdirSync(probeDir, { recursive: true });

  const entries = Object.entries(cfg?.providers || {}).filter(([, prov]) => prov && prov.modelList);
  const results = await Promise.all(
    entries.map(async ([name, prov]) => {
      const prev = prevCache?.providers?.[name];
      try {
        const binName = prov.cli?.bin || (prov.via === "codex-plugin" ? "codex" : null);
        const bin = binName ? resolveBin(binName) : null;
        if (!bin) throw new Error(`找不到 ${binName || name} 命令`);
        const stdout = await execCliAsync(bin, prov.modelList.cmd || [], { cwd: probeDir, timeoutMs });
        const parsed = parseByFormat(prov.modelList.format, stdout);
        const models = parsed.models.map((m) => ({
          id: m.id,
          label: m.label || m.id,
          pool: assignPool(prov, m.id),
        }));
        return [
          name,
          {
            ok: true,
            error: null,
            fetchedAt: isoNow,
            cliDefault: parsed.cliDefault ?? null,
            models,
          },
        ];
      } catch (e) {
        return [
          name,
          {
            ok: false,
            error: String(e.message || e).slice(0, 200),
            fetchedAt: prev?.fetchedAt || null,
            cliDefault: prev?.cliDefault ?? null,
            models: prev?.models || [],
          },
        ];
      }
    }),
  );

  const cache = {
    updatedAt: isoNow,
    providers: Object.fromEntries(results),
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modelsCachePath(stateDir), JSON.stringify(cache, null, 2) + "\n");
  return cache;
}

// 读取模型清单缓存：不带 refresh 且缓存未超过 24 小时直接返回缓存，否则刷新
export async function getModels(cfg, { stateDir, refresh = false, now = Date.now(), timeoutMs = 60_000 } = {}) {
  if (!refresh) {
    const cache = loadModelsCache(stateDir);
    if (!isModelsCacheExpired(cache, now)) return cache;
  }
  return refreshModels(cfg, { stateDir, now, timeoutMs });
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
