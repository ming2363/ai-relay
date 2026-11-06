// ai-relay 任务按活动超时判断与总运行时长上限单元测试
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { executeJob, formatTimeoutReason } from "./relay.mjs";
import { getWorkspaceActivityMtime } from "./lib.mjs";
import { getSessionActivityMtime } from "./usage.mjs";

function setupTestEnv(prefix = "ai-relay-timeout-") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const jobsDir = path.join(tmpDir, "jobs");
  const cwdDir = path.join(tmpDir, "worktree");
  const agyDir = path.join(tmpDir, "conversations");
  const grokDir = path.join(tmpDir, "grok-sessions");

  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(cwdDir, { recursive: true });
  fs.mkdirSync(agyDir, { recursive: true });
  fs.mkdirSync(grokDir, { recursive: true });

  // 最小空仓库夹具，仅供 git status 读取，不执行 Git 写入命令。
  fs.mkdirSync(path.join(cwdDir, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(cwdDir, ".git", "refs"), { recursive: true });
  fs.writeFileSync(path.join(cwdDir, ".git", "HEAD"), "ref: refs/heads/test\n");

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  return { tmpDir, jobsDir, cwdDir, agyDir, grokDir, cleanup };
}

test("1. 初期没有 cwd 元数据、仅 WAL 持续更新，超过无活动超时时长仍正常跑完", async () => {
  const env = setupTestEnv("ai-relay-test1-");
  try {
    // 模拟 agy 初期尚未写入 cwd 元数据的会话库
    const dbPath = path.join(env.agyDir, "conv-active.db");
    const walPath = path.join(env.agyDir, "conv-active.db-wal");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE trajectory_metadata_blob (data BLOB);");
    db.close();
    fs.writeFileSync(walPath, "initial wal\n");

    const job = {
      id: "job-active-log",
      provider: "agy",
      cwd: env.cwdDir,
      task: "持续写日志测试",
      role: "implement",
      write: false,
      startedAt: new Date().toISOString(),
      _jobsDir: env.jobsDir,
    };

    // 子进程每隔 150ms 追加写一次 wal 日志，共写 5 次（约 750ms），然后正常退出
    const childScript = `
      const fs = require('node:fs');
      const target = process.argv[1];
      let count = 0;
      const iv = setInterval(() => {
        try { fs.appendFileSync(target, 'tick ' + count + '\\n'); } catch {}
        count++;
        if (count >= 5) {
          clearInterval(iv);
          process.exit(0);
        }
      }, 150);
    `;

    const started = Date.now();
    const res = await executeJob(job, {
      bin: process.execPath,
      args: ["-e", childScript, walPath],
      idleTimeoutMs: 500, // 500ms 无活动即杀；子进程总运行约 750ms，但每 150ms 刷新一次日志
      maxRuntimeMs: 4000,
      checkIntervalMs: 80,
      jobsDir: env.jobsDir,
      agyDir: env.agyDir,
    });
    const duration = Date.now() - started;

    assert.equal(res.status, "done", "任务应成功完成而不是超时");
    assert.equal(res.exitCode, 0, "子进程退出码应为 0");
    assert.equal(res.timeoutReason, undefined, "不应有超时原因");
    assert.ok(duration >= 600, `运行总时长 (${duration}ms) 超过了 500ms 的 idleTimeout`);
  } finally {
    env.cleanup();
  }
});

test("2. 无活动被杀，reason 为 idle：连续无活动超过 idleTimeout 被杀死", async () => {
  const env = setupTestEnv("ai-relay-test2-");
  try {
    const job = {
      id: "job-idle-killed",
      provider: "agy",
      cwd: env.cwdDir,
      task: "空闲卡死测试",
      role: "debug",
      write: false,
      startedAt: new Date().toISOString(),
      _jobsDir: env.jobsDir,
    };

    // 子进程纯睡眠 10 秒，没有任何输出与文件写入
    const childScript = `setTimeout(() => {}, 10000);`;

    const started = Date.now();
    const res = await executeJob(job, {
      bin: process.execPath,
      args: ["-e", childScript],
      idleTimeoutMs: 500, // 500ms 无活动判定卡死
      maxRuntimeMs: 6000,
      checkIntervalMs: 80,
      jobsDir: env.jobsDir,
      agyDir: env.agyDir,
    });
    const duration = Date.now() - started;

    assert.equal(res.status, "timeout", "无活动任务应被判定为 timeout");
    assert.equal(res.timeoutReason, "idle", "超时原因应为 idle");
    assert.ok(duration < 2500, `应在无活动超时后很快被杀，实际耗时 ${duration}ms，远小于 6000ms`);

    // 验证落盘的 JSON 文件
    const saved = JSON.parse(fs.readFileSync(path.join(env.jobsDir, `${job.id}.json`), "utf8"));
    assert.equal(saved.status, "timeout");
    assert.equal(saved.timeoutReason, "idle");
  } finally {
    env.cleanup();
  }
});

test("3. 超总上限被杀，reason 为 max：即使持续写日志，超过 maxRuntime 仍被强行结束", async () => {
  const env = setupTestEnv("ai-relay-test3-");
  try {
    const dbPath = path.join(env.agyDir, "conv-max.db");
    const walPath = path.join(env.agyDir, "conv-max.db-wal");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE trajectory_metadata_blob (data BLOB);");
    db.prepare("INSERT INTO trajectory_metadata_blob (data) VALUES (?)").run(Buffer.from(`file://${env.cwdDir}`));
    db.close();
    fs.writeFileSync(walPath, "initial wal\n");

    const job = {
      id: "job-max-killed",
      provider: "agy",
      cwd: env.cwdDir,
      task: "总时长上限测试",
      role: "implement",
      write: false,
      startedAt: new Date().toISOString(),
      _jobsDir: env.jobsDir,
    };

    // 子进程每 80ms 持续写入，计划运行 10 秒
    const childScript = `
      const fs = require('node:fs');
      const target = process.argv[1];
      setInterval(() => {
        try { fs.appendFileSync(target, 'keepalive\\n'); } catch {}
      }, 80);
      setTimeout(() => {}, 10000);
    `;

    const started = Date.now();
    const res = await executeJob(job, {
      bin: process.execPath,
      args: ["-e", childScript, walPath],
      idleTimeoutMs: 2500, // idleTimeout 足够大，不会因为空闲触发
      maxRuntimeMs: 700,   // 总上限 700ms
      checkIntervalMs: 80,
      jobsDir: env.jobsDir,
      agyDir: env.agyDir,
    });
    const duration = Date.now() - started;

    assert.equal(res.status, "timeout", "超过总时长任务应被判定为 timeout");
    assert.equal(res.timeoutReason, "max", "超时原因应为 max");
    assert.ok(duration >= 600 && duration < 2500, `耗时 (${duration}ms) 应接近 maxRuntime 700ms 且远小于子进程 10s`);

    const saved = JSON.parse(fs.readFileSync(path.join(env.jobsDir, `${job.id}.json`), "utf8"));
    assert.equal(saved.status, "timeout");
    assert.equal(saved.timeoutReason, "max");
  } finally {
    env.cleanup();
  }
});

test("4. formatTimeoutReason：正确格式化 idle 与 max 超时描述", () => {
  assert.equal(formatTimeoutReason({ timeoutReason: "idle", idleTimeoutMin: 20 }), "连续 20 分钟无活动");
  assert.equal(formatTimeoutReason({ timeoutReason: "idle", idleTimeoutMin: 15 }), "连续 15 分钟无活动");
  assert.equal(formatTimeoutReason({ timeoutReason: "max" }), "超过总上限");
  assert.equal(formatTimeoutReason({ timeoutReason: null }), "");
});

test("5. getWorkspaceActivityMtime：工作区文件修改能被正确检测，超过 2000 个文件跳过", () => {
  const env = setupTestEnv("ai-relay-test5-");
  try {
    const file1 = path.join(env.cwdDir, "test.txt");
    fs.writeFileSync(file1, "hello");

    const mtime = getWorkspaceActivityMtime(env.cwdDir, 2000);
    assert.ok(mtime > 0, "应检测到 test.txt 的修改时间");

    // 限制为 0 时应被跳过
    const skipped = getWorkspaceActivityMtime(env.cwdDir, 0);
    assert.equal(skipped, 0, "超过限制应跳过返回 0");
  } finally {
    env.cleanup();
  }
});
