// Gemini 4 Neon：归池、档位、路由与旧配置升级
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateModelFields } from "./lib.mjs";
import { assignPool } from "./models.mjs";
import { modelTier, maxVariant } from "./score.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const DEF = JSON.parse(fs.readFileSync(path.join(dir, "../config/providers.default.json"), "utf8"));

// 0.25 的配置：已有 Hydrogen，没有 Neon
function oldCfg() {
  const cfg = structuredClone(DEF);
  const agy = cfg.providers.agy;
  agy.pools.gemini = agy.pools.gemini.filter((m) => !/neon/.test(m));
  agy.poolRules = agy.poolRules.filter((r) => r[0] !== "neon");
  agy.poolLabels.gemini = "Gemini Hydrogen / Flash";
  for (const role of Object.keys(cfg.routes)) cfg.routes[role] = cfg.routes[role].filter((e) => !/neon/.test(e));
  cfg.migrated = ["max-thinking", "gemini-hydrogen"];
  return cfg;
}

test("Neon 和 Orchestrator (Neon) 归入 gemini 池（官方与 Hydrogen / Flash 同一额度组）", () => {
  const agy = DEF.providers.agy;
  for (const id of ["gemini-4-neon-xhigh", "gemini-4-neon-low", "gemini-pro-orchestrator-neon"]) assert.equal(assignPool(agy, id), "gemini");
  assert.equal(assignPool(agy, "gemini-4-hydrogen-xhigh"), "gemini");
  assert.equal(assignPool(agy, "gemini-4-argon-high"), "gemini-argon");
});

test("Neon 高思考档是强档，低档是中档；maxVariant 返回最高档 xhigh", () => {
  assert.equal(modelTier(DEF, "agy", "gemini-4-neon-xhigh"), "strong");
  assert.equal(modelTier(DEF, "agy", "gemini-4-neon-high"), "strong");
  assert.equal(modelTier(DEF, "agy", "gemini-4-neon-medium"), "mid");
  assert.equal(modelTier(DEF, "agy", "gemini-4-neon-low"), "mid");
  assert.equal(modelTier(DEF, "agy", "gemini-4-hydrogen-xhigh"), "light");
  assert.equal(maxVariant(DEF, "agy", "gemini", "gemini-4-neon-low"), "gemini-4-neon-xhigh");
});

test("默认路由：七个角色都有 Neon，快问里它排在轻档之后", () => {
  for (const role of ["implement", "debug", "review", "read", "deep", "claude-backup"]) {
    assert.ok(DEF.routes[role].some((e) => e.startsWith("agy:gemini:gemini-4-neon-xhigh:")), role);
  }
  assert.equal(DEF.routes.quick[0], "agy:gemini:default");
  assert.ok(DEF.routes.quick.includes("agy:gemini:gemini-4-neon-xhigh:0.7"));
  // gemini 池默认模型仍是 Hydrogen（便宜的轻档留给简单活）
  assert.equal(DEF.providers.agy.defaultModels.gemini, "gemini-4-hydrogen-xhigh");
});

test("旧配置升级：补 Neon 模型、归池规则（在 flash 之前）、池名和路由，用户自加的路由保留", () => {
  const cfg = oldCfg();
  cfg.routes.implement.push("maas:maas:glm-5.3:0.75");
  assert.equal(migrateModelFields(cfg, DEF), true);
  const agy = cfg.providers.agy;
  assert.deepEqual(agy.pools.gemini.slice(0, 4), ["gemini-4-neon-xhigh", "gemini-4-neon-high", "gemini-4-neon-medium", "gemini-4-neon-low"]);
  const rules = agy.poolRules.map((r) => r[0]);
  assert.ok(rules.indexOf("neon") >= 0 && rules.indexOf("neon") < rules.indexOf("flash"));
  assert.equal(agy.poolLabels.gemini, "Gemini Neon / Hydrogen / Flash");
  assert.ok(cfg.routes.implement.includes("agy:gemini:gemini-4-neon-xhigh:0.9"));
  assert.ok(cfg.routes.implement.includes("maas:maas:glm-5.3:0.75"));
  assert.ok(cfg.routes.deep.includes("agy:gemini:gemini-4-neon-xhigh:0.95"));
  assert.deepEqual(cfg.migrated, ["max-thinking", "gemini-hydrogen", "gemini-neon", "read-route-0.27", "quick-route-0.28", "effort-args-0.29"]);
});

test("升级只做一次：用户删掉的 Neon 路由不加回；已有 Neon 路由（擅长度不同）不重复加", () => {
  const cfg = oldCfg();
  cfg.routes.review.push("agy:gemini:gemini-4-neon-xhigh:0.5");
  migrateModelFields(cfg, DEF);
  assert.equal(cfg.routes.review.filter((e) => /neon/.test(e)).length, 1);
  assert.ok(cfg.routes.review.includes("agy:gemini:gemini-4-neon-xhigh:0.5"));

  cfg.routes.implement = cfg.routes.implement.filter((e) => !/neon/.test(e));
  assert.equal(migrateModelFields(cfg, DEF), false);
  assert.ok(!cfg.routes.implement.some((e) => /neon/.test(e)));
});

test("用户改过池名不覆盖；新默认配置升级不改动", () => {
  const cfg = oldCfg();
  cfg.providers.agy.poolLabels.gemini = "我的 Gemini";
  migrateModelFields(cfg, DEF);
  assert.equal(cfg.providers.agy.poolLabels.gemini, "我的 Gemini");

  const fresh = structuredClone(DEF);
  migrateModelFields(fresh, DEF);
  assert.equal(fresh.providers.agy.pools.gemini.filter((m) => m === "gemini-4-neon-xhigh").length, 1);
  assert.equal(fresh.providers.agy.poolRules.filter((r) => r[0] === "neon").length, 1);
  for (const role of Object.keys(DEF.routes)) assert.deepEqual(fresh.routes[role], DEF.routes[role]);
});
