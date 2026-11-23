// 配速打分、保留规则、近似同分排序、中等任务优先中档、会员优先按量兜底单元测试
import test from "node:test";
import assert from "node:assert/strict";
import { paceOf, scoreRoute } from "./score.mjs";
import { poolStatus } from "./lib.mjs";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

test("1. paceOf：多窗口取最小值，缺少 remaining 或 resetAt 或已过重置点返回 null", () => {
  // 5h 窗口剩 90%，距重置 1.5h（周期剩 30%） -> 配速 +0.6
  // weekly 窗口剩 30%，距重置 151.2h（周期剩 90%） -> 配速 -0.6
  const st = {
    windows: [
      { key: "5h", remaining: 0.9, resetAt: NOW + 1.5 * HOUR, resetPassed: false },
      { key: "weekly", remaining: 0.3, resetAt: NOW + 151.2 * HOUR, resetPassed: false },
    ],
  };
  assert.ok(Math.abs(paceOf(st, NOW) - -0.6) < 1e-6);

  // 无 resetAt 或已过重置点
  assert.equal(paceOf({ windows: [{ key: "5h", remaining: 0.8, resetAt: null }] }, NOW), null);
  assert.equal(paceOf({ windows: [{ key: "5h", remaining: 0.8, resetAt: NOW - 1000, resetPassed: true }] }, NOW), null);
  assert.equal(paceOf({ windows: [] }, NOW), null);
  assert.equal(paceOf(null, NOW), null);
});

test("2. 剩 90%/周期剩 30% 的池额度项高于剩 30%/周期剩 90% 的；后者中等任务排最后，困难任务位置不变", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    modelTiers: {
      "fastUse:*": "strong",
      "richPool:*": "strong",
    },
    providers: {
      fastUse: { via: "relay", quota: { provider: "fastUse" } },
      richPool: { via: "relay", quota: { provider: "richPool" } },
    },
    routes: {
      implement: [
        "fastUse:p1:m1:1.0", // 擅长度更高（1.0），但剩 30%/周期剩 90%（配速 -0.6）
        "richPool:p2:m2:0.8", // 擅长度较低（0.8），但剩 90%/周期剩 30%（配速 +0.6）
      ],
    },
  };

  const rows = [
    // fastUse: 5h 窗口剩 30%，距重置 4.5h（周期剩 90%），配速 = -0.6 < -0.15
    { provider: "fastUse", pool_id: "p1", window_key: "5h", remaining_fraction: 0.3, reset_at: NOW + 4.5 * HOUR, allowance: "available", updated_at: NOW },
    // richPool: 5h 窗口剩 90%，距重置 1.5h（周期剩 30%），配速 = +0.6
    { provider: "richPool", pool_id: "p2", window_key: "5h", remaining_fraction: 0.9, reset_at: NOW + 1.5 * HOUR, allowance: "available", updated_at: NOW },
  ];

  // 中等任务：richPool 额度项 1.16 > fastUse 额度项 0.5；fastUse 进入保留组排最后并带 demoted
  const med = scoreRoute(cfg, rows, "implement", { now: NOW, level: "medium" });
  const richCand = [med.choice, ...med.alternatives].find((c) => c.provider === "richPool");
  const fastCand = [med.choice, ...med.alternatives].find((c) => c.provider === "fastUse");
  assert.equal(richCand.pace, 0.6);
  assert.equal(fastCand.pace, -0.6);
  assert.equal(richCand.parts.quota, 1.16);
  assert.equal(fastCand.parts.quota, 0.5);
  assert.ok(richCand.parts.quota > fastCand.parts.quota);

  assert.equal(med.choice.provider, "richPool");
  assert.equal(med.alternatives[0].provider, "fastUse");
  assert.equal(med.alternatives[0].demoted, "用得比进度快，留给困难任务");
  assert.equal(med.choice.demoted, undefined);

  // 困难任务：不分组，fastUse 因擅长度高依然排第一，且不带 demoted
  const hard = scoreRoute(cfg, rows, "implement", { now: NOW, level: "hard" });
  assert.equal(hard.choice.provider, "fastUse");
  assert.equal(hard.choice.demoted, undefined);
  assert.equal(hard.alternatives[0].provider, "richPool");
});

test("3. 配速不为负时，即使剩余低于 lowRemaining（30%）也不打七折", () => {
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
  // 剩 25%（< 30%，status.level 为 low），距重置 0.5h（周期剩 10%），配速 = +0.15 >= 0
  // quota = clamp(0.8 + 0.6 * 0.15, 0.5, 1.4) = 0.89（不乘 0.7）
  const rows = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.25, reset_at: NOW + 0.5 * HOUR, allowance: "available", updated_at: NOW },
  ];
  const res = scoreRoute(cfg, rows, "implement", { now: NOW });
  assert.equal(res.choice.status.level, "low");
  assert.equal(res.choice.pace, 0.15);
  assert.equal(res.choice.parts.quota, 0.89);
});

test("4. 近似同分按配速排：分数差 3% 按配速高到低排，差 10% 按分数排", () => {
  const makeCfg = (fitB) => ({
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      provA: { via: "relay", quota: { provider: "provA" } },
      provB: { via: "relay", quota: { provider: "provB" } },
    },
    routes: {
      implement: [
        `provA:pA:mA:1.0`,
        `provB:pB:mB:${fitB}`,
      ],
    },
  });

  // provA: 剩 50%，周期剩 50% -> 配速 0，quota 0.8
  // provB: 剩 90%，周期剩 30% -> 配速 +0.6，quota 1.16
  const rows = [
    { provider: "provA", pool_id: "pA", window_key: "5h", remaining_fraction: 0.5, reset_at: NOW + 2.5 * HOUR, allowance: "available", updated_at: NOW },
    { provider: "provB", pool_id: "pB", window_key: "5h", remaining_fraction: 0.9, reset_at: NOW + 1.5 * HOUR, allowance: "available", updated_at: NOW },
  ];

  // 情况 1：fitB = 0.90 -> provA 分数约 0.968，provB 分数约 0.939，相差约 3.0%（<= 5%） -> 按配速排，provB 在前
  const res3pct = scoreRoute(makeCfg(0.9), rows, "implement", { now: NOW, level: "medium" });
  const diffRatio1 = Math.abs(res3pct.choice.score - res3pct.alternatives[0].score) / Math.max(res3pct.choice.score, res3pct.alternatives[0].score);
  assert.ok(diffRatio1 > 0.02 && diffRatio1 <= 0.05, `预期分差在 2%~5% 之间，实际 ${diffRatio1}`);
  assert.equal(res3pct.choice.provider, "provB");
  assert.equal(res3pct.alternatives[0].provider, "provA");
  assert.ok(res3pct.choice.score < res3pct.alternatives[0].score, "provB 分数略低但因配速高排第一");

  // 情况 2：fitB = 0.75 -> provA 分数约 0.968，provB 分数约 0.871，相差约 10.0%（> 5%） -> 按分数排，provA 在前
  const res10pct = scoreRoute(makeCfg(0.75), rows, "implement", { now: NOW, level: "medium" });
  const diffRatio2 = (res10pct.choice.score - res10pct.alternatives[0].score) / res10pct.choice.score;
  assert.ok(diffRatio2 >= 0.08, `预期分差约 10%，实际 ${diffRatio2}`);
  assert.equal(res10pct.choice.provider, "provA");
  assert.equal(res10pct.alternatives[0].provider, "provB");
});

test("5. 中等任务分组排序：会员中档 -> 会员强档 -> 保留池 -> 按量计费；demoted 文字写入字段与 reason", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    modelTiers: {
      "strongProv:strongModel": "strong",
      "midProv:midModel": "mid",
      "meteredProv:meteredMid": "mid",
      "reservedProv:reservedMid": "mid",
      "reservedProv:reservedStrong": "strong",
    },
    providers: {
      strongProv: { via: "relay", quota: { provider: "strongProv" }, pools: { pStrong: ["strongModel"] } },
      midProv: { via: "relay", quota: { provider: "midProv" }, pools: { pMid: ["midModel"] } },
      meteredProv: { via: "relay", billing: "metered", quota: { provider: "meteredProv" }, pools: { pMeter: ["meteredMid"] } },
      // 保留池里存在强档模型（reservedStrong），才触发「留给困难任务」
      reservedProv: { via: "relay", quota: { provider: "reservedProv" }, pools: { pRes: ["reservedStrong", "reservedMid"] } },
    },
    routes: {
      implement: [
        "strongProv:pStrong:strongModel:1.0", // 会员强档（擅长度最高 1.0）
        "midProv:pMid:midModel:0.8",          // 会员中档（擅长度 0.8）
        "meteredProv:pMeter:meteredMid:0.95", // 按量中档（擅长度 0.95）
        "reservedProv:pRes:reservedMid:0.95", // 保留会员中档（剩余 0.3 < 0.5 且配速 -0.5 < -0.15）
      ],
    },
  };

  const baseRows = [
    { provider: "strongProv", pool_id: "pStrong", window_key: "5h", remaining_fraction: 0.8, reset_at: NOW + 2.5 * HOUR, allowance: "available", updated_at: NOW },
    { provider: "midProv", pool_id: "pMid", window_key: "5h", remaining_fraction: 0.8, reset_at: NOW + 2.5 * HOUR, allowance: "available", updated_at: NOW },
    { provider: "reservedProv", pool_id: "pRes", window_key: "5h", remaining_fraction: 0.3, reset_at: NOW + 4.0 * HOUR, allowance: "available", updated_at: NOW },
  ];

  // 1) 会员中档和强档都可用时：会员中档 -> 会员强档 -> 保留会员池 -> 按量计费
  const res1 = scoreRoute(cfg, baseRows, "implement", { now: NOW, level: "medium" });
  const order1 = [res1.choice, ...res1.alternatives].map((c) => c.provider);
  assert.deepEqual(order1, ["midProv", "strongProv", "reservedProv", "meteredProv"]);
  assert.equal(res1.choice.demoted, undefined);
  assert.equal(res1.alternatives[0].demoted, undefined);
  assert.equal(res1.alternatives[1].demoted, "用得比进度快，留给困难任务");
  assert.match(res1.alternatives[1].reason, /；用得比进度快，留给困难任务$/);
  assert.equal(res1.alternatives[2].demoted, "按量计费，会员候选优先");
  assert.match(res1.alternatives[2].reason, /；按量计费，会员候选优先$/);

  // 2) 会员中档不可用（blocked）时：首选会员强档，接着保留会员池、按量计费
  const rowsNoMid = [
    baseRows[0],
    { ...baseRows[1], remaining_fraction: 0.05 }, // midProv 耗尽
    baseRows[2],
  ];
  const res2 = scoreRoute(cfg, rowsNoMid, "implement", { now: NOW, level: "medium" });
  const order2 = [res2.choice, ...res2.alternatives].map((c) => c.provider);
  assert.deepEqual(order2, ["strongProv", "reservedProv", "meteredProv"]);
  assert.equal(res2.choice.provider, "strongProv");

  // 3) 未进保留的会员都不可用时：被保留的会员池仍排在按量计费之前
  const rowsOnlyMeteredAndReserved = [
    { ...baseRows[0], remaining_fraction: 0.05 }, // strongProv 耗尽
    { ...baseRows[1], remaining_fraction: 0.05 }, // midProv 耗尽
    baseRows[2],
  ];
  const res3 = scoreRoute(cfg, rowsOnlyMeteredAndReserved, "implement", { now: NOW, level: "medium" });
  assert.equal(res3.choice.provider, "reservedProv");
  assert.equal(res3.choice.demoted, "用得比进度快，留给困难任务");
  assert.match(res3.choice.reason, /；用得比进度快，留给困难任务$/);
  assert.equal(res3.alternatives[0].provider, "meteredProv");
  assert.equal(res3.alternatives[0].demoted, "按量计费，会员候选优先");
  assert.match(res3.alternatives[0].reason, /；按量计费，会员候选优先$/);

  // 4) 简单任务分组顺序：①会员 ②保留会员 ③按量计费
  const resEasy = scoreRoute(cfg, baseRows, "implement", { now: NOW, level: "easy" });
  const orderEasy = [resEasy.choice, ...resEasy.alternatives].map((c) => c.provider);
  assert.deepEqual(orderEasy, ["midProv", "strongProv", "reservedProv", "meteredProv"]);
  assert.equal(resEasy.alternatives[1].demoted, "用得比进度快，留给困难任务");
  assert.equal(resEasy.alternatives[2].demoted, "按量计费，会员候选优先");
});

test("6. 配速为 null 的池打分与改动前完全一致", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      codex: { via: "codex-plugin", quota: { provider: "codex" } },
      grok: { via: "relay", quota: { provider: "grok" } },
    },
    routes: {
      implement: [
        "codex:codex:default:1.0",
        "grok:supergrok-weekly:default:0.85",
      ],
    },
  };
  // 没有 reset_at，配速为 null
  const rows = [
    { provider: "codex", pool_id: "codex", window_key: "5h", remaining_fraction: 0.75, reset_at: null, allowance: "available", updated_at: NOW },
    { provider: "grok", pool_id: "supergrok-weekly", window_key: "weekly", remaining_fraction: 0.25, reset_at: null, allowance: "available", updated_at: NOW },
  ];

  const res = scoreRoute(cfg, rows, "implement", { now: NOW });
  const codex = res.choice;
  const grok = res.alternatives[0];

  assert.equal(codex.pace, null);
  // 旧公式：0.6 + 0.4 * 0.75 + 0 = 0.9
  assert.equal(codex.parts.quota, 0.9);

  assert.equal(grok.pace, null);
  // 旧公式：(0.6 + 0.4 * 0.25 + 0) * 0.7 = 0.49
  assert.equal(grok.parts.quota, 0.49);
});

test("7. reserved 仅在池存在强档模型且剩余 < 0.5 时触发：纯中档池与剩余 ≥ 0.5 均不被保留，保留池排在 maas 前", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      grok: {
        via: "relay",
        quota: { provider: "grok" },
        pools: { "supergrok-weekly": ["grok-4.7"] },
      },
      agy: {
        via: "relay",
        quota: { provider: "antigravity" },
        pools: {
          "claude-gpt": ["claude-opus-5-5-high", "claude-sonnet-5-5-high"],
          "gemini-argon": ["gemini-4-argon-high"],
        },
      },
      maas: {
        via: "relay",
        billing: "metered",
        quota: { provider: "maas" },
        pools: { maas: ["qwen4-max"] },
      },
    },
    routes: {
      implement: [
        "grok:supergrok-weekly:grok-4.7:0.85",        // 纯中档池
        "agy:claude-gpt:claude-sonnet-5-5-high:0.8",  // 含强档池里的中档模型
        "agy:gemini-argon:gemini-4-argon-high:0.9",   // 强档池
        "maas:maas:qwen4-max:0.95",                   // 按量计费
      ],
    },
  };

  // 1) 纯中档池 grok 剩余 0.30（<0.5）且配速 -0.60（<-0.15）：无强档模型，不被保留
  // 2) 含强档池 claude-gpt 剩余 0.50（>=0.5，边界值）且配速 -0.40（<-0.15）：剩余未低于 0.5，不被保留
  // 3) 含强档池 gemini-argon 剩余 0.40（<0.5）且配速 -0.50（<-0.15）：触发保留，但仍排在按量 maas 前
  const rows = [
    { provider: "grok", pool_id: "supergrok-weekly", window_key: "weekly", remaining_fraction: 0.30, reset_at: NOW + 151.2 * HOUR, allowance: "available", updated_at: NOW },
    { provider: "antigravity", pool_id: "claude-gpt", window_key: "5h", remaining_fraction: 0.50, reset_at: NOW + 4.5 * HOUR, allowance: "available", updated_at: NOW },
    { provider: "antigravity", pool_id: "gemini-argon", window_key: "5h", remaining_fraction: 0.40, reset_at: NOW + 4.5 * HOUR, allowance: "available", updated_at: NOW },
  ];

  const res = scoreRoute(cfg, rows, "implement", { now: NOW, level: "medium" });
  const all = [res.choice, ...res.alternatives];
  const grok = all.find((c) => c.provider === "grok");
  const sonnet = all.find((c) => c.pool === "claude-gpt");
  const argon = all.find((c) => c.pool === "gemini-argon");
  const maas = all.find((c) => c.provider === "maas");

  assert.equal(grok.demoted, undefined);
  assert.doesNotMatch(grok.reason, /留给困难任务/);
  assert.equal(sonnet.demoted, undefined);
  assert.doesNotMatch(sonnet.reason, /留给困难任务/);

  assert.equal(argon.demoted, "用得比进度快，留给困难任务");
  assert.match(argon.reason, /用得比进度快，留给困难任务/);
  assert.equal(maas.demoted, "按量计费，会员候选优先");
  assert.match(maas.reason, /按量计费，会员候选优先/);

  // 顺序：两个未保留中档（grok / sonnet，彼此按分数排）在前，接着保留池 argon，最后按量 maas
  const order = all.map((c) => `${c.provider}/${c.pool}`);
  assert.deepEqual(order.slice(0, 2).sort(), ["agy/claude-gpt", "grok/supergrok-weekly"]);
  assert.deepEqual(order.slice(2), ["agy/gemini-argon", "maas/maas"]);

  // 再测剩余 0.64（模拟 5h 64%、刚起步配速 -0.173）：同样不被保留
  const rows64 = [
    { provider: "grok", pool_id: "supergrok-weekly", window_key: "weekly", remaining_fraction: 0.05, reset_at: NOW + 151.2 * HOUR, allowance: "available", updated_at: NOW },
    { provider: "antigravity", pool_id: "claude-gpt", window_key: "5h", remaining_fraction: 0.64, reset_at: NOW + 4.065 * HOUR, allowance: "available", updated_at: NOW },
    { provider: "antigravity", pool_id: "gemini-argon", window_key: "5h", remaining_fraction: 0.40, reset_at: NOW + 4.5 * HOUR, allowance: "available", updated_at: NOW },
  ];
  const res64 = scoreRoute(cfg, rows64, "implement", { now: NOW, level: "medium" });
  assert.equal(res64.choice.pool, "claude-gpt");
  assert.equal(res64.choice.demoted, undefined);
  assert.ok(res64.choice.pace < -0.15);
});
