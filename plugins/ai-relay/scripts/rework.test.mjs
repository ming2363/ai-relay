// 逐个验收相关测试：wait 先完成先返回、rework 退回原员工返工、新建目录不误报越界
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitSnapshot, diffSnapshots, checkOutOfScope } from "./lib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(DIR, "relay.mjs");
const DEFAULT_CFG = path.join(DIR, "..", "config", "providers.default.json");

// 隔离的状态目录 + 一个只记下收到的参数的假 grok 命令行
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-rework-"));
  fs.mkdirSync(path.join(home, "jobs"), { recursive: true });
  const fake = path.join(home, "fake-grok.sh");
  const argsOut = path.join(home, "fake-args.txt");
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsOut}"\necho 已按意见改完\n`, { mode: 0o755 });
  const cfg = JSON.parse(fs.readFileSync(DEFAULT_CFG, "utf8"));
  cfg.providers.grok.cli.bin = fake;
  fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(cfg, null, 2));
  const repo = path.join(home, "repo");
  fs.mkdirSync(path.join(repo, "tasks", "a"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  return { home, repo, argsOut };
}

function relay(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [RELAY, ...args], {
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: home, CLAUDE_PROJECT_DIR: "", ...extraEnv },
    timeout: 30000,
  });
}

function writeJob(home, job, log = "") {
  fs.writeFileSync(path.join(home, "jobs", `${job.id}.json`), JSON.stringify(job, null, 2));
  if (log) fs.writeFileSync(path.join(home, "jobs", `${job.id}.log`), log);
}

const readJob = (home, id) => JSON.parse(fs.readFileSync(path.join(home, "jobs", `${id}.json`), "utf8"));

const BRIEF = ["角色：implement", "难度：中等", "", "## 目标", "为题库出 term-01。", "", "## 验收标准", "自检通过。"].join("\n");

function baseJob(repo, over = {}) {
  return {
    id: "20261108000000-grok-orig",
    provider: "grok",
    pool: "supergrok-weekly",
    model: "default",
    role: "implement",
    reason: "主模型指定 grok",
    write: true,
    cwd: repo,
    task: BRIEF,
    scope: ["tasks/a"],
    status: "done",
    startedAt: "2026-11-08T00:00:00.000Z",
    finishedAt: "2026-11-08T00:05:00.000Z",
    ...over,
  };
}

test("wait 多个任务：有一个结束就返回，并给出继续等剩下任务的命令", () => {
  const { home, repo } = setup();
  writeJob(home, baseJob(repo, { id: "j-done" }), "交付内容");
  writeJob(home, baseJob(repo, { id: "j-run", status: "running", finishedAt: null }));
  const t0 = Date.now();
  const r = relay(home, ["wait", "j-done", "j-run", "--timeout", "20"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 10000, "不应等到超时");
  assert.match(r.stdout, /任务 j-done ·/);
  assert.match(r.stdout, /任务 j-run 仍在运行/);
  assert.match(r.stdout, /relay rework <id>/);
  assert.match(r.stdout, /还有 1 个在运行，验收完继续等：.* wait j-run$/m);
});

test("wait 多个任务：已验收的不算新完成，--all 仍等全部结束", () => {
  const { home, repo } = setup();
  writeJob(home, baseJob(repo, { id: "j-ok", verdict: "pass" }));
  writeJob(home, baseJob(repo, { id: "j-run", status: "running", finishedAt: null }));
  const t0 = Date.now();
  const r = relay(home, ["wait", "j-ok", "j-run", "--timeout", "2"]);
  assert.ok(Date.now() - t0 >= 1900, "只有已验收的结束了，应继续等到超时");
  assert.match(r.stdout, /任务 j-ok 已验收（pass）/);
  writeJob(home, baseJob(repo, { id: "j-new" }), "交付内容");
  const t1 = Date.now();
  const all = relay(home, ["wait", "j-new", "j-run", "--all", "--timeout", "2"]);
  assert.ok(Date.now() - t1 >= 1900, "--all 要等全部结束");
  assert.match(all.stdout, /任务 j-run 仍在运行/);
});

test("rework：退回原员工，沿用模型、角色、写入范围，附上原派单、上次结果和修改意见", () => {
  const { home, repo, argsOut } = setup();
  const orig = baseJob(repo);
  writeJob(home, orig, "上次交付：term-01 已写完");
  const r = relay(home, ["rework", orig.id, "--", "term-01 自检没过，补上缺的测试用例"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /返工第 1 次，原任务 20261108000000-grok-orig/);

  const before = readJob(home, orig.id);
  assert.equal(before.verdict, "partial");
  assert.match(before.verdictNote, /^退回返工：term-01 自检没过/);

  const redoFile = fs.readdirSync(path.join(home, "jobs")).find((f) => f.endsWith(".json") && f !== `${orig.id}.json`);
  const redo = readJob(home, redoFile.replace(/\.json$/, ""));
  assert.equal(redo.reworkOf, orig.id);
  assert.equal(redo.reworkRound, 1);
  assert.equal(redo.provider, "grok");
  assert.equal(redo.role, "implement");
  assert.equal(redo.write, true);
  assert.deepEqual(redo.scope, ["tasks/a"]);
  assert.deepEqual(redo.withJobs, [orig.id]);
  assert.match(redo.reason, /^返工（第 1 次）：退回任务 20261108000000-grok-orig 的原员工/);

  const sent = fs.readFileSync(argsOut, "utf8");
  assert.match(sent, /为题库出 term-01。/);
  assert.match(sent, /## 返工意见（第 1 次）/);
  assert.match(sent, /term-01 自检没过，补上缺的测试用例/);
  assert.match(sent, /上次交付：term-01 已写完/);

  // 面板读的是 jobs --json：返工链和难度要带出去
  const listed = JSON.parse(relay(home, ["jobs", "--json"]).stdout).find((j) => j.id === redo.id);
  assert.equal(listed.reworkOf, orig.id);
  assert.equal(listed.reworkRound, 1);
  assert.equal(listed.level, "medium");

  // 返工的返工：轮次递增，原结论不被覆盖
  const r2 = relay(home, ["rework", redo.id, "--verdict", "fail", "--", "还是没过"]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readJob(home, redo.id).verdict, "fail");
  assert.match(fs.readFileSync(argsOut, "utf8"), /## 返工意见（第 2 次）/);
});

test("rework：已通过、仍在运行、没写意见的都拒绝", () => {
  const { home, repo } = setup();
  writeJob(home, baseJob(repo, { id: "j-pass", verdict: "pass" }));
  writeJob(home, baseJob(repo, { id: "j-run", status: "running", finishedAt: null }));
  writeJob(home, baseJob(repo, { id: "j-done" }));
  assert.match(relay(home, ["rework", "j-pass", "--", "再改改"]).stderr, /已验收通过/);
  assert.match(relay(home, ["rework", "j-run", "--", "再改改"]).stderr, /还在运行/);
  assert.match(relay(home, ["rework", "j-done"]).stderr, /没有修改意见/);
  assert.equal(readJob(home, "j-done").verdict, undefined);
  // 旧任务没写难度：要用 --level 补上
  writeJob(home, baseJob(repo, { id: "j-old", task: BRIEF.replace("难度：中等\n", "") }));
  assert.match(relay(home, ["rework", "j-old", "--", "再改改"]).stderr, /没写难度，返工时用 --level/);
  assert.equal(readJob(home, "j-old").verdict, undefined);
});

test("rework：返工任务没建成（写入范围被占）时，原任务不记结论", () => {
  const { home, repo } = setup();
  writeJob(home, baseJob(repo, { id: "j-busy", status: "running", startedAt: new Date().toISOString(), finishedAt: null, pid: process.pid }));
  writeJob(home, baseJob(repo, { id: "j-wait" }));
  const r = relay(home, ["rework", "j-wait", "--", "补上测试"]);
  assert.equal(r.status, 6, r.stderr);
  assert.equal(readJob(home, "j-wait").verdict, undefined);
});

test("新建目录里的文件逐个判断写入范围，不再整目录误报越界", () => {
  const { repo } = setup();
  const before = gitSnapshot(repo);
  fs.writeFileSync(path.join(repo, "tasks", "a", "prompt.md"), "题面\n");
  fs.mkdirSync(path.join(repo, "answers", "a"), { recursive: true });
  fs.writeFileSync(path.join(repo, "answers", "a", "key.txt"), "答案\n");
  const changed = diffSnapshots(before, gitSnapshot(repo));
  assert.deepEqual(checkOutOfScope(changed, ["tasks/a", "answers/a"], repo), []);
  assert.deepEqual(checkOutOfScope(changed, ["tasks/a"], repo), ["answers/a/key.txt"]);
});
