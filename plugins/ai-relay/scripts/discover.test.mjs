// ai-relay 新模型自动发现与接入单元测试
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { capsOf } from "./lib.mjs";
import { checkBrief, roleOfBrief, levelOfBrief, needsOfBrief } from "./brief.mjs";
import { assignPool } from "./models.mjs";
import { modelTier } from "./score.mjs";
import {
  DISCOVER_INTERVAL_MS,
  discoverModels,
  undoDiscover,
  listDiscoverRecords,
  loadDiscoverState,
  discoverLogPath,
  discoverLockPath,
  parseAiQuotaSnapshots,
  validateResearchResult,
  extractJsonObject,
  buildResearchBrief,
} from "./discover.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RELAY_PATH = path.join(DIR, "relay.mjs");

// 构造隔离的测试环境（临时目录 + 最小完整配置）
function makeEnv(customizer) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-discover-"));
  const configFile = path.join(stateDir, "providers.json");
  const cfg = {
    version: 1,
    quotaDb: "",
    providers: {
      claude: { label: "Claude", self: true, quota: { provider: "claude", pools: ["claude-subscription"] } },
      agy: {
        label: "Antigravity Pro",
        via: "relay",
        quota: { provider: "antigravity" },
        poolRules: [
          ["argon", "gemini-argon"],
          ["flash", "gemini"],
          ["^(claude|gpt)", "claude-gpt"],
        ],
        poolLabels: {
          "gemini-argon": "Gemini Argon",
          "claude-gpt": "Claude / GPT",
          gemini: "Gemini Flash",
        },
        defaultModels: {
          "gemini-argon": "gemini-4-argon-high",
          "claude-gpt": "claude-opus-5-5-high",
          gemini: "gemini-3.8-flash-high",
        },
        pools: {
          "gemini-argon": ["gemini-4-argon-high", "gemini-4-argon-low"],
          "claude-gpt": ["claude-opus-5-5-high"],
          gemini: ["gemini-3.8-flash-high", "gemini-3.8-flash-low"],
        },
        caps: { web: true, exec: false, vision: true },
      },
      grok: {
        label: "SuperGrok",
        via: "relay",
        quota: { provider: "grok" },
        pools: { "supergrok-weekly": ["default"] },
        caps: { web: true, exec: false, vision: true },
      },
    },
    routes: {
      implement: ["agy:gemini-argon:default:0.9"],
      debug: ["agy:gemini-argon:default:0.7"],
      review: ["grok:supergrok-weekly:default"],
      read: ["agy:gemini:default"],
      deep: ["agy:gemini-argon:default"],
      quick: ["agy:gemini:default"],
      "claude-backup": ["agy:claude-gpt:default"],
    },
  };
  if (customizer) customizer(cfg);
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n");
  const readCfg = () => JSON.parse(fs.readFileSync(configFile, "utf8"));
  const cleanup = () => fs.rmSync(stateDir, { recursive: true, force: true });
  return { stateDir, configFile, readCfg, cleanup };
}

function makeFits(overrides = {}) {
  return {
    implement: 0.88,
    debug: 0.82,
    review: 0.78,
    read: 0.65,
    deep: 0.98,
    quick: 0.35,
    "claude-backup": 0.5,
    ...overrides,
  };
}

function makeValidResearch(family, overrides = {}) {
  return {
    family,
    tier: "strong",
    vision: true,
    fits: makeFits(),
    evidence: ["https://example.com/model-release"],
    reason: "官方基准表现优异，适合主力编码与深度推理",
    ...overrides,
  };
}

function makeCache(providersModels) {
  const providers = {};
  for (const [name, models] of Object.entries(providersModels)) {
    providers[name] = { ok: true, error: null, models };
  }
  return { updatedAt: new Date().toISOString(), stale: false, providers };
}

test("1. 首次运行只把当前所有模型记为已知，不做调研也不修改配置", async () => {
  const env = makeEnv();
  try {
    let researchCalls = 0;
    const beforeRaw = fs.readFileSync(env.configFile, "utf8");
    const t0 = Date.parse("2026-11-20T00:00:00.000Z");

    const res = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0,
      getModels: async () => makeCache({
        agy: [
          { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
          { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
        ],
        grok: [{ id: "grok-4.7", label: "grok-4.7" }],
      }),
      research: async () => {
        researchCalls += 1;
        return makeValidResearch("should-not-run");
      },
    });

    assert.equal(res.initial, true);
    assert.equal(res.skipped, false);
    assert.equal(res.added.length, 0);
    assert.equal(researchCalls, 0);
    // 配置文件未被修改，也未产生 .bak 和日志
    assert.equal(fs.readFileSync(env.configFile, "utf8"), beforeRaw);
    assert.equal(fs.existsSync(`${env.configFile}.bak`), false);
    assert.equal(fs.existsSync(discoverLogPath(env.stateDir)), false);

    // state 里记下了已知模型和 lastResult
    const state = loadDiscoverState(env.stateDir);
    assert.equal(state.initialized, true);
    assert.equal(state.lastRunAt, new Date(t0).toISOString());
    assert.ok(state.known.agy.includes("gemini-4-argon-high"));
    assert.ok(state.known.agy.includes("gemini-3.8-flash-high"));
    assert.ok(state.known.grok.includes("grok-4.7"));
    assert.equal(state.lastResult.initial, true);
  } finally {
    env.cleanup();
  }
});

test("2. 新家族按 poolRules 归池并正确写 pools / modelTiers / modelCaps / routes，且先备份 providers.json", async () => {
  const env = makeEnv();
  try {
    const t0 = Date.parse("2026-11-20T00:00:00.000Z");
    const baseModels = [
      { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    ];
    await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0,
      getModels: async () => makeCache({ agy: baseModels, grok: [{ id: "grok-4.7", label: "grok-4.7" }] }),
    });

    const beforeRaw = fs.readFileSync(env.configFile, "utf8");
    const t1 = t0 + DISCOVER_INTERVAL_MS + 1000;
    const res = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t1,
      getModels: async () => makeCache({
        agy: [
          ...baseModels,
          { id: "claude-haiku-5-5-low", label: "Claude Haiku 5.5 (Low)" },
          { id: "claude-haiku-5-5-high", label: "Claude Haiku 5.5 (High)" },
        ],
        grok: [{ id: "grok-4.7", label: "grok-4.7" }],
      }),
      // 验证也能解析 markdown 代码块包裹的 JSON 字符串
      research: async () => "调研完成：\n```json\n" + JSON.stringify(makeValidResearch("claude-haiku-5-5", {
        tier: "light",
        vision: false,
        fits: makeFits({ implement: 0.5, debug: 0.49, review: 0.6, read: 0.99, deep: 0.3, quick: 0.9, "claude-backup": 0.45 }),
      })) + "\n```",
    });

    assert.equal(res.added.length, 1);
    assert.equal(res.added[0].provider, "agy");
    assert.equal(res.added[0].family, "claude-haiku-5-5");
    assert.equal(res.added[0].pool, "claude-gpt");
    assert.equal(res.added[0].bestModel, "claude-haiku-5-5-high");
    assert.equal(res.added[0].tier, "light");
    assert.equal(res.added[0].vision, false);
    assert.match(res.summary, /claude-haiku-5-5/);
    assert.match(res.summary, /https:\/\/example\.com\/model-release/);

    // 先备份了旧配置
    assert.equal(fs.readFileSync(`${env.configFile}.bak`, "utf8"), beforeRaw);

    const cfg = env.readCfg();
    // pools：所有思考档加入 claude-gpt（高档在前）
    assert.ok(cfg.providers.agy.pools["claude-gpt"].includes("claude-haiku-5-5-high"));
    assert.ok(cfg.providers.agy.pools["claude-gpt"].includes("claude-haiku-5-5-low"));
    // modelTiers：厂商:家族前缀* = tier，且 score.mjs 的 modelTier 正确生效
    assert.equal(cfg.modelTiers["agy:claude-haiku-5-5*"], "light");
    assert.equal(modelTier(cfg, "agy", "claude-haiku-5-5-high"), "light");
    assert.equal(modelTier(cfg, "agy", "claude-haiku-5-5-low"), "light");
    // modelCaps：写入 vision，且 capsOf 正确覆盖 provider 默认的 vision: true
    assert.equal(cfg.providers.agy.modelCaps["claude-haiku-5-5-high"].vision, false);
    assert.equal(cfg.providers.agy.modelCaps["claude-haiku-5-5-low"].vision, false);
    assert.equal(capsOf(cfg, cfg.providers.agy, "claude-haiku-5-5-high").vision, false);
    // routes：fits >= 0.5 才追加，且 fit 夹在 0.4–0.95（0.99 夹成 0.95，0.49 不加，0.5 刚好加）
    assert.ok(cfg.routes.implement.includes("agy:claude-gpt:claude-haiku-5-5-high:0.5"));
    assert.ok(!cfg.routes.debug.some((e) => e.includes("claude-haiku-5-5")));
    assert.ok(cfg.routes.review.includes("agy:claude-gpt:claude-haiku-5-5-high:0.6"));
    assert.ok(cfg.routes.read.includes("agy:claude-gpt:claude-haiku-5-5-high:0.95"));
    assert.ok(!cfg.routes.deep.some((e) => e.includes("claude-haiku-5-5")));
    assert.ok(cfg.routes.quick.includes("agy:claude-gpt:claude-haiku-5-5-high:0.9"));
    assert.ok(!cfg.routes["claude-backup"].some((e) => e.includes("claude-haiku-5-5")));

    // 日志与 state.lastResult 已记录
    const logs = listDiscoverRecords({ stateDir: env.stateDir });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].id, res.added[0].id);
    assert.equal(logs[0].family, "claude-haiku-5-5");
    const state = loadDiscoverState(env.stateDir);
    assert.equal(state.lastResult.added.length, 1);
  } finally {
    env.cleanup();
  }
});

test("3. poolRules 不中时按 AIQuota5h 分组归池（含真实多行全量 groups 格式）并补 poolRules 规则", async () => {
  const env = makeEnv();
  try {
    const t0 = Date.parse("2026-11-20T00:00:00.000Z");
    const base = [{ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" }];
    await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0,
      getModels: async () => makeCache({ agy: base }),
    });

    // 模拟真实 AIQuota5h pool_snapshots：每行 raw_summary 里都有全部 3 个 groups
    const fullGroupsSummary = JSON.stringify({
      groups: [
        {
          displayName: "Gemini Models",
          description: "Models within this group: Gemini 5 Krypton, Orchestrator (Krypton), Gemini 3.8 Flash",
          buckets: [{ bucketId: "gemini-weekly" }, { bucketId: "gemini-5h" }],
        },
        {
          displayName: "Claude and GPT models",
          description: "Models within this group: Claude Opus 5.5, GPT-OSS 120B",
          buckets: [{ bucketId: "3p-weekly" }],
        },
        {
          displayName: "Gemini 4 Argon",
          description: "For paid Pro plans, Argon quota is separate.",
          buckets: [{ bucketId: "gemini-argon-wtu-weekly" }],
        },
      ],
    });
    const fakeSnapshots = [
      { provider: "antigravity", pool_id: "claude-gpt", models_json: "[]", raw_summary: fullGroupsSummary },
      { provider: "antigravity", pool_id: "gemini", models_json: "[]", raw_summary: fullGroupsSummary },
      { provider: "antigravity", pool_id: "gemini-argon", models_json: "[]", raw_summary: fullGroupsSummary },
    ];

    // 先单独验证 parseAiQuotaSnapshots 不会把 Gemini 5 Krypton 错归给第一行的 claude-gpt
    const parsedGroups = parseAiQuotaSnapshots(fakeSnapshots, ["gemini-argon", "claude-gpt", "gemini"]);
    const geminiGroup = parsedGroups.find((g) => g.pool === "gemini");
    const claudeGroup = parsedGroups.find((g) => g.pool === "claude-gpt");
    assert.ok(geminiGroup.models.includes("gemini 5 krypton"));
    assert.ok(geminiGroup.models.includes("orchestrator (krypton)"));
    assert.ok(!claudeGroup.models.includes("gemini 5 krypton"));

    const res = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0 + DISCOVER_INTERVAL_MS,
      getModels: async () => makeCache({
        agy: [
          ...base,
          { id: "gemini-5-krypton-xhigh", label: "Gemini 5 Krypton (XHigh)" },
          { id: "gemini-5-krypton-low", label: "Gemini 5 Krypton (Low)" },
          { id: "gemini-orch-krypton", label: "Orchestrator (Krypton)" },
        ],
      }),
      readQuotaPools: async () => fakeSnapshots,
      research: async ({ family }) => makeValidResearch(family, { tier: "strong", vision: true }),
    });

    assert.equal(res.added.length, 2);
    const krypton = res.added.find((a) => a.family === "gemini-5-krypton");
    const orch = res.added.find((a) => a.family === "gemini-orch-krypton");
    assert.equal(krypton.pool, "gemini");
    assert.equal(krypton.poolSource, "aiquota");
    assert.equal(orch.pool, "gemini");
    assert.equal(orch.poolSource, "aiquota");

    const cfg = env.readCfg();
    // 补了 poolRules 规则，之后 assignPool 可直接命中
    assert.equal(assignPool(cfg.providers.agy, "gemini-5-krypton-xhigh"), "gemini");
    assert.equal(assignPool(cfg.providers.agy, "gemini-5-krypton-low"), "gemini");
    assert.equal(assignPool(cfg.providers.agy, "gemini-orch-krypton"), "gemini");
    assert.ok(cfg.providers.agy.pools.gemini.includes("gemini-5-krypton-xhigh"));
    assert.ok(cfg.providers.agy.pools.gemini.includes("gemini-5-krypton-low"));
    assert.equal(cfg.modelTiers["agy:gemini-5-krypton*"], "strong");
    assert.ok(cfg.routes.deep.includes("agy:gemini:gemini-5-krypton-xhigh:0.95"));
  } finally {
    env.cleanup();
  }
});

test("4. poolRules 与 AIQuota5h 均归不了池时不接入、不调调研、不改配置", async () => {
  const env = makeEnv();
  try {
    const t0 = Date.parse("2026-11-20T00:00:00.000Z");
    const base = [{ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" }];
    await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0,
      getModels: async () => makeCache({ agy: base }),
    });

    let researchCalls = 0;
    const beforeRaw = fs.readFileSync(env.configFile, "utf8");
    const res = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0 + DISCOVER_INTERVAL_MS,
      getModels: async () => makeCache({
        agy: [
          ...base,
          { id: "mystery-xenon-high", label: "Mystery Xenon (High)" },
          { id: "mystery-xenon-low", label: "Mystery Xenon (Low)" },
        ],
      }),
      readQuotaPools: async () => [],
      research: async () => {
        researchCalls += 1;
        return makeValidResearch("mystery-xenon");
      },
    });

    assert.equal(researchCalls, 0);
    assert.equal(res.added.length, 0);
    assert.equal(res.unpooled.length, 1);
    assert.equal(res.unpooled[0].family, "mystery-xenon");
    assert.match(res.summary, /未归池/);
    assert.equal(fs.readFileSync(env.configFile, "utf8"), beforeRaw);
    assert.equal(listDiscoverRecords({ stateDir: env.stateDir }).length, 0);
  } finally {
    env.cleanup();
  }
});

test("5. 员工调研 JSON 缺失字段或取值非法时直接放弃，不猜测也不修改配置", async () => {
  // 直接单元测试各种非法 JSON 情况
  const badCases = [
    ["纯文本非 JSON", "这个模型很强，建议强档"],
    ["缺 family", { tier: "strong", vision: true, fits: makeFits(), evidence: ["https://a.test"], reason: "好" }],
    ["family 答非所问", { family: "other-model", tier: "strong", vision: true, fits: makeFits(), evidence: ["https://a.test"], reason: "好" }],
    ["tier 非法", { family: "grok-5", tier: "ultra", vision: true, fits: makeFits(), evidence: ["https://a.test"], reason: "好" }],
    ["vision 非布尔", { family: "grok-5", tier: "strong", vision: "yes", fits: makeFits(), evidence: ["https://a.test"], reason: "好" }],
    ["fits 缺角色", { family: "grok-5", tier: "strong", vision: true, fits: { implement: 0.8 }, evidence: ["https://a.test"], reason: "好" }],
    ["fits 超出范围", { family: "grok-5", tier: "strong", vision: true, fits: makeFits({ implement: 1.5 }), evidence: ["https://a.test"], reason: "好" }],
    ["fits 负数", { family: "grok-5", tier: "strong", vision: true, fits: makeFits({ quick: -0.1 }), evidence: ["https://a.test"], reason: "好" }],
    ["evidence 为空", { family: "grok-5", tier: "strong", vision: true, fits: makeFits(), evidence: [], reason: "好" }],
    ["evidence 非法 URL", { family: "grok-5", tier: "strong", vision: true, fits: makeFits(), evidence: ["not-a-url"], reason: "好" }],
    ["缺 reason", { family: "grok-5", tier: "strong", vision: true, fits: makeFits(), evidence: ["https://a.test"], reason: "  " }],
  ];
  for (const [desc, payload] of badCases) {
    const v = validateResearchResult(payload, { expectedFamily: "grok-5" });
    assert.equal(v.ok, false, `应当拒绝：${desc}`);
  }

  // 验证能从 printJob 包裹文本中提取 JSON
  const wrapped = `任务 xxx · agy\n\n----- 输出 -----\n${JSON.stringify(makeValidResearch("grok-5"))}\n\n完整日志：/tmp/x.log`;
  assert.equal(extractJsonObject(wrapped)?.family, "grok-5");

  // 端到端：调研返回非法 JSON 时放弃接入、记录失败原因、不改配置
  const env = makeEnv();
  try {
    const t0 = Date.parse("2026-11-20T00:00:00.000Z");
    await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0,
      getModels: async () => makeCache({ grok: [{ id: "grok-4.7", label: "grok-4.7" }] }),
    });
    const beforeRaw = fs.readFileSync(env.configFile, "utf8");
    const res = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0 + DISCOVER_INTERVAL_MS,
      getModels: async () => makeCache({
        grok: [
          { id: "grok-4.7", label: "grok-4.7" },
          { id: "grok-5", label: "grok-5" },
        ],
      }),
      research: async () => JSON.stringify({ family: "grok-5", tier: "super", vision: true, fits: makeFits(), evidence: ["https://x.ai"], reason: "强" }),
    });

    assert.equal(res.added.length, 0);
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].family, "grok-5");
    assert.match(res.failed[0].reason, /tier 取值非法/);
    assert.equal(fs.readFileSync(env.configFile, "utf8"), beforeRaw);
    assert.equal(listDiscoverRecords({ stateDir: env.stateDir }).length, 0);
  } finally {
    env.cleanup();
  }
});

test("6. 已有用户配置项一律不覆盖（pools / modelTiers / modelCaps / 同家族 routes）", async () => {
  const env = makeEnv((cfg) => {
    // 预先手工配好部分条目：
    // - pools.gemini 已有 gemini-4-flash-x-low
    // - modelTiers 已有 agy:gemini-4-flash-x* = "mid"（调研给 "strong" 也不得覆盖）
    // - modelCaps 已有 gemini-4-flash-x-high.vision = false（调研给 true 也不得覆盖）
    // - routes.implement 已有同家族的 low 档路由
    // - routes.read 已有 default，且 defaultModels.gemini 指向同家族
    cfg.providers.agy.pools.gemini.push("gemini-4-flash-x-low");
    cfg.providers.agy.defaultModels.gemini = "gemini-4-flash-x-low";
    cfg.modelTiers = { "agy:gemini-4-flash-x*": "mid" };
    cfg.providers.agy.modelCaps = { "gemini-4-flash-x-high": { vision: false } };
    cfg.routes.implement.push("agy:gemini:gemini-4-flash-x-low:0.6");
  });
  try {
    const t0 = Date.parse("2026-11-20T00:00:00.000Z");
    await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0,
      getModels: async () => makeCache({ agy: [{ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" }] }),
    });

    const res = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0 + DISCOVER_INTERVAL_MS,
      getModels: async () => makeCache({
        agy: [
          { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
          { id: "gemini-4-flash-x-high", label: "Gemini 4 Flash X (High)" },
          { id: "gemini-4-flash-x-low", label: "Gemini 4 Flash X (Low)" },
        ],
      }),
      research: async () => makeValidResearch("gemini-4-flash-x", {
        tier: "strong",
        vision: true,
        fits: makeFits({ implement: 0.9, debug: 0.8, review: 0.7, read: 0.8, deep: 0.9, quick: 0.8, "claude-backup": 0.7 }),
      }),
    });

    assert.equal(res.added.length, 1);
    const cfg = env.readCfg();
    // pools：不重复添加 low，只新增 high
    assert.equal(cfg.providers.agy.pools.gemini.filter((x) => x === "gemini-4-flash-x-low").length, 1);
    assert.ok(cfg.providers.agy.pools.gemini.includes("gemini-4-flash-x-high"));
    // modelTiers：保留用户的 mid，不覆盖成 strong
    assert.equal(cfg.modelTiers["agy:gemini-4-flash-x*"], "mid");
    // modelCaps：high 保留用户的 false，low 补上 true
    assert.equal(cfg.providers.agy.modelCaps["gemini-4-flash-x-high"].vision, false);
    assert.equal(cfg.providers.agy.modelCaps["gemini-4-flash-x-low"].vision, true);
    // routes：implement 已有同家族不加；read/quick 的 default 解析到同家族也不加；debug/review/deep/claude-backup 正常追加
    assert.equal(cfg.routes.implement.filter((e) => e.includes("gemini-4-flash-x")).length, 1);
    assert.ok(!cfg.routes.read.some((e) => e.includes("gemini-4-flash-x-high")));
    assert.ok(!cfg.routes.quick.some((e) => e.includes("gemini-4-flash-x-high")));
    assert.ok(cfg.routes.debug.includes("agy:gemini:gemini-4-flash-x-high:0.8"));
    assert.ok(cfg.routes.deep.includes("agy:gemini:gemini-4-flash-x-high:0.9"));
  } finally {
    env.cleanup();
  }
});

test("7. 同家族多思考档（low/medium/high/xhigh）只调研一次，全部进池且路由使用最高档 xhigh", async () => {
  const env = makeEnv();
  try {
    const t0 = Date.parse("2026-11-20T00:00:00.000Z");
    await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0,
      getModels: async () => makeCache({ agy: [{ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" }] }),
    });

    const researchedFamilies = [];
    const res = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0 + DISCOVER_INTERVAL_MS,
      getModels: async () => makeCache({
        agy: [
          { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
          { id: "gemini-5-flash-low", label: "Gemini 5 Flash (Low)" },
          { id: "gemini-5-flash-medium", label: "Gemini 5 Flash (Medium)" },
          { id: "gemini-5-flash-high", label: "Gemini 5 Flash (High)" },
          { id: "gemini-5-flash-xhigh", label: "Gemini 5 Flash (XHigh)" },
        ],
      }),
      research: async ({ family, variants }) => {
        researchedFamilies.push({ family, count: variants.length });
        return makeValidResearch(family, { tier: "mid", vision: true });
      },
    });

    assert.equal(researchedFamilies.length, 1);
    assert.deepEqual(researchedFamilies[0], { family: "gemini-5-flash", count: 4 });
    assert.equal(res.added.length, 1);
    assert.equal(res.added[0].bestModel, "gemini-5-flash-xhigh");
    assert.deepEqual(res.added[0].variants, [
      "gemini-5-flash-xhigh",
      "gemini-5-flash-high",
      "gemini-5-flash-medium",
      "gemini-5-flash-low",
    ]);

    const cfg = env.readCfg();
    for (const v of res.added[0].variants) {
      assert.ok(cfg.providers.agy.pools.gemini.includes(v));
      assert.equal(cfg.providers.agy.modelCaps[v].vision, true);
    }
    assert.ok(cfg.routes.implement.includes("agy:gemini:gemini-5-flash-xhigh:0.88"));
    assert.equal(cfg.routes.implement.filter((e) => e.includes("gemini-5-flash")).length, 1);
  } finally {
    env.cleanup();
  }
});

test("8. --undo 精确回滚指定记录加的所有条目，不动其他接入记录和用户原有配置", async () => {
  const env = makeEnv();
  try {
    const t0 = Date.parse("2026-11-20T00:00:00.000Z");
    await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0,
      getModels: async () => makeCache({
        agy: [{ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" }],
        grok: [{ id: "grok-4.7", label: "grok-4.7" }],
      }),
    });

    // 一次接入两个家族：agy/gemini-5-krypton（走 AIQuota5h 补 poolRule）和 grok/grok-5
    const res = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0 + DISCOVER_INTERVAL_MS,
      getModels: async () => makeCache({
        agy: [
          { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
          { id: "gemini-5-krypton-xhigh", label: "Gemini 5 Krypton (XHigh)" },
          { id: "gemini-5-krypton-low", label: "Gemini 5 Krypton (Low)" },
        ],
        grok: [
          { id: "grok-4.7", label: "grok-4.7" },
          { id: "grok-5", label: "grok-5" },
        ],
      }),
      readQuotaPools: async () => [{ pool: "gemini", models: ["Gemini 5 Krypton"] }],
      research: async ({ family }) => makeValidResearch(family, { tier: "strong", vision: true }),
    });

    assert.equal(res.added.length, 2);
    const kryptonRec = res.added.find((x) => x.family === "gemini-5-krypton");
    const grokRec = res.added.find((x) => x.family === "grok-5");

    // 仅撤销 kryptonRec
    const undone = undoDiscover(kryptonRec.id, {
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0 + DISCOVER_INTERVAL_MS + 60_000,
    });
    assert.equal(undone.changed, true);
    assert.equal(undone.removed.poolRule, true);
    assert.equal(undone.removed.modelTier, true);

    const cfgAfter = env.readCfg();
    // krypton 的全部改动已被精确移除
    assert.ok(!cfgAfter.providers.agy.poolRules.some((r) => r[0] === "gemini-5-krypton"));
    assert.ok(!cfgAfter.providers.agy.pools.gemini.includes("gemini-5-krypton-xhigh"));
    assert.ok(!cfgAfter.providers.agy.pools.gemini.includes("gemini-5-krypton-low"));
    assert.equal(cfgAfter.modelTiers?.["agy:gemini-5-krypton*"], undefined);
    assert.equal(cfgAfter.providers.agy.modelCaps?.["gemini-5-krypton-xhigh"], undefined);
    for (const role of Object.keys(cfgAfter.routes)) {
      assert.ok(!cfgAfter.routes[role].some((e) => e.includes("gemini-5-krypton")), role);
    }

    // 用户原有 agy 配置完整保留
    assert.deepEqual(cfgAfter.providers.agy.pools.gemini, ["gemini-3.8-flash-high", "gemini-3.8-flash-low"]);
    assert.equal(cfgAfter.providers.agy.poolRules.length, 3);

    // 另一条记录 grok-5 的全部改动完整保留
    assert.ok(cfgAfter.providers.grok.pools["supergrok-weekly"].includes("grok-5"));
    assert.equal(cfgAfter.modelTiers["grok:grok-5*"], "strong");
    assert.equal(cfgAfter.providers.grok.modelCaps["grok-5"].vision, true);
    assert.ok(cfgAfter.routes.implement.includes("grok:supergrok-weekly:grok-5:0.88"));

    // 重复撤销同一条记录报错；list 中状态正确
    assert.throws(() => undoDiscover(kryptonRec.id, { stateDir: env.stateDir, configFile: env.configFile }), /撤销过/);
    const list = listDiscoverRecords({ stateDir: env.stateDir });
    assert.equal(list.find((r) => r.id === kryptonRec.id).undone, true);
    assert.equal(list.find((r) => r.id === grokRec.id).undone, false);
  } finally {
    env.cleanup();
  }
});

test("9. 6 小时节流：6 小时内跳过不拉清单不调研，--force 或超过 6 小时后才执行", async () => {
  const env = makeEnv();
  try {
    let modelCalls = 0;
    let researchCalls = 0;
    let listModels = [{ id: "grok-4.7", label: "grok-4.7" }];
    const getModelsMock = async () => {
      modelCalls += 1;
      return makeCache({ grok: listModels });
    };
    const researchMock = async ({ family }) => {
      researchCalls += 1;
      return makeValidResearch(family);
    };

    const t0 = Date.parse("2026-11-20T00:00:00.000Z");
    await discoverModels({ stateDir: env.stateDir, configFile: env.configFile, now: t0, getModels: getModelsMock, research: researchMock });
    assert.equal(modelCalls, 1);

    // 5 小时后出现新模型，但未到 6 小时且不带 --force -> 节流跳过
    listModels = [{ id: "grok-4.7", label: "grok-4.7" }, { id: "grok-5", label: "grok-5" }];
    const r5h = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0 + 5 * 3600_000,
      getModels: getModelsMock,
      research: researchMock,
    });
    assert.equal(r5h.skipped, true);
    assert.equal(r5h.reason, "throttled");
    assert.equal(modelCalls, 1);
    assert.equal(researchCalls, 0);

    // 5 小时带 --force -> 跳过节流立即探测并接入
    const rForce = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0 + 5 * 3600_000 + 1000,
      force: true,
      getModels: getModelsMock,
      research: researchMock,
    });
    assert.equal(rForce.skipped, false);
    assert.equal(rForce.added.length, 1);
    assert.equal(modelCalls, 2);
    assert.equal(researchCalls, 1);

    // 距离上次强制探测满 6 小时 -> 再次正常执行（发现 grok-5.1）
    listModels = [...listModels, { id: "grok-5.1", label: "grok-5.1" }];
    const rAfter6h = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now: t0 + 5 * 3600_000 + 1000 + DISCOVER_INTERVAL_MS,
      getModels: getModelsMock,
      research: researchMock,
    });
    assert.equal(rAfter6h.skipped, false);
    assert.equal(rAfter6h.added.length, 1);
    assert.equal(rAfter6h.added[0].family, "grok-5.1");
    assert.equal(modelCalls, 3);
    assert.equal(researchCalls, 2);
  } finally {
    env.cleanup();
  }
});

test("10. CLI 集成：relay models discover --help / --list / --undo 参数校验", () => {
  const env = makeEnv();
  try {
    const runRelay = (args) => spawnSync(process.execPath, [RELAY_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, AI_RELAY_HOME: env.stateDir },
      timeout: 15_000,
    });

    const helpRes = runRelay(["models", "discover", "--help"]);
    assert.equal(helpRes.status, 0, helpRes.stderr);
    assert.match(helpRes.stdout, /models discover \[--force\] \[--background\] \[--json\]/);
    assert.match(helpRes.stdout, /--undo <记录id>/);

    const listRes = runRelay(["models", "discover", "--list", "--json"]);
    assert.equal(listRes.status, 0, listRes.stderr);
    assert.deepEqual(JSON.parse(listRes.stdout), { records: [] });

    const badUndo = runRelay(["models", "discover", "--undo"]);
    assert.equal(badUndo.status, 1);
    assert.match(badUndo.stderr, /--undo <记录id>/);

    const missingUndo = runRelay(["models", "discover", "--undo", "disc-nonexistent"]);
    assert.equal(missingUndo.status, 1);
    assert.match(missingUndo.stderr, /找不到自动接入记录/);
  } finally {
    env.cleanup();
  }
});

test("11. 调研派单通过 brief.mjs 全部校验，且运行中锁防重入有效", async () => {
  const brief = buildResearchBrief({
    provider: "agy",
    providerLabel: "Antigravity Pro",
    family: "gemini-5-krypton",
    variants: [{ id: "gemini-5-krypton-xhigh", label: "Gemini 5 Krypton (XHigh)" }],
    pool: "gemini",
  });
  assert.deepEqual(checkBrief(brief), []);
  assert.equal(roleOfBrief(brief), "deep");
  assert.equal(levelOfBrief(brief), "medium");
  assert.deepEqual(needsOfBrief(brief), ["web"]);

  // 模拟已有存活进程持锁：discover 跳过不重复运行
  const env = makeEnv();
  try {
    const now = Date.parse("2026-11-20T00:00:00.000Z");
    fs.writeFileSync(discoverLockPath(env.stateDir), JSON.stringify({ pid: process.pid, startedAt: now - 1000 }));
    let getModelsCalled = false;
    const res = await discoverModels({
      stateDir: env.stateDir,
      configFile: env.configFile,
      now,
      force: true,
      getModels: async () => {
        getModelsCalled = true;
        return makeCache({});
      },
    });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, "running");
    assert.equal(getModelsCalled, false);
  } finally {
    env.cleanup();
  }
});

