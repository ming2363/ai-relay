// ai-relay 模型清单解析、归池、默认模型解析与校验单元测试
import test from "node:test";
import assert from "node:assert/strict";
import { resolveModel } from "./lib.mjs";
import {
  parseCodexModels,
  parseAgyModels,
  parseGrokModels,
  assignPool,
  setProviderDefaultModel,
} from "./models.mjs";

test("1. parseCodexModels：只取 visibility == 'list'，按 priority 升序，并解析 config.toml 顶层 model", () => {
  const sampleJson = JSON.stringify({
    models: [
      { slug: "gpt-6.1-terra", display_name: "GPT-6.1-Terra", visibility: "list", priority: 2 },
      { slug: "gpt-internal", display_name: "Internal", visibility: "hidden", priority: 0 },
      { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", priority: 1 },
      { slug: "spark", display_name: "Spark", visibility: "list", priority: 3 },
    ],
  });
  const sampleToml = `
# Codex 配置
model = "gpt-6.1-sol"

[projects."/tmp/demo"]
model = "should-not-use-section-model"
`;
  const res = parseCodexModels(sampleJson, sampleToml);
  assert.equal(res.cliDefault, "gpt-6.1-sol");
  assert.deepEqual(res.models, [
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
    { id: "gpt-6.1-terra", label: "GPT-6.1-Terra" },
    { id: "spark", label: "Spark" },
  ]);

  // 无 config.toml 时 cliDefault 为 null
  assert.equal(parseCodexModels(sampleJson, "").cliDefault, null);
});

test("2. parseAgyModels：跳过 Fetching available models... 行，解析 tab 或多空格分隔的 id 与显示名", () => {
  const sample = [
    "Fetching available models...",
    "gemini-4-argon-high\tGemini 4 Argon (High)",
    "gemini-3.8-flash-high     Gemini 3.8 Flash (High)",
    "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
  ].join("\n");
  const res = parseAgyModels(sample);
  assert.equal(res.cliDefault, null);
  assert.deepEqual(res.models, [
    { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
  ]);
});

test("3. parseGrokModels：解析 Default model 行与 - / * 模型列表，去掉 (default)，label 用 id", () => {
  const sample = `You are logged in with grok.com.

Default model: grok-4.7-build-fast

Available models:
  - grok-4.7
  * grok-4.7-build-fast (default)
  - grok-4.6
`;
  const res = parseGrokModels(sample);
  assert.equal(res.cliDefault, "grok-4.7-build-fast");
  assert.deepEqual(res.models, [
    { id: "grok-4.7", label: "grok-4.7" },
    { id: "grok-4.7-build-fast", label: "grok-4.7-build-fast" },
    { id: "grok-4.6", label: "grok-4.6" },
  ]);
});

test("4. assignPool：单池厂商全部归该池；多池厂商按 poolRules 顺序取首个命中，未命中为 null", () => {
  const grokProv = {
    pools: { "supergrok-weekly": ["default"] },
  };
  assert.equal(assignPool(grokProv, "grok-4.7"), "supergrok-weekly");
  assert.equal(assignPool(grokProv, "any-other-model"), "supergrok-weekly");

  const agyProv = {
    pools: {
      "gemini-argon": ["gemini-4-argon-high"],
      "claude-gpt": ["claude-opus-5-5-high"],
      gemini: ["gemini-3.8-flash-high"],
    },
    poolRules: [
      ["argon", "gemini-argon"],
      ["flash", "gemini"],
      ["^(claude|gpt)", "claude-gpt"],
    ],
  };
  assert.equal(assignPool(agyProv, "gemini-4-argon-high"), "gemini-argon");
  assert.equal(assignPool(agyProv, "gemini-3.8-flash-medium"), "gemini");
  assert.equal(assignPool(agyProv, "claude-sonnet-5-5-high"), "claude-gpt");
  assert.equal(assignPool(agyProv, "gpt-oss-120b-medium"), "claude-gpt");
  assert.equal(assignPool(agyProv, "unknown-experimental-1"), null);
});

test("5. resolveModel：model 为 default 且 defaultModels[pool] 有值时返回默认模型，否则原样返回", () => {
  const cfg = {
    providers: {
      agy: {
        defaultModels: {
          "gemini-argon": "gemini-4-argon-high",
          "claude-gpt": "claude-opus-5-5-high",
        },
      },
      grok: {},
    },
  };
  assert.equal(resolveModel(cfg, "agy", "gemini-argon", "default"), "gemini-4-argon-high");
  assert.equal(resolveModel(cfg, "agy", "gemini-argon", "gemini-4-argon-medium"), "gemini-4-argon-medium");
  assert.equal(resolveModel(cfg, "grok", "supergrok-weekly", "default"), "default");
});

test("6. provider model 校验：多池厂商写 default 报错、pool 不对报错、模型不归属该池报错、合法设置成功", () => {
  const cfg = {
    providers: {
      agy: {
        pools: {
          "gemini-argon": ["gemini-4-argon-high", "gemini-4-argon-medium"],
          "claude-gpt": ["claude-opus-5-5-high"],
          gemini: ["gemini-3.8-flash-high"],
        },
        poolRules: [
          ["argon", "gemini-argon"],
          ["flash", "gemini"],
          ["^(claude|gpt)", "claude-gpt"],
        ],
        defaultModels: {
          "gemini-argon": "gemini-4-argon-high",
          "claude-gpt": "claude-opus-5-5-high",
          gemini: "gemini-3.8-flash-high",
        },
      },
      grok: {
        pools: {
          "supergrok-weekly": ["default"],
        },
      },
    },
  };
  const modelsCache = {
    providers: {
      grok: {
        ok: true,
        models: [
          { id: "grok-4.7", label: "grok-4.7", pool: "supergrok-weekly" },
          { id: "grok-4.7-build-fast", label: "grok-4.7-build-fast", pool: "supergrok-weekly" },
        ],
      },
      agy: {
        ok: true,
        models: [
          { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)", pool: "gemini-argon" },
          { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)", pool: "gemini-argon" },
          { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)", pool: "claude-gpt" },
        ],
      },
    },
  };

  // 多池厂商写 default 报错
  assert.throws(
    () => setProviderDefaultModel(cfg, "agy", "gemini-argon", "default", modelsCache),
    /多个额度池.*不能设为 default/,
  );

  // pool 不属于该厂商报错
  assert.throws(
    () => setProviderDefaultModel(cfg, "grok", "wrong-pool", "grok-4.7", modelsCache),
    /没有额度池 wrong-pool/,
  );

  // 模型属于别的池时报错
  assert.throws(
    () => setProviderDefaultModel(cfg, "agy", "gemini-argon", "claude-opus-5-5-high", modelsCache),
    /属于额度池 claude-gpt/,
  );

  // 单池厂商设置模型清单中的模型成功，再写 default 删除该键
  setProviderDefaultModel(cfg, "grok", "supergrok-weekly", "grok-4.7", modelsCache);
  assert.equal(cfg.providers.grok.defaultModels?.["supergrok-weekly"], "grok-4.7");

  setProviderDefaultModel(cfg, "grok", "supergrok-weekly", "default", modelsCache);
  assert.equal(cfg.providers.grok.defaultModels?.["supergrok-weekly"], undefined);
});

// 旧配置升级：补齐模型字段，只在刚补 defaultModels 时把与默认相同的路由条目改写为 default
test("migrateModelFields 升级旧配置", async () => {
  const { migrateModelFields } = await import("./lib.mjs");
  const def = {
    providers: { agy: { modelList: { cmd: ["models"], format: "agy-table" }, defaultModels: { argon: "a-high" } } },
  };
  const cfg = {
    providers: { agy: { pools: { argon: ["a-high", "a-medium"] } } },
    routes: { deep: ["agy:argon:a-high:0.9"], read: ["agy:argon:a-medium"] },
  };
  assert.equal(migrateModelFields(cfg, def), true);
  assert.deepEqual(cfg.providers.agy.defaultModels, { argon: "a-high" });
  assert.deepEqual(cfg.routes.deep, ["agy:argon:default:0.9"]);
  assert.deepEqual(cfg.routes.read, ["agy:argon:a-medium"]);
  // 第二次加载：字段已在，不再改写（用户改了默认模型也不会吞掉单独指定的条目）
  cfg.providers.agy.defaultModels.argon = "a-medium";
  assert.equal(migrateModelFields(cfg, def), false);
  assert.deepEqual(cfg.routes.read, ["agy:argon:a-medium"]);
});
