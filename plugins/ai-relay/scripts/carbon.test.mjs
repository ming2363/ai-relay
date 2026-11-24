// Gemini 4 Carbon：归池、档位、路由与旧配置升级
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateModelFields } from "./lib.mjs";
import { assignPool } from "./models.mjs";
import { modelTier, maxVariant, pickVariant } from "./score.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const DEF = JSON.parse(fs.readFileSync(path.join(dir, "../config/providers.default.json"), "utf8"));

const EXPECTED_CARBON_ROUTES = {
  implement: "agy:gemini:gemini-4-carbon-high:0.92",
  debug: "agy:gemini:gemini-4-carbon-high:0.9",
  review: "agy:gemini:gemini-4-carbon-high:0.9",
  read: "agy:gemini:gemini-4-carbon-high:0.85",
  deep: "agy:gemini:gemini-4-carbon-high:0.95",
  "claude-backup": "agy:gemini:gemini-4-carbon-high:0.9",
};

// 0.29 的配置：已有 Neon 和 effort-args-0.29，没有 Carbon
function oldCfg() {
  const cfg = structuredClone(DEF);
  const agy = cfg.providers.agy;
  agy.pools.gemini = agy.pools.gemini.filter((m) => !/carbon/i.test(m));
  agy.poolRules = agy.poolRules.filter((r) => !/carbon/i.test(String(r[0])));
  for (const role of Object.keys(cfg.routes)) {
    cfg.routes[role] = cfg.routes[role].filter((e) => !/carbon/i.test(e));
  }
  cfg.migrated = ["max-thinking", "gemini-hydrogen", "gemini-neon", "read-route-0.27", "quick-route-0.28", "effort-args-0.29"];
  return cfg;
}

test("Carbon 归入 gemini 池，且归池规则位于 flash 之前", () => {
  const agy = DEF.providers.agy;
  for (const id of ["gemini-4-carbon-high", "gemini-4-carbon-medium", "gemini-4-carbon-low"]) {
    assert.equal(assignPool(agy, id), "gemini");
    assert.ok(agy.pools.gemini.includes(id), id);
  }
  const rules = agy.poolRules.map((r) => r[0]);
  assert.ok(rules.indexOf("carbon") >= 0 && rules.indexOf("carbon") < rules.indexOf("flash"));
});

test("Carbon 档位与选档：high 为强档，medium/low 为中档；最高档为 high（无 xhigh）", () => {
  assert.equal(modelTier(DEF, "agy", "gemini-4-carbon-high"), "strong");
  assert.equal(modelTier(DEF, "agy", "gemini-4-carbon-medium"), "mid");
  assert.equal(modelTier(DEF, "agy", "gemini-4-carbon-low"), "mid");
  // 自动探测写入 agy:gemini-4-carbon* 时，中低档仍按最长匹配保持中档
  const probed = { ...DEF, modelTiers: { "agy:gemini-4-carbon*": "strong" } };
  assert.equal(modelTier(probed, "agy", "gemini-4-carbon-high"), "strong");
  assert.equal(modelTier(probed, "agy", "gemini-4-carbon-medium"), "mid");
  assert.equal(modelTier(probed, "agy", "gemini-4-carbon-low"), "mid");

  assert.equal(maxVariant(DEF, "agy", "gemini", "gemini-4-carbon-low"), "gemini-4-carbon-high");
  assert.equal(pickVariant(DEF, "agy", "gemini", "gemini-4-carbon-high", "xhigh"), "gemini-4-carbon-high");
  assert.equal(pickVariant(DEF, "agy", "gemini", "gemini-4-carbon-high", "medium"), "gemini-4-carbon-medium");
});

test("默认路由：六个角色含 Carbon 且擅长度正确，quick 不含 Carbon", () => {
  for (const [role, expected] of Object.entries(EXPECTED_CARBON_ROUTES)) {
    assert.ok(DEF.routes[role].includes(expected), `${role} 应包含 ${expected}`);
  }
  assert.ok(!DEF.routes.quick.some((e) => /carbon/i.test(e)));
});

test("旧配置升级（无 Carbon）：补齐 gemini 池三档、归池规则和六个角色路由，保留用户自加路由", () => {
  const cfg = oldCfg();
  cfg.routes.implement.push("maas:maas:glm-5.3:0.75");
  assert.equal(migrateModelFields(cfg, DEF), true);

  const agy = cfg.providers.agy;
  assert.deepEqual(agy.pools.gemini.slice(0, 3), [
    "gemini-4-carbon-high",
    "gemini-4-carbon-medium",
    "gemini-4-carbon-low",
  ]);
  const rules = agy.poolRules.map((r) => r[0]);
  assert.ok(rules.indexOf("carbon") >= 0 && rules.indexOf("carbon") < rules.indexOf("flash"));

  for (const [role, expected] of Object.entries(EXPECTED_CARBON_ROUTES)) {
    assert.ok(cfg.routes[role].includes(expected), `${role} 迁移后应包含 ${expected}`);
  }
  assert.ok(!cfg.routes.quick.some((e) => /carbon/i.test(e)));
  assert.ok(cfg.routes.implement.includes("maas:maas:glm-5.3:0.75"));
  assert.deepEqual(cfg.migrated, [
    "max-thinking",
    "gemini-hydrogen",
    "gemini-neon",
    "read-route-0.27",
    "quick-route-0.28",
    "effort-args-0.29",
    "gemini-carbon-0.30",
  ]);
});

test("已有自动探测写入的 Carbon 规则和路由：迁移后不重复添加", () => {
  const cfg = oldCfg();
  const agy = cfg.providers.agy;
  // 模拟自动探测已写入 gemini-4-carbon 规则、池模型、部分角色不同擅长度/档位路由及 modelTiers
  agy.poolRules.unshift(["gemini-4-carbon", "gemini"]);
  agy.pools.gemini.push("gemini-4-carbon-high", "gemini-4-carbon-medium", "gemini-4-carbon-low");
  cfg.modelTiers = { "agy:gemini-4-carbon*": "strong" };
  cfg.routes.implement.push("agy:gemini:gemini-4-carbon-high:0.88");
  cfg.routes.debug.push("agy:gemini:gemini-4-carbon-medium:0.8");
  cfg.routes.review.push("agy:gemini:gemini-4-carbon-high:0.85");
  cfg.routes.read.push("agy:gemini:gemini-4-carbon-high:0.8");
  cfg.routes.deep.push("agy:gemini:gemini-4-carbon-high:0.9");
  cfg.routes["claude-backup"].push("agy:gemini:gemini-4-carbon-high:0.85");

  assert.equal(migrateModelFields(cfg, DEF), true);
  assert.equal(agy.poolRules.filter((r) => /carbon/i.test(String(r[0]))).length, 1);
  assert.equal(agy.poolRules[0][0], "gemini-4-carbon");
  assert.equal(agy.pools.gemini.filter((m) => m === "gemini-4-carbon-high").length, 1);
  assert.equal(agy.pools.gemini.filter((m) => m === "gemini-4-carbon-medium").length, 1);
  assert.equal(agy.pools.gemini.filter((m) => m === "gemini-4-carbon-low").length, 1);

  for (const role of Object.keys(EXPECTED_CARBON_ROUTES)) {
    assert.equal(cfg.routes[role].filter((e) => /:gemini-4-carbon/i.test(e)).length, 1, `${role} 不应重复添加`);
  }
  assert.ok(cfg.routes.implement.includes("agy:gemini:gemini-4-carbon-high:0.88"));
  assert.ok(cfg.routes.debug.includes("agy:gemini:gemini-4-carbon-medium:0.8"));
  assert.ok(!cfg.routes.quick.some((e) => /carbon/i.test(e)));
  assert.ok(cfg.migrated.includes("gemini-carbon-0.30"));
});

test("升级只做一次：用户删掉的 Carbon 池模型、规则和路由不再加回；新默认配置升级不重复", () => {
  const cfg = oldCfg();
  assert.equal(migrateModelFields(cfg, DEF), true);

  // 模拟用户手动删除 Carbon 条目
  cfg.providers.agy.pools.gemini = cfg.providers.agy.pools.gemini.filter((m) => !/carbon/i.test(m));
  cfg.providers.agy.poolRules = cfg.providers.agy.poolRules.filter((r) => !/carbon/i.test(String(r[0])));
  cfg.routes.implement = cfg.routes.implement.filter((e) => !/carbon/i.test(e));
  cfg.routes.deep = cfg.routes.deep.filter((e) => !/carbon/i.test(e));

  assert.equal(migrateModelFields(cfg, DEF), false);
  assert.ok(!cfg.providers.agy.pools.gemini.some((m) => /carbon/i.test(m)));
  assert.ok(!cfg.providers.agy.poolRules.some((r) => /carbon/i.test(String(r[0]))));
  assert.ok(!cfg.routes.implement.some((e) => /carbon/i.test(e)));
  assert.ok(!cfg.routes.deep.some((e) => /carbon/i.test(e)));

  // 新默认配置升级不重复添加
  const fresh = structuredClone(DEF);
  migrateModelFields(fresh, DEF);
  assert.equal(fresh.providers.agy.pools.gemini.filter((m) => m === "gemini-4-carbon-high").length, 1);
  assert.equal(fresh.providers.agy.poolRules.filter((r) => r[0] === "carbon").length, 1);
  for (const role of Object.keys(DEF.routes)) {
    assert.deepEqual(fresh.routes[role], DEF.routes[role]);
  }
});
