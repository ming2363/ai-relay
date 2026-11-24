// ai-relay 模型打分路由单元测试
import test from "node:test";
import assert from "node:assert/strict";
import { scoreRoute } from "./score.mjs";

test("1. 停用厂商、blocked 额度进入 skipped，并带正确的 why", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      codex: { via: "codex-plugin", quota: { provider: "codex" } },
      agy: { via: "relay", quota: { provider: "antigravity" } },
      grok: { via: "relay", enabled: false, quota: { provider: "grok" } },
    },
    routes: {
      implement: [
        "codex:codex:default",
        "agy:gemini:gemini-3.8-flash-high",
        "grok:supergrok-weekly:default",
      ],
    },
  };
  const now = 1700000000000;
  // codex 额度 0.10 (< minRemaining 0.15)，进入 blocked
  // agy 额度 0.80，正常可用
  // grok 厂商设置了 enabled: false，停用
  const rows = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.10, reset_at: now + 3600000, allowance: "available", updated_at: now },
    { provider: "antigravity", pool_id: "gemini", window_key: "5h", remaining_fraction: 0.80, reset_at: now + 3600000, allowance: "available", updated_at: now },
  ];

  const res = scoreRoute(cfg, rows, "implement", { now });
  assert.equal(res.choice?.provider, "agy");
  assert.equal(res.alternatives.length, 0);
  assert.equal(res.skipped.length, 2);

  const codexSkipped = res.skipped.find((s) => s.provider === "codex");
  assert.ok(codexSkipped);
  assert.equal(codexSkipped.why, "额度耗尽或过低");
  assert.equal(codexSkipped.status.level, "blocked");

  const grokSkipped = res.skipped.find((s) => s.provider === "grok");
  assert.ok(grokSkipped);
  assert.equal(grokSkipped.why, "已停用");
});

test("2. 两个候选 fit 不同但额度相同时，靠前的胜出", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      codex: { via: "codex-plugin", quota: { provider: "codex" } },
      agy: { via: "relay", quota: { provider: "antigravity" } },
    },
    routes: {
      implement: [
        "codex:codex:default",
        "agy:gemini:gemini-3.8-flash-high",
      ],
    },
  };
  const now = 1700000000000;
  // 两个候选额度相同且重置时间较远（无重置紧迫度加分），靠前的 fit=1.0，靠后的 fit=0.85
  const rows = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.80, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
    { provider: "antigravity", pool_id: "gemini", window_key: "5h", remaining_fraction: 0.80, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
  ];

  const res = scoreRoute(cfg, rows, "implement", { now });
  assert.equal(res.choice?.provider, "codex");
  assert.equal(res.choice?.parts.fit, 1.0);
  assert.equal(res.alternatives[0]?.provider, "agy");
  assert.equal(res.alternatives[0]?.parts.fit, 0.85);
  assert.ok(res.choice.score > res.alternatives[0].score);
});

test("3. 默认权重下额度不能反超明显更擅长的候选；调高额度权重后才会反超", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      codex: { via: "codex-plugin", quota: { provider: "codex" } },
      agy: { via: "relay", quota: { provider: "antigravity" } },
    },
    routes: {
      implement: [
        "codex:codex:default:1.0",
        "agy:gemini:gemini-3.8-flash-high:0.75",
      ],
    },
  };
  const now = 1700000000000;
  // 第一个候选（codex）：只有 weekly 窗口还剩 50%、6 天（144小时）后重置
  // 第二个候选（agy）：5h 窗口还剩 100%、30 分钟（0.5小时）后重置
  const rows = [
    { provider: "codex", pool_id: "codex", window_key: "weekly", remaining_fraction: 0.50, reset_at: now + 144 * 3600000, allowance: "available", updated_at: now },
    { provider: "antigravity", pool_id: "gemini", window_key: "5h", remaining_fraction: 1.0, reset_at: now + 1800000, allowance: "available", updated_at: now },
  ];

  // 默认权重（额度 0.25，最低）：明显更擅长的 codex 保持第一（差距超过 5% 近似同分带宽）
  const res = scoreRoute(cfg, rows, "implement", { now });
  assert.equal(res.choice?.provider, "codex");
  assert.equal(res.alternatives[0]?.provider, "agy");

  // 用户把额度权重调高（例如 3）时，快重置且额度满的 agy 反超
  const res2 = scoreRoute({ ...cfg, scoreWeights: { quota: 3 } }, rows, "implement", { now });
  assert.equal(res2.choice?.provider, "agy");
  assert.ok(res2.choice.score > res2.alternatives[0].score);
});

test("4. history 里有 verdict fail 的候选可靠度下降", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      codex: { via: "codex-plugin", quota: { provider: "codex" } },
    },
    routes: {
      implement: ["codex:codex:default"],
    },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
  ];

  // 无历史：reliability = 0.4 + 0.6 * 0.9 = 0.94
  const resNoHist = scoreRoute(cfg, rows, "implement", { now, history: [] });
  assert.equal(resNoHist.choice?.parts.reliability, 0.94);

  // 有一条同角色 verdict fail：rate = (0 + 1.8) / (1 + 2) = 0.6 -> reliability = 0.76
  const histFail = [
    { provider: "codex", model: "default", status: "failed", verdict: "fail", role: "implement" },
  ];
  const resFail = scoreRoute(cfg, rows, "implement", { now, history: histFail });
  assert.equal(resFail.choice?.parts.reliability, 0.76);
  assert.ok(resFail.choice.score < resNoHist.choice.score);
});

test("5. level 为 low 时：配速不为 null 按配速公式算（不乘 0.7），配速为 null 时保持旧公式乘 0.7", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      codex: { via: "codex-plugin", quota: { provider: "codex" } },
    },
    routes: {
      implement: ["codex:codex:default"],
    },
  };
  const now = 1700000000000;
  // 1) 有重置时间：remaining = 0.20, 4h 后重置 -> 周期剩余 0.8 -> 配速 = -0.6 -> clamp(0.8 + 0.6*(-0.6), 0.5, 1.4) = 0.5
  const rowsWithReset = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.20, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
  ];
  const resWithReset = scoreRoute(cfg, rowsWithReset, "implement", { now });
  assert.equal(resWithReset.choice?.status.level, "low");
  assert.equal(resWithReset.choice?.pace, -0.6);
  assert.equal(resWithReset.choice?.parts.quota, 0.5);

  // 2) 无重置时间（配速为 null）：remaining = 0.20, expiring = 0 -> (0.6 + 0.4*0.2) * 0.7 = 0.476
  const rowsNoReset = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.20, reset_at: null, allowance: "available", updated_at: now },
  ];
  const resNoReset = scoreRoute(cfg, rowsNoReset, "implement", { now });
  assert.equal(resNoReset.choice?.status.level, "low");
  assert.equal(resNoReset.choice?.pace, null);
  assert.equal(resNoReset.choice?.parts.quota, 0.476);
});

test("6. reason 字符串格式正确，包括\"优先用掉\"的追加", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      agy: { via: "relay", quota: { provider: "antigravity" } },
      codex: { via: "codex-plugin", quota: { provider: "codex" } },
    },
    routes: {
      implement: ["agy:gemini:gemini-3.8-flash-high", "codex:codex:default"],
    },
  };
  const now = 1700000000000;
  // agy: 5h 剩余 100%，0.5 小时后重置（< 5/3 小时）
  // codex: weekly 剩余 80%，20.0 小时后重置（< 168/3 = 56 小时）
  const rows = [
    { provider: "antigravity", pool_id: "gemini", window_key: "5h", remaining_fraction: 1.0, reset_at: now + 1800000, allowance: "available", updated_at: now },
    { provider: "codex", pool_id: "codex", window_key: "weekly", remaining_fraction: 0.8, reset_at: now + 20 * 3600000, allowance: "available", updated_at: now },
  ];

  const res = scoreRoute(cfg, rows, "implement", { now });
  const agy = res.choice;
  assert.match(agy.reason, /^擅长 \d+\.\d{2} · 可靠 \d+\.\d{2} · 额度 \d+\.\d{2} · 速度 \d+\.\d{2} · 负载 \d+\.\d{2} → \d+\.\d{2}；5h 额度 0\.5 小时后重置，优先用掉$/);

  const codex = res.alternatives[0];
  assert.match(codex.reason, /^擅长 \d+\.\d{2} · 可靠 \d+\.\d{2} · 额度 \d+\.\d{2} · 速度 \d+\.\d{2} · 负载 \d+\.\d{2} → \d+\.\d{2}；周 额度 20\.0 小时后重置，优先用掉$/);
});

test("7. only 过滤和未知角色抛错", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      codex: { via: "codex-plugin", quota: { provider: "codex" } },
      agy: { via: "relay", quota: { provider: "antigravity" } },
    },
    routes: {
      implement: ["codex:codex:default", "agy:gemini:gemini-3.8-flash-high"],
      review: ["agy:gemini:gemini-3.8-flash-high"],
    },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.9, reset_at: now + 3600000, allowance: "available", updated_at: now },
    { provider: "antigravity", pool_id: "gemini", window_key: "5h", remaining_fraction: 0.9, reset_at: now + 3600000, allowance: "available", updated_at: now },
  ];

  // only 过滤：只保留 agy
  const resOnly = scoreRoute(cfg, rows, "implement", { only: "agy", now });
  assert.equal(resOnly.choice?.provider, "agy");
  assert.equal(resOnly.alternatives.length, 0);
  assert.equal(resOnly.skipped.length, 0);

  // 未知角色抛错
  assert.throws(
    () => scoreRoute(cfg, rows, "nonexistent"),
    (err) => {
      assert.match(err.message, /未知角色 nonexistent，可选：implement, review/);
      return true;
    }
  );
});

test("8. speed 速度计算：<=90s 为 1，>=600s 为 0.85，中间线性插值，无记录为 1", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: { codex: { via: "codex-plugin", quota: { provider: "codex" } } },
    routes: { implement: ["codex:codex:default"] },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 3600000, allowance: "available", updated_at: now },
  ];

  // 无记录为 1
  const resEmpty = scoreRoute(cfg, rows, "implement", { now, history: [] });
  assert.equal(resEmpty.choice?.parts.speed, 1);

  // <= 90s 为 1
  const histFast = [
    { provider: "codex", model: "default", status: "done", startedAt: "2026-11-04T00:00:00Z", finishedAt: "2026-11-04T00:01:00Z" },
  ];
  const resFast = scoreRoute(cfg, rows, "implement", { now, history: histFast });
  assert.equal(resFast.choice?.parts.speed, 1);

  // >= 600s 为 0.85
  const histSlow = [
    { provider: "codex", model: "default", status: "done", startedAt: "2026-11-04T00:00:00Z", finishedAt: "2026-11-04T00:15:00Z" },
  ];
  const resSlow = scoreRoute(cfg, rows, "implement", { now, history: histSlow });
  assert.equal(resSlow.choice?.parts.speed, 0.85);

  // 耗时 345s 线性插值: 1 - 0.15 * (345 - 90) / 510 = 0.925
  const histMid = [
    { provider: "codex", model: "default", status: "done", startedAt: "2026-11-04T00:00:00Z", finishedAt: "2026-11-04T00:05:45Z" },
  ];
  const resMid = scoreRoute(cfg, rows, "implement", { now, history: histMid });
  assert.ok(Math.abs(resMid.choice?.parts.speed - 0.925) < 1e-6);
});

test("9. reliability 对 partial、timeout、cancelled 的处理", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: { codex: { via: "codex-plugin", quota: { provider: "codex" } } },
    routes: { implement: ["codex:codex:default"] },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 3600000, allowance: "available", updated_at: now },
  ];

  // cancelled 且无 verdict 不计入 -> reliability 保持默认 0.94
  const histCancelled = [
    { provider: "codex", model: "default", status: "cancelled", role: "implement" },
  ];
  const resCancelled = scoreRoute(cfg, rows, "implement", { now, history: histCancelled });
  assert.equal(resCancelled.choice?.parts.reliability, 0.94);

  // partial: score = 0.5, role 相同权重 1 -> rate = 2.3 / 3 -> reliability = 0.4 + 0.6 * (2.3/3) = 0.86
  const histPartial = [
    { provider: "codex", model: "default", status: "done", verdict: "partial", role: "implement" },
  ];
  const resPartial = scoreRoute(cfg, rows, "implement", { now, history: histPartial });
  assert.ok(Math.abs(resPartial.choice?.parts.reliability - 0.86) < 1e-6);

  // timeout 且无 verdict: score = 0, role 相同权重 1, count = 1 -> rate = 1.8 / 3 = 0.6 -> reliability = 0.76
  const histTimeout = [
    { provider: "codex", model: "default", status: "timeout", role: "implement" },
  ];
  const resTimeout = scoreRoute(cfg, rows, "implement", { now, history: histTimeout });
  assert.equal(resTimeout.choice?.parts.reliability, 0.76);
});

test("10. 额度未知（level === unknown）时 quota 为 0.8", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: { codex: { via: "codex-plugin", quota: { provider: "codex" } } },
    routes: { implement: ["codex:codex:default"] },
  };
  const now = 1700000000000;
  const res = scoreRoute(cfg, [], "implement", { now });
  assert.equal(res.choice?.status.level, "unknown");
  assert.equal(res.choice?.parts.quota, 0.8);
});

test("11. 得分相同时按原始路由表顺序优先", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      codex: { via: "codex-plugin", quota: { provider: "codex" } },
      agy: { via: "relay", quota: { provider: "antigravity" } },
    },
    // 第 5、6 候选的 fit 都是 0.4（max(0.4, 1 - 0.15*i)）
    routes: {
      implement: [
        "dummy:d:0",
        "dummy:d:1",
        "dummy:d:2",
        "dummy:d:3",
        "dummy:d:4",
        "codex:codex:default",
        "agy:gemini:gemini-3.8-flash-high",
      ],
    },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
    { provider: "antigravity", pool_id: "gemini", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
  ];

  const res = scoreRoute(cfg, rows, "implement", { now });
  assert.equal(res.choice?.provider, "codex");
  assert.equal(res.alternatives[0]?.provider, "agy");
  assert.equal(res.choice?.score, res.alternatives[0]?.score);
});

test("12. 无可用候选时 choice 为 null", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      grok: { via: "relay", enabled: false, quota: { provider: "grok" } },
    },
    routes: {
      implement: ["grok:supergrok-weekly:default"],
    },
  };
  const res = scoreRoute(cfg, [], "implement");
  assert.equal(res.choice, null);
  assert.equal(res.alternatives.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].why, "已停用");
});

test("13. 质量优先：A 排第 0 位（fit 1.0）额度 low，B 排第 2 位（fit 0.7）额度满，两者无历史记录，A 胜出", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      provA: { via: "relay", quota: { provider: "provA" } },
      dummy: { via: "relay", enabled: false, quota: { provider: "dummy" } },
      provB: { via: "relay", quota: { provider: "provB" } },
    },
    routes: {
      implement: [
        "provA:poolA:modelA", // 第 0 位
        "dummy:poolD:modelD", // 第 1 位
        "provB:poolB:modelB", // 第 2 位
      ],
    },
  };
  const now = 1700000000000;
  // A: 剩余 0.27 (< lowRemaining 0.30，level 为 low)，周窗口 5 天（120h）后重置
  // B: 剩余 1.0 (满)，周窗口 6 天（144h）后重置
  const rows = [
    { provider: "provA", pool_id: "poolA", window_key: "weekly", remaining_fraction: 0.27, reset_at: now + 120 * 3600000, allowance: "available", updated_at: now },
    { provider: "provB", pool_id: "poolB", window_key: "weekly", remaining_fraction: 1.0, reset_at: now + 144 * 3600000, allowance: "available", updated_at: now },
  ];

  const res = scoreRoute(cfg, rows, "implement", { now, history: [] });
  assert.equal(res.choice?.provider, "provA");
  assert.equal(res.choice?.status.level, "low");
  assert.equal(res.choice?.parts.fit, 1.0);

  const candB = res.alternatives.find((c) => c.provider === "provB");
  assert.ok(candB);
  assert.equal(candB.parts.fit, 0.7);
  assert.ok(res.choice.score > candB.score);
});

test("14. 可靠度按角色加权：同一模型在 review 角色下 2 条 fail，在 implement 角色下 2 条 pass，选 implement 时可靠度高于选 review", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      codex: { via: "codex-plugin", quota: { provider: "codex" } },
    },
    routes: {
      implement: ["codex:codex:default"],
      review: ["codex:codex:default"],
    },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
  ];
  const history = [
    { provider: "codex", model: "default", status: "failed", verdict: "fail", role: "review" },
    { provider: "codex", model: "default", status: "failed", verdict: "fail", role: "review" },
    { provider: "codex", model: "default", status: "done", verdict: "pass", role: "implement" },
    { provider: "codex", model: "default", status: "done", verdict: "pass", role: "implement" },
  ];

  const resImplement = scoreRoute(cfg, rows, "implement", { now, history });
  const resReview = scoreRoute(cfg, rows, "review", { now, history });

  // implement: 2 条 pass 权重大(1)，2 条 fail 权重小(0.5) -> rate = (2+1.8)/(3+2) = 0.76 -> rel = 0.856
  // review: 2 条 fail 权重大(1)，2 条 pass 权重小(0.5) -> rate = (1+1.8)/(3+2) = 0.56 -> rel = 0.736
  assert.equal(resImplement.choice?.parts.reliability, 0.856);
  assert.equal(resReview.choice?.parts.reliability, 0.736);
  assert.ok(resImplement.choice.parts.reliability > resReview.choice.parts.reliability);
});

test("15. 负载：同 provider 有 2 条 running 记录（10 分钟前开始），load 为 1/1.4，reason 含\"该厂商有 2 个任务在跑\"，90 分钟前的记录不计入", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      agy: { via: "relay", quota: { provider: "antigravity" } },
    },
    routes: {
      implement: ["agy:gemini:gemini-3.8-flash-high"],
    },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "antigravity", pool_id: "gemini", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
  ];
  const history = [
    // 2 条 10 分钟前开始的 running 任务（计入）
    { provider: "agy", model: "gemini-3.8-flash-high", status: "running", startedAt: new Date(now - 10 * 60 * 1000).toISOString() },
    { provider: "agy", model: "gemini-3.8-flash-high", status: "running", startedAt: new Date(now - 10 * 60 * 1000).toISOString() },
    // 1 条 90 分钟前开始的 running 任务（超时不计入）
    { provider: "agy", model: "gemini-3.8-flash-high", status: "running", startedAt: new Date(now - 90 * 60 * 1000).toISOString() },
    // 1 条其它 provider 的 running 任务（不计入）
    { provider: "codex", model: "default", status: "running", startedAt: new Date(now - 10 * 60 * 1000).toISOString() },
  ];

  const res = scoreRoute(cfg, rows, "implement", { now, history });
  // load = 1 / (1 + 0.2 * 2) = 1 / 1.4 ≈ 0.714
  const expectedLoad = Math.round((1 / 1.4 + Number.EPSILON) * 1000) / 1000;
  assert.equal(res.choice?.parts.load, expectedLoad);
  assert.match(res.choice?.reason, /该厂商有 2 个任务在跑/);
});

test("16. 第 4 段擅长度：x:p:m:0.75 的 fit 为 0.75，超出范围的值被截断到 0.1–1", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      prov1: { via: "relay", quota: { provider: "p1" } },
      prov2: { via: "relay", quota: { provider: "p2" } },
      prov3: { via: "relay", quota: { provider: "p3" } },
    },
    routes: {
      implement: [
        "prov1:pool1:model1:0.75", // 显式指定 0.75
        "prov2:pool2:model2:1.5",  // 超出上限，应截断为 1.0
        "prov3:pool3:model3:0.05", // 超出下限，应截断为 0.1
      ],
    },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "p1", pool_id: "pool1", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
    { provider: "p2", pool_id: "pool2", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
    { provider: "p3", pool_id: "pool3", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
  ];

  const res = scoreRoute(cfg, rows, "implement", { now });
  const c1 = [res.choice, ...res.alternatives].find((c) => c.provider === "prov1");
  const c2 = [res.choice, ...res.alternatives].find((c) => c.provider === "prov2");
  const c3 = [res.choice, ...res.alternatives].find((c) => c.provider === "prov3");

  assert.equal(c1?.parts.fit, 0.75);
  assert.equal(c2?.parts.fit, 1.0);
  assert.equal(c3?.parts.fit, 0.1);
});

test("17. 权重覆盖：cfg.scoreWeights = { quota: 5 } 时，额度高的候选能反超", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    scoreWeights: { quota: 5 },
    providers: {
      provA: { via: "relay", quota: { provider: "provA" } },
      dummy: { via: "relay", quota: { provider: "dummy" } },
      provB: { via: "relay", quota: { provider: "provB" } },
    },
    routes: {
      implement: [
        "provA:poolA:modelA", // 第 0 位，fit 1.0，但额度 low
        "dummy:poolD:modelD",
        "provB:poolB:modelB", // 第 2 位，fit 0.7，但额度满
      ],
    },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "provA", pool_id: "poolA", window_key: "weekly", remaining_fraction: 0.27, reset_at: now + 120 * 3600000, allowance: "available", updated_at: now },
    { provider: "provB", pool_id: "poolB", window_key: "weekly", remaining_fraction: 1.0, reset_at: now + 144 * 3600000, allowance: "available", updated_at: now },
  ];

  const res = scoreRoute(cfg, rows, "implement", { now, history: [] });
  // 在 quota: 5 高权重下，provB 反超 provA 成为 choice
  assert.equal(res.choice?.provider, "provB");
  const candA = res.alternatives.find((c) => c.provider === "provA");
  assert.ok(candA);
  assert.ok(res.choice.score > candA.score);
});

function sandboxCfg() {
  return {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      codex: { via: "codex-plugin", sandbox: "workspace", quota: { provider: "codex" } },
      agy: { via: "relay", quota: { provider: "antigravity" } },
    },
    routes: {
      implement: [
        "codex:codex:default",
        "agy:gemini:gemini-3.8-flash-high",
      ],
    },
  };
}

function sandboxRows(now) {
  return [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
    { provider: "antigravity", pool_id: "gemini", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
  ];
}

test("18. 目标目录在工作区外时，sandbox 为 workspace 的厂商被跳过，why 正确", () => {
  const now = 1700000000000;
  const workspace = "/Users/x/proj";
  const target = "/Users/x/.claude/local-marketplace";
  const res = scoreRoute(sandboxCfg(), sandboxRows(now), "implement", { now, write: true, target, workspace });
  assert.equal(res.choice?.provider, "agy");
  const codex = res.skipped.find((s) => s.provider === "codex");
  assert.ok(codex);
  assert.equal(codex.why, `沙箱只能写 ${workspace}，目标目录不在其中`);
  assert.equal(res.skipped.some((s) => s.provider === "agy"), false);
});

test("19. 目标目录在工作区内时，sandbox 为 workspace 的厂商不跳过", () => {
  const now = 1700000000000;
  const workspace = "/Users/x/proj";
  const target = "/Users/x/proj/frontend-demo";
  const res = scoreRoute(sandboxCfg(), sandboxRows(now), "implement", { now, write: true, target, workspace });
  assert.equal(res.choice?.provider, "codex");
  assert.equal(res.skipped.length, 0);
});

test("20. 不传 write、target 时，即使厂商沙箱只能写工作区也不跳过", () => {
  const now = 1700000000000;
  const res = scoreRoute(sandboxCfg(), sandboxRows(now), "implement", { now });
  assert.equal(res.choice?.provider, "codex");
  assert.equal(res.skipped.length, 0);
});

function capsCfg() {
  return {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      codex: { via: "codex-plugin", caps: { web: false, exec: true }, quota: { provider: "codex" } },
      agy: { via: "relay", caps: { web: true, exec: false }, quota: { provider: "antigravity" } },
      grok: { via: "relay", caps: { web: false, exec: false }, quota: { provider: "grok" } },
    },
    routes: {
      implement: [
        "codex:codex:default",
        "agy:gemini:gemini-3.8-flash-high",
        "grok:supergrok-weekly:default",
      ],
    },
  };
}

function capsRows(now) {
  return [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
    { provider: "antigravity", pool_id: "gemini", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
    { provider: "grok", pool_id: "supergrok-weekly", window_key: "weekly", remaining_fraction: 0.8, reset_at: now + 20 * 3600000, allowance: "available", updated_at: now },
  ];
}

test("21. 需要 web 时，caps.web 为 false 的厂商被跳过，why 为不具备：联网", () => {
  const now = 1700000000000;
  const res = scoreRoute(capsCfg(), capsRows(now), "implement", { now, needs: ["web"] });
  assert.equal(res.choice?.provider, "agy");
  const codex = res.skipped.find((s) => s.provider === "codex");
  assert.ok(codex);
  assert.equal(codex.why, "不具备：联网");
  const grok = res.skipped.find((s) => s.provider === "grok");
  assert.ok(grok);
  assert.equal(grok.why, "不具备：联网");
  assert.equal(res.skipped.some((s) => s.provider === "agy"), false);
});

test("22. 同时需要 web 和 exec 时，两项都缺的厂商 why 为不具备：联网、执行命令", () => {
  const now = 1700000000000;
  const res = scoreRoute(capsCfg(), capsRows(now), "implement", { now, needs: ["web", "exec"] });
  const grok = res.skipped.find((s) => s.provider === "grok");
  assert.ok(grok);
  assert.equal(grok.why, "不具备：联网、执行命令");
  assert.equal(res.choice, null);
  assert.equal(res.skipped.find((s) => s.provider === "codex")?.why, "不具备：联网");
  assert.equal(res.skipped.find((s) => s.provider === "agy")?.why, "不具备：执行命令");
});

test("23. 不传 needs 时不按能力跳过", () => {
  const now = 1700000000000;
  const res = scoreRoute(capsCfg(), capsRows(now), "implement", { now });
  assert.equal(res.choice?.provider, "codex");
  assert.equal(res.skipped.length, 0);
});

test("24. route 写 default 且有 defaultModels 时，候选 model 是实际模型，可靠度按实际模型查", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      agy: {
        via: "relay",
        quota: { provider: "antigravity" },
        defaultModels: {
          "gemini-argon": "gemini-4-argon-high",
        },
      },
    },
    routes: {
      implement: ["agy:gemini-argon:default:0.9"],
    },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "antigravity", pool_id: "gemini-argon", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
  ];
  const history = [
    { provider: "agy", model: "gemini-4-argon-high", status: "failed", verdict: "fail", role: "implement" },
  ];

  const res = scoreRoute(cfg, rows, "implement", { now, history });
  assert.equal(res.choice?.model, "gemini-4-argon-high");
  assert.equal(res.choice?.routeModel, "default");
  // 按实际模型 gemini-4-argon-high 查到 1 条同角色 fail，reliability 从 0.94 降为 0.76
  assert.equal(res.choice?.parts.reliability, 0.76);
});

test("25. 路由去重遇到同一 厂商|池|模型 时保留 fit 更高的条目（含 defaultModels 切到同模型和思考档合并）", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      agy: {
        via: "relay",
        quota: { provider: "antigravity" },
        defaultModels: {
          gemini: "gemini-4-neon-xhigh",
          "gemini-argon": "gemini-4-argon-high",
        },
        pools: {
          gemini: ["gemini-4-neon-xhigh", "gemini-4-neon-high", "gemini-4-hydrogen-xhigh"],
          "gemini-argon": ["gemini-4-argon-high", "gemini-4-argon-medium"],
        },
      },
    },
    routes: {
      // default 解析为 gemini-4-neon-xhigh（fit 0.4）在前，末尾显式 Neon 条目（fit 0.9）在后
      implement: [
        "agy:gemini:default:0.4",
        "agy:gemini-argon:default:0.85",
        "agy:gemini:gemini-4-neon-xhigh:0.9",
      ],
      // 思考档换到目标档后同为 gemini-4-argon-high：低 fit 在前、高 fit 在后应留高 fit；同 fit 留先出现的
      review: [
        "agy:gemini-argon:gemini-4-argon-medium:0.6",
        "agy:gemini-argon:gemini-4-argon-high:0.9",
        "agy:gemini:gemini-4-neon-high:0.8",
        "agy:gemini:gemini-4-neon-xhigh:0.8",
      ],
    },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "antigravity", pool_id: "gemini", window_key: "5h", remaining_fraction: 0.9, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
    { provider: "antigravity", pool_id: "gemini-argon", window_key: "5h", remaining_fraction: 0.9, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
  ];

  const impl = scoreRoute(cfg, rows, "implement", { now, level: "hard" });
  const neons = [impl.choice, ...impl.alternatives].filter((c) => c.model === "gemini-4-neon-xhigh");
  assert.equal(neons.length, 1);
  assert.equal(impl.choice?.model, "gemini-4-neon-xhigh");
  assert.equal(impl.choice?.parts.fit, 0.9);
  assert.equal(impl.choice?.routeModel, "gemini-4-neon-xhigh");

  const rev = scoreRoute(cfg, rows, "review", { now, level: "hard" });
  assert.equal(rev.choice?.model, "gemini-4-argon-high");
  assert.equal(rev.choice?.parts.fit, 0.9);
  assert.equal(rev.choice?.routeModel, "gemini-4-argon-high");
  const revNeon = rev.alternatives.find((c) => c.model === "gemini-4-neon-xhigh");
  assert.equal(revNeon?.parts.fit, 0.8);
  // 同 fit（0.8）时保留先出现的条目
  assert.equal(revNeon?.routeModel, "gemini-4-neon-high");
});

test("26. 排序比较用未取整原始分：3 位小数取整并列时高原始分胜出，不再靠路由下标决胜", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    modelTiers: {
      "provA:*": "strong",
      "provB:*": "strong",
    },
    providers: {
      provA: { via: "relay", quota: { provider: "provA" } },
      provB: { via: "relay", quota: { provider: "provB" } },
    },
    routes: {
      // provA 排在下标 0，provB 排在下标 1；两者 fit / reliability / speed / load 均相同
      review: [
        "provA:pA:mA:0.85",
        "provB:pB:mB:0.85",
      ],
    },
  };
  const now = 1700000000000;
  // hard 权重 fit=3, rel=3, quota=0.1, speed=0.25, load=0.25
  // provA: pace=0 -> quota=0.800 -> rawScore ≈ 0.899984 -> round3 = 0.9
  // provB: pace=+0.025 -> quota=0.815 -> rawScore ≈ 0.900237 -> round3 = 0.9
  const rows = [
    { provider: "provA", pool_id: "pA", window_key: "5h", remaining_fraction: 0.5, reset_at: now + 2.5 * 3600000, allowance: "available", updated_at: now },
    { provider: "provB", pool_id: "pB", window_key: "5h", remaining_fraction: 0.525, reset_at: now + 2.5 * 3600000, allowance: "available", updated_at: now },
  ];

  const res = scoreRoute(cfg, rows, "review", { now, level: "hard" });
  assert.equal(res.choice?.provider, "provB");
  assert.equal(res.alternatives[0]?.provider, "provA");
  // 对外返回的 score 字段仍保留 3 位小数（本例两者同为 0.9）
  assert.equal(res.choice?.score, 0.9);
  assert.equal(res.alternatives[0]?.score, 0.9);
  // 内部排序字段不泄漏到返回对象
  assert.equal("_rawScore" in res.choice, false);
});

test("27. calcReliability 跳过 quotaExhausted === true 的历史记录，不拉低可靠度", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      agy: { via: "relay", quota: { provider: "antigravity" } },
    },
    routes: {
      implement: ["agy:claude-gpt:claude-opus-5-5-high"],
    },
  };
  const now = 1700000000000;
  const rows = [
    { provider: "antigravity", pool_id: "claude-gpt", window_key: "5h", remaining_fraction: 0.8, reset_at: now + 4 * 3600000, allowance: "available", updated_at: now },
  ];

  // 全部是额度耗尽导致的失败（含带 verdict: fail 和不带 verdict 两种）：跳过后可靠度保持默认 0.94
  const onlyExhausted = [
    { provider: "agy", model: "claude-opus-5-5-high", status: "failed", verdict: "fail", role: "implement", quotaExhausted: true },
    { provider: "agy", model: "claude-opus-5-5-high", status: "failed", verdict: "fail", role: "implement", quotaExhausted: true },
    { provider: "agy", model: "claude-opus-5-5-high", status: "failed", role: "implement", quotaExhausted: true },
  ];
  const resExhausted = scoreRoute(cfg, rows, "implement", { now, history: onlyExhausted });
  assert.equal(resExhausted.choice?.parts.reliability, 0.94);

  // 混入 1 条非额度耗尽的普通失败（quotaExhausted 为 false 或缺省）：只算这条普通失败，可靠度降为 0.76
  const mixed = [
    ...onlyExhausted,
    { provider: "agy", model: "claude-opus-5-5-high", status: "failed", verdict: "fail", role: "implement", quotaExhausted: false },
  ];
  const resMixed = scoreRoute(cfg, rows, "implement", { now, history: mixed });
  assert.equal(resMixed.choice?.parts.reliability, 0.76);
});
