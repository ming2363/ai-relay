// 按任务难度派单：模型分档、难度门槛、简单任务优先便宜模型、派单难度必填
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scoreRoute, modelTier, maxVariant, parseLevel, tierAllowed } from "./score.mjs";
import { levelOfBrief } from "./brief.mjs";
import { noModelText } from "./relay.mjs";

const NOW = 1700000000000;
const CFG = {
  minRemaining: 0.15,
  lowRemaining: 0.3,
  providers: {
    codex: { via: "codex-plugin", quota: { provider: "codex" }, pools: { codex: ["default"] } },
    agy: {
      via: "relay",
      quota: { provider: "antigravity" },
      pools: {
        "gemini-argon": ["gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"],
        gemini: ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"],
      },
    },
    grok: { via: "relay", quota: { provider: "grok" }, pools: { "supergrok-weekly": ["default"] } },
  },
  routes: {
    implement: [
      "codex:codex:default",
      "agy:gemini-argon:gemini-4-argon-high:0.9",
      "grok:supergrok-weekly:default:0.85",
      "agy:gemini:gemini-3.8-flash-high",
    ],
  },
};
const row = (provider, pool, remaining) => ({ provider, pool_id: pool, window_key: "weekly", remaining_fraction: remaining, reset_at: NOW + 5 * 86400000, allowance: "available", updated_at: NOW });
const ALL_FULL = [row("codex", "codex", 0.9), row("antigravity", "gemini-argon", 0.9), row("grok", "supergrok-weekly", 0.6), row("antigravity", "gemini", 0.99)];

test("模型分档：按「厂商:模型」最长匹配，配置可覆盖，没列到的算中档", () => {
  assert.equal(modelTier({}, "agy", "gemini-3.8-flash-low"), "light");
  assert.equal(modelTier({}, "agy", "gemini-4-argon-high"), "strong");
  assert.equal(modelTier({}, "agy", "gemini-4-argon-medium"), "mid");
  assert.equal(modelTier({}, "codex", "default"), "mid");
  assert.equal(modelTier({}, "codex", "gpt-6-astra"), "strong");
  assert.equal(modelTier({}, "codex", "gpt-6.1-sol"), "strong");
  assert.equal(modelTier({}, "codex", "gpt-6.1-terra"), "mid");
  assert.equal(modelTier({}, "codex", "gpt-6-luna"), "light");
  assert.equal(modelTier({}, "codex", "gpt-5.6-sol"), "light");
  assert.equal(modelTier({}, "kimi", "k2"), "mid");
  assert.equal(modelTier({ modelTiers: { "grok:*": "strong" } }, "grok", "grok-4.7"), "strong");
});

test("难度解析：派单行和中英文写法", () => {
  assert.equal(levelOfBrief("角色：implement\n难度：简单\n## 目标"), "easy");
  assert.equal(levelOfBrief("难度: 困难（跨模块）"), "hard");
  assert.equal(levelOfBrief("难度：<简单|中等|困难>"), null);
  assert.equal(levelOfBrief("## 目标\n做点事"), null);
  assert.equal(parseLevel("medium"), "medium");
  assert.equal(tierAllowed("hard", "mid"), false);
  assert.equal(tierAllowed("hard", "mid", true), true);
  assert.equal(tierAllowed("medium", "light"), false);
});

test("同一模型有几档时一律换成池里最高的一档：xhigh > high > medium > low；池里没有更高的就不换", () => {
  assert.equal(maxVariant(CFG, "agy", "gemini", "gemini-3.8-flash-low"), "gemini-3.8-flash-high");
  const hyd = { providers: { agy: { pools: { gemini: ["gemini-4-hydrogen-xhigh", "gemini-4-hydrogen-high", "gemini-4-hydrogen-medium"] } } } };
  assert.equal(maxVariant(hyd, "agy", "gemini", "gemini-4-hydrogen-medium"), "gemini-4-hydrogen-xhigh");
  assert.equal(maxVariant(hyd, "agy", "gemini", "gemini-4-hydrogen-xhigh"), "gemini-4-hydrogen-xhigh");
  assert.equal(maxVariant(CFG, "agy", "gemini-argon", "gemini-4-argon-medium"), "gemini-4-argon-high");
  assert.equal(maxVariant(CFG, "grok", "supergrok-weekly", "grok-4.7"), "grok-4.7");
  assert.equal(maxVariant({ providers: { agy: { pools: { gemini: ["gemini-3.8-flash-low"] } } } }, "agy", "gemini", "gemini-3.8-flash-low"), "gemini-3.8-flash-low");
});

test("换到最高档后同一模型只留一条候选（read 路由里 Argon medium 换成 high 后不重复）", () => {
  const cfg = structuredClone(CFG);
  cfg.routes.read = ["agy:gemini-argon:gemini-4-argon-high:0.9", "agy:gemini-argon:gemini-4-argon-medium:0.6"];
  const r = scoreRoute(cfg, ALL_FULL, "read", { now: NOW });
  const all = [r.choice, ...r.alternatives, ...r.skipped].filter(Boolean).filter((c) => c.model === "gemini-4-argon-high");
  assert.equal(all.length, 1);
  // 点名具体模型时不换档
  const exact = scoreRoute(cfg, ALL_FULL, "read", { now: NOW, exactModel: true });
  assert.ok([exact.choice, ...exact.alternatives].some((c) => c.model === "gemini-4-argon-medium"));
});

test("简单任务：额度充足的轻档 Flash 排第一，强档 Codex 不再因为排名靠前胜出", () => {
  const r = scoreRoute(CFG, ALL_FULL, "implement", { now: NOW, level: "easy" });
  assert.equal(r.choice.provider, "agy");
  assert.equal(r.choice.model, "gemini-3.8-flash-high");
  assert.equal(r.choice.tier, "light");
  assert.match(r.choice.reason, /^难度简单：优先额度充足、便宜的模型，它是轻档；.*经济 1\.00/);
  // 不写难度时保持旧规则：Codex 排第一
  assert.equal(scoreRoute(CFG, ALL_FULL, "implement", { now: NOW }).choice.provider, "codex");
});

test("中等任务：跳过轻档，Argon 一律用最高档 high 参与", () => {
  const r = scoreRoute(CFG, ALL_FULL, "implement", { now: NOW, level: "medium" });
  const flash = r.skipped.find((s) => s.provider === "agy" && s.pool === "gemini");
  assert.ok(flash?.tierTooLow);
  assert.equal(flash.why, "中等任务需要中档以上，它是轻档");
  const argon = [r.choice, ...r.alternatives].find((c) => c.pool === "gemini-argon");
  assert.equal(argon.model, "gemini-4-argon-high");
});

test("困难任务：只派强档；强档都没额度时不降级，加 downgrade 才放宽到中档", () => {
  const r = scoreRoute(CFG, ALL_FULL, "implement", { now: NOW, level: "hard" });
  assert.ok(["codex", "agy"].includes(r.choice.provider));
  assert.equal(r.choice.tier, "strong");
  assert.ok(r.skipped.some((s) => s.provider === "grok" && s.why === "困难任务需要强档，它是中档"));

  const drained = [row("codex", "codex", 0.05), row("antigravity", "gemini-argon", 0.0), row("grok", "supergrok-weekly", 0.6), row("antigravity", "gemini", 0.99)];
  const none = scoreRoute(CFG, drained, "implement", { now: NOW, level: "hard" });
  assert.equal(none.choice, null);
  const down = scoreRoute(CFG, drained, "implement", { now: NOW, level: "hard", downgrade: true });
  assert.equal(down.choice.provider, "grok");
  assert.match(down.choice.reason, /^难度困难（已降级）/);
});

// ---------- 命令行：派单难度必填 ----------
const DIR = path.dirname(fileURLToPath(import.meta.url));
function relay(args, input) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-level-"));
  return spawnSync(process.execPath, [path.join(DIR, "relay.mjs"), ...args], {
    input, encoding: "utf8", env: { ...process.env, AI_RELAY_HOME: home, CLAUDE_PROJECT_DIR: "" }, timeout: 20000,
  });
}

test("relay run 派单没写难度就退回，pick 不带 --level 也退回", () => {
  const brief = "角色：implement\n\n## 目标\n改个文案\n\n## 验收标准\n文案改好";
  const run = relay(["run", "grok", "--cwd", os.tmpdir()], brief);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /派单没写难度，已退回/);
  const pick = relay(["pick", "implement"]);
  assert.equal(pick.status, 2);
  assert.match(pick.stderr, /需要 --level/);
});

test("relay run 点名的模型档位不够就退回，--downgrade 写明原因才放行到打分之后", () => {
  const brief = "角色：implement\n难度：困难\n\n## 目标\n重构调度\n\n## 验收标准\n测试通过";
  const r = relay(["run", "grok", "--cwd", os.tmpdir()], brief);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /跳过：grok \/ \S+  困难任务需要强档，它是中档/);
  assert.match(r.stderr, /够档位的一个都没有。由主管自己做，或确认降一档也能做好时加 --downgrade/);
});

test("派给 Codex：没写难度退回；模型档位不够退回；--model / --effort 放到第一行", () => {
  // 每次调用一个新状态目录：放行的可写任务会占住写入范围，不能影响下一次
  const freshHome = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-level-codex-"));
    fs.writeFileSync(path.join(home, "mode"), "auto\n");
    // 本机 Codex 额度可能已用完：指到一个不存在的额度池，让测试只看难度和模型
    const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "..", "config", "providers.default.json"), "utf8"));
    cfg.providers.codex.quota.provider = "codex-test-none";
    fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(cfg));
    return home;
  };
  // Codex 自己的默认模型从 CODEX_HOME/config.toml 读；测试里指到临时目录，默认设成轻档的 Luna
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-home-"));
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-6-luna"\n\n[profiles.x]\nmodel = "gpt-6-astra"\n');
  const call = (prompt, codex = codexHome) => spawnSync(process.execPath, [path.join(DIR, "pretool-hook.mjs")], {
    input: JSON.stringify({ session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "codex:codex-rescue", prompt } }),
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: freshHome(), CODEX_HOME: codex, CLAUDE_PROJECT_DIR: "" },
  });
  const out = (prompt, codex) => JSON.parse(call(prompt, codex).stdout || "{}").hookSpecificOutput || {};
  const firstLine = (o) => o.updatedInput.prompt.split("\n")[0];
  const body = "\n\n## 目标\n重构调度\n\n## 验收标准\n测试通过";

  assert.match(call("角色：implement" + body).stdout, /没写难度，已退回/);
  // 不写 --model：用 Codex 自己的默认模型（这里是轻档 Luna），并把它钉在第一行
  const easy = out("角色：implement\n难度：简单" + body);
  assert.equal(firstLine(easy), "--model gpt-6-luna --effort xhigh");
  assert.match(out("角色：implement\n难度：中等" + body).permissionDecisionReason, /gpt-6-luna 是轻档模型，接不了中等任务/);
  // 困难任务写了强档：参数放第一行，正文里不再出现 --model
  const hard = out("--model gpt-6.1-sol --background\n角色：implement\n难度：困难" + body);
  assert.equal(hard.permissionDecision, "allow");
  assert.equal(firstLine(hard), "--model gpt-6.1-sol --effort xhigh --background");
  assert.doesNotMatch(hard.updatedInput.prompt.split("\n").slice(1).join("\n"), /--model/);
  // 写在正文中间的 --model 也要检查，不能绕过档位
  assert.match(out("角色：implement\n难度：中等\n用 --model gpt-6-luna 跑" + body).permissionDecisionReason, /gpt-6-luna 是轻档模型/);
  // --model=x 写法同样认出来，并从正文去掉
  const eq = out("角色：implement\n难度：中等 --model=gpt-6.1-terra" + body);
  assert.equal(firstLine(eq), "--model gpt-6.1-terra --effort xhigh");
  assert.doesNotMatch(eq.updatedInput.prompt.split("\n").slice(1).join("\n"), /--model/);
  // 写了两个不同的模型、推理强度不合法：退回
  assert.match(out("--model gpt-6.1-sol\n角色：implement\n难度：困难\n--model gpt-6-luna" + body).permissionDecisionReason, /写了不同的值/);
  assert.match(out("--effort 高\n角色：implement\n难度：中等 --model gpt-6.1-terra" + body).permissionDecisionReason, /不是 Codex 认的推理强度/);
  // 读不到 Codex 默认模型：中等以上要写明 --model
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-empty-"));
  assert.match(out("角色：implement\n难度：中等" + body, empty).permissionDecisionReason, /读不到 Codex 的默认模型/);
});

test("难度行：没填的占位符跳过，继续认后面的；也接受标题写法", () => {
  assert.equal(levelOfBrief("难度：<简单|中等|困难>\n难度：中等"), "medium");
  assert.equal(levelOfBrief("## 难度：困难"), "hard");
});

test("没选出模型：够档位的全因额度跳过才提示降级，否则只列原因", () => {
  const quota = { provider: "codex", model: "default", why: "额度耗尽或过低" };
  const low = { provider: "grok", model: "grok-4.7", why: "困难任务需要强档，它是中档", tierTooLow: true };
  const sandbox = { provider: "codex", model: "default", why: "沙箱只能写 /a，目标目录不在其中" };
  assert.match(noModelText("implement", "hard", [quota, low]), /够档位的都没额度。由主管自己做/);
  const mixed = noModelText("implement", "hard", [sandbox, low]);
  assert.doesNotMatch(mixed, /--downgrade/);
  assert.match(mixed, /跳过：codex \/ default  沙箱只能写/);
  assert.match(mixed, /原因见上面每一条/);
});

test("换档后的模型共用同一家族的历史验收记录", () => {
  const history = [
    { provider: "agy", model: "gemini-3.8-flash-low", role: "implement", status: "done", verdict: "fail" },
    { provider: "agy", model: "gemini-3.8-flash-medium", role: "implement", status: "done", verdict: "fail" },
  ];
  const r = scoreRoute(CFG, ALL_FULL, "implement", { now: NOW, level: "easy", history });
  const flash = [r.choice, ...r.alternatives].find((c) => c.pool === "gemini");
  assert.equal(flash.model, "gemini-3.8-flash-high");
  assert.ok(flash.parts.reliability < 0.8, `flash-high 应带上 low、medium 的两次失败，实际 ${flash.parts.reliability}`);
});

test("pick 降级选出的模型，打印的派单命令带上同样的 --downgrade", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-level-pick-"));
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "..", "config", "providers.default.json"), "utf8"));
  cfg.quotaDb = "";
  // 强档都停用，只剩中档 Grok
  cfg.providers.codex.enabled = false;
  cfg.routes.implement = cfg.routes.implement.filter((e) => !e.startsWith("agy:"));
  // 已升级过的配置：加载时不再补回 Neon 路由
  cfg.migrated = ["max-thinking", "gemini-hydrogen", "gemini-neon", "read-route-0.27"];
  fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [path.join(DIR, "relay.mjs"), "pick", "implement", "--level", "困难", "--downgrade", "强档停用，Grok 做得了"], {
    encoding: "utf8", env: { ...process.env, AI_RELAY_HOME: home, CLAUDE_PROJECT_DIR: "" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /relay run grok --role implement --model \S+ --downgrade "强档停用，Grok 做得了"/);
});

test("旧配置迁移：没改过的角色换成 Codex 分模型的新路由，用户加的条目保留，改过的不动", async () => {
  const { migrateModelFields } = await import("./lib.mjs");
  const def = JSON.parse(fs.readFileSync(path.join(DIR, "..", "config", "providers.default.json"), "utf8"));
  const cfg = structuredClone(def);
  cfg.providers.codex.pools.codex = ["default", "gpt-6.1-terra", "spark"];
  cfg.routes.implement = ["codex:codex:default", "agy:gemini-argon:default:0.9", "grok:supergrok-weekly:default:0.85", "agy:claude-gpt:claude-sonnet-5-5-high", "agy:gemini:default", "kimi:kimi:default"];
  cfg.routes.deep = ["codex:codex:default", "agy:gemini-argon:default"];
  assert.equal(migrateModelFields(cfg, def), true);
  assert.deepEqual(cfg.routes.implement, [...def.routes.implement, "kimi:kimi:default"]);
  // Codex 迁移不动改过的 deep；Neon 迁移照常补上 Neon
  assert.deepEqual(cfg.routes.deep, ["codex:codex:default", "agy:gemini-argon:default", "agy:gemini:gemini-4-neon-xhigh:0.95"]);
  assert.ok(cfg.providers.codex.pools.codex.includes("gpt-6-luna"));
  assert.equal(migrateModelFields(cfg, def), false);
});
