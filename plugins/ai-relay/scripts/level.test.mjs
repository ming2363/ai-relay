// 按任务难度派单：模型分档、难度门槛、简单任务优先便宜模型、派单难度必填
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scoreRoute, modelTier, levelVariant, parseLevel, tierAllowed } from "./score.mjs";
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
  assert.equal(modelTier({}, "codex", "default"), "strong");
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

test("同一模型有几档时按难度换：简单 low、中等 medium、困难 high；池里没有那一档就不换", () => {
  assert.equal(levelVariant(CFG, "agy", "gemini", "gemini-3.8-flash-high", "easy"), "gemini-3.8-flash-low");
  assert.equal(levelVariant(CFG, "agy", "gemini-argon", "gemini-4-argon-high", "medium"), "gemini-4-argon-medium");
  assert.equal(levelVariant(CFG, "grok", "supergrok-weekly", "grok-4.7", "easy"), "grok-4.7");
  assert.equal(levelVariant({ providers: { agy: { pools: { gemini: ["gemini-3.8-flash-high"] } } } }, "agy", "gemini", "gemini-3.8-flash-high", "easy"), "gemini-3.8-flash-high");
});

test("简单任务：额度充足的轻档 Flash 排第一，强档 Codex 不再因为排名靠前胜出", () => {
  const r = scoreRoute(CFG, ALL_FULL, "implement", { now: NOW, level: "easy" });
  assert.equal(r.choice.provider, "agy");
  assert.equal(r.choice.model, "gemini-3.8-flash-low");
  assert.equal(r.choice.tier, "light");
  assert.match(r.choice.reason, /^难度简单：优先额度充足、便宜的模型，它是轻档；.*经济 1\.00/);
  // 不写难度时保持旧规则：Codex 排第一
  assert.equal(scoreRoute(CFG, ALL_FULL, "implement", { now: NOW }).choice.provider, "codex");
});

test("中等任务：跳过轻档，Argon 换成 medium 后按中档参与", () => {
  const r = scoreRoute(CFG, ALL_FULL, "implement", { now: NOW, level: "medium" });
  const flash = r.skipped.find((s) => s.provider === "agy" && s.pool === "gemini");
  assert.ok(flash?.tierTooLow);
  assert.equal(flash.why, "中等任务需要中档以上，它是轻档");
  const argon = [r.choice, ...r.alternatives].find((c) => c.pool === "gemini-argon");
  assert.equal(argon.model, "gemini-4-argon-medium");
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

test("派给 Codex 的派单没写难度就退回，写了就不因难度拦截", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-level-codex-"));
  fs.writeFileSync(path.join(home, "mode"), "auto\n");
  // 本机 Codex 额度可能已用完：指到一个不存在的额度池，让测试只看难度这一项
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "..", "config", "providers.default.json"), "utf8"));
  cfg.providers.codex.quota.provider = "codex-test-none";
  fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(cfg));
  const call = (prompt) => spawnSync(process.execPath, [path.join(DIR, "pretool-hook.mjs")], {
    input: JSON.stringify({ session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "codex:codex-rescue", prompt } }),
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: home, CLAUDE_PROJECT_DIR: "" },
  });
  const body = "\n\n## 目标\n重构调度\n\n## 验收标准\n测试通过";
  const denied = call("角色：implement" + body);
  assert.match(denied.stdout, /没写难度，已退回/);
  const ok = call("角色：implement\n难度：困难" + body);
  assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecision, "allow");
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
    { provider: "agy", model: "gemini-3.8-flash-high", role: "implement", status: "done", verdict: "fail" },
    { provider: "agy", model: "gemini-3.8-flash-high", role: "implement", status: "done", verdict: "fail" },
  ];
  const r = scoreRoute(CFG, ALL_FULL, "implement", { now: NOW, level: "easy", history });
  const flash = [r.choice, ...r.alternatives].find((c) => c.pool === "gemini");
  assert.equal(flash.model, "gemini-3.8-flash-low");
  assert.ok(flash.parts.reliability < 0.8, `flash-low 应带上 flash-high 的两次失败，实际 ${flash.parts.reliability}`);
});

test("pick 降级选出的模型，打印的派单命令带上同样的 --downgrade", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-level-pick-"));
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "..", "config", "providers.default.json"), "utf8"));
  // 强档都停用，只剩中档 Grok
  cfg.providers.codex.enabled = false;
  cfg.routes.implement = cfg.routes.implement.filter((e) => !e.startsWith("agy:"));
  fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [path.join(DIR, "relay.mjs"), "pick", "implement", "--level", "困难", "--downgrade", "强档停用，Grok 做得了"], {
    encoding: "utf8", env: { ...process.env, AI_RELAY_HOME: home, CLAUDE_PROJECT_DIR: "" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /relay run grok --role implement --model \S+ --downgrade "强档停用，Grok 做得了"/);
});
