// Codex 日志脱敏、无 pid 可写记录空闲锁失效、以及用量与额度缓存的并发文件锁测试
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const posttoolHookPath = path.join(scriptsDir, "posttool-hook.mjs");

test("posttool-hook 写入的 Codex 日志对 sk-、ghp_、Bearer 密钥脱敏", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-hook-mask-"));
  const state = path.join(home, "ai-relay");
  fs.mkdirSync(state, { recursive: true });
  try {
    const toolUseId = "toolu_codex_mask_01";
    const rawSecretSk = "sk-proj1234567890abcdefXYZ";
    const rawSecretGhp = "ghp_1234567890abcdefABCDEF";
    const rawBearer = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload";
    const payload = {
      tool_name: "Agent",
      tool_use_id: toolUseId,
      tool_input: {
        subagent_type: "codex:codex-rescue",
      },
      tool_response: `执行日志：\nOPENAI_API_KEY=${rawSecretSk}\nGITHUB_TOKEN=${rawSecretGhp}\nAuthorization: Bearer ${rawBearer}\n完成。`,
    };
    const res = spawnSync(process.execPath, [posttoolHookPath], {
      encoding: "utf8",
      input: JSON.stringify(payload),
      cwd: scriptsDir,
      env: {
        PATH: process.env.PATH || "",
        HOME: home,
        AI_RELAY_HOME: state,
        LANG: "C",
        TMPDIR: process.env.TMPDIR || "/tmp",
      },
    });
    assert.equal(res.status, 0, res.stderr);

    const logFile = path.join(state, "jobs", `${toolUseId}.log`);
    assert.equal(fs.existsSync(logFile), true);
    const logContent = fs.readFileSync(logFile, "utf8");
    assert.match(logContent, /sk-\*\*\*/);
    assert.match(logContent, /ghp_\*\*\*/);
    assert.match(logContent, /Bearer \*\*\*/);
    assert.equal(logContent.includes(rawSecretSk), false);
    assert.equal(logContent.includes(rawSecretGhp), false);
    assert.equal(logContent.includes(rawBearer), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runningWriters：无 pid 的可写记录超 20 分钟且工作区无活动时失效，有活动或未超时或有存活 pid 的仍保留", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-writers-"));
  const state = path.join(home, "ai-relay");
  const repo = path.join(home, "repo");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  try {
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "README.md"), "init\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init"], {
      cwd: repo,
      stdio: "ignore",
    });

    const prevHome = process.env.AI_RELAY_HOME;
    process.env.AI_RELAY_HOME = state;
    try {
      const lib = await import(`./lib.mjs?writers=${Date.now()}`);
      const { appendHistory, runningWriters, JOBS_DIR } = lib;

      const now = Date.now();
      const histFile = path.join(state, "history.jsonl");

      // 1. 无 pid、25 分钟前开始（超 20 分钟）、无 pid、5 分钟前开始（未超时）
      appendHistory({
        id: "codex-stale",
        provider: "codex",
        write: true,
        scope: ["src"],
        status: "running",
        startedAt: new Date(now - 25 * 60_000).toISOString(),
        cwd: repo,
      });
      appendHistory({
        id: "codex-fresh",
        provider: "codex",
        write: true,
        scope: ["docs"],
        status: "running",
        startedAt: new Date(now - 5 * 60_000).toISOString(),
        cwd: repo,
      });

      // 2. 有存活 pid（当前进程）、25 分钟前开始；有死 pid、5 分钟前开始
      fs.mkdirSync(JOBS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(JOBS_DIR, "relay-alive.json"),
        JSON.stringify({
          id: "relay-alive",
          provider: "agy",
          write: true,
          scope: ["lib"],
          status: "running",
          pid: process.pid,
          startedAt: new Date(now - 25 * 60_000).toISOString(),
          cwd: repo,
        }),
      );
      fs.writeFileSync(
        path.join(JOBS_DIR, "relay-dead.json"),
        JSON.stringify({
          id: "relay-dead",
          provider: "agy",
          write: true,
          scope: ["test"],
          status: "running",
          pid: 999999,
          startedAt: new Date(now - 5 * 60_000).toISOString(),
          cwd: repo,
        }),
      );

      const histBefore = fs.readFileSync(histFile, "utf8");

      // 工作区干净（无活动）：codex-stale 不再出现，codex-fresh 和 relay-alive 仍出现，relay-dead 不出现
      const listIdle = runningWriters(repo, now).map((r) => r.id);
      assert.equal(listIdle.includes("codex-stale"), false);
      assert.equal(listIdle.includes("codex-fresh"), true);
      assert.equal(listIdle.includes("relay-alive"), true);
      assert.equal(listIdle.includes("relay-dead"), false);
      // history.jsonl 原记录不能被改动
      assert.equal(fs.readFileSync(histFile, "utf8"), histBefore);

      // 工作区有旧活动（30 分钟前改的文件）：依然算最近 20 分钟无活动，codex-stale 不出现
      const dirtyFile = path.join(repo, "dirty.txt");
      fs.writeFileSync(dirtyFile, "work in progress\n");
      const oldSec = (now - 30 * 60_000) / 1000;
      fs.utimesSync(dirtyFile, oldSec, oldSec);
      const listOldAct = runningWriters(repo, now).map((r) => r.id);
      assert.equal(listOldAct.includes("codex-stale"), false);

      // 工作区最近 20 分钟内有活动（5 分钟前修改）：codex-stale 重新被视为活跃
      const recentSec = (now - 5 * 60_000) / 1000;
      fs.utimesSync(dirtyFile, recentSec, recentSec);
      const listRecentAct = runningWriters(repo, now).map((r) => r.id);
      assert.equal(listRecentAct.includes("codex-stale"), true);
      assert.equal(listRecentAct.includes("codex-fresh"), true);
      assert.equal(listRecentAct.includes("relay-alive"), true);
    } finally {
      if (prevHome === undefined) delete process.env.AI_RELAY_HOME;
      else process.env.AI_RELAY_HOME = prevHome;
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("并发子进程同时调用 recordMeteredUsage 与 markPoolExhausted 不丢数据", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-concurrent-"));
  const state = path.join(home, "ai-relay");
  fs.mkdirSync(state, { recursive: true });
  try {
    const now = 1700000000000;
    const workers = 10;
    const tokensPerWorker = 125;

    const runNode = (code) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
          cwd: scriptsDir,
          env: {
            PATH: process.env.PATH || "",
            HOME: home,
            AI_RELAY_HOME: state,
            LANG: "C",
            TMPDIR: process.env.TMPDIR || "/tmp",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) reject(new Error(`子进程退出码 ${code}: ${stderr}`));
          else resolve();
        });
      });

    // 1. 10 个子进程同时调用 recordMeteredUsage 各累加固定 token
    await Promise.all(
      Array.from({ length: workers }, () =>
        runNode(`
          import { recordMeteredUsage } from "./lib.mjs";
          recordMeteredUsage("maas", ${tokensPerWorker}, ${now});
        `),
      ),
    );

    const usageData = JSON.parse(fs.readFileSync(path.join(state, "metered-usage.json"), "utf8"));
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, "0");
    const dayKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    assert.equal(usageData[dayKey]?.maas, workers * tokensPerWorker);

    // 2. 10 个子进程同时调用 markPoolExhausted 标记不同的额度池
    await Promise.all(
      Array.from({ length: workers }, (_, i) =>
        runNode(`
          import { markPoolExhausted } from "./quota.mjs";
          markPoolExhausted(${JSON.stringify(state)}, "prov-${i}", "pool-${i}", ${now});
        `),
      ),
    );

    const cacheData = JSON.parse(fs.readFileSync(path.join(state, "quota-cache.json"), "utf8"));
    for (let i = 0; i < workers; i++) {
      const key = `cli-limit:prov-${i}:pool-${i}`;
      assert.ok(cacheData.sources?.[key], `缺少并发标记的池 ${key}`);
      assert.equal(cacheData.sources[key].rows?.[0]?.remaining_fraction, 0);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("withFileLock：超过 10 秒的陈旧锁自动清理，抢锁超时退化执行且不抛错", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-filelock-"));
  try {
    const { withFileLock } = await import(`./lib.mjs?lock=${Date.now()}`);
    const target = path.join(dir, "data.json");
    const lockFile = `${target}.lock`;

    // 1. 超过 10 秒的陈旧锁会被清理并成功加锁、解锁
    fs.writeFileSync(lockFile, "stale");
    const staleSec = (Date.now() - 15_000) / 1000;
    fs.utimesSync(lockFile, staleSec, staleSec);
    const r1 = withFileLock(target, () => "ok-stale");
    assert.equal(r1, "ok-stale");
    assert.equal(fs.existsSync(lockFile), false);

    // 2. 新鲜锁占住且超时：退化执行 fn，不抛错，也不删别人的锁
    fs.writeFileSync(lockFile, "held");
    const r2 = withFileLock(target, () => "ok-fallback", { timeoutMs: 50, retryMs: 15 });
    assert.equal(r2, "ok-fallback");
    assert.equal(fs.existsSync(lockFile), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
