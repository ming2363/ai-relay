// lib.mjs 一批缺陷修复的回归测试：只读能力判定、子目录 git 路径、跨目录写锁、命令识别、bash 快照、read 路由迁移
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  capsOf, gitSnapshot, diffSnapshots, checkOutOfScope, getWorkspaceActivityMtime, repoPathToCwd,
  isRelayRunCommand, isRelayRunWriteCommand, migrateModelFields,
} from "./lib.mjs";

function repoWithSub() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lib-fixes-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "pkg", "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "pkg", "src", "a.js"), "1\n");
  fs.writeFileSync(path.join(repo, "top.txt"), "1\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}

test("capsOf：fullAccessWriteOnly 的厂商只读时不算能执行命令，可写时算", () => {
  const cfg = { workerFullAccess: true };
  const prov = { caps: { exec: false }, cli: { fullAccess: ["--x"], fullAccessWriteOnly: true } };
  assert.equal(capsOf(cfg, prov, "m", { write: false }).exec, false);
  assert.equal(capsOf(cfg, prov, "m", { write: true }).exec, true);
  // 不传 write 时保持原行为
  assert.equal(capsOf(cfg, prov, "m").exec, true);
});

test("仓库子目录作 cwd：已脏文件再被改能检出，越界按相对 cwd 判断，工作区活动能读到", () => {
  const repo = repoWithSub();
  try {
    const sub = path.join(repo, "pkg");
    fs.writeFileSync(path.join(sub, "src", "a.js"), "2\n");
    const before = gitSnapshot(sub);
    fs.writeFileSync(path.join(sub, "src", "a.js"), "3333\n");
    fs.writeFileSync(path.join(repo, "top.txt"), "changed\n");
    const changed = diffSnapshots(before, gitSnapshot(sub));
    // cwd 以外（仓库根的 top.txt）不进快照
    assert.equal(changed.length, 1);
    assert.match(changed[0], /pkg\/src\/a\.js/);
    assert.deepEqual(checkOutOfScope(changed, ["src"], sub), []);
    assert.deepEqual(checkOutOfScope(changed, ["other"], sub), ["pkg/src/a.js"]);
    assert.ok(getWorkspaceActivityMtime(sub) > 0);
    assert.equal(repoPathToCwd(sub, "pkg/src/a.js"), "src/a.js");
    assert.equal(repoPathToCwd(sub, "top.txt"), null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("relay 命令识别：heredoc 正文里的 --write 不算，rework 算 relay 派单", () => {
  const ro = `node relay.mjs run agy --role review <<'RELAY_EOF'\n正文里提到 --write 参数\nRELAY_EOF`;
  assert.equal(isRelayRunCommand(ro), true);
  assert.equal(isRelayRunWriteCommand(ro), false);
  assert.equal(isRelayRunWriteCommand(`node relay.mjs run agy --write <<'E'\nx\nE`), true);
  assert.equal(isRelayRunCommand(`node relay.mjs rework 123 -- 改一下`), true);
  assert.equal(isRelayRunWriteCommand(`node relay.mjs rework 123 -- 改一下`), false);
  assert.equal(isRelayRunCommand(`node relay.mjs self "原因里有 run 字样"`), false);
});

test("read 路由迁移：旧 argon-medium 写法与无擅长度的 grok 改写一次，用户改过的不动", () => {
  const cfg = { routes: { read: ["agy:gemini:default", "agy:gemini-argon:gemini-4-argon-medium", "grok:supergrok-weekly:default"] }, providers: {} };
  migrateModelFields(cfg, { providers: {}, routes: {} });
  assert.deepEqual(cfg.routes.read, ["agy:gemini:default", "agy:gemini-argon:default:0.85", "grok:supergrok-weekly:default:0.7"]);
  assert.ok(cfg.migrated.includes("read-route-0.27"));
  cfg.routes.read.push("agy:gemini-argon:gemini-4-argon-medium");
  migrateModelFields(cfg, { providers: {}, routes: {} });
  assert.equal(cfg.routes.read.at(-1), "agy:gemini-argon:gemini-4-argon-medium");
});

test("并行改动归属：落在别的并行任务写入范围内、且不在本任务范围内的改动不算本任务的", async () => {
  const { withoutOtherWriters, scopeLineSnapshot } = await import("./lib.mjs");
  const repo = repoWithSub();
  try {
    const real = fs.realpathSync(repo);
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const job = { id: "a", cwd: repo, scope: ["pkg"], write: true, startedAt: t0, finishedAt: new Date().toISOString() };
    const others = [{ id: "b", cwd: repo, scope: ["docs"], write: true, startedAt: t0, finishedAt: null, status: "running" }];
    const lines = [" M pkg/src/a.js", "?? docs/x.md", " M top.txt"];
    // docs/x.md 属于并行任务 b；top.txt 谁的范围都不在，留着按越界报
    assert.deepEqual(withoutOtherWriters(job, lines, others), [" M pkg/src/a.js", " M top.txt"]);
    // 时间不重叠的任务不参与归属
    const old = [{ ...others[0], startedAt: "2000-01-01T00:00:00Z", finishedAt: "2000-01-01T01:00:00Z" }];
    assert.equal(withoutOtherWriters(job, lines, old).length, 3);
    const snap = { heads: {}, files: { [path.join(real, "pkg/src/a.js")]: { n: 3 }, [path.join(real, "docs/x.md")]: { n: 9 } } };
    assert.deepEqual(Object.keys(scopeLineSnapshot(snap, job).files), [path.join(real, "pkg/src/a.js")]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--downgrade 缺原因：pick 不吞掉后面的 --json，run 报错要求写原因", async () => {
  const { spawnSync } = await import("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dg-"));
  try {
    const relay = path.join(path.dirname(new URL(import.meta.url).pathname), "relay.mjs");
    const env = { ...process.env, AI_RELAY_HOME: home, CLAUDE_PROJECT_DIR: "" };
    const pick = spawnSync(process.execPath, [relay, "pick", "implement", "--level", "困难", "--downgrade", "--json"], { encoding: "utf8", env });
    assert.doesNotThrow(() => JSON.parse(pick.stdout), pick.stdout + pick.stderr);
    const run = spawnSync(process.execPath, [relay, "run", "agy", "--role", "implement", "--level", "中等", "--downgrade", "--", "## 目标\nx\n## 验收标准\ny"], { encoding: "utf8", env });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--downgrade 要写原因/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("卡住无产出的任务不计可靠度：超时或取消、没输出没改动才算，有改动或有输出照常计", async () => {
  const { isStalledJob } = await import("./lib.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stall-"));
  try {
    fs.writeFileSync(path.join(dir, "a.log"), "\n[stderr]\nerror: interrupted\n");
    fs.writeFileSync(path.join(dir, "b.log"), "做了一半的汇报\n[stderr]\nx");
    assert.equal(isStalledJob({ id: "a", status: "timeout" }, dir), true);
    assert.equal(isStalledJob({ id: "none", status: "cancelled" }, dir), true);
    assert.equal(isStalledJob({ id: "b", status: "timeout" }, dir), false);
    assert.equal(isStalledJob({ id: "a", status: "timeout", changedFiles: [" M x.js"] }, dir), false);
    assert.equal(isStalledJob({ id: "a", status: "failed" }, dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const { scoreRoute } = await import("./score.mjs");
  const NOW = Date.UTC(2026, 10, 24);
  const cfg = { minRemaining: 0.15, lowRemaining: 0.3, providers: { p: { via: "relay", quota: { provider: "q" }, pools: { x: ["m"] } } }, modelTiers: { "p:*": "strong" }, routes: { deep: ["p:x:m"] } };
  const rows = [{ provider: "q", pool_id: "x", window_key: "weekly", remaining_fraction: 0.9, reset_at: NOW + 5 * 86400000, allowance: "available", updated_at: NOW }];
  const fails = Array.from({ length: 3 }, () => ({ provider: "p", model: "m", role: "deep", status: "cancelled", verdict: "fail" }));
  const rel = (history) => scoreRoute(cfg, rows, "deep", { now: NOW, level: "hard", history }).choice.parts.reliability;
  assert.equal(rel(fails.map((r) => ({ ...r, stalled: true }))), rel([]));
  assert.ok(rel(fails) < rel([]));
});

test("简单任务：擅长度差一大截（0.4 对 0.9）时强档胜出，quick 中等任务有强档可派", async () => {
  const { scoreRoute } = await import("./score.mjs");
  const NOW = Date.UTC(2026, 10, 24);
  const cfg = {
    minRemaining: 0.15, lowRemaining: 0.3,
    providers: { agy: { via: "relay", quota: { provider: "antigravity" }, defaultModels: { gemini: "gemini-4-hydrogen-xhigh", "gemini-argon": "gemini-4-argon-high" }, pools: { gemini: ["gemini-4-hydrogen-xhigh", "gemini-4-neon-xhigh"], "gemini-argon": ["gemini-4-argon-high"] } } },
    routes: {
      implement: ["agy:gemini-argon:default:0.9", "agy:gemini:default:0.4"],
      quick: ["agy:gemini:default", "agy:gemini:gemini-4-neon-xhigh:0.7", "agy:gemini-argon:default:0.7"],
    },
  };
  const row = (pool) => ({ provider: "antigravity", pool_id: pool, window_key: "weekly", remaining_fraction: 0.9, reset_at: NOW + 5 * 86400000, allowance: "available", updated_at: NOW });
  const rows = [row("gemini"), row("gemini-argon")];
  assert.equal(scoreRoute(cfg, rows, "implement", { now: NOW, level: "easy" }).choice.model, "gemini-4-argon-high");
  assert.equal(scoreRoute(cfg, rows, "quick", { now: NOW, level: "easy" }).choice.model, "gemini-4-hydrogen-xhigh");
  assert.equal(scoreRoute(cfg, rows, "quick", { now: NOW, level: "medium" }).choice.tier, "strong");
});
