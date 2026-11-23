// ai-relay 取消后台任务：worker 与员工 CLI 进程都要被结束，且状态保持 cancelled
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), "relay.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-cancel-"));
  const cwd = path.join(home, "work");
  fs.mkdirSync(path.join(home, "jobs"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, AI_RELAY_HOME: home };
  const jobFile = (id) => path.join(home, "jobs", `${id}.json`);
  const readJob = (id) => JSON.parse(fs.readFileSync(jobFile(id), "utf8"));
  const writeJob = (job) => fs.writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2));
  // 用异步方式跑 relay：同步 spawnSync 会让测试进程来不及回收被杀掉的 worker 子进程（僵尸进程仍被视为存在）
  const relayAsync = (...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [RELAY, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { home, cwd, env, readJob, writeJob, relayAsync, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test("取消后台任务：worker 与员工 CLI 进程都被结束，状态保持 cancelled", async () => {
  const t = setup();
  const pids = [];
  try {
    const id = "cancel-bg-1";
    // 假员工 CLI：长时间不退出
    t.writeJob({
      id, provider: "agy", cwd: t.cwd, task: "取消测试", role: "implement", write: false,
      status: "running", startedAt: new Date().toISOString(),
      _bin: process.execPath, _args: ["-e", "setInterval(()=>{},1000)"],
    });
    // 与 cmdRun --background 一致：detached 启动 _worker
    const worker = spawn(process.execPath, [RELAY, "_worker", id], { detached: true, stdio: "ignore", env: t.env, cwd: t.cwd });
    worker.unref();
    pids.push(worker.pid);

    let job;
    for (let i = 0; i < 100; i++) {
      job = t.readJob(id);
      if (job.childPid) break;
      await sleep(100);
    }
    assert.ok(job.childPid, "childPid 应已写入");
    pids.push(job.childPid);
    assert.equal(job.pid, worker.pid);
    assert.notEqual(job.childPid, job.pid);
    assert.ok(alive(job.pid) && alive(job.childPid));

    const res = await t.relayAsync("cancel", id);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /已取消任务/);

    assert.equal(alive(job.pid), false, "worker 进程应已不存在");
    assert.equal(alive(job.childPid), false, "员工 CLI 进程应已不存在");
    assert.equal(t.readJob(id).status, "cancelled");
    await sleep(3000);
    assert.equal(t.readJob(id).status, "cancelled", "取消后不能被 worker 事后覆盖");
  } finally {
    for (const pid of pids) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    t.cleanup();
  }
});

test("已结束的任务 cancel 仍提示无需取消，且不改状态", async () => {
  const t = setup();
  try {
    t.writeJob({ id: "cancel-done-1", provider: "agy", cwd: t.cwd, status: "done", startedAt: new Date().toISOString() });
    const res = await t.relayAsync("cancel", "cancel-done-1");
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /无需取消/);
    assert.equal(t.readJob("cancel-done-1").status, "done");
  } finally {
    t.cleanup();
  }
});

test("执行进程写回前重读：磁盘已是 cancelled 时不覆盖成 done/failed，并留下取消前的改动清单", async () => {
  const t = setup();
  const pids = [];
  try {
    const id = "cancel-fg-1";
    spawnSync("git", ["init", "-q"], { cwd: t.cwd });
    // 假员工 CLI：先改一个文件，再一直不退出
    t.writeJob({
      id, provider: "agy", cwd: t.cwd, task: "前台取消测试", role: "implement", write: true, scope: ["."],
      status: "running", startedAt: new Date().toISOString(),
      _bin: process.execPath, _args: ["-e", "require('fs').writeFileSync('a.txt','x');setInterval(()=>{},1000)"],
    });
    const worker = spawn(process.execPath, [RELAY, "_worker", id], { detached: true, stdio: "ignore", env: t.env, cwd: t.cwd });
    worker.unref();
    pids.push(worker.pid);

    let job;
    for (let i = 0; i < 100; i++) {
      job = t.readJob(id);
      if (job.childPid && fs.existsSync(path.join(t.cwd, "a.txt"))) break;
      await sleep(100);
    }
    assert.ok(job.childPid, "员工 CLI 应已启动");
    pids.push(job.childPid);

    // 模拟 cancel 先落盘 cancelled，随后员工 CLI 退出、执行进程开始写回
    t.writeJob({ ...job, status: "cancelled" });
    process.kill(job.childPid, "SIGTERM");

    for (let i = 0; i < 100 && alive(worker.pid); i++) await sleep(100);
    const after = t.readJob(id);
    assert.equal(after.status, "cancelled");
    assert.ok(after.finishedAt, "应补写结束时间");
    assert.ok((after.changedFiles || []).some((f) => String(f.path ?? f).includes("a.txt")), `改动清单应含 a.txt，实际 ${JSON.stringify(after.changedFiles)}`);
  } finally {
    for (const pid of pids) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    t.cleanup();
  }
});

test("前台 relay 进程被 SIGTERM 结束时，员工 CLI 进程组一起结束", async () => {
  const t = setup();
  const pids = [];
  try {
    const id = "fg-sigterm-1";
    t.writeJob({
      id, provider: "agy", cwd: t.cwd, task: "前台信号测试", role: "implement", write: false,
      status: "running", startedAt: new Date().toISOString(),
      _bin: process.execPath, _args: ["-e", "setInterval(()=>{},1000)"],
    });
    // _worker 用前台方式执行 executeJob；这里不 detached，模拟调用方直接 kill 子进程
    const worker = spawn(process.execPath, [RELAY, "_worker", id], { stdio: "ignore", env: t.env, cwd: t.cwd });
    pids.push(worker.pid);
    let job;
    for (let i = 0; i < 100; i++) {
      job = t.readJob(id);
      if (job.childPid) break;
      await sleep(100);
    }
    assert.ok(job.childPid);
    pids.push(job.childPid);
    process.kill(worker.pid, "SIGTERM");
    for (let i = 0; i < 50 && alive(job.childPid); i++) await sleep(100);
    assert.equal(alive(job.childPid), false, "员工 CLI 应随 relay 一起结束");
  } finally {
    for (const pid of pids) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    t.cleanup();
  }
});
