// ai-relay 模型清单解析、归池、默认模型解析与校验单元测试
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveModel } from "./lib.mjs";
import {
  MODEL_CACHE_TTL_MS,
  parseCodexModels,
  parseAgyModels,
  parseGrokModels,
  assignPool,
  setProviderDefaultModel,
  cacheIsStale,
  refreshModels,
  getModels,
  modelsCachePath,
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

function makeFakeCli(dir, name, stdout, exitCode = 0) {
  const binPath = path.join(dir, name);
  const script = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${exitCode});\n`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

test("7. 厂商第一次拉取时所有模型 isNew 为 false；多池厂商匹配不上池的模型仍在输出里且 unpooled 为 true", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-models-first-"));
  try {
    const fakeAgy = makeFakeCli(
      stateDir,
      "fake-agy",
      [
        "gemini-4-argon-high\tGemini 4 Argon (High)",
        "mystery-experimental-v1\tMystery Experimental v1",
        "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      ].join("\n"),
    );
    const cfg = {
      providers: {
        agy: {
          cli: { bin: fakeAgy },
          pools: {
            "gemini-argon": ["gemini-4-argon-high"],
            gemini: ["gemini-3.8-flash-high"],
          },
          poolRules: [
            ["argon", "gemini-argon"],
            ["flash", "gemini"],
          ],
          modelList: { cmd: ["models"], format: "agy-table" },
        },
      },
    };
    const now = Date.parse("2026-11-14T12:00:00.000Z");
    const cache = await refreshModels(cfg, { stateDir, now });
    const models = cache.providers.agy.models;
    assert.equal(models.length, 3);
    // 第一次被拉取：全部模型記为老模型，isNew 为 false，顺序保持 CLI 原顺序
    assert.deepEqual(models.map((m) => m.id), [
      "gemini-4-argon-high",
      "mystery-experimental-v1",
      "gemini-3.8-flash-high",
    ]);
    for (const m of models) {
      assert.equal(m.isNew, false);
      assert.equal(m.firstSeen, "1970-01-01T00:00:00.000Z");
    }
    // 匹配不上池的模型仍在输出里，pool 为 null 且 unpooled 为 true
    const unpooled = models.find((m) => m.id === "mystery-experimental-v1");
    assert.equal(unpooled.pool, null);
    assert.equal(unpooled.unpooled, true);
    const pooled = models.find((m) => m.id === "gemini-4-argon-high");
    assert.equal(pooled.pool, "gemini-argon");
    assert.equal(pooled.unpooled, undefined);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("8. 老缓存（无 firstSeen）刷新后，原有模型 isNew 为 false，新出现的模型 isNew 为 true 且排在最前；超过 7 天后 isNew 变为 false", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-models-upgrade-"));
  try {
    // 写入升级前的老缓存（模型条目没有 firstSeen）
    const legacyCache = {
      updatedAt: "2026-11-01T00:00:00.000Z",
      providers: {
        grok: {
          ok: true,
          error: null,
          fetchedAt: "2026-11-01T00:00:00.000Z",
          cliDefault: "grok-4.6",
          models: [
            { id: "grok-4.6", label: "grok-4.6", pool: "supergrok-weekly" },
            { id: "grok-4.5", label: "grok-4.5", pool: "supergrok-weekly" },
          ],
        },
      },
    };
    fs.writeFileSync(modelsCachePath(stateDir), JSON.stringify(legacyCache, null, 2));

    // 本次 CLI 返回中，grok-4.7 和 grok-4.7-fast 是新模型（且位于列表中间/末尾）
    const fakeGrok = makeFakeCli(
      stateDir,
      "fake-grok",
      [
        "Default model: grok-4.6",
        "Available models:",
        "  - grok-4.6",
        "  - grok-4.7",
        "  - grok-4.5",
        "  - grok-4.7-fast",
      ].join("\n"),
    );
    const cfg = {
      providers: {
        grok: {
          cli: { bin: fakeGrok },
          pools: { "supergrok-weekly": ["default"] },
          modelList: { cmd: ["models"], format: "grok-list" },
        },
      },
    };

    const t1 = Date.parse("2026-11-10T00:00:00.000Z");
    const refreshed = await refreshModels(cfg, { stateDir, now: t1 });
    const models = refreshed.providers.grok.models;
    // 新模型排在最前面，各自内部保持 CLI 原有顺序
    assert.deepEqual(models.map((m) => m.id), [
      "grok-4.7",
      "grok-4.7-fast",
      "grok-4.6",
      "grok-4.5",
    ]);
    assert.equal(models[0].isNew, true);
    assert.equal(models[0].firstSeen, "2026-11-10T00:00:00.000Z");
    assert.equal(models[1].isNew, true);
    assert.equal(models[1].firstSeen, "2026-11-10T00:00:00.000Z");
    assert.equal(models[2].isNew, false);
    assert.equal(models[2].firstSeen, "1970-01-01T00:00:00.000Z");
    assert.equal(models[3].isNew, false);
    assert.equal(models[3].firstSeen, "1970-01-01T00:00:00.000Z");

    // 8 天后再次刷新（firstSeen 超过 7 天）：isNew 变为 false，顺序恢复 CLI 顺序
    const t2 = t1 + 8 * 24 * 3600_000;
    const after8d = await refreshModels(cfg, { stateDir, now: t2 });
    const modelsAfter = after8d.providers.grok.models;
    for (const m of modelsAfter) {
      assert.equal(m.isNew, false);
    }
    assert.equal(modelsAfter.find((m) => m.id === "grok-4.7").firstSeen, "2026-11-10T00:00:00.000Z");
    assert.deepEqual(modelsAfter.map((m) => m.id), [
      "grok-4.6",
      "grok-4.7",
      "grok-4.5",
      "grok-4.7-fast",
    ]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("9. 某厂商拉取失败时沿用上次清单和 firstSeen", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-models-fail-"));
  try {
    const t0 = Date.parse("2026-11-10T00:00:00.000Z");
    const prevCache = {
      updatedAt: "2026-11-10T00:00:00.000Z",
      providers: {
        grok: {
          ok: true,
          error: null,
          fetchedAt: "2026-11-10T00:00:00.000Z",
          cliDefault: "grok-4.7",
          firstSeen: {
            "grok-4.7": "2026-11-09T00:00:00.000Z",
            "grok-4.6": "1970-01-01T00:00:00.000Z",
          },
          models: [
            { id: "grok-4.7", label: "grok-4.7", pool: "supergrok-weekly", firstSeen: "2026-11-09T00:00:00.000Z", isNew: true },
            { id: "grok-4.6", label: "grok-4.6", pool: "supergrok-weekly", firstSeen: "1970-01-01T00:00:00.000Z", isNew: false },
          ],
        },
      },
    };
    fs.writeFileSync(modelsCachePath(stateDir), JSON.stringify(prevCache, null, 2));

    const failBin = makeFakeCli(stateDir, "fail-grok", "CLI crashed", 1);
    const cfg = {
      providers: {
        grok: {
          cli: { bin: failBin },
          pools: { "supergrok-weekly": ["default"] },
          modelList: { cmd: ["models"], format: "grok-list" },
        },
      },
    };

    const res = await refreshModels(cfg, { stateDir, now: t0 + 3600_000 });
    const g = res.providers.grok;
    assert.equal(g.ok, false);
    assert.match(g.error, /CLI crashed/);
    assert.equal(g.fetchedAt, "2026-11-10T00:00:00.000Z");
    assert.deepEqual(g.models.map((m) => ({ id: m.id, firstSeen: m.firstSeen, isNew: m.isNew })), [
      { id: "grok-4.7", firstSeen: "2026-11-09T00:00:00.000Z", isNew: true },
      { id: "grok-4.6", firstSeen: "1970-01-01T00:00:00.000Z", isNew: false },
    ]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("10. 缓存有效期为 6 小时：5 小时不算过期、7 小时算过期，getModels 返回的 stale 与 cacheIsStale 一致", async () => {
  assert.equal(MODEL_CACHE_TTL_MS, 6 * 3600_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-models-stale-"));
  try {
    let cliCalls = 0;
    const cfg = {
      providers: {
        maas: {
          endpoint: { baseUrl: "https://example.test", secret: "maas" },
          pools: { maas: ["qwen3.8-max"] },
          modelList: { format: "openai-http" },
        },
      },
    };
    const t0 = Date.parse("2026-11-14T00:00:00.000Z");
    const fetchImpl = async () => {
      cliCalls++;
      return {
        ok: true,
        async text() {
          return JSON.stringify({ data: [{ id: "qwen3.8-max" }] });
        },
      };
    };

    const initial = await getModels(cfg, { stateDir, now: t0, secrets: { maas: "sk-fake" }, fetchImpl });
    assert.equal(cliCalls, 1);
    assert.equal(initial.stale, false);

    // 5 小时：不算过期
    const t5h = t0 + 5 * 3600_000;
    assert.equal(cacheIsStale(initial, t5h), false);
    const res5h = await getModels(cfg, { stateDir, now: t5h, secrets: { maas: "sk-fake" }, fetchImpl });
    assert.equal(cliCalls, 1);
    assert.equal(res5h.stale, false);

    // 7 小时：算过期。allowStale 时先返回旧缓存且 stale 为 true，不拉取
    const t7h = t0 + 7 * 3600_000;
    assert.equal(cacheIsStale(initial, t7h), true);
    const res7h = await getModels(cfg, { stateDir, now: t7h, allowStale: true, secrets: { maas: "sk-fake" }, fetchImpl });
    assert.equal(cliCalls, 1);
    assert.equal(res7h.stale, true);
    // 不带 allowStale 时过期会自动重新拉取，不点刷新也能看到新模型
    const auto7h = await getModels(cfg, { stateDir, now: t7h, secrets: { maas: "sk-fake" }, fetchImpl });
    assert.equal(cliCalls, 2);
    assert.equal(auto7h.stale, false);

    // 传 refresh: true 时触发刷新，stale 变回 false
    const refreshed = await getModels(cfg, { stateDir, refresh: true, now: t7h, secrets: { maas: "sk-fake" }, fetchImpl });
    assert.equal(cliCalls, 3);
    assert.equal(refreshed.stale, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
