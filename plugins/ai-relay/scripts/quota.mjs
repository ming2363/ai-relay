// ai-relay 自带的额度获取：不依赖 AIQuota5h，各家用各自官方工具或本地记录
//   Claude：由状态插件把当前会话的 rateLimits 传进来（插件接口 $.session.usage）
//   Codex ：读 ~/.codex/sessions 里最近一次会话记录中的 rate_limits（不联网）
//   agy   ：运行 `agy -p /usage`（斜杠命令，不消耗模型额度，约 3 秒）
//   Grok  ：官方 CLI 没有查额度的命令，直接查 grok.com 计费接口（用 CLI 登录令牌）；失败时沿用 AIQuota5h
// 结果写入 ~/.claude/ai-relay/quota-cache.json，钩子只读缓存，不在每条消息时现查
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CODEX_TAIL_BYTES = 256 * 1024;
const AGY_MIN_INTERVAL_MS = 5 * 60_000;
const AGY_GROUPS = { "Gemini Models": "gemini", "Claude and GPT models": "claude-gpt", "Gemini 4 Argon": "gemini-argon" };

export function cachePath(stateDir) {
  return path.join(stateDir, "quota-cache.json");
}

export function loadCache(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(stateDir), "utf8"));
  } catch {
    return { sources: {} };
  }
}

const row = (provider, pool, key, remaining, resetAt, updatedAt) => ({
  provider,
  pool_id: pool,
  window_key: key,
  remaining_fraction: remaining,
  reset_at: resetAt,
  allowance: remaining !== null && remaining <= 0 ? "exhausted" : "available",
  updated_at: updatedAt,
});

// Claude：插件传入的 [{ kind: five_hour|seven_day, percentUsed, resetsAt }]
export function claudeRows(limits, now) {
  const keyOf = { five_hour: "5h", seven_day: "weekly" };
  return (limits || [])
    .filter((l) => keyOf[l.kind] && typeof l.percentUsed === "number")
    .map((l) => row("claude", "claude-subscription", keyOf[l.kind], Math.max(0, 100 - l.percentUsed) / 100, l.resetsAt ? Date.parse(l.resetsAt) : null, now));
}

// Codex：找最近修改的会话文件，取文件尾部最后一条 rate_limits
export function codexRows(home = os.homedir()) {
  const root = path.join(home, ".codex", "sessions");
  const files = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) files.push({ p, m: fs.statSync(p).mtimeMs });
    }
  };
  walk(root, 0);
  files.sort((a, b) => b.m - a.m);
  for (const { p } of files.slice(0, 5)) {
    const size = fs.statSync(p).size;
    const fd = fs.openSync(p, "r");
    const len = Math.min(size, CODEX_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.includes('"rate_limits"'));
    for (const line of lines.reverse()) {
      try {
        const d = JSON.parse(line);
        const rl = d.payload?.rate_limits;
        if (!rl || (rl.limit_id && rl.limit_id !== "codex")) continue;
        const at = Date.parse(d.timestamp) || Date.now();
        const out = [];
        for (const w of [rl.primary, rl.secondary]) {
          if (!w || typeof w.used_percent !== "number") continue;
          const key = w.window_minutes <= 300 ? "5h" : "weekly";
          out.push(row("codex", "codex", key, Math.max(0, 100 - w.used_percent) / 100, w.resets_at ? w.resets_at * 1000 : null, at));
        }
        if (out.length) return out;
      } catch {
        // 半截的行跳过
      }
    }
  }
  return [];
}

// agy：`agy -p /usage` 输出每行「分组\t窗口说明\t剩余%\t重置时间」
export function parseAgyUsage(text, now) {
  const out = [];
  for (const line of text.split("\n")) {
    const parts = line.split("\t").map((s) => s.trim());
    if (parts.length < 3) continue;
    const pool = AGY_GROUPS[parts[0]];
    const pct = parts[2].match(/^(\d+(?:\.\d+)?)%$/);
    if (!pool || !pct) continue;
    const key = /five hour/i.test(parts[1]) ? "5h" : /week/i.test(parts[1]) ? "weekly" : null;
    if (!key) continue;
    out.push(row("antigravity", pool, key, Number(pct[1]) / 100, parts[3] ? Date.parse(parts[3]) || null : null, now));
  }
  return out;
}

export function agyRows(bin, cwd, now) {
  const res = spawnSync(bin, ["-p", "/usage", "--output-format", "text", "--print-timeout", "20s", "--sandbox", "--mode", "plan"], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || `退出码 ${res.status}`).trim().slice(0, 200));
  const rows = parseAgyUsage(res.stdout || "", now);
  if (!rows.length) throw new Error("agy /usage 没有返回可识别的额度");
  return rows;
}

// 刷新缓存：每个来源单独成败，失败时保留上次的数据并记下原因
export function refreshCache({ stateDir, claudeLimits, agyBin, force = false, now = Date.now() }) {
  const cache = loadCache(stateDir);
  const set = (name, fn) => {
    const prev = cache.sources[name] || {};
    try {
      const rows = fn();
      if (rows === null) return;
      cache.sources[name] = { rows, fetchedAt: now, error: null };
    } catch (e) {
      cache.sources[name] = { rows: prev.rows || [], fetchedAt: prev.fetchedAt || null, error: String(e.message || e).slice(0, 200) };
    }
  };
  if (claudeLimits) {
    set("claude", () => {
      const rows = claudeRows(claudeLimits, now);
      // 5h 窗口重置后、新窗口第一次请求前，Claude Code 不报这个窗口：沿用上次的读数，
      // 状态计算时已过重置点的窗口按 100% 处理，面板显示"已重置"
      const got = new Set(rows.map((r) => r.window_key));
      const kept = (cache.sources.claude?.rows || []).filter((r) => !got.has(r.window_key));
      return [...rows, ...kept];
    });
  }
  set("codex", () => {
    const rows = codexRows();
    if (!rows.length) throw new Error("本机没有找到 Codex 的会话记录（用过一次 Codex 后才有）");
    // 记录里是最后一次使用 Codex 时的额度；没再用就没再消耗，按刚读到处理，不标过期
    return rows.map((r) => ({ ...r, updated_at: now }));
  });
  if (agyBin) {
    const last = cache.sources.agy?.fetchedAt || 0;
    // agy 每次要起进程，5 分钟内不重复查
    if (force || now - last >= AGY_MIN_INTERVAL_MS || cache.sources.agy?.error) {
      fs.mkdirSync(path.join(stateDir, "probe"), { recursive: true });
      set("agy", () => agyRows(agyBin, path.join(stateDir, "probe"), now));
    }
  }
  fs.writeFileSync(cachePath(stateDir), JSON.stringify(cache, null, 2));
  return cache;
}

// 缓存中的所有额度行
export function cachedRows(stateDir) {
  const cache = loadCache(stateDir);
  return Object.values(cache.sources).flatMap((s) => s.rows || []);
}

// ---------- Grok：直接查 grok.com 的计费接口（官方 CLI 没有给程序用的额度命令） ----------
// 用 Grok CLI 登录后存在 ~/.grok/auth.json 的令牌鉴权；令牌只在内存里使用，不写日志、不进命令行参数、不进报错信息。
// 令牌过期时不自己刷新（避免和 grok CLI、用户的刷新脚本抢写 auth.json），直接报错，额度沿用旧缓存或 AIQuota5h。
const GROK_BILLING_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const GROK_MIN_INTERVAL_MS = 5 * 60_000;

function grokToken(home = os.homedir(), now = Date.now()) {
  let root;
  try {
    root = JSON.parse(fs.readFileSync(path.join(home, ".grok", "auth.json"), "utf8"));
  } catch {
    throw new Error("没有找到 Grok 登录信息（~/.grok/auth.json），先在终端运行 grok 登录");
  }
  const entry = Object.entries(root).find(([scope, v]) => scope.startsWith("https://auth.x.ai::") && v?.key);
  if (!entry) throw new Error("Grok 登录信息里没有令牌，先在终端运行 grok 重新登录");
  const info = entry[1];
  const exp = Date.parse(info.expires_at || "");
  if (exp && exp <= now) throw new Error("Grok 登录令牌已过期，等 grok CLI 或刷新脚本更新后再查");
  return String(info.key).trim();
}

// protobuf 解码：只支持本接口用到的几种编码
function readVarint(buf, start) {
  let value = 0n, shift = 0n, offset = start;
  while (offset < buf.length && shift <= 63n) {
    const b = buf[offset++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: Number(value), offset };
    shift += 7n;
  }
  throw new Error("Grok 额度响应格式异常（整数不完整）");
}

function protoFields(buf) {
  const fields = new Map();
  let offset = 0;
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    offset = key.offset;
    const field = Math.floor(key.value / 8), wire = key.value % 8;
    let value;
    if (wire === 0) ({ value, offset } = readVarint(buf, offset));
    else if (wire === 1) { value = buf.readDoubleLE(offset); offset += 8; }
    else if (wire === 5) { value = buf.readFloatLE(offset); offset += 4; }
    else if (wire === 2) {
      const len = readVarint(buf, offset);
      offset = len.offset;
      if (offset + len.value > buf.length) throw new Error("Grok 额度响应格式异常（消息被截断）");
      value = buf.subarray(offset, offset + len.value);
      offset += len.value;
    } else throw new Error("Grok 额度响应格式异常（不支持的编码）");
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push({ wire, value });
  }
  return fields;
}

const one = (fields, n, wire) => {
  const list = fields.get(n);
  if (!list) return undefined;
  if (list.length !== 1 || list[0].wire !== wire) throw new Error("Grok 额度接口的字段类型变了，需要更新解析");
  return list[0].value;
};

// gRPC-web 帧：取第一个数据帧，检查尾帧里的 grpc-status
function grpcPayload(buf) {
  let offset = 0, payload = null;
  while (offset + 5 <= buf.length) {
    const flags = buf[offset], len = buf.readUInt32BE(offset + 1);
    const body = buf.subarray(offset + 5, offset + 5 + len);
    if (flags === 0x80) {
      const status = body.toString("utf8").match(/grpc-status:\s*(\d+)/i)?.[1];
      if (status && status !== "0") throw new Error(`Grok 额度接口返回错误（grpc-status ${status}）`);
    } else if (flags === 0 && !payload) payload = body;
    offset += 5 + len;
  }
  if (!payload) throw new Error("Grok 额度响应里没有数据");
  return payload;
}

// 解析周额度：config(1) → 当前周期(8){类型(1)=2 表示按周, 开始(2), 结束(3)}；已用百分比在 config 的 5 号字段（float）
export function parseGrokCredits(buf) {
  const config = one(protoFields(grpcPayload(buf)), 1, 2);
  if (!config) throw new Error("Grok 额度响应缺少配置");
  const fields = protoFields(config);
  const current = one(fields, 8, 2);
  if (!current) throw new Error("Grok 额度响应缺少当前周期");
  const period = protoFields(current);
  if (one(period, 1, 0) !== 2) throw new Error("Grok 返回的不是按周计算的额度");
  const ts = (n) => {
    const m = one(period, n, 2);
    if (!m) throw new Error("Grok 周期时间缺失");
    const t = protoFields(m);
    return (one(t, 1, 0) || 0) * 1000 + Math.floor((one(t, 2, 0) || 0) / 1e6);
  };
  const periodStart = ts(2), periodEnd = ts(3);
  if (!(periodEnd > periodStart)) throw new Error("Grok 周期时间无效");
  // 统一周额度账户（11 号字段为 1）里，百分比字段省略就是 0；其他账户缺省时视为未知
  const unified = one(fields, 11, 0) === 1;
  const raw = one(fields, 1, 5);
  const used = raw ?? (unified ? 0 : null);
  const usedPercent = used !== null && Number.isFinite(used) && used >= 0 && used <= 100 ? used : null;
  return { usedPercent, periodStart, periodEnd };
}

export async function grokRows(now = Date.now(), fetchImpl = fetch) {
  const token = grokToken(os.homedir(), now);
  const res = await fetchImpl(GROK_BILLING_URL, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "*/*",
      "Content-Type": "application/grpc-web+proto",
      Origin: "https://grok.com",
      Referer: "https://grok.com/?_s=usage",
      "x-grpc-web": "1",
      "x-user-agent": "connect-es/2.1.1",
    },
    body: Buffer.from([0, 0, 0, 0, 0]),
  });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? `Grok 登录失效（HTTP ${res.status}），在终端运行 grok 重新登录` : `Grok 额度接口 HTTP ${res.status}`);
  const status = res.headers.get("grpc-status");
  if (status && status !== "0") throw new Error(`Grok 额度接口返回错误（grpc-status ${status}）`);
  const { usedPercent, periodEnd } = parseGrokCredits(Buffer.from(await res.arrayBuffer()));
  const remaining = usedPercent === null ? null : Math.max(0, 100 - usedPercent) / 100;
  return [row("grok", "supergrok-weekly", "weekly", remaining, periodEnd, now)];
}

// 异步刷新 Grok（其他来源是同步的，Grok 要联网，单独一个函数）；5 分钟内不重复查
export async function refreshGrok({ stateDir, force = false, now = Date.now() }) {
  const cache = loadCache(stateDir);
  const prev = cache.sources.grok || {};
  if (!force && !prev.error && prev.fetchedAt && now - prev.fetchedAt < GROK_MIN_INTERVAL_MS) return cache;
  try {
    cache.sources.grok = { rows: await grokRows(now), fetchedAt: now, error: null };
  } catch (e) {
    // 报错信息由本模块生成，不含令牌
    cache.sources.grok = { rows: prev.rows || [], fetchedAt: prev.fetchedAt || null, error: String(e.message || e).slice(0, 200) };
  }
  fs.writeFileSync(cachePath(stateDir), JSON.stringify(cache, null, 2));
  return cache;
}
