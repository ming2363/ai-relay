// 看图能力、密钥打码与对接缺口测试
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { capsOf, maskSecrets, savePrompt, cleanup, migrateModelFields } from "./lib.mjs";
import { needsOfBrief, imagePathsOf, needsWithImages, buildDispatchPrompt } from "./brief.mjs";
import { scoreRoute, capsSkipWhy } from "./score.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const relayPath = path.join(scriptsDir, "relay.mjs");
const defaultCfgPath = path.join(scriptsDir, "../config/providers.default.json");

function makeTestHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-vision-test-"));
  const cfg = JSON.parse(fs.readFileSync(defaultCfgPath, "utf8"));
  cfg.quotaDb = "";
  fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify(cfg, null, 2));
  return dir;
}

function runRelay(stateDir, args, opts = {}) {
  return spawnSync(process.execPath, [relayPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: stateDir, CLAUDE_PROJECT_DIR: "" },
    timeout: 30000,
    ...opts,
  });
}

test("验收 2：capsOf 模型覆盖优先于厂商级；不传模型时取厂商级", () => {
  const cfg = { workerFullAccess: true };
  const prov = {
    caps: { web: false, exec: false, vision: false },
    modelCaps: {
      "m-vision": { vision: true },
      "m-novision": { vision: false },
    },
  };
  assert.equal(capsOf(cfg, prov, "m-vision").vision, true);
  assert.equal(capsOf(cfg, prov, "m-novision").vision, false);
  assert.equal(capsOf(cfg, prov, "m-unknown").vision, false);
  assert.equal(capsOf(cfg, prov).vision, false);

  const prov2 = {
    caps: { web: true, exec: true, vision: true },
    modelCaps: {
      "m-novision": { vision: false },
    },
  };
  assert.equal(capsOf(cfg, prov2, "m-novision").vision, false);
  assert.equal(capsOf(cfg, prov2, "m-other").vision, true);
  assert.equal(capsOf(cfg, prov2).vision, true);
});

test("验收 3：派单正文没写「需要的能力」但出现图片路径时 needsWithImages 含 vision；没有图片路径也没写看图时不含", () => {
  assert.deepEqual(imagePathsOf("请看 docs/a.png 和 /tmp/b.JPG，以及 a.gif, test.WEBP"), ["docs/a.png", "/tmp/b.JPG", "a.gif", "test.WEBP"]);
  assert.deepEqual(imagePathsOf("这里没有任何图片路径"), []);

  const briefWithImg = `角色：implement
难度：中等

## 目标
实现页面，参考 docs/a.png

## 验收标准
对齐截图`;
  assert.deepEqual(needsWithImages(briefWithImg), ["vision"]);

  const briefNoImg = `角色：implement
难度：中等

## 目标
实现纯文本算法

## 验收标准
通过单元测试`;
  assert.deepEqual(needsWithImages(briefNoImg), []);

  const briefExplicit = `角色：implement
难度：中等

## 目标
分析布局

## 需要的能力
看图

## 验收标准
分析正确`;
  assert.deepEqual(needsWithImages(briefExplicit), ["vision"]);
});

test("验收 4：needs 含 vision 时，同一厂商里 modelCaps 标了 vision 的模型成为候选，没标的被跳过且原因是'不具备：看图'；needs 为空时两者都是候选", () => {
  const cfg = {
    providers: {
      maas: {
        via: "relay",
        pools: { maas: ["qwen3.8-max", "glm-5.3"] },
        caps: { web: false, exec: false, vision: false },
        modelCaps: {
          "qwen3.8-max": { vision: true },
        },
        quota: { provider: "maas" },
      },
    },
    routes: {
      implement: ["maas:maas:qwen3.8-max", "maas:maas:glm-5.3"],
    },
  };
  const rows = []; // unknown quota

  const resWithVision = scoreRoute(cfg, rows, "implement", { needs: ["vision"] });
  assert.equal(resWithVision.choice?.model, "qwen3.8-max");
  const skipped = resWithVision.skipped.find((s) => s.model === "glm-5.3");
  assert.ok(skipped);
  assert.equal(skipped.why, "不具备：看图");

  const resEmpty = scoreRoute(cfg, rows, "implement", { needs: [] });
  assert.equal(resEmpty.choice?.model, "qwen3.8-max");
  assert.equal(resEmpty.alternatives[0]?.model, "glm-5.3");
  assert.equal(resEmpty.skipped.length, 0);
});

test("验收 5：点名一个看不了图的模型跑带图派单被退回；Codex 钩子对带图派单拒绝并给出文案", async () => {
  const home = makeTestHome();
  fs.writeFileSync(path.join(home, "mode"), "auto\n");
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "providers.json"), "utf8"));
  cfg.providers.maas = {
    label: "国产模型",
    via: "relay",
    billing: "metered",
    pools: { maas: ["qwen3.8-max", "glm-5.3"] },
    caps: { web: false, exec: false, vision: false },
    modelCaps: { "qwen3.8-max": { vision: true } },
    quota: { provider: "maas" },
    cli: { bin: "node", prompt: ["-e", "process.exit(0)"] },
  };
  fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(cfg, null, 2));

  const task = `角色：implement
难度：中等

## 目标
根据 docs/demo.png 修改代码

## 验收标准
样式一致`;

  const runRes = runRelay(home, ["run", "maas", "--role", "implement", "--model", "glm-5.3", "--", task]);
  assert.equal(runRes.status, 3);
  assert.match(runRes.stderr, /maas 不具备：看图/);

  // Codex 钩子能力拦截
  const hookPath = path.join(scriptsDir, "pretool-hook.mjs");
  const hookRes = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      tool_name: "Agent",
      session_id: "test-sess",
      cwd: home,
      tool_input: {
        subagent_type: "codex:codex-rescue",
        prompt: `--model gpt-6.1-sol\n\n${task}`,
      },
    }),
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: home, CLAUDE_PROJECT_DIR: home },
  });
  assert.equal(hookRes.status, 0, hookRes.stderr);
  const out = JSON.parse(hookRes.stdout);
  assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput?.permissionDecisionReason, /\[ai-relay\] Codex 不具备：看图。带图的部分请改派能看图的模型（relay pick <角色> --needs vision），或由主控看图后把结论写进派单背景。/);
});

test("验收 6：buildDispatchPrompt 在 caps.vision 不为 true 时含'你看不了图片'那一行，为 true 时不含", () => {
  const promptNoVision = buildDispatchPrompt({
    task: "任务内容",
    cwd: process.cwd(),
    caps: { web: false, exec: false, vision: false },
  });
  assert.ok(promptNoVision.includes("你看不了图片：不要用读文件工具打开图片文件；需要图片内容时在汇报的『需要主控协助』里写明。"));

  const promptWithVision = buildDispatchPrompt({
    task: "任务内容",
    cwd: process.cwd(),
    caps: { web: false, exec: false, vision: true },
  });
  assert.ok(!promptWithVision.includes("你看不了图片"));

  const promptUndefinedVision = buildDispatchPrompt({
    task: "任务内容",
    cwd: process.cwd(),
    caps: { web: false, exec: false },
  });
  assert.ok(promptUndefinedVision.includes("你看不了图片：不要用读文件工具打开图片文件；需要图片内容时在汇报的『需要主控协助』里写明。"));
});

test("验收 7：endpoint 模板添加含 qwen3.8-max 和 glm-5.3 的厂商后，modelCaps 里只有 qwen3.8-max；provider caps 命令能开关；--remove 清掉条目", () => {
  const home = makeTestHome();
  const spec = {
    preset: "endpoint",
    name: "my-endpoint",
    label: "测试接口",
    baseUrl: "https://example.com",
    models: ["qwen3.8-max", "glm-5.3"],
  };
  const addRes = runRelay(home, ["provider", "add", "--json-spec", JSON.stringify(spec)]);
  assert.equal(addRes.status, 0, addRes.stderr);

  const cfgAfterAdd = JSON.parse(fs.readFileSync(path.join(home, "providers.json"), "utf8"));
  const prov = cfgAfterAdd.providers["my-endpoint"];
  assert.deepEqual(prov.modelCaps, { "qwen3.8-max": { vision: true } });

  // provider caps 开关
  const offRes = runRelay(home, ["provider", "caps", "my-endpoint", "qwen3.8-max", "vision", "off"]);
  assert.equal(offRes.status, 0, offRes.stderr);
  const cfgOff = JSON.parse(fs.readFileSync(path.join(home, "providers.json"), "utf8"));
  assert.equal(cfgOff.providers["my-endpoint"].modelCaps["qwen3.8-max"].vision, false);

  const onRes = runRelay(home, ["provider", "caps", "my-endpoint", "qwen3.8-max", "vision", "on"]);
  assert.equal(onRes.status, 0, onRes.stderr);
  const cfgOn = JSON.parse(fs.readFileSync(path.join(home, "providers.json"), "utf8"));
  assert.equal(cfgOn.providers["my-endpoint"].modelCaps["qwen3.8-max"].vision, true);

  // --remove 清掉条目
  const rmRes = runRelay(home, ["provider", "models", "my-endpoint", "--remove", "qwen3.8-max"]);
  assert.equal(rmRes.status, 0, rmRes.stderr);
  const cfgRm = JSON.parse(fs.readFileSync(path.join(home, "providers.json"), "utf8"));
  assert.equal(cfgRm.providers["my-endpoint"].modelCaps["qwen3.8-max"], undefined);
});

test("验收 8：旧配置里内置厂商 caps 没有 vision 键时升级后补上默认值，已有的不被覆盖", () => {
  const def = JSON.parse(fs.readFileSync(defaultCfgPath, "utf8"));
  const cfg = structuredClone(def);
  delete cfg.providers.agy.caps.vision;
  delete cfg.providers.codex.caps.vision;
  delete cfg.providers.grok.caps.vision;
  cfg.providers.codex.caps.vision = true; // 用户自定义已设为 true

  const changed = migrateModelFields(cfg, def);
  assert.equal(changed, true);
  assert.equal(cfg.providers.agy.caps.vision, true);
  assert.equal(cfg.providers.grok.caps.vision, true);
  assert.equal(cfg.providers.codex.caps.vision, true); // 用户设的 true 未被覆盖
});

test("验收 9：maskSecrets 对各前缀和 Bearer 生效、短串和普通文字不变；savePrompt 写出的文件是打码的；每日清理会把 prompts/ 和 rounds/ 里已有的明文打码", () => {
  // 1. 各前缀和 Bearer 生效
  assert.equal(maskSecrets("sk-1234567890123456"), "sk-***");
  assert.equal(maskSecrets("ghp_abcdefghijklmnop"), "ghp_***");
  assert.equal(maskSecrets("AKIAIOSFODNN7EXAMPLE"), "AKIA***");
  assert.equal(maskSecrets("xoxb-123456789012"), "xoxb-***");
  assert.equal(maskSecrets("xoxa-123456789012"), "xoxa-***");
  assert.equal(maskSecrets("xoxp-123456789012"), "xoxp-***");
  assert.equal(maskSecrets("Bearer abcdef1234567890xyz"), "Bearer ***");

  // 短串和普通文字不变
  assert.equal(maskSecrets("sk-short"), "sk-short");
  assert.equal(maskSecrets("Bearer short"), "Bearer short");
  assert.equal(maskSecrets("普通文字不变"), "普通文字不变");

  // 2. savePrompt 写出的文件打码 & 3. 每日清理把已有的明文打码
  const home = makeTestHome();
  const childScript = `
    import path from "node:path";
    import fs from "node:fs";
    import { savePrompt, cleanup } from "./lib.mjs";
    savePrompt("test-sess", "请使用密钥 sk-1234567890123456 进行测试");
    const roundDir = path.join(process.env.AI_RELAY_HOME, "rounds");
    fs.mkdirSync(roundDir, { recursive: true });
    fs.writeFileSync(path.join(process.env.AI_RELAY_HOME, "prompts", "old-sess.txt"), "旧文件明文 sk-1234567890123456");
    fs.writeFileSync(path.join(roundDir, "old-round.json"), JSON.stringify([{ text: "旧轮次 sk-1234567890123456" }]));
    cleanup(Date.now());
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: scriptsDir,
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: home },
  });
  assert.equal(res.status, 0, res.stderr);

  const content = fs.readFileSync(path.join(home, "prompts", "test-sess.txt"), "utf8");
  assert.equal(content, "请使用密钥 sk-*** 进行测试");
  assert.equal(fs.readFileSync(path.join(home, "prompts", "old-sess.txt"), "utf8"), "旧文件明文 sk-***");
  const roundContent = fs.readFileSync(path.join(home, "rounds", "old-round.json"), "utf8");
  assert.ok(roundContent.includes("sk-***"));
  assert.ok(!roundContent.includes("sk-1234567890123456"));
});

test("验收 10：relay status --json 里按量厂商的额度池行带 billing", () => {
  const home = makeTestHome();
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "providers.json"), "utf8"));
  cfg.providers.maas = {
    label: "国产模型",
    via: "relay",
    billing: "metered",
    pools: { maas: ["qwen3.8-max"] },
    quota: { provider: "maas" },
  };
  fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(cfg, null, 2));

  const res = runRelay(home, ["status", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const data = JSON.parse(res.stdout);
  const maasPool = data.pools.find((p) => p.name === "maas");
  assert.ok(maasPool);
  assert.equal(maasPool.billing, "metered");
});
