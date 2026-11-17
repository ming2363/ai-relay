// 自动验证：可写任务结束时 relay 在任务目录里执行派单「## 验证命令」并记录结果，同时记录改动行数
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyOfBrief } from "./brief.mjs";
import { executeJob } from "./relay.mjs";

// ---------- 单元：验证命令解析 ----------

test("verifyOfBrief：解析编号行、列表行，去掉反引号，跳过占位行，最多 3 条", () => {
  const text = `角色：implement
难度：中等

## 目标
加一个文件

## 验证命令
- node --test
2、\`cd scripts && node --test\`
3) \`sh -c "echo hi"\`
4. exit 9
5. <这里写验证命令>

## 验收标准
测试全过`;
  assert.deepEqual(verifyOfBrief(text), [
    "node --test",
    "cd scripts && node --test",
    'sh -c "echo hi"',
  ]);
});

test("verifyOfBrief：标题可带 #、括注、冒号；没有这一段或占位符都返回空数组", () => {
  assert.deepEqual(verifyOfBrief("## 验证命令（主控核对）\n\nnode --test\n"), ["node --test"]);
  assert.deepEqual(verifyOfBrief("## 验证命令：\ncd scripts && node --test\n"), ["cd scripts && node --test"]);
  assert.deepEqual(verifyOfBrief("验证命令\n<占位符>\n"), []);
  assert.deepEqual(verifyOfBrief("没有任何验证命令小节"), []);
  assert.deepEqual(verifyOfBrief(""), []);
});

// ---------- 执行：自动验证与改动行数 ----------

function setupTestEnv(prefix = "ai-relay-verify-") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const jobsDir = path.join(tmpDir, "jobs");
  const stateDir = path.join(tmpDir, "state");
  const cwdDir = path.join(tmpDir, "worktree");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(cwdDir, { recursive: true });

  // 最小 git 仓库夹具，仅供 git status / lineSnapshot 读取，不执行写入命令。
  fs.mkdirSync(path.join(cwdDir, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(cwdDir, ".git", "refs"), { recursive: true });
  fs.writeFileSync(path.join(cwdDir, ".git", "HEAD"), "ref: refs/heads/test\n");

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };
  return { tmpDir, jobsDir, stateDir, cwdDir, cleanup };
}

function baseJob(env, over = {}) {
  return {
    id: "job-verify",
    provider: "grok",
    pool: "supergrok-weekly",
    role: "implement",
    write: true,
    cwd: env.cwdDir,
    task: "",
    startedAt: new Date().toISOString(),
    _jobsDir: env.jobsDir,
    ...over,
  };
}

// 跑一个假任务：node -e 脚本，脚本里可用 process.argv[1] 取第一个透传参数
async function runJob(env, job, script, arg, opts = {}) {
  return executeJob(job, {
    cfg: { providers: {} },
    bin: process.execPath,
    args: ["-e", script, arg],
    idleTimeoutMs: 4000,
    maxRuntimeMs: 15000,
    checkIntervalMs: 80,
    stateDir: env.stateDir,
    ...opts,
  });
}

const BRIEF_WITH_VERIFY = `角色：implement
难度：中等

## 目标
加一个文件

## 验证命令
exit 0
exit 3

## 验收标准
测试全过`;

test("带验证命令的可写任务：退出码非 0 时 ok 为 false、verifyFailed 为 true、status 仍为 done", async () => {
  const env = setupTestEnv("ai-relay-verify-ok-");
  try {
    const job = baseJob(env, { task: BRIEF_WITH_VERIFY });
    const res = await runJob(env, job, `process.exit(0);`, env.cwdDir);

    assert.equal(res.status, "done");
    assert.equal(res.verify.ok, false);
    assert.equal(res.verifyFailed, true);
    assert.equal(res.verify.results.length, 2);
    assert.equal(res.verify.results[0].exitCode, 0);
    assert.equal(res.verify.results[1].exitCode, 3);
    assert.equal(res.verify.results[1].cmd, "exit 3");
  } finally {
    env.cleanup();
  }
});

test("验证命令超时：verifyTimeoutMin 很小、命令 sleep 5，记为 timedOut、exitCode 为 null", async () => {
  const env = setupTestEnv("ai-relay-verify-timeout-");
  try {
    const job = baseJob(env, {
      task: `## 目标\n加文件\n\n## 验证命令\nsleep 5\n\n## 验收标准\n自检`,
    });
    const res = await runJob(env, job, `process.exit(0);`, env.cwdDir, {
      cfg: { providers: {}, verifyTimeoutMin: 0.01 },
    });

    assert.equal(res.status, "done");
    assert.equal(res.verify.ok, false);
    assert.equal(res.verifyFailed, true);
    assert.equal(res.verify.results[0].timedOut, true);
    assert.equal(res.verify.results[0].exitCode, null);
  } finally {
    env.cleanup();
  }
});

test("只读任务和失败任务都不执行验证命令", async () => {
  const readEnv = setupTestEnv("ai-relay-verify-readonly-");
  try {
    const readJob = baseJob(readEnv, { task: BRIEF_WITH_VERIFY, write: false });
    const readRes = await runJob(readEnv, readJob, `process.exit(0);`, readEnv.cwdDir);
    assert.equal(readRes.status, "done");
    assert.equal(readRes.verify, undefined);
  } finally {
    readEnv.cleanup();
  }

  const failEnv = setupTestEnv("ai-relay-verify-fail-");
  try {
    const failJob = baseJob(failEnv, { task: BRIEF_WITH_VERIFY });
    const failRes = await runJob(failEnv, failJob, `process.exit(1);`, failEnv.cwdDir);
    assert.equal(failRes.status, "failed");
    assert.equal(failRes.verify, undefined);
  } finally {
    failEnv.cleanup();
  }
});

test("可写任务写了 3 行新文件时 changedLines 为 3", async () => {
  const env = setupTestEnv("ai-relay-verify-lines-");
  try {
    const target = path.join(env.cwdDir, "new.txt");
    const job = baseJob(env, { task: "## 目标\n写一个新文件\n\n## 验收标准\n自检" });
    const res = await runJob(env, job, `const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'a\\nb\\nc\\n');`, target);
    assert.equal(res.status, "done");
    assert.equal(res.changedLines, 3);
  } finally {
    env.cleanup();
  }
});

test("失败任务报 Grok 额度耗尽时 quotaExhausted 为 true 且缓存里出现 cli-limit 来源；成功任务写 usage limit 不标记", async () => {
  const failEnv = setupTestEnv("ai-relay-verify-quota-fail-");
  try {
    const failJob = baseJob(failEnv, {
      task: "## 目标\n写文件\n\n## 验收标准\n自检",
    });
    const failRes = await runJob(failEnv, failJob, `process.stderr.write("You've reached your free Grok Build usage limit"); process.exit(1);`, failEnv.cwdDir);
    assert.equal(failRes.status, "failed");
    assert.equal(failRes.quotaExhausted, true);

    const cache = JSON.parse(fs.readFileSync(path.join(failEnv.stateDir, "quota-cache.json"), "utf8"));
    assert.ok(cache.sources["cli-limit:grok:supergrok-weekly"], "缓存里应出现 cli-limit: 来源");
  } finally {
    failEnv.cleanup();
  }

  const okEnv = setupTestEnv("ai-relay-verify-quota-ok-");
  try {
    const okJob = baseJob(okEnv, {
      task: "## 目标\n写文件\n\n## 验收标准\n自检",
    });
    const okRes = await runJob(okEnv, okJob, `process.stdout.write("we are about to hit the usage limit soon");`, okEnv.cwdDir);
    assert.equal(okRes.status, "done");
    assert.equal(okRes.quotaExhausted, undefined);

    // 成功任务不触发额度标记，也不应写 cli-limit 缓存
    assert.equal(fs.existsSync(path.join(okEnv.stateDir, "quota-cache.json")), false);
  } finally {
    okEnv.cleanup();
  }
});
