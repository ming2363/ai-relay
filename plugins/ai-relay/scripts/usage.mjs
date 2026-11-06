// 从本机 CLI 会话日志（Grok / Antigravity）读取外派任务的 token 用量并支持历史回填
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { JOBS_DIR } from "./lib.mjs";

export const DEFAULT_GROK_SESSIONS_DIR = path.join(os.homedir(), ".grok", "sessions");
export const DEFAULT_AGY_CONVERSATIONS_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");
const MATCH_WINDOW_PADDING_MS = 30_000;

// ---------- 最小 Protobuf 解析器（仅支持 varint / 64-bit / length-delimited / 32-bit） ----------

// 读取单个 protobuf varint，返回 { value, next }；越界或非法时返回 null
export function readVarint(buf, offset = 0) {
  let val = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: Number(val), next: pos };
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
}

// 解析一层 protobuf 消息字段，返回 [{ field, wireType, value?, bytes? }]
export function readProtoFields(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (!tag || tag.value <= 0) break;
    offset = tag.next;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    if (field <= 0) break;
    if (wireType === 0) {
      const v = readVarint(buf, offset);
      if (!v) break;
      offset = v.next;
      fields.push({ field, wireType, value: v.value });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) break;
      fields.push({ field, wireType, bytes: buf.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, offset);
      if (!len || len.value < 0 || len.next + len.value > buf.length) break;
      offset = len.next;
      fields.push({ field, wireType, bytes: buf.subarray(offset, offset + len.value) });
      offset += len.value;
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) break;
      fields.push({ field, wireType, bytes: buf.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

// 从 agy 的 gen_metadata 单行 protobuf 数据按 1 → 4 → {2: input, 3: output} 提取用量
export function readAgyGenMetadataUsage(input) {
  if (!input || !input.length) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  for (const f1 of readProtoFields(input)) {
    if (f1.field !== 1 || f1.wireType !== 2) continue;
    for (const f4 of readProtoFields(f1.bytes)) {
      if (f4.field !== 4 || f4.wireType !== 2) continue;
      for (const sub of readProtoFields(f4.bytes)) {
        if (sub.wireType === 0 && sub.field === 2) {
          inputTokens += sub.value;
          found = true;
        } else if (sub.wireType === 0 && sub.field === 3) {
          outputTokens += sub.value;
          found = true;
        }
      }
    }
  }
  return found ? { input: inputTokens, output: outputTokens } : null;
}

// ---------- 时间窗与目录匹配辅助 ----------

function jobTimeWindow(job) {
  if (!job?.cwd || !job?.startedAt) return null;
  const startMs = Date.parse(job.startedAt);
  if (Number.isNaN(startMs)) return null;
  const rawEndMs = job.finishedAt ? Date.parse(job.finishedAt) : (job.status === "running" ? Date.now() : startMs);
  const endMs = Number.isNaN(rawEndMs) ? startMs : Math.max(startMs, rawEndMs);
  return {
    startMs,
    endMs,
    minMs: startMs - MATCH_WINDOW_PADDING_MS,
    maxMs: endMs + MATCH_WINDOW_PADDING_MS,
  };
}

function normalizeCwd(p) {
  return path.resolve(String(p || ""));
}

function bufferHasFileUri(data) {
  if (!data) return false;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buf.length > 0 && buf.toString("utf8").includes("file:///");
}

// 递归检查嵌套 protobuf length-delimited 字段中是否含有精确匹配 isTargetUri 的 file:/// URI
function protoFieldsMatchTargetUri(fields, isTargetUri, depth = 0) {
  for (const f of fields) {
    if (f.wireType !== 2 || !f.bytes || !f.bytes.length) continue;
    const s = f.bytes.toString("utf8");
    if (s.startsWith("file:///") && !s.includes("\x00") && !s.includes("\n")) {
      if (isTargetUri(s)) return true;
    } else if (depth < 3 && s.includes("file:///")) {
      if (protoFieldsMatchTargetUri(readProtoFields(f.bytes), isTargetUri, depth + 1)) return true;
    }
  }
  return false;
}

// 判断 agy trajectory_metadata_blob 或 executor_metadata 的 data 是否匹配目标 cwd
export function agyBlobMatchesCwd(data, targetCwd) {
  if (!data || !targetCwd) return false;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!buf.length) return false;

  const normCwd = normalizeCwd(targetCwd);
  const rawUri = `file://${normCwd.startsWith("/") ? normCwd : "/" + normCwd}`.replace(/\/$/, "");
  const encUri = pathToFileURL(normCwd).href.replace(/\/$/, "");
  const isTargetUri = (s) => {
    const clean = String(s || "").trim().replace(/\/$/, "");
    return clean === rawUri || clean === encUri;
  };

  // 优先从 protobuf 顶层字段 7 或 1.1（会话工作区 URI）提取精确 URI，避免把 1.2（git 仓库根目录）误判为子目录任务的 cwd
  const topFields = readProtoFields(buf);
  const extracted = [];
  for (const f of topFields) {
    if (f.wireType !== 2 || !f.bytes) continue;
    if (f.field === 7) {
      const s = f.bytes.toString("utf8");
      if (s.startsWith("file:///")) extracted.push(s);
    } else if (f.field === 1) {
      const direct = f.bytes.toString("utf8");
      if (direct.startsWith("file:///")) {
        extracted.push(direct);
      } else {
        for (const sub of readProtoFields(f.bytes)) {
          if (sub.field === 1 && sub.wireType === 2 && sub.bytes) {
            const s = sub.bytes.toString("utf8");
            if (s.startsWith("file:///")) extracted.push(s);
          }
        }
      }
    }
  }
  if (extracted.length > 0) {
    return extracted.some(isTargetUri);
  }

  // 兼容 executor_metadata 等嵌套 protobuf 字段（如 10.12 / 17.12）
  if (protoFieldsMatchTargetUri(topFields, isTargetUri, 0)) {
    return true;
  }

  // 兼容测试中直接写入非 protobuf 纯文本 file:///<cwd> 字符串的情况
  const text = buf.toString("utf8");
  for (const target of [rawUri, encUri]) {
    let idx = text.indexOf(target);
    while (idx !== -1) {
      const nextChar = text[idx + target.length] || "";
      // 确保匹配的是完整目录路径而非某个子目录的前缀
      if (!nextChar || !/[a-zA-Z0-9._\-/%]/.test(nextChar)) return true;
      idx = text.indexOf(target, idx + 1);
    }
  }
  return false;
}

// 判断 agy SQLite 库是否匹配目标 cwd：trajectory_metadata_blob 为空或无 file:/// 时用 executor_metadata 兜底
function agyDbMatchesCwd(db, targetCwd) {
  let trajRows = [];
  try {
    trajRows = db.prepare("SELECT data FROM trajectory_metadata_blob").all();
  } catch {}
  const hasTrajUri = trajRows.some((r) => bufferHasFileUri(r?.data));
  if (hasTrajUri) {
    return trajRows.some((r) => r?.data && agyBlobMatchesCwd(r.data, targetCwd));
  }
  let execRows = [];
  try {
    execRows = db.prepare("SELECT data FROM executor_metadata").all();
  } catch {}
  return execRows.some((r) => r?.data && agyBlobMatchesCwd(r.data, targetCwd));
}

// 读取 jobsDir 下所有已有任务占用的 usage.source（可排除当前任务自身）
export function collectUsedSources(jobsDir = JOBS_DIR, excludeJobId = null) {
  const used = new Set();
  if (!jobsDir || !fs.existsSync(jobsDir)) return used;
  let files = [];
  try {
    files = fs.readdirSync(jobsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return used;
  }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(jobsDir, f), "utf8"));
      if (excludeJobId && j?.id === excludeJobId) continue;
      if (j?.usage?.source) used.add(String(j.usage.source));
    } catch {}
  }
  return used;
}

function getUsedSourcesSet(job, opts) {
  const obj = typeof opts === "object" && opts !== null ? opts : {};
  const used = new Set();
  if (obj.usedSources) {
    for (const s of obj.usedSources) {
      if (s) used.add(String(s));
    }
  }
  const hasCustomSessionDir =
    typeof opts === "string" ||
    Boolean(obj.grokDir || obj.sessionsDir || obj.agyDir || obj.conversationsDir);
  const jobsDir = obj.jobsDir || (!hasCustomSessionDir && !obj.usedSources ? JOBS_DIR : null);
  if (jobsDir) {
    for (const s of collectUsedSources(jobsDir, job?.id)) {
      used.add(s);
    }
  }
  return used;
}

// ---------- Grok 用量读取 ----------

function resolveGrokDir(opts) {
  if (typeof opts === "string") return opts;
  return opts?.grokDir || opts?.sessionsDir || DEFAULT_GROK_SESSIONS_DIR;
}

export function grokUsageFor(job, opts = {}) {
  const win = jobTimeWindow(job);
  if (!win) return null;
  const sessionsRoot = resolveGrokDir(opts);
  if (!fs.existsSync(sessionsRoot)) return null;

  const usedSources = getUsedSourcesSet(job, opts);
  const targetCwd = normalizeCwd(job.cwd);
  const encodedCandidates = new Set([
    encodeURIComponent(job.cwd),
    encodeURIComponent(targetCwd),
  ]);

  // 收集要扫描的 cwd 目录：优先直接定位 <encodeURIComponent(cwd)>，若目录名存在差异也兼容扫描
  const cwdDirs = [];
  for (const enc of encodedCandidates) {
    const d = path.join(sessionsRoot, enc);
    if (fs.existsSync(d)) cwdDirs.push({ dir: d, encodedMatch: true });
  }
  try {
    for (const entry of fs.readdirSync(sessionsRoot)) {
      if (encodedCandidates.has(entry)) continue;
      const d = path.join(sessionsRoot, entry);
      try {
        if (fs.statSync(d).isDirectory()) cwdDirs.push({ dir: d, encodedMatch: false });
      } catch {}
    }
  } catch {}

  const candidates = [];
  for (const { dir: cwdDir, encodedMatch } of cwdDirs) {
    let sessionIds = [];
    try {
      sessionIds = fs.readdirSync(cwdDir);
    } catch {
      continue;
    }
    for (const sid of sessionIds) {
      if (usedSources.has(sid)) continue;
      const sDir = path.join(cwdDir, sid);
      const summaryFile = path.join(sDir, "summary.json");
      const usageFile = path.join(sDir, "usage.json");
      if (!fs.existsSync(summaryFile) || !fs.existsSync(usageFile)) continue;
      try {
        const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
        const source = String(summary?.info?.id || summary?.id || sid);
        if (usedSources.has(source)) continue;
        const sumCwd = summary?.info?.cwd ?? summary?.cwd;
        if (sumCwd) {
          if (normalizeCwd(sumCwd) !== targetCwd) continue;
        } else if (!encodedMatch) {
          continue;
        }
        const rawCreated = summary?.created_at ?? summary?.createdAt ?? summary?.info?.created_at ?? summary?.info?.createdAt;
        const createdMs = Date.parse(rawCreated);
        if (Number.isNaN(createdMs) || createdMs < win.minMs || createdMs > win.maxMs) continue;
        candidates.push({ source, usageFile, createdMs, diff: Math.abs(createdMs - win.startMs) });
      } catch {}
    }
  }

  if (!candidates.length) return null;
  // 按候选创建时间升序配对，确保同批并发任务按 startedAt 升序与候选创建时间升序依次配对不交叉
  candidates.sort((a, b) => a.createdMs - b.createdMs || a.source.localeCompare(b.source));

  for (const cand of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(cand.usageFile, "utf8"));
      const s = data?.session;
      if (!s || typeof s !== "object") continue;
      const hasAny =
        typeof s.inputTokens === "number" ||
        typeof s.outputTokens === "number" ||
        typeof s.cachedReadTokens === "number" ||
        typeof s.totalTokens === "number";
      if (!hasAny) continue;
      const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
      const cacheRead = num(s.cachedReadTokens);
      const input = Math.max(0, num(s.inputTokens) - cacheRead);
      const output = num(s.outputTokens);
      const total = typeof s.totalTokens === "number" && Number.isFinite(s.totalTokens) ? s.totalTokens : input + output + cacheRead;
      const result = { input, output, cacheRead, total, source: cand.source };
      if (opts?.usedSources instanceof Set) opts.usedSources.add(cand.source);
      return result;
    } catch {}
  }
  return null;
}

// ---------- Antigravity (agy) 用量读取 ----------

function resolveAgyDir(opts) {
  if (typeof opts === "string") return opts;
  return opts?.agyDir || opts?.conversationsDir || DEFAULT_AGY_CONVERSATIONS_DIR;
}

export function agyUsageFor(job, opts = {}) {
  const win = jobTimeWindow(job);
  if (!win) return null;
  const convDir = resolveAgyDir(opts);
  if (!fs.existsSync(convDir)) return null;

  const usedSources = getUsedSourcesSet(job, opts);
  let files = [];
  try {
    files = fs.readdirSync(convDir).filter((f) => f.endsWith(".db"));
  } catch {
    return null;
  }

  const candidates = [];
  for (const f of files) {
    if (usedSources.has(f)) continue;
    const dbPath = path.join(convDir, f);
    let st;
    try {
      st = fs.statSync(dbPath);
    } catch {
      continue;
    }
    const createdMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    if (createdMs < win.minMs || createdMs > win.maxMs) continue;

    let matched = false;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      matched = agyDbMatchesCwd(db, job.cwd);
    } catch {
      matched = false;
    } finally {
      try {
        db?.close();
      } catch {}
    }
    if (matched) {
      candidates.push({ source: f, dbPath, createdMs, diff: Math.abs(createdMs - win.startMs) });
    }
  }

  if (!candidates.length) return null;
  // 按候选创建时间升序配对，确保同批并发任务按 startedAt 升序与候选创建时间升序依次配对不交叉
  candidates.sort((a, b) => a.createdMs - b.createdMs || a.source.localeCompare(b.source));

  for (const cand of candidates) {
    let db;
    try {
      db = new DatabaseSync(cand.dbPath, { readOnly: true });
      const rows = db.prepare("SELECT data FROM gen_metadata ORDER BY idx").all();
      let input = 0;
      let output = 0;
      let count = 0;
      for (const r of rows) {
        if (!r?.data) continue;
        const u = readAgyGenMetadataUsage(r.data);
        if (u) {
          input += u.input;
          output += u.output;
          count++;
        }
      }
      if (count > 0) {
        const result = { input, output, cacheRead: 0, total: input + output, source: cand.source };
        if (opts?.usedSources instanceof Set) opts.usedSources.add(cand.source);
        return result;
      }
    } catch {} finally {
      try {
        db?.close();
      } catch {}
    }
  }
  return null;
}

// 按任务 provider 自动分发读取 usage
export function usageForJob(job, opts = {}) {
  if (!job || typeof job !== "object") return null;
  if (job.provider === "grok") return grokUsageFor(job, opts);
  if (job.provider === "agy") return agyUsageFor(job, opts);
  return null;
}

function getDirMaxMtime(dirPath) {
  let maxMtime = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dirPath, ent.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
        if (ent.isDirectory()) {
          for (const sub of fs.readdirSync(full)) {
            try {
              const subSt = fs.statSync(path.join(full, sub));
              if (subSt.mtimeMs > maxMtime) maxMtime = subSt.mtimeMs;
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}
  return maxMtime;
}

// 获取 Grok 会话日志文件的最新修改时间（会话目录内所有文件的最大 mtime）
export function getGrokSessionActivityMtime(job, opts = {}) {
  const win = jobTimeWindow(job);
  if (!win) return 0;
  const sessionsRoot = resolveGrokDir(opts);
  if (!fs.existsSync(sessionsRoot)) return 0;

  if (job?._matchedGrokDir && (!opts?.grokDir || job._matchedGrokDir.startsWith(opts.grokDir)) && fs.existsSync(job._matchedGrokDir)) {
    return getDirMaxMtime(job._matchedGrokDir);
  }

  const usedSources = getUsedSourcesSet(job, opts);
  const targetCwd = normalizeCwd(job.cwd);
  const encodedCandidates = new Set([
    encodeURIComponent(job.cwd),
    encodeURIComponent(targetCwd),
  ]);

  const cwdDirs = [];
  for (const enc of encodedCandidates) {
    const d = path.join(sessionsRoot, enc);
    if (fs.existsSync(d)) cwdDirs.push({ dir: d, encodedMatch: true });
  }
  try {
    for (const entry of fs.readdirSync(sessionsRoot)) {
      if (encodedCandidates.has(entry)) continue;
      const d = path.join(sessionsRoot, entry);
      try {
        if (fs.statSync(d).isDirectory()) cwdDirs.push({ dir: d, encodedMatch: false });
      } catch {}
    }
  } catch {}

  const candidates = [];
  for (const { dir: cwdDir, encodedMatch } of cwdDirs) {
    let sessionIds = [];
    try {
      sessionIds = fs.readdirSync(cwdDir);
    } catch {
      continue;
    }
    for (const sid of sessionIds) {
      if (usedSources.has(sid)) continue;
      const sDir = path.join(cwdDir, sid);
      const summaryFile = path.join(sDir, "summary.json");
      if (!fs.existsSync(summaryFile)) continue;
      try {
        const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
        const source = String(summary?.info?.id || summary?.id || sid);
        if (usedSources.has(source)) continue;
        const sumCwd = summary?.info?.cwd ?? summary?.cwd;
        if (sumCwd) {
          if (normalizeCwd(sumCwd) !== targetCwd) continue;
        } else if (!encodedMatch) {
          continue;
        }
        const rawCreated = summary?.created_at ?? summary?.createdAt ?? summary?.info?.created_at ?? summary?.info?.createdAt;
        const createdMs = Date.parse(rawCreated);
        if (Number.isNaN(createdMs) || createdMs < win.minMs || createdMs > win.maxMs) continue;
        candidates.push({ sDir, source, createdMs });
      } catch {}
    }
  }

  if (!candidates.length) return 0;
  candidates.sort((a, b) => a.createdMs - b.createdMs || a.source.localeCompare(b.source));

  const primary = candidates[0];
  if (job && typeof job === "object") {
    try { job._matchedGrokDir = primary.sDir; } catch {}
  }
  return getDirMaxMtime(primary.sDir);
}

function getAgyDbMaxMtime(dbPath, includeShm = true) {
  let maxMtime = 0;
  for (const suffix of includeShm ? ["", "-wal", "-shm"] : ["", "-wal"]) {
    try {
      const st = fs.statSync(dbPath + suffix);
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
    } catch {}
  }
  return maxMtime;
}

// 只读探测也可能触碰 SHM；DB/WAL 不变时复用匹配结果，避免监测器自己制造持续活动。
const agyActivityMatches = new Map();

// 获取 Antigravity (agy) 会话日志文件的最新修改时间（.db、.db-wal、.db-shm 的最大 mtime）
export function getAgySessionActivityMtime(job, opts = {}) {
  const win = jobTimeWindow(job);
  if (!win) return 0;
  const convDir = resolveAgyDir(opts);
  if (!fs.existsSync(convDir)) return 0;

  if (job?._matchedAgyDb && path.dirname(job._matchedAgyDb) === convDir && fs.existsSync(job._matchedAgyDb)) {
    return getAgyDbMaxMtime(job._matchedAgyDb);
  }

  const usedSources = getUsedSourcesSet(job, opts);
  let files = [];
  try {
    files = [...new Set(fs.readdirSync(convDir)
      .filter((f) => /\.db(?:-wal|-shm)?$/.test(f))
      .map((f) => f.replace(/-(?:wal|shm)$/, "")))];
  } catch {
    return 0;
  }

  const candidates = [];
  let fallbackMtime = 0;
  for (const f of files) {
    if (usedSources.has(f)) continue;
    const dbPath = path.join(convDir, f);
    const activityMtime = getAgyDbMaxMtime(dbPath);
    fallbackMtime = Math.max(fallbackMtime, activityMtime);
    let st;
    try {
      st = fs.statSync(dbPath);
    } catch {
      continue;
    }
    const createdMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    // agy 可能复用旧库，活动识别不能用创建时间排除仍在写 WAL 的会话。
    const contentMtime = getAgyDbMaxMtime(dbPath, false);
    if (contentMtime < win.minMs) continue;
    const cached = agyActivityMatches.get(dbPath);
    let matched = cached?.cwd === job.cwd && cached.mtime === contentMtime ? cached.matched : undefined;
    if (matched === undefined) {
      let db;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        matched = agyDbMatchesCwd(db, job.cwd);
      } catch {
        matched = false;
      } finally {
        try { db?.close(); } catch {}
      }
      agyActivityMatches.set(dbPath, { cwd: job.cwd, mtime: contentMtime, matched });
    }
    if (matched) candidates.push({ source: f, dbPath, createdMs, activityMtime });
  }

  // 初期元数据为空或仍指向旧 cwd 时不缓存猜测；有目录活动就保活，总时长上限仍生效。
  if (!candidates.length) return fallbackMtime;
  candidates.sort((a, b) => Math.abs(a.createdMs - win.startMs) - Math.abs(b.createdMs - win.startMs) || a.source.localeCompare(b.source));
  const primary = candidates[0];
  if (job && typeof job === "object") {
    try { job._matchedAgyDb = primary.dbPath; } catch {}
  }
  return primary.activityMtime;
}

// 统一获取员工会话日志文件的最新修改时间（Grok 会话目录内文件、agy 的 .db、WAL 和 SHM）
export function getSessionActivityMtime(job, opts = {}) {
  if (!job || typeof job !== "object") return 0;
  if (job.provider === "grok") return getGrokSessionActivityMtime(job, opts);
  if (job.provider === "agy") return getAgySessionActivityMtime(job, opts);
  return 0;
}

// 对 jobs 列表中 status 为 running 的 agy/grok 任务实时算一次 usage，放在 job.liveUsage
// 只读不写回 job json，也不持久占用 source
export function attachLiveUsage(jobs, opts = {}) {
  if (!Array.isArray(jobs)) return jobs;
  const usedSources = new Set();
  if (opts.usedSources) {
    for (const s of opts.usedSources) {
      if (s) usedSources.add(String(s));
    }
  }
  // 先收集已有 usage 的 source，防止 running 任务误匹配到已完成任务占用的日志
  for (const j of jobs) {
    if (j?.usage?.source) usedSources.add(String(j.usage.source));
  }
  for (const j of jobs) {
    if (!j || j.status !== "running") continue;
    if (j.provider !== "agy" && j.provider !== "grok") continue;
    const live = usageForJob(j, { ...opts, usedSources });
    if (live) {
      j.liveUsage = live;
    }
  }
  return jobs;
}

// ---------- 历史任务回填 ----------

// 回填没有 usage 的 agy / grok 任务（支持 opts.redo 清掉旧 usage 后按新规则全部重算）：
// - 传入 jobs 数组时直接处理该数组（若提供了 opts.jobsDir 且对应 json 文件存在，则同步只写回 usage 字段）；
// - 未传 jobs 数组时从 jobsDir（默认 JOBS_DIR）读取所有 *.json 并写回 usage 字段。
export function backfill(jobsOrOpts, maybeOpts = {}) {
  const isArray = Array.isArray(jobsOrOpts);
  const opts = isArray ? maybeOpts : (jobsOrOpts || {});
  const jobsDir = opts.jobsDir || (!isArray ? JOBS_DIR : null);
  const redo = !!opts.redo;

  let records = [];
  if (isArray) {
    records = jobsOrOpts.map((job) => ({
      job,
      file: job?.id && jobsDir ? path.join(jobsDir, `${job.id}.json`) : null,
    }));
  } else if (jobsDir && fs.existsSync(jobsDir)) {
    const files = fs.readdirSync(jobsDir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      const file = path.join(jobsDir, f);
      try {
        const job = JSON.parse(fs.readFileSync(file, "utf8"));
        records.push({ job, file });
      } catch {}
    }
  }

  // --redo：先清掉所有已结束 agy / grok 任务的 usage（内存与磁盘同步只删改 usage 字段）
  if (redo) {
    for (const { job, file } of records) {
      if (!job || (job.provider !== "agy" && job.provider !== "grok")) continue;
      if (job.status === "running") continue;
      if ("usage" in job) delete job.usage;
      if (file && fs.existsSync(file)) {
        try {
          const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
          if ("usage" in onDisk) {
            delete onDisk.usage;
            fs.writeFileSync(file, JSON.stringify(onDisk, null, 2));
          }
        } catch {}
      }
    }
  }

  const usedSources = new Set();
  if (opts.usedSources) {
    for (const s of opts.usedSources) {
      if (s) usedSources.add(String(s));
    }
  }
  if (!redo && jobsDir) {
    for (const s of collectUsedSources(jobsDir)) {
      usedSources.add(s);
    }
  }

  const items = [];
  const unmatchedIds = [];
  let skipped = 0;
  const pending = [];

  for (const rec of records) {
    const { job } = rec;
    if (!job || (job.provider !== "agy" && job.provider !== "grok")) continue;
    if (job.usage) {
      if (job.usage.source) usedSources.add(String(job.usage.source));
      skipped++;
      continue;
    }
    if (job.status === "running") continue;
    pending.push(rec);
  }

  // 按任务 startedAt 升序（相同则按 id 升序）依次配对，确保多个并发任务与候选创建时间升序一一对应不交叉
  pending.sort((a, b) => {
    const ta = Date.parse(a.job?.startedAt || "");
    const tb = Date.parse(b.job?.startedAt || "");
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
    return String(a.job?.id || "").localeCompare(String(b.job?.id || ""));
  });

  for (const { job, file } of pending) {
    const usage = usageForJob(job, { ...opts, usedSources });
    if (usage) {
      if (usage.source) usedSources.add(String(usage.source));
      job.usage = usage;
      if (file && fs.existsSync(file)) {
        try {
          const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
          onDisk.usage = usage;
          fs.writeFileSync(file, JSON.stringify(onDisk, null, 2));
        } catch {}
      }
      items.push({ id: job.id, provider: job.provider, usage });
    } else {
      unmatchedIds.push(job.id);
    }
  }

  return {
    filled: items.length,
    unmatched: unmatchedIds.length,
    skipped,
    items,
    unmatchedIds,
  };
}
