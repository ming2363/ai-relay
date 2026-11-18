// 自定义接口：命令行权限、环境变量、密钥、JSON 输出、模板路由
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { maskSecretValue, normalizeBaseUrl } from "./lib.mjs";
import { parseOpenAiHttpModels, refreshModels } from "./models.mjs";
import { usageFromOutputJson } from "./usage.mjs";
import { assembleArgs, executeJob, resolveJobEnv, summarizeProvider } from "./relay.mjs";

const SECRET = "sk-test-000";
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const relayPath = path.join(scriptsDir, "relay.mjs");
const presets = JSON.parse(fs.readFileSync(path.join(scriptsDir, "../config/presets.json"), "utf8"));
const defaultCfg = JSON.parse(fs.readFileSync(path.join(scriptsDir, "../config/providers.default.json"), "utf8"));

const MAAS_MODELS = [
  "deepseek-v4-pro-0813",
  "deepseek-v4.1-flash-1017",
  "glm-5.3",
  "qwen3.8-max",
  "kimi-k3.1-pro",
  "doubao-seed-2-0-pro-260215",
  "MiniMax-M2.5",
];
const MAAS_MIDS = MAAS_MODELS.filter((id) => !/flash|lite/i.test(id));
const MAAS_LIGHTS = MAAS_MODELS.filter((id) => /flash|lite/i.test(id));

function realSecretsStamp() {
  try {
    const st = fs.statSync(path.join(os.homedir(), ".claude", "ai-relay", "secrets.json"));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-endpoint-"));
  const state = path.join(home, "ai-relay");
  fs.mkdirSync(state, { recursive: true });
  const cfg = structuredClone(defaultCfg);
  cfg.quotaDb = "";
  fs.writeFileSync(path.join(state, "providers.json"), JSON.stringify(cfg, null, 2) + "\n");
  return {
    home,
    state,
    cleanup() {
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function runRelay(state, args, { input } = {}) {
  return spawnSync(process.execPath, [relayPath, ...args], {
    encoding: "utf8",
    input,
    cwd: scriptsDir,
    env: {
      PATH: process.env.PATH || "",
      HOME: path.dirname(state),
      AI_RELAY_HOME: state,
      LANG: "C",
      TMPDIR: process.env.TMPDIR || "/tmp",
    },
  });
}

function readCfg(state) {
  return JSON.parse(fs.readFileSync(path.join(state, "providers.json"), "utf8"));
}

function maasRoutes(routes, role) {
  return (routes?.[role] || []).filter((entry) => String(entry).startsWith("maas:"));
}

function routeLine(model, fit) {
  return `maas:maas:${model}:${fit}`;
}

function expectedRoutes() {
  const mid = (fit) => MAAS_MIDS.map((id) => routeLine(id, fit));
  const light = (fit) => MAAS_LIGHTS.map((id) => routeLine(id, fit));
  return {
    implement: [...mid(0.75), ...light(0.5)],
    review: [...mid(0.75), ...light(0.5)],
    debug: mid(0.65),
    deep: mid(0.65),
    read: [...light(0.8), ...mid(0.7)],
    quick: light(0.8),
  };
}

function endpointProvider(over = {}) {
  return {
    label: "国产模型（自定义接口）",
    via: "relay",
    billing: "metered",
    endpoint: { baseUrl: "https://example.test", secret: "maas" },
    quota: { provider: "maas", pools: ["maas"] },
    cli: structuredClone(presets.endpoint.cli),
    env: {
      ANTHROPIC_BASE_URL: "{baseUrl}",
      ANTHROPIC_API_KEY: "{secret}",
      ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4.1-flash-1017",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
    },
    envUnset: [...presets.endpoint.envUnset],
    pools: { maas: ["qwen3.8-max", "deepseek-v4.1-flash-1017"] },
    caps: { web: false, exec: false },
    modelList: { format: "openai-http" },
    ...over,
  };
}

function runtimeCfg(provOver = {}, cfgOver = {}) {
  return {
    idleTimeoutMin: 20,
    maxRuntimeMin: 240,
    workerFullAccess: true,
    providers: { maas: endpointProvider(provOver) },
    ...cfgOver,
  };
}

function makeWork() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-endpoint-work-"));
  const jobs = path.join(root, "jobs");
  const cwd = path.join(root, "cwd");
  fs.mkdirSync(jobs, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return {
    root,
    jobs,
    cwd,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("地址去掉末尾斜杠和 /v1；打码按原文替换", () => {
  assert.equal(normalizeBaseUrl("https://model-api.maas.com.cn/v1/"), "https://model-api.maas.com.cn");
  assert.equal(normalizeBaseUrl("https://example.test/gateway/V1"), "https://example.test/gateway");
  assert.throws(() => normalizeBaseUrl("ftp://example.test"), /http/);
  assert.equal(maskSecretValue("a.b+c 和 a.b+c", "a.b+c"), "*** 和 ***");
  assert.equal(maskSecretValue("没有", SECRET), "没有");
});

test("只读只用 plan；可写按最高权限替换参数；grok 命令行保持原样", () => {
  const cfg = runtimeCfg();
  const base = { provider: "maas", pool: "maas", model: "qwen3.8-max", cwd: "/work", wrappedPrompt: "任务" };
  const readArgs = assembleArgs(cfg, { ...base, write: false });
  assert.deepEqual(readArgs, ["--model", "qwen3.8-max", "--permission-mode", "plan", "--bare", "-p", "任务", "--output-format", "json"]);
  assert.equal(readArgs.includes("--dangerously-skip-permissions"), false);
  assert.equal(readArgs.join(" ").includes(SECRET), false);

  const writeOn = assembleArgs(cfg, { ...base, write: true });
  assert.deepEqual(writeOn, ["--model", "qwen3.8-max", "--dangerously-skip-permissions", "--bare", "-p", "任务", "--output-format", "json"]);
  assert.equal(writeOn.includes("acceptEdits"), false);
  assert.equal(writeOn.includes("plan"), false);

  const off = runtimeCfg({ fullAccessEnabled: false });
  const writeOff = assembleArgs(off, { ...base, write: true });
  assert.deepEqual(writeOff, ["--model", "qwen3.8-max", "--permission-mode", "acceptEdits", "--bare", "-p", "任务", "--output-format", "json"]);
  assert.equal(writeOff.includes("--dangerously-skip-permissions"), false);

  const grok = { provider: "grok", pool: "supergrok-weekly", model: "grok-4.7", cwd: "/work", wrappedPrompt: "你好" };
  assert.deepEqual(assembleArgs(defaultCfg, { ...grok, write: false }), [
    "--model", "grok-4.7", "--reasoning-effort", "xhigh", "--permission-mode", "plan", "--cwd", "/work", "--always-approve", "-p", "你好",
  ]);
  assert.deepEqual(assembleArgs(defaultCfg, { ...grok, write: true }), [
    "--model", "grok-4.7", "--reasoning-effort", "xhigh", "--cwd", "/work", "--always-approve", "-p", "你好",
  ]);
});

test("子进程带上接口地址和密钥，并清掉会员登录变量；没有密钥时任务失败", async () => {
  const work = makeWork();
  const saved = {
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    CLAUDECODE: process.env.CLAUDECODE,
    CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
  };
  process.env.ANTHROPIC_AUTH_TOKEN = "token-should-go";
  process.env.CLAUDECODE = "1";
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
  const dump = path.join(work.root, "env.json");
  const script = path.join(work.root, "dump-env.js");
  fs.writeFileSync(script, `const fs = require("node:fs");
fs.writeFileSync(process.env.AI_RELAY_DUMP, JSON.stringify({
  base: process.env.ANTHROPIC_BASE_URL || "",
  key: process.env.ANTHROPIC_API_KEY || "",
  hasToken: Object.prototype.hasOwnProperty.call(process.env, "ANTHROPIC_AUTH_TOKEN"),
  hasClaudeCode: Object.prototype.hasOwnProperty.call(process.env, "CLAUDECODE"),
  hasEntrypoint: Object.prototype.hasOwnProperty.call(process.env, "CLAUDE_CODE_ENTRYPOINT"),
}));
`);
  process.env.AI_RELAY_DUMP = dump;
  try {
    const job = {
      id: "job-env",
      provider: "maas",
      pool: "maas",
      model: "qwen3.8-max",
      cwd: work.cwd,
      wrappedPrompt: "任务",
      startedAt: new Date().toISOString(),
      _jobsDir: work.jobs,
    };
    const res = await executeJob(job, {
      cfg: runtimeCfg(),
      secrets: { maas: SECRET },
      bin: process.execPath,
      args: [script],
      idleTimeoutMs: 5000,
      maxRuntimeMs: 5000,
      checkIntervalMs: 1000,
    });
    assert.equal(res.status, "done");
    const dumped = JSON.parse(fs.readFileSync(dump, "utf8"));
    assert.equal(dumped.base, "https://example.test");
    assert.equal(dumped.key, SECRET);
    assert.equal(dumped.hasToken, false);
    assert.equal(dumped.hasClaudeCode, false);
    assert.equal(dumped.hasEntrypoint, false);
    assert.equal(fs.readFileSync(script, "utf8").includes(SECRET), false);
    assert.equal(fs.readFileSync(path.join(work.jobs, "job-env.log"), "utf8").includes(SECRET), false);

    const marker = path.join(work.root, "ran");
    const miss = path.join(work.root, "miss.js");
    fs.writeFileSync(miss, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    await assert.rejects(
      () => executeJob({ ...job, id: "job-missing-key" }, {
        cfg: runtimeCfg(),
        secrets: {},
        bin: process.execPath,
        args: [miss],
        idleTimeoutMs: 5000,
        maxRuntimeMs: 5000,
        checkIntervalMs: 1000,
      }),
      /relay provider key maas/,
    );
    assert.equal(fs.existsSync(marker), false);
    const savedJob = JSON.parse(fs.readFileSync(path.join(work.jobs, "job-missing-key.json"), "utf8"));
    assert.equal(savedJob.status, "failed");
    assert.match(savedJob.error, /relay provider key maas/);
  } finally {
    delete process.env.AI_RELAY_DUMP;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    work.cleanup();
  }
});

test("JSON 取 result 和用量；is_error 记失败；非 JSON 原样；日志和结果打码", async () => {
  const work = makeWork();
  const cfg = runtimeCfg();
  const secrets = { maas: SECRET };
  async function run(id, source) {
    const script = path.join(work.root, `${id}.js`);
    fs.writeFileSync(script, source);
    return executeJob({
      id,
      provider: "maas",
      pool: "maas",
      model: "qwen3.8-max",
      cwd: work.cwd,
      wrappedPrompt: "任务",
      startedAt: new Date().toISOString(),
      _jobsDir: work.jobs,
    }, {
      cfg,
      secrets,
      bin: process.execPath,
      args: [script],
      idleTimeoutMs: 5000,
      maxRuntimeMs: 5000,
      checkIntervalMs: 1000,
    });
  }
  try {
    const ok = await run("job-json", `const key = process.env.ANTHROPIC_API_KEY;
process.stdout.write(JSON.stringify({
  result: "结果里有 " + key,
  is_error: false,
  usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 2 },
}));
process.stderr.write("错误流 " + key);
`);
    assert.equal(ok.status, "done");
    assert.equal(ok.result, "结果里有 ***");
    assert.deepEqual(ok.usage, { input: 11, output: 7, cacheRead: 2, total: 20, source: "output-json" });
    const log = fs.readFileSync(path.join(work.jobs, "job-json.log"), "utf8");
    const saved = fs.readFileSync(path.join(work.jobs, "job-json.json"), "utf8");
    assert.equal(log.includes(SECRET), false);
    assert.equal(saved.includes(SECRET), false);
    assert.match(log, /结果里有 \*\*\*/);
    assert.match(log, /错误流 \*\*\*/);
    assert.match(log, /\[stderr\]/);

    const failed = await run("job-error", `process.stdout.write(JSON.stringify({ result: "失败了", is_error: true, usage: { input_tokens: 1, output_tokens: 2 } }));`);
    assert.equal(failed.status, "failed");
    assert.equal(failed.result, "失败了");
    assert.equal(failed.usage.input, 1);
    assert.equal(failed.usage.output, 2);

    const plain = await run("job-text", `process.stdout.write("原样文本，不是 JSON");`);
    assert.equal(plain.status, "done");
    assert.equal(plain.result, undefined);
    assert.equal(plain.usage, undefined);
    assert.equal(fs.readFileSync(path.join(work.jobs, "job-text.log"), "utf8"), "原样文本，不是 JSON");
  } finally {
    work.cleanup();
  }
});

test("usageFromOutputJson 与厂商用量字段一致；不是合法 JSON 时不算用量", () => {
  assert.deepEqual(usageFromOutputJson('{"usage":{"input_tokens":3,"output_tokens":4}}'), {
    input: 3,
    output: 4,
    cacheRead: 0,
    total: 7,
    source: "output-json",
  });
  assert.equal(usageFromOutputJson("不是 JSON"), null);
  assert.equal(parseOpenAiHttpModels('{"data":[{"id":"qwen3.8-max"},{"id":"qwen3.8-max"},{"id":"glm-5.3"}]}').models.map((m) => m.id).join(","), "qwen3.8-max,glm-5.3");
});

test("openai-http 拉全量模型并标出已启用；没有密钥时不请求、不崩溃", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-models-"));
  try {
    const cfg = runtimeCfg();
    let called = false;
    const missing = await refreshModels(cfg, {
      stateDir: state,
      secrets: {},
      fetchImpl: async () => {
        called = true;
        throw new Error("不应该请求网络");
      },
    });
    assert.equal(called, false);
    assert.equal(missing.providers.maas.ok, false);
    assert.match(missing.providers.maas.error, /relay provider key maas/);

    let seen = null;
    const cache = await refreshModels(cfg, {
      stateDir: state,
      secrets: { maas: SECRET },
      fetchImpl: async (url, options) => {
        seen = { url, authorization: options.headers.Authorization };
        return {
          ok: true,
          async text() {
            return JSON.stringify({ data: [{ id: "qwen3.8-max" }, { id: "other-model" }] });
          },
        };
      },
    });
    assert.equal(seen.url, "https://example.test/v1/models");
    assert.equal(seen.authorization, `Bearer ${SECRET}`);
    const models = cache.providers.maas.models;
    assert.equal(models.find((m) => m.id === "qwen3.8-max").enabled, true);
    assert.equal(models.find((m) => m.id === "other-model").enabled, false);
    assert.equal(models.find((m) => m.id === "other-model").pool, null);
    assert.equal(JSON.stringify(cache).includes(SECRET), false);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("providers 摘要只有 hasKey，并带出计费、地址和模型能力", () => {
  const cfg = runtimeCfg({ modelCaps: { "qwen3.8-max": { vision: true } } });
  const item = summarizeProvider(cfg, "maas", cfg.providers.maas, { maas: SECRET });
  assert.equal(item.hasKey, true);
  assert.equal(item.billing, "metered");
  assert.deepEqual(item.endpoint, { baseUrl: "https://example.test" });
  assert.deepEqual(item.modelCaps, { "qwen3.8-max": { vision: true } });
  assert.equal(JSON.stringify(item).includes(SECRET), false);
  const grok = summarizeProvider(defaultCfg, "grok", defaultCfg.providers.grok, { grok: SECRET });
  assert.equal(grok.hasKey, false);
  assert.equal(grok.billing, undefined);
});

test("endpoint 模板写入白名单、环境、命令、档位和路由；重复添加和增删模型不产生重复；删除厂商清干净", () => {
  const env = makeHome();
  const beforeSecrets = realSecretsStamp();
  const spec = {
    preset: "endpoint",
    name: "maas",
    label: "国产模型（自定义接口）",
    baseUrl: "https://model-api.maas.com.cn/v1/",
    models: MAAS_MODELS,
  };
  try {
    const added = runRelay(env.state, ["provider", "add", "--json-spec", JSON.stringify(spec)]);
    assert.equal(added.status, 0, added.stderr);
    const cfg = readCfg(env.state);
    const prov = cfg.providers.maas;
    assert.equal(prov.billing, "metered");
    assert.deepEqual(prov.endpoint, { baseUrl: "https://model-api.maas.com.cn", secret: "maas" });
    assert.deepEqual(prov.pools, { maas: MAAS_MODELS });
    assert.deepEqual(prov.env, {
      ANTHROPIC_BASE_URL: "{baseUrl}",
      ANTHROPIC_API_KEY: "{secret}",
      ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4.1-flash-1017",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      MAX_THINKING_TOKENS: "32000",
    });
    assert.deepEqual(prov.envUnset, ["ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);
    assert.deepEqual(prov.cli, presets.endpoint.cli);
    assert.deepEqual(prov.caps, { web: false, exec: false, vision: false });
    assert.deepEqual(prov.modelList, { format: "openai-http" });
    assert.equal(prov.defaultModels.maas, "deepseek-v4-pro-0813");
    const wantTiers = Object.fromEntries(MAAS_MODELS.map((id) => [`maas:${id}`, /flash|lite/i.test(id) ? "light" : "mid"]));
    for (const [key, tier] of Object.entries(wantTiers)) assert.equal(cfg.modelTiers[key], tier);
    const wantRoutes = expectedRoutes();
    for (const [role, lines] of Object.entries(wantRoutes)) {
      assert.deepEqual(maasRoutes(cfg.routes, role), lines);
      const own = cfg.routes[role].filter((entry) => !String(entry).startsWith("maas:"));
      assert.deepEqual(cfg.routes[role].slice(0, own.length), own);
    }
    assert.equal(maasRoutes(cfg.routes, "claude-backup").length, 0);

    const again = runRelay(env.state, ["provider", "add", "--json-spec", JSON.stringify(spec)]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /已存在/);
    assert.deepEqual(maasRoutes(readCfg(env.state).routes, "implement"), wantRoutes.implement);

    const listed = runRelay(env.state, ["provider", "models", "maas"]);
    assert.equal(listed.status, 0, listed.stderr);
    for (const id of MAAS_MODELS) assert.match(listed.stdout, new RegExp(id));

    const removed = runRelay(env.state, ["provider", "models", "maas", "--remove", "deepseek-v4.1-flash-1017"]);
    assert.equal(removed.status, 0, removed.stderr);
    let next = readCfg(env.state);
    assert.equal(next.providers.maas.pools.maas.includes("deepseek-v4.1-flash-1017"), false);
    assert.equal(next.modelTiers["maas:deepseek-v4.1-flash-1017"], undefined);
    assert.equal(JSON.stringify(next.routes).includes("deepseek-v4.1-flash-1017"), false);
    assert.equal(next.providers.maas.env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
    assert.deepEqual(maasRoutes(next.routes, "implement"), MAAS_MIDS.map((id) => routeLine(id, 0.75)));

    const extra = "extra-lite-9";
    assert.equal(runRelay(env.state, ["provider", "models", "maas", "--add", extra]).status, 0);
    assert.equal(runRelay(env.state, ["provider", "models", "maas", "--add", extra]).status, 0);
    next = readCfg(env.state);
    assert.equal(next.providers.maas.pools.maas.filter((id) => id === extra).length, 1);
    assert.equal(next.modelTiers[`maas:${extra}`], "light");
    assert.equal(next.providers.maas.env.ANTHROPIC_SMALL_FAST_MODEL, extra);
    assert.equal(maasRoutes(next.routes, "implement").filter((entry) => entry.includes(extra)).length, 1);
    assert.equal(maasRoutes(next.routes, "review").filter((entry) => entry.includes(extra)).length, 1);
    assert.equal(maasRoutes(next.routes, "read").filter((entry) => entry.includes(extra)).length, 1);
    assert.equal(maasRoutes(next.routes, "quick").filter((entry) => entry.endsWith(`${extra}:0.8`)).length, 1);
    assert.equal(maasRoutes(next.routes, "debug").filter((entry) => entry.includes(extra)).length, 0);
    assert.equal(maasRoutes(next.routes, "deep").filter((entry) => entry.includes(extra)).length, 0);

    next.modelTiers["grok:grok-4.7"] = "mid";
    fs.writeFileSync(path.join(env.state, "providers.json"), JSON.stringify(next, null, 2) + "\n");
    const gone = runRelay(env.state, ["provider", "remove", "maas"]);
    assert.equal(gone.status, 0, gone.stderr);
    const left = readCfg(env.state);
    assert.equal(left.providers.maas, undefined);
    assert.equal(JSON.stringify(left.routes).includes("maas:"), false);
    assert.equal(Object.keys(left.modelTiers).some((key) => key.startsWith("maas:")), false);
    assert.equal(left.modelTiers["grok:grok-4.7"], "mid");
    assert.equal(left.providers.grok.label, defaultCfg.providers.grok.label);
  } finally {
    assert.equal(realSecretsStamp(), beforeSecrets);
    env.cleanup();
  }
});

test("密钥从标准输入写入且权限是 600，命令参数会被拒绝，--clear 能删，输出只有 hasKey", () => {
  const env = makeHome();
  const beforeSecrets = realSecretsStamp();
  const spec = {
    preset: "endpoint",
    name: "maas",
    label: "国产模型（自定义接口）",
    baseUrl: "https://example.test",
    models: ["qwen3.8-max"],
  };
  try {
    assert.equal(runRelay(env.state, ["provider", "add", "--json-spec", JSON.stringify(spec)]).status, 0);
    const rejected = runRelay(env.state, ["provider", "key", "maas", SECRET]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /不能把密钥写在命令/);
    assert.equal(rejected.stdout.includes(SECRET), false);
    const rejectedDash = runRelay(env.state, ["provider", "key", "maas", "--", SECRET]);
    assert.notEqual(rejectedDash.status, 0);
    assert.equal(fs.existsSync(path.join(env.state, "secrets.json")), false);

    const saved = runRelay(env.state, ["provider", "key", "maas", "--stdin"], { input: `${SECRET}\n` });
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(saved.stdout.includes(SECRET), false);
    const file = path.join(env.state, "secrets.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).maas, SECRET);

    const listed = runRelay(env.state, ["providers", "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout.includes(SECRET), false);
    const maas = JSON.parse(listed.stdout).providers.find((item) => item.name === "maas");
    assert.equal(maas.hasKey, true);
    assert.equal(maas.billing, "metered");
    assert.deepEqual(maas.endpoint, { baseUrl: "https://example.test" });
    assert.deepEqual(maas.modelCaps, { "qwen3.8-max": { vision: true } });
    assert.equal(maas.endpoint.secret, undefined);
    const rawCfg = fs.readFileSync(path.join(env.state, "providers.json"), "utf8");
    assert.equal(rawCfg.includes(SECRET), false);

    const status = runRelay(env.state, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    const maasLine = status.stdout.split("\n").find((line) => line.includes("[maas/maas]"));
    assert.match(maasLine, /按量计费/);
    assert.equal(maasLine.includes("额度未知"), false);
    const pick = runRelay(env.state, ["pick", "implement", "--level", "中等", "--provider", "maas"]);
    assert.equal(pick.status, 0, pick.stderr);
    assert.match(pick.stdout, /按量计费/);

    const secrets = JSON.parse(fs.readFileSync(file, "utf8"));
    secrets.other = "sk-other-000";
    fs.writeFileSync(file, JSON.stringify(secrets));
    const cleared = runRelay(env.state, ["provider", "key", "maas", "--clear"]);
    assert.equal(cleared.status, 0, cleared.stderr);
    const left = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(left.maas, undefined);
    assert.equal(left.other, "sk-other-000");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const after = JSON.parse(runRelay(env.state, ["providers", "--json"]).stdout);
    assert.equal(after.providers.find((item) => item.name === "maas").hasKey, false);
  } finally {
    assert.equal(realSecretsStamp(), beforeSecrets);
    env.cleanup();
  }
});

test("没有 env 的厂商不改子进程环境", () => {
  const resolved = resolveJobEnv(defaultCfg, { provider: "grok" }, { grok: SECRET });
  assert.equal(resolved.env, undefined);
  assert.equal(resolved.secret, "");
});
