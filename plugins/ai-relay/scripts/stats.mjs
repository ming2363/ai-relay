// 统计纯函数：额度周期浪费采样、最新周期摘要、员工与主管工作量统计
import fs from "node:fs";
import path from "node:path";

const ONE_HOUR_MS = 3600_000;
const TWELVE_HOURS_MS = 12 * 3600_000;
const MAX_CYCLES = 60;

/**
 * 规范化时间戳为毫秒数字，支持数字和可解析的日期字符串，失败返回 null
 */
function parseTimestamp(ts) {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts;
  }
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * 额度历史文件路径
 */
function historyFilePath(stateDir) {
  return path.join(stateDir, "quota-history.json");
}

/**
 * 安全读取 quota-history.json，失败时返回默认结构
 */
function loadQuotaHistory(stateDir) {
  try {
    const raw = fs.readFileSync(historyFilePath(stateDir), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        last: parsed.last && typeof parsed.last === "object" ? parsed.last : {},
        cycles: Array.isArray(parsed.cycles) ? parsed.cycles : [],
      };
    }
  } catch {
    // 读失败或不存在时使用默认结构
  }
  return { last: {}, cycles: [] };
}

/**
 * 安全写回 quota-history.json，写失败不抛错
 */
function saveQuotaHistory(stateDir, data) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(historyFilePath(stateDir), JSON.stringify(data, null, 2), "utf8");
  } catch {
    // 读写失败不抛错
  }
}

/**
 * 采样额度记录，检测周期结束并归档到 cycles
 * @param {string} stateDir 状态存储目录
 * @param {Array<object>} rows 额度行数组
 * @param {number} [now=Date.now()] 当前时间戳
 * @returns {object} 写入后的 { last, cycles } 对象
 */
export function sampleQuotaHistory(stateDir, rows, now = Date.now()) {
  const data = loadQuotaHistory(stateDir);

  if (!Array.isArray(rows)) {
    return data;
  }

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    // 忽略 window_key 为 "cli-limit" 的行和 remaining_fraction 不是数字的行
    if (row.window_key === "cli-limit") continue;
    if (typeof row.remaining_fraction !== "number" || !Number.isFinite(row.remaining_fraction)) continue;

    const provider = row.provider ?? "";
    const pool = row.pool_id ?? "";
    const window = row.window_key ?? "";
    const key = `${provider}|${pool}|${window}`;

    const prev = data.last[key];
    const newResetAt = parseTimestamp(row.reset_at);

    // 若 last 里有这个键且新的 reset_at 比存的 resetAt 晚 1 小时以上（说明上个周期结束了）
    if (
      prev &&
      typeof prev.resetAt === "number" &&
      typeof newResetAt === "number" &&
      newResetAt - prev.resetAt >= ONE_HOUR_MS
    ) {
      data.cycles.push({
        provider,
        pool,
        window,
        leftover: prev.remaining,
        endedAt: prev.resetAt,
        sampledAt: prev.at,
      });
    }

    // 更新 last 记录
    const sampledAt = parseTimestamp(row.updated_at) ?? now;
    data.last[key] = {
      remaining: row.remaining_fraction,
      resetAt: newResetAt,
      at: sampledAt,
    };
  }

  // cycles 只保留最后 60 条
  if (data.cycles.length > MAX_CYCLES) {
    data.cycles = data.cycles.slice(-MAX_CYCLES);
  }

  saveQuotaHistory(stateDir, data);
  return data;
}

/**
 * 获取每个额度池各窗口最新一个已结束周期的摘要
 * @param {string} stateDir 状态存储目录
 * @param {number} [now=Date.now()] 当前时间戳
 * @returns {Record<string, { window: string, leftover: number, endedAt: number, reliable: boolean }>}
 */
export function lastCycles(stateDir, now = Date.now()) {
  const data = loadQuotaHistory(stateDir);
  const result = {};

  for (const c of data.cycles) {
    if (!c || typeof c !== "object") continue;
    const provider = c.provider ?? "";
    const pool = c.pool ?? "";
    const window = c.window ?? "";
    const key = `${provider}|${pool}|${window}`;
    const endedAt = typeof c.endedAt === "number" ? c.endedAt : 0;
    const existing = result[key];

    // 每个额度池+窗口取 endedAt 最新的一条；相同时间取后追加的
    if (!existing || endedAt >= existing.endedAt) {
      const sampledAt = typeof c.sampledAt === "number" ? c.sampledAt : 0;
      const diff = endedAt - sampledAt;
      // reliable 为 endedAt - sampledAt <= 12 小时（最后一次采样离重置太远时数据不可靠）
      const reliable = diff >= 0 && diff <= TWELVE_HOURS_MS;

      result[key] = {
        window,
        leftover: c.leftover,
        endedAt: c.endedAt,
        reliable,
      };
    }
  }

  return result;
}

/**
 * 统计员工和主管工作量
 * @param {object} params
 * @param {Array<object>} [params.jobs] 任务记录数组
 * @param {Array<object>} [params.rounds] 对话轮次数组
 * @param {number} [params.days=7] 统计天数范围
 * @param {number} [params.now=Date.now()] 当前时间戳
 * @returns {{
 *   workerLines: number,
 *   byWorker: Record<string, number>,
 *   selfLines: number,
 *   rounds: { edited: number, withWriteDispatch: number },
 *   workerShare: number | null
 * }}
 */
export function workStats({ jobs = [], rounds = [], days = 7, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 3600_000;

  // 规范化并过滤有效任务（startedAt 在最近 days 天内，支持数字和 ISO 字符串，解析失败则丢弃）
  const validJobs = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || typeof j !== "object") continue;
    const startedAtMs = parseTimestamp(j.startedAt);
    if (startedAtMs === null || startedAtMs < cutoff) continue;
    validJobs.push({
      ...j,
      _startedAtMs: startedAtMs,
    });
  }

  // 规范化并过滤有效轮次（startedAt 在最近 days 天内，支持数字和 ISO 字符串，解析失败则丢弃）
  const validRounds = [];
  for (const r of Array.isArray(rounds) ? rounds : []) {
    if (!r || typeof r !== "object") continue;
    const startedAtMs = parseTimestamp(r.startedAt);
    if (startedAtMs === null || startedAtMs < cutoff) continue;
    const parsedFinished = parseTimestamp(r.finishedAt);
    const finishedAtMs = parsedFinished !== null ? parsedFinished : now;
    validRounds.push({
      ...r,
      _startedAtMs: startedAtMs,
      _finishedAtMs: finishedAtMs,
    });
  }

  let workerLines = 0;
  const byWorker = {};

  // 员工工作量：write 为真的任务 changedLines 之和（没有或非法就当 0）
  for (const j of validJobs) {
    if (!j.write) continue;
    const lines =
      typeof j.changedLines === "number" && Number.isFinite(j.changedLines)
        ? Math.max(0, j.changedLines)
        : 0;
    workerLines += lines;

    const workerKey = `${j.provider ?? "unknown"}/${j.model ?? "unknown"}`;
    byWorker[workerKey] = (byWorker[workerKey] || 0) + lines;
  }

  // 主管工作量：轮次 selfLines 之和
  let selfLines = 0;
  for (const r of validRounds) {
    const lines =
      typeof r.selfLines === "number" && Number.isFinite(r.selfLines)
        ? Math.max(0, r.selfLines)
        : 0;
    selfLines += lines;
  }

  // 轮次统计：
  // 一个任务属于某轮的条件：sessionId 相同，且 startedAt 在该轮 startedAt 和 finishedAt（没有就用 now）之间
  let edited = 0;
  let withWriteDispatch = 0;

  for (const r of validRounds) {
    // 检查是否有可写外派
    const hasWriteDispatch = validJobs.some((j) => {
      if (!j.write) return false;
      if (!j.sessionId || !r.sessionId || j.sessionId !== r.sessionId) return false;
      return j._startedAtMs >= r._startedAtMs && j._startedAtMs <= r._finishedAtMs;
    });

    if (hasWriteDispatch) {
      withWriteDispatch++;
    }

    const hasSelfEdit =
      (typeof r.selfLines === "number" && Number.isFinite(r.selfLines) ? r.selfLines : 0) > 0;
    if (hasSelfEdit || hasWriteDispatch) {
      edited++;
    }
  }

  // 员工占比：workerLines / (workerLines + selfLines)，分母为 0 时为 null
  const totalLines = workerLines + selfLines;
  const workerShare = totalLines > 0 ? workerLines / totalLines : null;

  return {
    workerLines,
    byWorker,
    selfLines,
    rounds: {
      edited,
      withWriteDispatch,
    },
    workerShare,
  };
}
