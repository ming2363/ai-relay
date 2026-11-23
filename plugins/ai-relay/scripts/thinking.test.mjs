// 思考一律最高与 Gemini Hydrogen 的旧配置升级
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateModelFields } from "./lib.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const DEF = JSON.parse(fs.readFileSync(path.join(dir, "../config/providers.default.json"), "utf8"));

// 0.23 及以前的配置：没有 Hydrogen、Grok 没有固定参数、自定义接口没有思考预算
function oldCfg() {
  const cfg = structuredClone(DEF);
  delete cfg.providers.grok.cli.alwaysArgs;
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

test("旧配置升级：Grok 补 --reasoning-effort xhigh，自定义接口补思考预算，Hydrogen 进 gemini 池并成为默认", () => {
  const cfg = oldCfg();
  assert.equal(migrateModelFields(cfg, DEF), true);
  assert.deepEqual(cfg.providers.grok.cli.alwaysArgs, ["--reasoning-effort", "xhigh"]);
  assert.equal(cfg.providers.maas.env.MAX_THINKING_TOKENS, "32000");
  const agy = cfg.providers.agy;
  assert.deepEqual(agy.pools.gemini.slice(0, 4), ["gemini-4-hydrogen-xhigh", "gemini-4-hydrogen-high", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-low"]);
  assert.ok(agy.pools.gemini.includes("gemini-3.8-flash-high"));
  const rules = agy.poolRules.map((r) => r[0]);
  assert.ok(rules.indexOf("hydrogen") >= 0 && rules.indexOf("hydrogen") < rules.indexOf("flash"));
  assert.equal(agy.defaultModels.gemini, "gemini-4-hydrogen-xhigh");
  assert.equal(agy.poolLabels.gemini, "Gemini Neon / Hydrogen / Flash");
  assert.ok(cfg.routes.quick.includes("agy:gemini:default"));
  assert.deepEqual(cfg.migrated, ["max-thinking", "gemini-hydrogen", "gemini-neon", "read-route-0.27"]);
});

test("旧配置升级只做一次：用户改过的默认模型不覆盖，升级后删掉的不再加回", () => {
  const cfg = oldCfg();
  cfg.providers.agy.defaultModels.gemini = "gemini-3.8-flash-low";
  cfg.routes.quick = ["agy:gemini:gemini-3.8-flash-low"];
  migrateModelFields(cfg, DEF);
  assert.equal(cfg.providers.agy.defaultModels.gemini, "gemini-3.8-flash-low");
  assert.deepEqual(cfg.routes.quick, ["agy:gemini:gemini-3.8-flash-low"]);

  cfg.providers.agy.pools.gemini = cfg.providers.agy.pools.gemini.filter((m) => !/hydrogen/.test(m));
  cfg.providers.grok.cli.alwaysArgs = [];
  delete cfg.providers.maas.env.MAX_THINKING_TOKENS;
  assert.equal(migrateModelFields(cfg, DEF), false);
  assert.ok(!cfg.providers.agy.pools.gemini.some((m) => /hydrogen/.test(m)));
  assert.deepEqual(cfg.providers.grok.cli.alwaysArgs, []);
  assert.equal(cfg.providers.maas.env.MAX_THINKING_TOKENS, undefined);
});

test("已经手动加过 Hydrogen 的配置：不重复加模型和规则", () => {
  const cfg = structuredClone(DEF);
  migrateModelFields(cfg, DEF);
  const agy = cfg.providers.agy;
  assert.equal(agy.pools.gemini.filter((m) => m === "gemini-4-hydrogen-xhigh").length, 1);
  assert.equal(agy.poolRules.filter((r) => r[0] === "hydrogen").length, 1);
});
