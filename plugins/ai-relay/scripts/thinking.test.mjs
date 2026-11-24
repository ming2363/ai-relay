// 按任务和模型选思考强度：默认强度表、解析与优先级、后缀就近选档、Grok/Codex/自定义接口落地与旧配置迁移
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateModelFields } from "./lib.mjs";
import { parseEffort, defaultEffort, resolveEffort, pickVariant, scoreRoute } from "./score.mjs";
import { effortOfBrief, BRIEF_TEMPLATE } from "./brief.mjs";
import { assembleArgs, resolveJobEnv, executeJob } from "./relay.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(dir, "relay.mjs");
const PRETOOL = path.join(dir, "pretool-hook.mjs");
const DEF = JSON.parse(fs.readFileSync(path.join(dir, "../config/providers.default.json"), "utf8"));
const PRESETS = JSON.parse(fs.readFileSync(path.join(dir, "../config/presets.json"), "utf8"));

// 0.23 及以前的配置：没有 Hydrogen、Grok 没有 cli.effort、自定义接口没有思考预算
function oldCfg() {
  const cfg = structuredClone(DEF);
  delete cfg.providers.grok.cli.effort;
  cfg.providers.grok.cli.alwaysArgs = ["--reasoning-effort", "xhigh"];
  const agy = cfg.providers.agy;
  agy.pools.gemini = agy.pools.gemini.filter((m) => !/hydrogen/.test(m));
  agy.poolRules = agy.poolRules.filter((r) => r[0] !== "hydrogen");
  agy.defaultModels.gemini = "gemini-3.8-flash-high";
  agy.poolLabels.gemini = "Gemini Flash";
  cfg.routes.quick = cfg.routes.quick.map((e) => (e === "agy:gemini:default" ? "agy:gemini:gemini-3.8-flash-medium" : e));
  cfg.providers.maas = {
    endpoint: { baseUrl: "https://x", secret: "maas" },
    cli: { bin: "claude" },
    env: { ANTHROPIC_BASE_URL: "{baseUrl}", ANTHROPIC_API_KEY: "{secret}" },
    quota: { provider: "maas", pools: ["maas"] },
    pools: { maas: ["m1"] },
  };
  return cfg;
}

// ---------- 旧配置迁移 ----------

test("旧配置升级：Grok 删固定 --reasoning-effort xhigh 并补 cli.effort，自定义接口补兜底思考预算，Hydrogen 进 gemini 池并成为默认", () => {
  const cfg = oldCfg();
  assert.equal(migrateModelFields(cfg, DEF), true);
  assert.equal(cfg.providers.grok.cli.alwaysArgs, undefined);
  assert.deepEqual(cfg.providers.grok.cli.effort, ["--reasoning-effort", "{effort}"]);
  assert.equal(cfg.providers.maas.env.MAX_THINKING_TOKENS, "32000");
  const agy = cfg.providers.agy;
  assert.deepEqual(agy.pools.gemini.slice(0, 4), ["gemini-4-hydrogen-xhigh", "gemini-4-hydrogen-high", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-low"]);
  assert.ok(agy.pools.gemini.includes("gemini-3.8-flash-high"));
  const rules = agy.poolRules.map((r) => r[0]);
  assert.ok(rules.indexOf("hydrogen") >= 0 && rules.indexOf("hydrogen") < rules.indexOf("flash"));
  assert.equal(agy.defaultModels.gemini, "gemini-4-hydrogen-xhigh");
  assert.equal(agy.poolLabels.gemini, "Gemini Neon / Hydrogen / Flash");
  assert.ok(cfg.routes.quick.includes("agy:gemini:default"));
  assert.deepEqual(cfg.migrated, ["max-thinking", "gemini-hydrogen", "gemini-neon", "read-route-0.27", "quick-route-0.28", "effort-args-0.29"]);
});

test("旧配置升级只做一次：用户改过的默认模型不覆盖，升级后删掉的不再加回", () => {
  const cfg = oldCfg();
  cfg.providers.agy.defaultModels.gemini = "gemini-3.8-flash-low";
  cfg.routes.quick = ["agy:gemini:gemini-3.8-flash-low"];
  migrateModelFields(cfg, DEF);
  assert.equal(cfg.providers.agy.defaultModels.gemini, "gemini-3.8-flash-low");
  // 用户自己的条目不动；quick 路由只在末尾补上强档（中等以上的问答才有人接）
  assert.deepEqual(cfg.routes.quick, ["agy:gemini:gemini-3.8-flash-low", "agy:gemini:gemini-4-neon-xhigh:0.7", "agy:gemini-argon:default:0.7"]);

  cfg.providers.agy.pools.gemini = cfg.providers.agy.pools.gemini.filter((m) => !/hydrogen/.test(m));
  delete cfg.providers.grok.cli.effort;
  delete cfg.providers.maas.env.MAX_THINKING_TOKENS;
  cfg.routes.quick = ["agy:gemini:gemini-3.8-flash-low"];
  assert.equal(migrateModelFields(cfg, DEF), false);
  assert.deepEqual(cfg.routes.quick, ["agy:gemini:gemini-3.8-flash-low"]);
  assert.ok(!cfg.providers.agy.pools.gemini.some((m) => /hydrogen/.test(m)));
  assert.equal(cfg.providers.grok.cli.effort, undefined);
  assert.equal(cfg.providers.maas.env.MAX_THINKING_TOKENS, undefined);
});

test("已经手动加过 Hydrogen 的配置：不重复加模型和规则", () => {
  const cfg = structuredClone(DEF);
  migrateModelFields(cfg, DEF);
  const agy = cfg.providers.agy;
  assert.equal(agy.pools.gemini.filter((m) => m === "gemini-4-hydrogen-xhigh").length, 1);
  assert.equal(agy.poolRules.filter((r) => r[0] === "hydrogen").length, 1);
});

test("迁移 effort-args-0.29：只删 alwaysArgs 里的 --reasoning-effort xhigh 这一对，保留用户其他参数和自定义值", () => {
  // 1. 混有用户其他 alwaysArgs：只删那一对，其余原样保留
  const cfg = structuredClone(DEF);
  cfg.migrated = ["max-thinking", "gemini-hydrogen", "gemini-neon", "read-route-0.27", "quick-route-0.28"];
  delete cfg.providers.grok.cli.effort;
  cfg.providers.grok.cli.alwaysArgs = ["--foo", "1", "--reasoning-effort", "xhigh", "--bar"];
  assert.equal(migrateModelFields(cfg, DEF), true);
  assert.deepEqual(cfg.providers.grok.cli.alwaysArgs, ["--foo", "1", "--bar"]);
  assert.deepEqual(cfg.providers.grok.cli.effort, ["--reasoning-effort", "{effort}"]);
  assert.ok(cfg.migrated.includes("effort-args-0.29"));

  // 2. 用户自己把 alwaysArgs 改成了 --reasoning-effort low：不删，也不覆盖用户已自定义的 cli.effort
  const custom = structuredClone(DEF);
  custom.migrated = ["max-thinking", "gemini-hydrogen", "gemini-neon", "read-route-0.27", "quick-route-0.28"];
  custom.providers.grok.cli.alwaysArgs = ["--reasoning-effort", "low", "--verbose"];
  custom.providers.grok.cli.effort = ["--custom-effort", "{effort}"];
  assert.equal(migrateModelFields(custom, DEF), true);
  assert.deepEqual(custom.providers.grok.cli.alwaysArgs, ["--reasoning-effort", "low", "--verbose"]);
  assert.deepEqual(custom.providers.grok.cli.effort, ["--custom-effort", "{effort}"]);
});

// ---------- 默认强度表、困难下限、解析与优先级 ----------

test("默认强度表：按难度映射，implement 或可写上调一档封顶最高，困难任务不低于高", () => {
  // 普通只读角色（read / review / debug / quick / 无角色）
  assert.equal(defaultEffort("easy", { role: "read" }), "medium");
  assert.equal(defaultEffort("medium", { role: "review" }), "high");
  assert.equal(defaultEffort("hard", { role: "deep" }), "xhigh");
  assert.equal(defaultEffort("easy"), "medium");
  assert.equal(defaultEffort("medium"), "high");
  assert.equal(defaultEffort("hard"), "xhigh");

  // 写代码或写文档（role === implement 或 write === true）上调一档，封顶最高
  assert.equal(defaultEffort("easy", { role: "implement" }), "high");
  assert.equal(defaultEffort("medium", { role: "implement" }), "xhigh");
  assert.equal(defaultEffort("hard", { role: "implement" }), "xhigh");
  assert.equal(defaultEffort("easy", { role: "read", write: true }), "high");
  assert.equal(defaultEffort("medium", { role: "debug", write: true }), "xhigh");
  assert.equal(defaultEffort("hard", { role: "debug", write: true }), "xhigh");
  // implement 且同时传 write，只上调一档（简单仍为 high，不跳到 xhigh）
  assert.equal(defaultEffort("easy", { role: "implement", write: true }), "high");

  // 点名覆盖默认值（简单/中等允许压低到 low）
  assert.equal(resolveEffort({ level: "easy", role: "implement", write: true, effort: "低" }), "low");
  assert.equal(resolveEffort({ level: "medium", role: "implement", effort: "low" }), "low");
  assert.equal(resolveEffort({ level: "easy", role: "read", effort: "最高" }), "xhigh");

  // 困难任务不低于「高」：点名低或中都按高处理，高/最高保持不变
  assert.equal(resolveEffort({ level: "hard", role: "read", effort: "low" }), "high");
  assert.equal(resolveEffort({ level: "hard", role: "read", effort: "中" }), "high");
  assert.equal(resolveEffort({ level: "hard", role: "implement", write: true, effort: "低" }), "high");
  assert.equal(resolveEffort({ level: "hard", role: "read", effort: "高" }), "high");
  assert.equal(resolveEffort({ level: "hard", role: "read", effort: "最高" }), "xhigh");
});

test("思考强度解析：中英文、派单「思考：」行与模板占位符", () => {
  assert.equal(parseEffort("低"), "low");
  assert.equal(parseEffort("中"), "medium");
  assert.equal(parseEffort("高"), "high");
  assert.equal(parseEffort("最高"), "xhigh");
  assert.equal(parseEffort("LOW"), "low");
  assert.equal(parseEffort("Medium"), "medium");
  assert.equal(parseEffort("high"), "high");
  assert.equal(parseEffort("xhigh"), "xhigh");
  assert.equal(parseEffort("超高"), null);
  assert.equal(parseEffort(""), null);
  assert.equal(parseEffort(null), null);

  assert.equal(effortOfBrief("角色：read\n难度：简单\n思考：低\n## 目标"), "low");
  assert.equal(effortOfBrief("思考: 最高（跨模块）"), "xhigh");
  assert.equal(effortOfBrief("## 思考：高"), "high");
  assert.equal(effortOfBrief("思考：<低|中|高|最高>\n思考：中"), "medium");
  assert.equal(effortOfBrief("思考：乱写的\n## 目标"), null);
  assert.equal(effortOfBrief(BRIEF_TEMPLATE), null);
  assert.match(BRIEF_TEMPLATE, /难度：[^\n]*\n思考：/);
});

// ---------- 后缀选档的就近规则 ----------

test("pickVariant：有目标档选目标档；无则取更高最近一档；再无取更低最近一档；无后缀不换", () => {
  const cfg = {
    providers: {
      agy: {
        pools: {
          full: ["m-xhigh", "m-high", "m-medium", "m-low"],
          noMed: ["m-xhigh", "m-high", "m-low"],
          onlyEnds: ["m-xhigh", "m-low"],
          noXhigh: ["m-high", "m-medium", "m-low"],
          lowMid: ["m-medium", "m-low"],
          onlyHigh: ["m-high"],
        },
      },
    },
  };

  // 四档齐全：精确命中
  assert.equal(pickVariant(cfg, "agy", "full", "m-xhigh", "low"), "m-low");
  assert.equal(pickVariant(cfg, "agy", "full", "m-xhigh", "medium"), "m-medium");
  assert.equal(pickVariant(cfg, "agy", "full", "m-low", "high"), "m-high");
  assert.equal(pickVariant(cfg, "agy", "full", "m-low", "xhigh"), "m-xhigh");

  // 缺目标档：先往高找最近一档
  assert.equal(pickVariant(cfg, "agy", "noMed", "m-low", "medium"), "m-high");
  assert.equal(pickVariant(cfg, "agy", "onlyEnds", "m-low", "medium"), "m-xhigh");
  assert.equal(pickVariant(cfg, "agy", "onlyEnds", "m-low", "high"), "m-xhigh");
  assert.equal(pickVariant(cfg, "agy", "onlyHigh", "m-low", "low"), "m-high");

  // 更高没有时：往低找最近一档
  assert.equal(pickVariant(cfg, "agy", "noXhigh", "m-medium", "xhigh"), "m-high");
  assert.equal(pickVariant(cfg, "agy", "lowMid", "m-low", "xhigh"), "m-medium");
  assert.equal(pickVariant(cfg, "agy", "lowMid", "m-low", "high"), "m-medium");

  // 没有思考档后缀、或池里没有任何同家族模型：不换
  assert.equal(pickVariant(cfg, "agy", "full", "grok-4.7", "low"), "grok-4.7");
  assert.equal(pickVariant(cfg, "agy", "full", "default", "high"), "default");
  assert.equal(pickVariant(cfg, "agy", "full", "other-high", "low"), "other-high");
});

test("poolHasStrongModel 仍按池最高档判断：即使当前强度把候选换成 mid 档，含强档池仍会触发保留", () => {
  const NOW = 1_700_000_000_000;
  const HOUR = 3_600_000;
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      agy: {
        via: "relay",
        quota: { provider: "antigravity" },
        pools: {
          "gemini-argon": ["gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"],
        },
      },
      grok: {
        via: "relay",
        quota: { provider: "grok" },
        pools: { "supergrok-weekly": ["grok-4.7"] },
      },
    },
    routes: {
      read: [
        "agy:gemini-argon:gemini-4-argon-high:0.95",
        "grok:supergrok-weekly:grok-4.7:0.8",
      ],
    },
  };
  // read + easy 默认 effort=medium，Argon 换成 gemini-4-argon-medium（mid 档）；
  // 但 gemini-argon 池含 gemini-4-argon-high（strong 档），剩 0.35 且配速 -0.55 时仍应被保留
  const rows = [
    { provider: "antigravity", pool_id: "gemini-argon", window_key: "5h", remaining_fraction: 0.35, reset_at: NOW + 4.5 * HOUR, allowance: "available", updated_at: NOW },
    { provider: "grok", pool_id: "supergrok-weekly", window_key: "weekly", remaining_fraction: 0.8, reset_at: NOW + 84 * HOUR, allowance: "available", updated_at: NOW },
  ];
  const res = scoreRoute(cfg, rows, "read", { now: NOW, level: "easy" });
  const argon = [res.choice, ...res.alternatives].find((c) => c.provider === "agy");
  assert.equal(argon.model, "gemini-4-argon-medium");
  assert.equal(argon.tier, "mid");
  assert.equal(argon.demoted, "用得比进度快，留给困难任务");
});

// ---------- Grok 参数与自定义接口 MAX_THINKING_TOKENS ----------

test("Grok assembleArgs 按强度传 --reasoning-effort，未传 effort 时不带该参数", () => {
  const base = { provider: "grok", pool: "supergrok-weekly", model: "default", cwd: "/work", write: false, wrappedPrompt: "测试" };
  for (const eff of ["low", "medium", "high", "xhigh"]) {
    const args = assembleArgs(DEF, { ...base, effort: eff });
    const idx = args.indexOf("--reasoning-effort");
    assert.ok(idx >= 0, `缺少 --reasoning-effort：${args.join(" ")}`);
    assert.equal(args[idx + 1], eff);
  }
  const noEff = assembleArgs(DEF, base);
  assert.equal(noEff.includes("--reasoning-effort"), false);
});

test("自定义 claude 接口子进程 MAX_THINKING_TOKENS 随思考强度覆盖，且不改动配置对象", async () => {
  const cfg = {
    idleTimeoutMin: 20,
    maxRuntimeMin: 240,
    providers: {
      maas: {
        via: "relay",
        endpoint: { baseUrl: "https://example.test", secret: "maas" },
        cli: structuredClone(PRESETS.endpoint.cli),
        env: structuredClone(PRESETS.endpoint.env),
        envUnset: [...PRESETS.endpoint.envUnset],
        pools: { maas: ["qwen3.8-max"] },
      },
    },
  };
  const secrets = { maas: "sk-test-budget" };
  const expected = [
    ["low", "4000"],
    ["medium", "10000"],
    ["high", "20000"],
    ["xhigh", "32000"],
  ];
  for (const [effort, tokens] of expected) {
    const { env } = resolveJobEnv(cfg, { provider: "maas", effort }, secrets);
    assert.equal(env.MAX_THINKING_TOKENS, tokens);
  }
  // 原配置里的 env 不被覆盖
  assert.equal(cfg.providers.maas.env.MAX_THINKING_TOKENS, "32000");

  // 真实子进程验证：executeJob 把按强度算出的 MAX_THINKING_TOKENS 传入子进程
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-budget-"));
  const jobsDir = path.join(root, "jobs");
  const cwd = path.join(root, "cwd");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const script = path.join(root, "echo-budget.js");
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({ result: process.env.MAX_THINKING_TOKENS || "", is_error: false }));');
  try {
    for (const [effort, tokens] of [["low", "4000"], ["high", "20000"]]) {
      const res = await executeJob({
        id: `job-budget-${effort}`,
        provider: "maas",
        pool: "maas",
        model: "qwen3.8-max",
        effort,
        cwd,
        wrappedPrompt: "hi",
        startedAt: new Date().toISOString(),
        _jobsDir: jobsDir,
      }, { cfg, secrets, bin: process.execPath, args: [script], idleTimeoutMs: 5000, maxRuntimeMs: 5000, checkIntervalMs: 1000 });
      assert.equal(res.status, "done");
      assert.equal(res.result, tokens);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- CLI 端到端：relay pick、relay run、relay result ----------

function makeRelayHome(mutateCfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-effort-cli-"));
  const cfg = structuredClone(DEF);
  cfg.quotaDb = "";
  cfg.migrated = ["max-thinking", "gemini-hydrogen", "gemini-neon", "read-route-0.27", "quick-route-0.28", "effort-args-0.29"];
  if (mutateCfg) mutateCfg(cfg, home);
  fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(cfg, null, 2) + "\n");
  fs.writeFileSync(path.join(home, "mode"), "auto\n");
  return home;
}

function runRelay(home, args, input) {
  return spawnSync(process.execPath, [RELAY, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: home, CLAUDE_PROJECT_DIR: "" },
    timeout: 20000,
  });
}

test("relay pick：默认选档、--effort 覆盖、困难下限、--write 上调、Codex 提示与中文输出", () => {
  const home = makeRelayHome((cfg) => {
    // 禁用 codex 和 grok，让 agy 在各角色稳定成为首选
    cfg.providers.codex.enabled = false;
    cfg.providers.grok.enabled = false;
  });
  try {
    // 1. implement + 中等 → 默认最高档（claude-sonnet-5-5-high，且备选 Neon 为 gemini-4-neon-xhigh），输出「思考：最高」
    const implMed = runRelay(home, ["pick", "implement", "--level", "中等"]);
    assert.equal(implMed.status, 0, implMed.stderr + implMed.stdout);
    assert.match(implMed.stdout, /思考：最高/);
    assert.match(implMed.stdout, /→ agy \/ claude-gpt \/ claude-sonnet-5-5-high/);
    assert.match(implMed.stdout, /gemini-4-neon-xhigh/);
    const implJson = JSON.parse(runRelay(home, ["pick", "implement", "--level", "中等", "--json"]).stdout);
    assert.equal(implJson.effort, "xhigh");
    const neonCand = [implJson.choice, ...implJson.alternatives].find((c) => c.pool === "gemini");
    assert.equal(neonCand.model, "gemini-4-neon-xhigh");

    // 2. read + 简单 → 默认中档（gemini-4-hydrogen-medium），输出「思考：中」
    const readEasy = runRelay(home, ["pick", "read", "--level", "简单"]);
    assert.equal(readEasy.status, 0, readEasy.stderr + readEasy.stdout);
    assert.match(readEasy.stdout, /思考：中/);
    assert.match(readEasy.stdout, /→ agy \/ gemini \/ gemini-4-hydrogen-medium/);

    // 3. read + 简单 + --effort 低 → 压到 -low 档
    const readLow = runRelay(home, ["pick", "read", "--level", "简单", "--effort", "低"]);
    assert.equal(readLow.status, 0, readLow.stderr + readLow.stdout);
    assert.match(readLow.stdout, /思考：低/);
    assert.match(readLow.stdout, /→ agy \/ gemini \/ gemini-4-hydrogen-low/);

    // 4. read + 简单 + --write → 上调一档到「高」（-high）
    const readWrite = runRelay(home, ["pick", "read", "--level", "简单", "--write"]);
    assert.equal(readWrite.status, 0, readWrite.stderr + readWrite.stdout);
    assert.match(readWrite.stdout, /思考：高/);
    assert.match(readWrite.stdout, /→ agy \/ gemini \/ gemini-4-hydrogen-high/);

    // 5. 困难任务点名 --effort 低 → 按「高」处理（选 -high 而非 -low）
    const hardLow = runRelay(home, ["pick", "implement", "--level", "困难", "--effort", "低"]);
    assert.equal(hardLow.status, 0, hardLow.stderr + hardLow.stdout);
    assert.match(hardLow.stdout, /思考：高/);
    const hardJson = JSON.parse(runRelay(home, ["pick", "implement", "--level", "困难", "--effort", "低", "--json"]).stdout);
    assert.equal(hardJson.effort, "high");
    const hardNeon = [hardJson.choice, ...hardJson.alternatives].find((c) => c.pool === "gemini");
    assert.equal(hardNeon.model, "gemini-4-neon-high");

    // 6. 非法 --effort 报错退出码 2
    const bad = runRelay(home, ["pick", "read", "--level", "简单", "--effort", "超高"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--effort 取值无效/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  // 7. 池里没有 -low 时，--effort 低 取最近的更高一档（-medium）
  const homeNoLow = makeRelayHome((cfg) => {
    cfg.providers.codex.enabled = false;
    cfg.providers.grok.enabled = false;
    cfg.providers.agy.pools.gemini = cfg.providers.agy.pools.gemini.filter((m) => !m.endsWith("-low"));
  });
  try {
    const near = runRelay(homeNoLow, ["pick", "read", "--level", "简单", "--effort", "低"]);
    assert.equal(near.status, 0, near.stderr + near.stdout);
    assert.match(near.stdout, /→ agy \/ gemini \/ gemini-4-hydrogen-medium/);
  } finally {
    fs.rmSync(homeNoLow, { recursive: true, force: true });
  }

  // 8. Codex pick 提示行里的 --effort 随强度变化
  const homeCodex = makeRelayHome();
  try {
    const cEasy = runRelay(homeCodex, ["pick", "review", "--level", "简单", "--provider", "codex"]);
    assert.equal(cEasy.status, 0, cEasy.stderr + cEasy.stdout);
    assert.match(cEasy.stdout, /思考：中/);
    assert.match(cEasy.stdout, /--effort medium/);

    const cImplMed = runRelay(homeCodex, ["pick", "implement", "--level", "中等", "--provider", "codex"]);
    assert.equal(cImplMed.status, 0, cImplMed.stderr + cImplMed.stdout);
    assert.match(cImplMed.stdout, /思考：最高/);
    assert.match(cImplMed.stdout, /--effort xhigh/);

    const cHardLow = runRelay(homeCodex, ["pick", "implement", "--level", "困难", "--effort", "低", "--provider", "codex"]);
    assert.equal(cHardLow.status, 0, cHardLow.stderr + cHardLow.stdout);
    assert.match(cHardLow.stdout, /思考：高/);
    assert.match(cHardLow.stdout, /--effort high/);

    // relay run 点名 codex 时提示行里的 --effort 同样随强度变化
    const runCodex = runRelay(homeCodex, ["run", "codex", "--cwd", homeCodex], "角色：review\n难度：简单\n\n## 目标\n检查\n\n## 验收标准\n无误");
    assert.equal(runCodex.status, 3);
    assert.match(runCodex.stderr, /--effort medium/);
    const runCodexLow = runRelay(homeCodex, ["run", "codex", "--effort", "低", "--cwd", homeCodex], "角色：review\n难度：简单\n\n## 目标\n检查\n\n## 验收标准\n无误");
    assert.equal(runCodexLow.status, 3);
    assert.match(runCodexLow.stderr, /--effort low/);
  } finally {
    fs.rmSync(homeCodex, { recursive: true, force: true });
  }
});

test("relay run 与 result：命令行 --effort 优先于派单「思考：」、传给 Grok、写入 job.effort 并展示中文", () => {
  const argsOut = path.join(os.tmpdir(), `relay-grok-args-${process.pid}-${Date.now()}.txt`);
  const home = makeRelayHome((cfg, dirPath) => {
    const fake = path.join(dirPath, "fake-grok.sh");
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsOut}"\necho 完成\n`, { mode: 0o755 });
    cfg.providers.grok.cli.bin = fake;
    cfg.modelTiers = { "grok:*": "strong" };
  });
  const cwd = path.join(home, "work");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    // 1. 派单写「思考：低」，未传 --effort → 生效为 low
    const briefLow = "角色：read\n难度：简单\n思考：低\n\n## 目标\n读文件\n\n## 验收标准\n读完";
    const r1 = runRelay(home, ["run", "grok", "--cwd", cwd], briefLow);
    assert.equal(r1.status, 0, r1.stderr + r1.stdout);
    assert.match(r1.stdout, /思考：低/);
    let lines = fs.readFileSync(argsOut, "utf8").trim().split("\n");
    assert.equal(lines[lines.indexOf("--reasoning-effort") + 1], "low");

    const id1 = (r1.stdout.match(/任务 (\S+) ·/) || [])[1];
    const job1 = JSON.parse(fs.readFileSync(path.join(home, "jobs", `${id1}.json`), "utf8"));
    assert.equal(job1.effort, "low");

    // relay result 输出也包含「思考：低」
    const res1 = runRelay(home, ["result", id1]);
    assert.equal(res1.status, 0, res1.stderr);
    assert.match(res1.stdout, /思考：低/);

    // 2. 命令行 --effort 最高 优先于派单里的「思考：低」
    const r2 = runRelay(home, ["run", "grok", "--effort", "最高", "--cwd", cwd], briefLow);
    assert.equal(r2.status, 0, r2.stderr + r2.stdout);
    assert.match(r2.stdout, /思考：最高/);
    lines = fs.readFileSync(argsOut, "utf8").trim().split("\n");
    assert.equal(lines[lines.indexOf("--reasoning-effort") + 1], "xhigh");

    // 3. 困难任务点名 --effort 低 → 按高处理
    const briefHard = "角色：read\n难度：困难\n思考：低\n\n## 目标\n分析\n\n## 验收标准\n清楚";
    const r3 = runRelay(home, ["run", "grok", "--effort", "低", "--cwd", cwd], briefHard);
    assert.equal(r3.status, 0, r3.stderr + r3.stdout);
    assert.match(r3.stdout, /思考：高/);
    lines = fs.readFileSync(argsOut, "utf8").trim().split("\n");
    assert.equal(lines[lines.indexOf("--reasoning-effort") + 1], "high");

    // 4. 后台启动输出含「思考：最高」且保持「可写）」结尾（兼容 posttool-hook 分工识别）
    const briefWrite = "角色：read\n难度：中等\n\n## 目标\n改文档\n\n## 验收标准\n改好";
    const rBg = runRelay(home, ["run", "grok", "--write", "--background", "--cwd", cwd], briefWrite);
    assert.equal(rBg.status, 0, rBg.stderr + rBg.stdout);
    assert.match(rBg.stdout, /已后台启动任务 \S+（[^）\n]*思考：最高，可写）/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(argsOut, { force: true });
  }
});

// ---------- Codex pretool-hook 第一行 ----------

test("Codex pretool-hook 第一行：--effort 优先于「思考：」优先于默认强度，困难不低于高", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-effort-"));
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\n');
  const body = "\n\n## 目标\n检查逻辑\n\n## 验收标准\n无误";

  const call = (prompt) => {
    const home = makeRelayHome((cfg) => {
      cfg.providers.codex.quota.provider = "codex-test-none";
    });
    try {
      const r = spawnSync(process.execPath, [PRETOOL], {
        input: JSON.stringify({ session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "codex:codex-rescue", prompt } }),
        encoding: "utf8",
        env: { ...process.env, AI_RELAY_HOME: home, CODEX_HOME: codexHome, CLAUDE_PROJECT_DIR: "" },
      });
      return JSON.parse(r.stdout || "{}").hookSpecificOutput || {};
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
  const firstLine = (o) => o.updatedInput.prompt.split("\n")[0];

  try {
    // 1. 默认强度随难度和角色变化
    assert.equal(firstLine(call("角色：review\n难度：简单" + body)), "--model gpt-6.1-sol --effort medium");
    assert.equal(firstLine(call("角色：implement\n难度：简单" + body)), "--model gpt-6.1-sol --effort high");
    assert.equal(firstLine(call("角色：review\n难度：中等" + body)), "--model gpt-6.1-sol --effort high");
    assert.equal(firstLine(call("角色：implement\n难度：中等" + body)), "--model gpt-6.1-sol --effort xhigh");
    assert.equal(firstLine(call("角色：review\n难度：困难" + body)), "--model gpt-6.1-sol --effort xhigh");

    // 2. 派单「思考：」覆盖默认；困难任务仍不低于高；认不出当没写
    assert.equal(firstLine(call("角色：review\n难度：简单\n思考：低" + body)), "--model gpt-6.1-sol --effort low");
    assert.equal(firstLine(call("角色：review\n难度：简单\n思考：最高" + body)), "--model gpt-6.1-sol --effort xhigh");
    assert.equal(firstLine(call("角色：review\n难度：困难\n思考：低" + body)), "--model gpt-6.1-sol --effort high");
    assert.equal(firstLine(call("角色：review\n难度：简单\n思考：瞎写" + body)), "--model gpt-6.1-sol --effort medium");

    // 3. 派单显式写了 --effort 时照写的（优先于「思考：」和默认）
    assert.equal(firstLine(call("--effort low\n角色：implement\n难度：中等\n思考：最高" + body)), "--model gpt-6.1-sol --effort low");
    assert.equal(firstLine(call("--effort minimal\n角色：review\n难度：困难" + body)), "--model gpt-6.1-sol --effort minimal");

    // 4. 原有 --effort 合法性检查保留
    assert.match(call("--effort 超高\n角色：review\n难度：简单" + body).permissionDecisionReason, /不是 Codex 认的推理强度/);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
