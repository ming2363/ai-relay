// 大改动自动初审：触发条件、排除实现者厂商、派单内容、跳过原因、Codex 钩子接入
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-autoreview-"));
process.env.AI_RELAY_HOME = HOME;
const dir = path.dirname(fileURLToPath(import.meta.url));
const DEF = JSON.parse(fs.readFileSync(path.join(dir, "../config/providers.default.json"), "utf8"));
fs.writeFileSync(path.join(HOME, "providers.json"), JSON.stringify({ ...DEF, quotaDb: "" }));
const { startAutoReview, autoReviewPlan, changesDiff, executeJob } = await import("./relay.mjs");

const NOW = Date.now();
const row = (provider, pool, remaining) => ({ provider, pool_id: pool, window_key: "weekly", remaining_fraction: remaining, reset_at: new Date(NOW + 3 * 86400_000).toISOString(), updated_at: new Date(NOW).toISOString() });
const ROWS = [row("antigravity", "gemini-argon", 0.9), row("antigravity", "gemini", 0.9), row("antigravity", "claude-gpt", 0.9), row("grok", "supergrok-weekly", 0.9)];
const cfg = () => structuredClone({ ...DEF, quotaDb: "" });

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}
function makeRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-ar-repo-")));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "a.mjs"), "export const a = 1;\n");
  git(repo, ["add", "a.mjs"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
  fs.writeFileSync(path.join(repo, "a.mjs"), "export const a = 2;\n");
  fs.writeFileSync(path.join(repo, "b.mjs"), "export const b = 'new file';\n");
  return repo;
}

function bigJob(repo, over = {}) {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-ar-jobs-"));
  return {
    id: "20261118000000-agy-impl",
    provider: "agy",
    pool: "gemini-argon",
    model: "gemini-4-argon-high",
    role: "implement",
    write: true,
    status: "done",
    changedLines: 200,
    changedFiles: [" M a.mjs", "?? b.mjs"],
    cwd: repo,
    task: "角色：implement\n难度：中等\n\n## 目标\n把 a 改成 2，新建 b\n\n## 验收标准\n- a 是 2\n- b 存在",
    result: "改好了：a.mjs、b.mjs",
    sessionId: "s-ar",
    _jobsDir: jobsDir,
    ...over,
  };
}

test("改 200 行的可写任务：派给另一家厂商（不是实现者 agy）只读、中等难度的初审，派单带原派单、结果和 diff", () => {
  const repo = makeRepo();
  try {
    const orig = bigJob(repo);
    const res = startAutoReview(cfg(), orig, { spawnWorker: false, mode: "auto", rows: ROWS });
    assert.ok(res?.id, JSON.stringify(res));
    assert.notEqual(res.provider, "agy");
    const job = JSON.parse(fs.readFileSync(path.join(orig._jobsDir, `${res.id}.json`), "utf8"));
    assert.equal(job.role, "review");
    assert.equal(job.level, "medium");
    assert.equal(job.write, false);
    assert.equal(job.autoReviewOf, orig.id);
    assert.equal(job.sessionId, "s-ar");
    assert.match(job.reason, /自动初审任务 20261118000000-agy-impl.*排除实现者 agy/);
    assert.match(job.wrappedPrompt, /权限：只读/);
    assert.match(job.wrappedPrompt, /把 a 改成 2，新建 b/);
    assert.match(job.wrappedPrompt, /改好了：a\.mjs、b\.mjs/);
    assert.match(job.wrappedPrompt, /export const a = 2;/);
    assert.match(job.wrappedPrompt, /new file/);
    assert.match(job.task, /- a\.mjs\n- b\.mjs/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("不做初审的情况：改动不到 150 行、只读、失败、本身是审查、配置关闭时不起；阈值可配", () => {
  const c = cfg();
  const base = bigJob("/tmp");
  const opt = { mode: "auto", rows: ROWS };
  assert.equal(autoReviewPlan(c, { ...base, changedLines: 50 }, opt), null);
  assert.equal(autoReviewPlan(c, { ...base, write: false }, opt), null);
  assert.equal(autoReviewPlan(c, { ...base, status: "failed" }, opt), null);
  assert.equal(autoReviewPlan(c, { ...base, role: "review" }, opt), null);
  assert.equal(autoReviewPlan(c, { ...base, autoReviewOf: "x" }, opt), null);
  assert.equal(autoReviewPlan({ ...c, autoReview: false }, base, opt), null);
  assert.equal(autoReviewPlan({ ...c, autoReviewMinLines: 300 }, base, opt), null);
  assert.ok(autoReviewPlan({ ...c, autoReviewMinLines: 100 }, { ...base, changedLines: 120 }, opt).candidate);
});

test("满足条件但做不了时写明原因：手动模式；只有实现者一家可用", () => {
  const c = cfg();
  const base = bigJob("/tmp");
  assert.deepEqual(autoReviewPlan(c, base, { mode: "manual", rows: ROWS }), { skipped: "手动模式不自动初审" });
  c.providers.grok.enabled = false;
  const onlyAgy = autoReviewPlan(c, base, { mode: "auto", rows: ROWS });
  assert.match(onlyAgy.skipped, /没有可用的审查员工/);
});

test("changesDiff：只含这次改到的文件，新建文件整份列出", () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, "other.mjs"), "不相关\n");
    const d = changesDiff(repo, [" M a.mjs", "?? b.mjs"]);
    assert.match(d, /a\.mjs/);
    assert.match(d, /new file/);
    assert.doesNotMatch(d, /不相关/);
    assert.equal(changesDiff(repo, []), null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("executeJob：员工写了 200 行，结束时记下初审 id 并立即返回；只写几行的不起初审", async () => {
  const repo = makeRepo();
  try {
    const c = cfg();
    const writer = (n) => `require("fs").writeFileSync("gen${n}.mjs", Array.from({ length: ${n} }, (_, i) => "// " + i).join("\\n") + "\\n"); console.log("写好了")`;
    const run = (n) => {
      const job = { ...bigJob(repo), id: `20261118000000-agy-w${n}`, status: "running", result: undefined, changedFiles: undefined };
      delete job.changedLines;
      return executeJob(job, { cfg: c, bin: process.execPath, args: ["-e", writer(n)], autoReviewSpawn: false, mode: "auto", rows: ROWS, skipVerify: true });
    };
    const t0 = Date.now();
    const big = await run(200);
    assert.ok(Date.now() - t0 < 20_000);
    assert.equal(big.status, "done");
    assert.equal(big.changedLines, 200);
    assert.ok(big.autoReviewId, JSON.stringify({ skipped: big.autoReviewSkipped }));
    const review = JSON.parse(fs.readFileSync(path.join(big._jobsDir, `${big.autoReviewId}.json`), "utf8"));
    assert.equal(review.autoReviewOf, big.id);
    assert.match(review.wrappedPrompt, /\/\/ 199/);

    const small = await run(5);
    assert.equal(small.changedLines, 5);
    assert.equal(small.autoReviewId, undefined);
    assert.equal(small.autoReviewSkipped, undefined);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Codex 外派改动大：钩子请 relay 判断初审，做不了时把原因告诉主管并记进台账", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-ar-hook-"));
  const repo = makeRepo();
  try {
    const c = { ...DEF, quotaDb: "" };
    // 实现者以外的厂商都停用：初审做不了
    c.providers.grok.enabled = false;
    c.providers.agy.enabled = false;
    fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(c));
    fs.writeFileSync(path.join(home, "mode"), "auto\n");
    const id = "toolu_ar_codex";
    const { lineSnapshot, gitSnapshot } = await import("./lib.mjs");
    const linesBefore = await lineSnapshot(repo);
    const snapshot = gitSnapshot(repo);
    fs.writeFileSync(path.join(home, "history.jsonl"), [
      JSON.stringify({ id, provider: "codex", model: "gpt-6.1-sol", role: "implement", write: true, status: "running", startedAt: new Date().toISOString(), cwd: repo, task: "派单", brief: "## 目标\n大改", snapshot, linesBefore }),
    ].join("\n") + "\n");
    // 用一个超过 150 行的新文件模拟 Codex 的改动
    fs.writeFileSync(path.join(repo, "big.mjs"), Array.from({ length: 200 }, (_, i) => `// ${i}`).join("\n") + "\n");
    const r = spawnSync(process.execPath, [path.join(dir, "posttool-hook.mjs")], {
      input: JSON.stringify({ tool_name: "Agent", session_id: "s1", tool_use_id: id, cwd: repo, tool_input: { subagent_type: "codex:codex-rescue", prompt: "x" }, tool_response: "完成" }),
      encoding: "utf8",
      env: { ...process.env, AI_RELAY_HOME: home, CLAUDE_PROJECT_DIR: "" },
    });
    assert.equal(r.status, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /自动初审：没有可用的审查员工/);
    const merged = Object.assign({}, ...fs.readFileSync(path.join(home, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.id === id));
    assert.ok(merged.changedLines >= 150, String(merged.changedLines));
    assert.match(merged.autoReviewSkipped, /没有可用的审查员工/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
