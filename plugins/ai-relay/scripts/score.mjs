// ai-relay 模型打分路由：按擅长度、额度紧迫度、历史可靠度、执行速度、当前负载综合打分并排序
import { capsOf, isEnabled, isInside, poolStatus } from "./lib.mjs";

const WINDOW_TOTAL_HOURS = {
  "5h": 5,
  weekly: 168,
};

const WINDOW_LABEL = {
  "5h": "5h",
  weekly: "周",
};

const DEFAULT_SCORE_WEIGHTS = {
  fit: 3,
  reliability: 3,
  // 额度权重最低：额度只要不低于 15%（硬门槛），就不该压过更擅长、更可靠的模型
  quota: 0.25,
  speed: 0.5,
  load: 0.5,
};

function windowTotalHours(key) {
  return WINDOW_TOTAL_HOURS[key] || 24;
}

function windowLabel(key) {
  return WINDOW_LABEL[key] || key;
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function round(val, decimals) {
  const factor = 10 ** decimals;
  return Math.round((val + Number.EPSILON) * factor) / factor;
}

// 1. fit 擅长度：
//   - 若显式提供第 4 段擅长度，限制在 0.1 到 1 之间
//   - 否则按位置计算：max(0.4, 1 - 0.15 * i)，i 为路由原始下标
function calcFit(index, explicitFit) {
  if (explicitFit !== undefined && explicitFit !== "") {
    const val = Number(explicitFit);
    if (!Number.isNaN(val)) {
      return clamp(val, 0.1, 1);
    }
  }
  return Math.max(0.4, 1 - 0.15 * index);
}

// 2. quota 额度：
//   - level 为 unknown: 0.8
//   - 否则: binding = status.remaining; expiring = 各窗口中 remaining * clamp(1 - 距重置小时数 / 窗口总小时数, 0, 1) 的最大值
//   - quota = 0.6 + 0.4 * binding + 0.4 * expiring; level 为 low 时再乘 0.7
function calcQuota(status, now) {
  if (status.level === "unknown") {
    return 0.8;
  }
  const binding = typeof status.remaining === "number" ? status.remaining : 0;
  let expiring = 0;
  for (const w of status.windows || []) {
    if (w.remaining === null || w.remaining === undefined) continue;
    if (w.resetAt === null || w.resetAt === undefined) continue;
    if (w.resetPassed) continue;
    const totalHours = windowTotalHours(w.key);
    const hoursUntilReset = Math.max(0, (w.resetAt - now) / 3_600_000);
    const val = w.remaining * clamp(1 - hoursUntilReset / totalHours, 0, 1);
    if (val > expiring) expiring = val;
  }
  let quota = 0.6 + 0.4 * binding + 0.4 * expiring;
  if (status.level === "low") {
    quota *= 0.7;
  }
  return quota;
}

// 3. reliability 可靠度（按角色加权）：
//   - 同 provider、同 model 且 status !== 'running'
//   - 记录 role 与本次 role 相同权重为 1，不同或无 role 权重为 0.5
//   - verdict: pass(1), partial(0.5), fail(0); 无 verdict: done(1), failed/timeout(0), cancelled 不计入
//   - sum = Σ 权重 × 成功分, count = Σ 权重
//   - rate = (sum + 1.8) / (count + 2); reliability = 0.4 + 0.6 * rate
function calcReliability(history, provider, model, role) {
  let sum = 0;
  let count = 0;
  for (const r of history || []) {
    if (r.provider !== provider || r.model !== model || r.status === "running") continue;
    const w = (r.role && r.role === role) ? 1 : 0.5;
    if (r.verdict === "pass") {
      sum += w * 1;
      count += w;
    } else if (r.verdict === "partial") {
      sum += w * 0.5;
      count += w;
    } else if (r.verdict === "fail") {
      sum += w * 0;
      count += w;
    } else if (!r.verdict) {
      if (r.status === "done") {
        sum += w * 1;
        count += w;
      } else if (r.status === "failed" || r.status === "timeout") {
        sum += w * 0;
        count += w;
      }
    }
  }
  const rate = (sum + 1.8) / (count + 2);
  return 0.4 + 0.6 * rate;
}

// 4. speed 速度：
//   - 取同 provider、同 model、status 为 done 且有 finishedAt 的记录求耗时中位数
//   - <= 90s 记 1; >= 600s 记 0.85; 之间线性插值; 无记录记 1
function calcSpeed(history, provider, model) {
  const durations = [];
  for (const r of history || []) {
    if (r.provider !== provider || r.model !== model) continue;
    if (r.status !== "done") continue;
    if (!r.finishedAt || !r.startedAt) continue;
    const start = Date.parse(r.startedAt);
    const finish = Date.parse(r.finishedAt);
    if (Number.isNaN(start) || Number.isNaN(finish) || finish < start) continue;
    durations.push((finish - start) / 1000);
  }
  if (!durations.length) return 1;
  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const median = durations.length % 2 === 0
    ? (durations[mid - 1] + durations[mid]) / 2
    : durations[mid];

  if (median <= 90) return 1;
  if (median >= 600) return 0.85;
  return 1 - 0.15 * ((median - 90) / 510);
}

// 5. load 负载：
//   - 统计同 provider、status 为 running、startedAt 在 now 之前 60 分钟以内的记录条数 running
//   - load = 1 / (1 + 0.2 * running)
function calcLoad(history, provider, now) {
  let running = 0;
  const windowMs = 60 * 60 * 1000;
  for (const r of history || []) {
    if (r.provider !== provider || r.status !== "running") continue;
    if (!r.startedAt) continue;
    const start = Date.parse(r.startedAt);
    if (Number.isNaN(start)) continue;
    const diff = now - start;
    if (diff >= 0 && diff <= windowMs) {
      running += 1;
    }
  }
  const load = 1 / (1 + 0.2 * running);
  return { running, load };
}

// 6. 加权几何平均打分：
//   - 权重从 cfg.scoreWeights 读取，缺省为 fit: 3, reliability: 3, quota: 1, speed: 0.5, load: 0.5
//   - score = exp( Σ w_k * ln(part_k) / Σ w_k )，四舍五入到 3 位小数
function calcWeightedScore(parts, weightsCfg) {
  const merged = { ...DEFAULT_SCORE_WEIGHTS, ...weightsCfg };
  // 防护：权重只认非负有限数；分值钳到不小于 0.001，避免 ln(0)、ln(负数) 产生 -Infinity 或 NaN
  let totalWeight = 0;
  let weightedLogSum = 0;
  for (const key of Object.keys(DEFAULT_SCORE_WEIGHTS)) {
    const w = Number(merged[key]);
    if (!Number.isFinite(w) || w <= 0) continue;
    const v = Number(parts[key]);
    totalWeight += w;
    weightedLogSum += w * Math.log(Number.isFinite(v) ? Math.max(v, 0.001) : 0.001);
  }
  if (totalWeight <= 0) return 0;
  return round(Math.exp(weightedLogSum / totalWeight), 3);
}

// 格式化原因说明（中文，写给人看）
// 格式：擅长 1.00 · 可靠 0.94 · 额度 0.55 · 速度 1.00 · 负载 1.00 → 0.91
// 若 running > 0，追加「；该厂商有 N 个任务在跑」
// 若某窗口 remaining >= 0.5 且距重置不到该窗口总时长的 1/3，追加「；5h 额度 X 小时后重置，优先用掉」
function formatReason(parts, score, status, now, running = 0) {
  let text = `擅长 ${parts.fit.toFixed(2)} · 可靠 ${parts.reliability.toFixed(2)} · 额度 ${parts.quota.toFixed(2)} · 速度 ${parts.speed.toFixed(2)} · 负载 ${parts.load.toFixed(2)} → ${score.toFixed(2)}`;

  if (running > 0) {
    text += `；该厂商有 ${running} 个任务在跑`;
  }

  const urgent = [];
  for (const w of status.windows || []) {
    if (w.remaining === null || w.remaining === undefined || w.remaining < 0.5) continue;
    if (w.resetAt === null || w.resetAt === undefined || w.resetPassed) continue;
    const totalHours = windowTotalHours(w.key);
    const hoursUntilReset = (w.resetAt - now) / 3_600_000;
    if (hoursUntilReset > 0 && hoursUntilReset < totalHours / 3) {
      urgent.push({ key: w.key, hours: hoursUntilReset });
    }
  }

  if (urgent.length > 0) {
    urgent.sort((a, b) => a.hours - b.hours);
    const target = urgent[0];
    text += `；${windowLabel(target.key)} 额度 ${target.hours.toFixed(1)} 小时后重置，优先用掉`;
  }

  return text;
}

// needs 里任一能力在 caps 中不为 true 就跳过。空或不传不检查。文案顺序固定为联网、执行命令
function capsSkipWhy(caps, needs) {
  if (!Array.isArray(needs) || needs.length === 0) return "";
  const labels = [];
  if (needs.includes("web") && caps?.web !== true) labels.push("联网");
  if (needs.includes("exec") && caps?.exec !== true) labels.push("执行命令");
  for (const name of needs) {
    if (name === "web" || name === "exec") continue;
    if (caps?.[name] !== true) labels.push(String(name));
  }
  return labels.length ? `不具备：${labels.join("、")}` : "";
}

export function scoreRoute(cfg, rows, role, { only, history = [], now = Date.now(), write, target, workspace, needs } = {}) {
  const route = cfg?.routes?.[role];
  if (!route) {
    const available = Object.keys(cfg?.routes || {}).join(", ");
    throw new Error(`未知角色 ${role}，可选：${available}`);
  }

  const cands = [];
  const skipped = [];

  for (let i = 0; i < route.length; i++) {
    const entry = route[i];
    const [provName, pool, model, fitRaw] = entry.split(":");
    if (only && provName !== only) continue;

    const prov = cfg.providers?.[provName];
    const quotaProvider = prov?.quota?.provider || provName;
    const st = poolStatus(cfg, rows, quotaProvider, pool, now);

    if (!isEnabled(prov)) {
      skipped.push({
        provider: provName,
        pool,
        model,
        via: prov?.via,
        status: st,
        why: "已停用",
      });
      continue;
    }

    // 能力检查在额度之前：缺能力就不要拿额度去比较
    const capsWhy = capsSkipWhy(capsOf(cfg, prov), needs);
    if (capsWhy) {
      skipped.push({
        provider: provName,
        pool,
        model,
        via: prov?.via,
        status: st,
        why: capsWhy,
      });
      continue;
    }

    if (st.level === "blocked") {
      skipped.push({
        provider: provName,
        pool,
        model,
        via: prov?.via,
        status: st,
        why: "额度耗尽或过低",
      });
      continue;
    }

    // 沙箱只能写会话工作区。write、target、workspace 缺任何一项都不检查
    if (write && target && workspace && prov?.sandbox === "workspace" && !isInside(target, workspace)) {
      skipped.push({
        provider: provName,
        pool,
        model,
        via: prov?.via,
        status: st,
        why: `沙箱只能写 ${workspace}，目标目录不在其中`,
      });
      continue;
    }

    // 各项保留 3 位小数，避免浮点尾差（0.9400000000000001）进入展示和比较
    const fit = round(calcFit(i, fitRaw), 3);
    const quota = round(calcQuota(st, now), 3);
    const reliability = round(calcReliability(history, provName, model, role), 3);
    const speed = round(calcSpeed(history, provName, model), 3);
    const { running, load: rawLoad } = calcLoad(history, provName, now);
    const load = round(rawLoad, 3);

    const parts = { fit, reliability, quota, speed, load };
    const score = calcWeightedScore(parts, cfg?.scoreWeights);
    const reason = formatReason(parts, score, st, now, running);

    cands.push({
      provider: provName,
      pool,
      model,
      via: prov?.via,
      status: st,
      score,
      parts,
      reason,
      _index: i,
    });
  }

  cands.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a._index - b._index;
  });

  const ordered = cands.map(({ _index, ...cand }) => cand);

  return {
    role,
    choice: ordered[0] || null,
    alternatives: ordered.slice(1),
    skipped,
  };
}
