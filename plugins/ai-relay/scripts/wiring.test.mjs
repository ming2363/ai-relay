// 面板依赖的命令接线：relay stats、status --json 的 lastCycles、provider pool-rule；以及模型缓存按新规则重算归池、文档文件不计行数
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDocPath } from "./lib.mjs";
import { getModels } from "./models.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const relayPath = path.join(scriptsDir, "relay.mjs");
const defaultCfg = JSON.parse(fs.readFileSync(path.join(scriptsDir, "../config/providers.default.json"), "utf8"));

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-wiring-"));
  const state = path.join(home, "ai-relay");
  fs.mkdirSync(path.join(state, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(state, "rounds"), { recursive: true });
  const cfg = structuredClone(defaultCfg);
  cfg.quotaDb = "";
  fs.writeFileSync(path.join(state, "providers.json"), JSON.stringify(cfg, null, 2) + "\n");
  return { home, state, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function runRelay(state, args) {
  return spawnSync(process.execPath, [relayPath, ...args], {
    encoding: "utf8",
    cwd: scriptsDir,
    env: { PATH: process.env.PATH || "", HOME: path.dirname(state), AI_RELAY_HOME: state, LANG: "C", TMPDIR: process.env.TMPDIR || "/tmp" },
  });
}

const readCfg = (state) => JSON.parse(fs.readFileSync(path.join(state, "providers.json"), "utf8"));

test("relay stats --json：员工按可写外派改动行数，主管按轮次行数，外派按会话归到轮次", () => {
  const h = makeHome();
  try {
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const job = (id, extra) => fs.writeFileSync(path.join(h.state, "jobs", `${id}.json`), JSON.stringify({ id, provider: "agy", model: "m1", status: "done", task: "t", cwd: "/x", ...extra }));
    job("j1", { write: true, changedLines: 120, sessionId: "s1", startedAt: iso(now - 3600_000) });
    job("j2", { write: false, changedLines: 999, sessionId: "s1", startedAt: iso(now - 3500_000) });
    job("j3", { write: true, changedLines: 50, sessionId: "s1", startedAt: iso(now - 30 * 86400_000) });
    // 3 天前的：--days 7 要算进去（--days 是带值参数，不能被当成开关）
    job("j4", { write: true, changedLines: 10, sessionId: "s2", startedAt: iso(now - 3 * 86400_000) });
    fs.writeFileSync(path.join(h.state, "rounds", "s1.json"), JSON.stringify([
      { id: "r1", sessionId: "s1", startedAt: now - 4000_000, finishedAt: now - 3000_000, selfLines: 30 },
      { id: "r2", sessionId: "s1", startedAt: now - 2000_000, finishedAt: now - 1000_000, selfLines: 0 },
    ]));
    const r = runRelay(h.state, ["stats", "--json", "--days", "7"]);
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.workerLines, 130);
    assert.deepEqual(s.byWorker, { "agy/m1": 130 });
    assert.equal(s.selfLines, 30);
    assert.deepEqual(s.rounds, { edited: 1, withWriteDispatch: 1 });
    assert.equal(s.workerShare, 130 / 160);

    const text = runRelay(h.state, ["stats"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /近 7 天：员工 130 行（占比 81%），主管 30 行/);
    assert.notEqual(runRelay(h.state, ["stats", "--days", "0"]).status, 0);
  } finally {
    h.cleanup();
  }
});

test("relay status --json：额度窗口重置后带上个周期剩余 lastCycles", () => {
  const h = makeHome();
  try {
    const now = Date.now();
    const oldReset = now - 2 * 3600_000;
    const newReset = now + 3 * 3600_000;
    // 上一次采样：上个周期快结束时还剩 40%
    fs.writeFileSync(path.join(h.state, "quota-history.json"), JSON.stringify({
      last: { "antigravity|gemini|5h": { remaining: 0.4, resetAt: oldReset, at: oldReset - 3600_000 } },
      cycles: [],
    }));
    fs.writeFileSync(path.join(h.state, "quota-cache.json"), JSON.stringify({
      sources: {
        antigravity: {
          fetchedAt: new Date(now).toISOString(),
          rows: [{ provider: "antigravity", pool_id: "gemini", window_key: "5h", remaining_fraction: 0.9, reset_at: new Date(newReset).toISOString(), updated_at: new Date(now).toISOString() }],
        },
      },
    }));
    const r = runRelay(h.state, ["status", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const pool = out.pools.find((p) => p.name === "agy" && p.pool === "gemini");
    assert.deepEqual(pool.lastCycles, [{ window: "5h", leftover: 0.4, endedAt: oldReset, reliable: true }]);
    const other = out.pools.find((p) => p.name === "agy" && p.pool === "gemini-argon");
    assert.equal(other.lastCycles, undefined);
  } finally {
    h.cleanup();
  }
});

test("relay provider pool-rule：在最前面加只匹配这个模型的规则，重复指定会替换，池名和单池厂商要校验", () => {
  const h = makeHome();
  try {
    const ok = runRelay(h.state, ["provider", "pool-rule", "agy", "gemini-pro-orchestrator-g1.pro", "gemini"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /已归入额度池 gemini/);
    let rules = readCfg(h.state).providers.agy.poolRules;
    assert.deepEqual(rules[0], ["^gemini-pro-orchestrator-g1\\.pro$", "gemini"]);

    assert.equal(runRelay(h.state, ["provider", "pool-rule", "agy", "gemini-pro-orchestrator-g1.pro", "gemini-argon"]).status, 0);
    rules = readCfg(h.state).providers.agy.poolRules;
    assert.deepEqual(rules[0], ["^gemini-pro-orchestrator-g1\\.pro$", "gemini-argon"]);
    assert.equal(rules.filter((x) => x[0] === "^gemini-pro-orchestrator-g1\\.pro$").length, 1);

    const badPool = runRelay(h.state, ["provider", "pool-rule", "agy", "x-model", "nope"]);
    assert.notEqual(badPool.status, 0);
    assert.match(badPool.stderr, /没有额度池 nope/);
    const single = runRelay(h.state, ["provider", "pool-rule", "codex", "x-model", "codex"]);
    assert.notEqual(single.status, 0);
    assert.match(single.stderr, /只有一个额度池/);
  } finally {
    h.cleanup();
  }
});

test("模型缓存里记为未归池的模型，按当前 poolRules 重算；自定义接口未启用的模型仍不归池", async () => {
  const h = makeHome();
  try {
    const now = Date.now();
    fs.writeFileSync(path.join(h.state, "models-cache.json"), JSON.stringify({
      updatedAt: new Date(now).toISOString(),
      providers: {
        agy: { ok: true, models: [{ id: "gemini-pro-orchestrator-g1-pro", pool: null, firstSeen: "1970-01-01T00:00:00.000Z" }] },
        ep: { ok: true, models: [{ id: "glm-9", pool: null, enabled: false, firstSeen: "1970-01-01T00:00:00.000Z" }] },
      },
    }));
    const cfg = structuredClone(defaultCfg);
    cfg.providers.agy.poolRules = [["^gemini-pro-orchestrator-g1-pro$", "gemini"], ...cfg.providers.agy.poolRules];
    cfg.providers.ep = { quota: { provider: "ep", pools: ["ep"] }, pools: { ep: [] } };
    const res = await getModels(cfg, { stateDir: h.state, now });
    const agyModel = res.providers.agy.models[0];
    assert.equal(agyModel.pool, "gemini");
    assert.equal(agyModel.unpooled, undefined);
    assert.equal(res.providers.ep.models[0].pool, null);
    assert.equal(res.providers.ep.models[0].unpooled, true);
  } finally {
    h.cleanup();
  }
});

test("isDocPath：Markdown 和纯文本算文档，源码不算", () => {
  assert.equal(isDocPath("/a/docs/plans/交接.md"), true);
  assert.equal(isDocPath("README.MD"), true);
  assert.equal(isDocPath("notes.txt"), true);
  assert.equal(isDocPath("src/app.mjs"), false);
  assert.equal(isDocPath("register.tsx"), false);
  assert.equal(isDocPath(""), false);
});
