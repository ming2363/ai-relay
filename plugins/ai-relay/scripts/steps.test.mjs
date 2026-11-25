// 步骤规格降档：中等任务带合格的「## 步骤」规格时，轻档模型可以接
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stepsOfBrief, hasStepSpec, BRIEF_TEMPLATE } from "./brief.mjs";
import { scoreRoute, tierAllowed } from "./score.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const relayPath = path.join(scriptsDir, "relay.mjs");
const NOW = 1700000000000;

// ---------- 单元：步骤解析 ----------

test("stepsOfBrief：按编号行和列表项切分，去掉序号，跳过占位符", () => {
  const numbered = `角色：implement
难度：中等

## 步骤
1. 在 plugins/ai-relay/scripts/brief.mjs 加导出函数
2、更新 plugins/ai-relay/scripts/steps.test.mjs 的断言
3) 跑一遍测试

## 验收标准
测试全过`;
  assert.deepEqual(stepsOfBrief(numbered), [
    "在 plugins/ai-relay/scripts/brief.mjs 加导出函数",
    "更新 plugins/ai-relay/scripts/steps.test.mjs 的断言",
    "跑一遍测试",
  ]);

  const dashed = "## 步骤\n- 改 src/a.mjs\n* 改 src/b.mjs\n";
  assert.deepEqual(stepsOfBrief(dashed), ["改 src/a.mjs", "改 src/b.mjs"]);

  // 没写序号的普通行也算一步
  assert.deepEqual(stepsOfBrief("步骤：\n改 a/b.mjs\n改 c/d.mjs"), ["改 a/b.mjs", "改 c/d.mjs"]);
  // 模板里的占位符不算步骤；没有这一段返回空数组
  assert.deepEqual(stepsOfBrief(BRIEF_TEMPLATE), []);
  assert.deepEqual(stepsOfBrief("## 目标\n做点事"), []);
  // 小节到下一个标题或下一段名称为止
  assert.deepEqual(stepsOfBrief("## 步骤\n改 a/b.mjs\n\n## 验收标准\n改 c/d.mjs"), ["改 a/b.mjs"]);
});

test("hasStepSpec：至少 2 步且每步点到文件才算合格", () => {
  const ok = `## 步骤
1. 在 plugins/ai-relay/scripts/brief.mjs 新增导出函数
2. 更新 plugins/ai-relay/scripts/steps.test.mjs 的断言`;
  assert.equal(hasStepSpec(ok), true);
  // 以常见源码目录开头的路径也算
  assert.equal(hasStepSpec("## 步骤\n改 src/util 里的函数\n更新 plugins/ai-relay/scripts 的测试"), true);

  // 只有 1 步
  assert.equal(hasStepSpec("## 步骤\n1. 改 plugins/ai-relay/scripts/brief.mjs"), false);
  // 步骤里没有文件路径
  assert.equal(hasStepSpec("## 步骤\n1. 加一个导出函数\n2. 更新测试断言"), false);
  // 有一步没点到文件
  assert.equal(hasStepSpec("## 步骤\n1. 改 src/a.mjs\n2. 再检查一下"), false);
  // 没有「## 步骤」小节
  assert.equal(hasStepSpec("## 目标\n改 src/a.mjs 和 src/b.mjs"), false);
  // 只有模板占位符
  assert.equal(hasStepSpec(BRIEF_TEMPLATE), false);
  assert.equal(hasStepSpec(""), false);
});

test("BRIEF_TEMPLATE 在「验收标准」前有「## 步骤」小节和说明", () => {
  const stepAt = BRIEF_TEMPLATE.indexOf("## 步骤");
  const acceptAt = BRIEF_TEMPLATE.indexOf("## 验收标准");
  assert.ok(stepAt > 0 && acceptAt > stepAt, "「## 步骤」应在「## 验收标准」之前");
  assert.match(BRIEF_TEMPLATE.slice(stepAt, acceptAt), /可选。中等任务写成步骤级规格（至少 2 步、每步点到文件）时，轻档模型也能接/);
});

// ---------- 单元：打分 ----------

const CFG = {
  minRemaining: 0.15,
  lowRemaining: 0.3,
  quotaDb: "",
  providers: {
    midp: { via: "relay", quota: { provider: "midq" }, pools: { m: ["mid-m"] } },
    lightp: { via: "relay", quota: { provider: "lightq" }, pools: { l: ["light-m"] } },
  },
  modelTiers: { "midp:*": "mid", "lightp:*": "light" },
  routes: { implement: ["midp:m:mid-m", "lightp:l:light-m:0.8"] },
};
const row = (provider, pool, remaining) => ({
  provider, pool_id: pool, window_key: "weekly", remaining_fraction: remaining,
  reset_at: NOW + 5 * 86400000, allowance: remaining <= 0 ? "exhausted" : "available", updated_at: NOW,
});
// 中档没额度、轻档额度充足
const ROWS = [row("midq", "m", 0), row("lightq", "l", 0.9)];

test("scoreRoute：中等任务带 steps 时轻档进候选，理由写明带步骤规格；不带 steps 仍跳过", () => {
  const plain = scoreRoute(CFG, ROWS, "implement", { now: NOW, level: "medium" });
  assert.equal(plain.choice, null);
  const skippedLight = plain.skipped.find((s) => s.provider === "lightp");
  assert.ok(skippedLight.tierTooLow);
  assert.equal(skippedLight.why, "中等任务需要中档以上，它是轻档");

  const withSteps = scoreRoute(CFG, ROWS, "implement", { now: NOW, level: "medium", steps: true });
  assert.equal(withSteps.choice.provider, "lightp");
  assert.equal(withSteps.choice.tier, "light");
  assert.match(withSteps.choice.reason, /^难度中等：/);
  assert.match(withSteps.choice.reason, /带步骤规格，轻档可接/);
  assert.doesNotMatch(withSteps.choice.reason, /已降级/);
});

test("scoreRoute：困难任务和其他情况忽略 steps，行为不变", () => {
  // 困难：轻档即便带 steps 也接不了
  const hard = scoreRoute(CFG, [row("midq", "m", 0.9), row("lightq", "l", 0.9)], "implement", { now: NOW, level: "hard", steps: true });
  assert.equal(hard.choice, null);
  assert.ok(hard.skipped.some((s) => s.provider === "lightp" && s.tierTooLow));
  // 简单：本来就允许轻档，理由里不写步骤规格
  const easy = scoreRoute(CFG, [row("midq", "m", 0.9), row("lightq", "l", 0.9)], "implement", { now: NOW, level: "easy", steps: true });
  assert.equal(easy.choice.tier, "light");
  assert.doesNotMatch(easy.choice.reason, /带步骤规格/);
  // 中等 + downgrade 时仍写降级，不叠加步骤规格文案
  const down = scoreRoute(CFG, ROWS, "implement", { now: NOW, level: "medium", downgrade: true, steps: true });
  assert.match(down.choice.reason, /^难度中等（已降级）：/);
  assert.doesNotMatch(down.choice.reason, /带步骤规格/);
  // 中档可用时，带 steps 也仍首选中档
  const both = scoreRoute(CFG, [row("midq", "m", 0.9), row("lightq", "l", 0.9)], "implement", { now: NOW, level: "medium", steps: true });
  assert.equal(both.choice.provider, "midp");
});

test("scoreRoute：中等任务带 steps 时，分组为 够档位（强档与中档同组按综合分） → 放宽轻档，read 下够档位优先于轻档", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    providers: {
      agy: {
        via: "relay",
        quota: { provider: "antigravity" },
        defaultModels: {
          gemini: "gemini-4-hydrogen-xhigh",
          "gemini-argon": "gemini-4-argon-high",
        },
        pools: {
          gemini: ["gemini-4-neon-xhigh", "gemini-4-hydrogen-xhigh"],
          "gemini-argon": ["gemini-4-argon-high"],
        },
      },
      grok: {
        via: "relay",
        quota: { provider: "grok" },
        pools: { "supergrok-weekly": ["default"] },
      },
    },
    routes: {
      // 模拟真实 read 路由：轻档 Hydrogen 排第 0 位（fit 1.0），强档 Argon/Neon 在后，中档 Grok 排最后
      read: [
        "agy:gemini:default:1.0",
        "agy:gemini-argon:default:0.85",
        "agy:gemini:gemini-4-neon-xhigh:0.8",
        "grok:supergrok-weekly:default:0.7",
      ],
    },
  };
  const fullRows = [
    row("antigravity", "gemini", 0.9),
    row("antigravity", "gemini-argon", 0.9),
    row("grok", "supergrok-weekly", 0.9),
  ];

  // 1) 三档都在时：够档位同组按综合分 Argon (0.85) → Neon (0.8) → Grok (0.7)，最后才是放宽轻档 Hydrogen
  const all = scoreRoute(cfg, fullRows, "read", { now: NOW, level: "medium", steps: true });
  const tiers = [all.choice, ...all.alternatives].map((c) => c.tier);
  assert.deepEqual(tiers, ["strong", "strong", "mid", "light"]);
  assert.equal(all.choice.model, "gemini-4-argon-high");
  assert.equal(all.alternatives.at(-1).model, "gemini-4-hydrogen-xhigh");

  // 2) 中档停用、只有强档和轻档时（真实 read 在线场景）：强档优先于轻档，绝不因 steps 反选轻档
  const noMidCfg = structuredClone(cfg);
  noMidCfg.providers.grok.enabled = false;
  const noMid = scoreRoute(noMidCfg, fullRows, "read", { now: NOW, level: "medium", steps: true });
  assert.equal(noMid.choice.tier, "strong");
  assert.equal(noMid.alternatives[0].tier, "strong");
  assert.equal(noMid.alternatives[1].model, "gemini-4-hydrogen-xhigh");
  assert.equal(noMid.alternatives[1].tier, "light");
});

test("scoreRoute：中等任务带 steps 时，按量计费组内够档位在前、轻档在后；有够档位候选时绝不反选轻档", () => {
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    modelTiers: {
      "agy:light-m": "light",
      "maas:qwen4-max": "mid",
      "maas:flash": "light",
    },
    providers: {
      agy: { via: "relay", quota: { provider: "antigravity" }, pools: { g: ["light-m"] } },
      maas: { via: "relay", billing: "metered", quota: { provider: "maas" }, pools: { maas: ["qwen4-max", "flash"] } },
    },
    routes: {
      // 故意让轻档 fit 都高于中档，验证分组优先于分数
      read: [
        "agy:g:light-m:1.0",
        "maas:maas:flash:0.95",
        "maas:maas:qwen4-max:0.75",
      ],
    },
  };
  const rows = [row("antigravity", "g", 0.95)];

  // 1) 会员仅剩轻档、按量有中档：按量中档够档位排第一，之后才是会员轻档、按量轻档
  const res = scoreRoute(cfg, rows, "read", { now: NOW, level: "medium", steps: true });
  assert.deepEqual(
    [res.choice, ...res.alternatives].map((c) => `${c.provider}/${c.model}`),
    ["maas/qwen4-max", "agy/light-m", "maas/flash"],
  );

  // 2) 仅按量（only: maas）：组内够档位 qwen4-max 在前，轻档 flash 在后
  const maasOnly = scoreRoute(cfg, rows, "read", { now: NOW, level: "medium", steps: true, only: "maas" });
  assert.deepEqual(
    [maasOnly.choice, ...maasOnly.alternatives].map((c) => c.model),
    ["qwen4-max", "flash"],
  );
});

test("tierAllowed：第 4 个参数 steps 只对中等任务放宽一档", () => {
  assert.equal(tierAllowed("medium", "light"), false);
  assert.equal(tierAllowed("medium", "light", false, true), true);
  assert.equal(tierAllowed("hard", "mid", false, true), false);
  assert.equal(tierAllowed("hard", "mid", true, false), true);
  assert.equal(tierAllowed("easy", "light", false, true), true);
  assert.equal(tierAllowed("medium", "mid", false, true), true);
});

// ---------- 命令行 ----------

// 隔离的临时状态目录：中档额度耗尽、轻档额度充足，假 CLI 直接返回成功
function makeStepsHome(fakeBin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-steps-"));
  const providers = {
    midp: {
      label: "中档厂商",
      via: "relay",
      quota: { provider: "midq" },
      pools: { m: ["mid-m"] },
      cli: { bin: fakeBin, prompt: [], model: ["--model", "{model}"], read: [], write: [], cwd: null, fullAccess: [] },
      caps: { web: false, exec: false, vision: false },
    },
    lightp: {
      label: "轻档厂商",
      via: "relay",
      quota: { provider: "lightq" },
      pools: { l: ["light-m"] },
      cli: { bin: fakeBin, prompt: [], model: ["--model", "{model}"], read: [], write: [], cwd: null, fullAccess: [] },
      caps: { web: false, exec: false, vision: false },
    },
  };
  fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify({
    minRemaining: 0.15,
    lowRemaining: 0.3,
    quotaDb: "",
    providers,
    modelTiers: { "midp:*": "mid", "lightp:*": "light" },
    routes: { implement: ["midp:m:mid-m", "lightp:l:light-m:0.8"] },
  }, null, 2) + "\n");
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "quota-cache.json"), JSON.stringify({
    sources: {
      test: {
        fetchedAt: now,
        rows: [
          { provider: "midq", pool_id: "m", window_key: "weekly", remaining_fraction: 0, reset_at: now + 5 * 86400000, allowance: "exhausted", updated_at: now },
          { provider: "lightq", pool_id: "l", window_key: "weekly", remaining_fraction: 0.9, reset_at: now + 5 * 86400000, allowance: "available", updated_at: now },
        ],
      },
    },
  }, null, 2) + "\n");
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function runRelay(home, args, { input } = {}) {
  return spawnSync(process.execPath, [relayPath, ...args], {
    encoding: "utf8",
    input,
    cwd: scriptsDir,
    env: {
      PATH: process.env.PATH || "",
      HOME: os.tmpdir(),
      AI_RELAY_HOME: home,
      CLAUDE_PROJECT_DIR: "",
      LANG: "C",
      TMPDIR: process.env.TMPDIR || "/tmp",
    },
    timeout: 30000,
  });
}

// 前台 run 不打印分派理由，从任务记录里读（stdout 首行是「任务 <id> · …」）
function jobReasonOf(home, stdout) {
  const id = (stdout.match(/任务 (\S+) ·/) || [])[1];
  assert.ok(id, "stdout 里应有任务 id：" + stdout);
  const job = JSON.parse(fs.readFileSync(path.join(home, "jobs", `${id}.json`), "utf8"));
  return job.reason;
}

// 派单正文：stepsText 为 null 时不写「## 步骤」小节
function briefOf(stepsText) {
  const steps = stepsText === null ? "" : `\n## 步骤\n${stepsText}\n`;
  return `角色：implement\n难度：中等\n\n## 目标\n给打分模块加一个选项\n\n## 验收标准\n测试全过\n${steps}`;
}

const GOOD_STEPS = "1. 在 plugins/ai-relay/scripts/score.mjs 加 steps 选项\n2. 更新 plugins/ai-relay/scripts/steps.test.mjs 的断言";

test("验收 2：中档全不可用时，中等任务不带步骤被退回，带合格步骤放行", () => {
  const fakeBin = path.join(scriptsDir, "fake-steps-bin.mjs");
  fs.writeFileSync(fakeBin, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ result: "ok", is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }));');
  fs.chmodSync(fakeBin, 0o755);
  try {
    // 自动选人：不带步骤 → 轻档因档位不够被跳过，中档没额度 → 没有候选
    const h1 = makeStepsHome(fakeBin);
    try {
      const noSteps = runRelay(h1.dir, ["run", "auto", "--role", "implement", "--cwd", h1.dir, "--", briefOf(null)]);
      assert.equal(noSteps.status, 3, noSteps.stdout + noSteps.stderr);
      assert.match(noSteps.stderr, /跳过：lightp \/ light-m  中等任务需要中档以上，它是轻档/);
      assert.match(noSteps.stderr, /没有可用模型/);
    } finally {
      h1.cleanup();
    }

    // 自动选人：带合格步骤 → 轻档放行
    const h2 = makeStepsHome(fakeBin);
    try {
      const withSteps = runRelay(h2.dir, ["run", "auto", "--role", "implement", "--cwd", h2.dir, "--", briefOf(GOOD_STEPS)]);
      assert.equal(withSteps.status, 0, withSteps.stdout + withSteps.stderr);
      assert.match(withSteps.stdout, /任务 .*lightp \/ light-m/);
      // 前台模式不打印分派理由，从任务记录里读
      assert.match(jobReasonOf(h2.dir, withSteps.stdout), /带步骤规格，轻档可接/);
      assert.doesNotMatch(jobReasonOf(h2.dir, withSteps.stdout), /降级原因/);
    } finally {
      h2.cleanup();
    }

    // 点名轻档：不带步骤被档位检查退回，带合格步骤放行
    const h3 = makeStepsHome(fakeBin);
    try {
      const named = runRelay(h3.dir, ["run", "lightp", "--role", "implement", "--model", "light-m", "--cwd", h3.dir, "--", briefOf(null)]);
      assert.equal(named.status, 3, named.stdout + named.stderr);
      assert.match(named.stderr, /lightp \/ light-m 是轻档模型，接不了中等任务/);

      const namedSteps = runRelay(h3.dir, ["run", "lightp", "--role", "implement", "--model", "light-m", "--cwd", h3.dir, "--", briefOf(GOOD_STEPS)]);
      assert.equal(namedSteps.status, 0, namedSteps.stdout + namedSteps.stderr);
      assert.match(namedSteps.stdout, /任务 .*lightp \/ light-m/);
    } finally {
      h3.cleanup();
    }
  } finally {
    fs.rmSync(fakeBin, { force: true });
  }
});

test("验收 2：只有 1 步、或步骤里没有文件路径时，轻档仍被退回", () => {
  const fakeBin = path.join(scriptsDir, "fake-steps-bin2.mjs");
  fs.writeFileSync(fakeBin, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ result: "ok", is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }));');
  fs.chmodSync(fakeBin, 0o755);
  try {
    const cases = [
      ["只有 1 步", "1. 在 plugins/ai-relay/scripts/score.mjs 加 steps 选项"],
      ["步骤里没有文件路径", "1. 加一个打分选项\n2. 更新测试断言"],
      ["其中一步没点到文件", "1. 在 plugins/ai-relay/scripts/score.mjs 加 steps 选项\n2. 再检查一下"],
    ];
    for (const [name, steps] of cases) {
      const h = makeStepsHome(fakeBin);
      try {
        const r = runRelay(h.dir, ["run", "lightp", "--role", "implement", "--model", "light-m", "--cwd", h.dir, "--", briefOf(steps)]);
        assert.equal(r.status, 3, `${name}：${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /是轻档模型，接不了中等任务/, name);
      } finally {
        h.cleanup();
      }
    }
  } finally {
    fs.rmSync(fakeBin, { force: true });
  }
});

test("验收 4：pick --level 中等 没有候选时，输出轻档候选和步骤规格提示；--steps 可预览", () => {
  const fakeBin = path.join(scriptsDir, "fake-steps-bin3.mjs");
  fs.writeFileSync(fakeBin, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ result: "ok", is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }));');
  fs.chmodSync(fakeBin, 0o755);
  const home = makeStepsHome(fakeBin);
  try {
    const pick = runRelay(home.dir, ["pick", "implement", "--level", "中等"]);
    assert.equal(pick.status, 3, pick.stdout + pick.stderr);
    assert.match(pick.stdout, /跳过：lightp \/ light-m  中等任务需要中档以上，它是轻档/);
    assert.match(pick.stdout, /轻档候选（现在因档位不够被跳过）：/);
    assert.match(pick.stdout, /lightp \/ light-m/);
    assert.match(pick.stdout, /把任务写成「## 步骤」规格（至少 2 步，每步点到具体文件）后可以派给它们/);
    assert.match(pick.stdout, /relay pick 加 --steps 可预览/);

    // --steps：直接把轻档选出来
    const preview = runRelay(home.dir, ["pick", "implement", "--level", "中等", "--steps"]);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.match(preview.stdout, /→ lightp \/ l \/ light-m（轻档）/);
    assert.match(preview.stdout, /带步骤规格，轻档可接/);
    // 已经带 --steps 时不再重复提示
    assert.doesNotMatch(preview.stdout, /轻档候选（现在因档位不够被跳过）/);

    // 困难任务无候选时不给步骤规格提示（步骤规格只对中等任务生效）
    const hard = runRelay(home.dir, ["pick", "implement", "--level", "困难"]);
    assert.equal(hard.status, 3);
    assert.doesNotMatch(hard.stdout, /把任务写成「## 步骤」规格/);
  } finally {
    home.cleanup();
    fs.rmSync(fakeBin, { force: true });
  }
});
