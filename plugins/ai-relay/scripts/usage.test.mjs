// ai-relay 外派任务本机会话日志 token 用量读取（Grok / Antigravity）与回填单元测试
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  readVarint,
  readProtoFields,
  readAgyGenMetadataUsage,
  grokUsageFor,
  agyUsageFor,
  backfill,
  attachLiveUsage,
} from "./usage.mjs";

// 手工编码 protobuf varint 与 length-delimited 字段的测试辅助函数
function encodeVarint(n) {
  let v = BigInt(n);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeVarintField(fieldNo, value) {
  return Buffer.concat([encodeVarint((fieldNo << 3) | 0), encodeVarint(value)]);
}

function encodeBytesField(fieldNo, buf) {
  const payload = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  return Buffer.concat([encodeVarint((fieldNo << 3) | 2), encodeVarint(payload.length), payload]);
}

function encodeAgyGenRow({ input, output, modelEnum = 1319, thinking = 0 }) {
  // 构造字段 4：{ 1: modelEnum, 2: input, 3: output, 9: thinking }
  const field4 = Buffer.concat([
    encodeVarintField(1, modelEnum),
    encodeVarintField(2, input),
    encodeVarintField(3, output),
    encodeVarintField(9, thinking),
  ]);
  // 构造字段 1：{ 3: modelEnum, 4: field4 }
  const field1 = Buffer.concat([
    encodeVarintField(3, modelEnum),
    encodeBytesField(4, field4),
  ]);
  // 顶层包含干扰字段 2 和目标字段 1
  return Buffer.concat([
    encodeBytesField(2, Buffer.from([1])),
    encodeBytesField(1, field1),
  ]);
}

function encodeAgyTrajectoryBlob(cwd, gitRoot = cwd) {
  const uri = `file://${cwd}`;
  const rootUri = `file://${gitRoot}`;
  const field1 = Buffer.concat([
    encodeBytesField(1, uri),
    encodeBytesField(2, rootUri),
  ]);
  return Buffer.concat([
    encodeBytesField(1, field1),
    encodeBytesField(7, uri),
  ]);
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("1. Protobuf 解析器：正确读取 varint 与嵌套字段 1 → 4 → {2, 3}", () => {
  const rowBuf = encodeAgyGenRow({ input: 11103, output: 1115, thinking: 1045 });
  const v = readVarint(encodeVarint(300), 0);
  assert.deepEqual(v, { value: 300, next: 2 });

  const top = readProtoFields(rowBuf);
  assert.equal(top.length, 2);
  assert.deepEqual(readAgyGenMetadataUsage(rowBuf), { input: 11103, output: 1115 });
});

test("2. Grok 会话匹配与用量映射：按 input = inputTokens - cachedReadTokens 计算，多候选选最接近 startedAt", () => {
  const tmpDir = makeTempDir("relay-grok-usage-");
  try {
    const cwd = "/tmp/workspace/demo-grok";
    const encDir = path.join(tmpDir, encodeURIComponent(cwd));

    // 候选 A：距离 startedAt 15 秒
    const s1 = path.join(encDir, "session-far");
    fs.mkdirSync(s1, { recursive: true });
    fs.writeFileSync(
      path.join(s1, "summary.json"),
      JSON.stringify({ info: { id: "session-far", cwd }, created_at: "2026-11-05T10:17:49.000Z" }),
    );
    fs.writeFileSync(
      path.join(s1, "usage.json"),
      JSON.stringify({
        session: { inputTokens: 99999, outputTokens: 999, cachedReadTokens: 0, totalTokens: 100998 },
      }),
    );

    // 候选 B：距离 startedAt 0.2 秒（应被选中）
    const s2 = path.join(encDir, "session-near");
    fs.mkdirSync(s2, { recursive: true });
    fs.writeFileSync(
      path.join(s2, "summary.json"),
      JSON.stringify({ info: { id: "session-near", cwd }, created_at: "2026-11-05T10:17:34.800Z" }),
    );
    fs.writeFileSync(
      path.join(s2, "usage.json"),
      JSON.stringify({
        session: {
          inputTokens: 24705,
          outputTokens: 2041,
          cachedReadTokens: 7040,
          cacheCreationTokens: 0,
          reasoningTokens: 1920,
          totalTokens: 26746,
        },
      }),
    );

    const job = {
      id: "job-grok-1",
      provider: "grok",
      cwd,
      startedAt: "2026-11-05T10:17:34.600Z",
      finishedAt: "2026-11-05T10:18:05.800Z",
    };

    const usage = grokUsageFor(job, { grokDir: tmpDir });
    assert.deepEqual(usage, {
      input: 17665,
      output: 2041,
      cacheRead: 7040,
      total: 26746,
      source: "session-near",
    });

    // 时间窗外（早于 startedAt - 30s 或晚于 finishedAt + 30s）不匹配
    const outOfWindowJob = {
      ...job,
      startedAt: "2026-11-05T10:00:00.000Z",
      finishedAt: "2026-11-05T10:05:00.000Z",
    };
    assert.equal(grokUsageFor(outOfWindowJob, { grokDir: tmpDir }), null);

    // cwd 不同不匹配
    const otherCwdJob = {
      ...job,
      cwd: "/tmp/workspace/other-project",
    };
    assert.equal(grokUsageFor(otherCwdJob, { grokDir: tmpDir }), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("3. agy SQLite 库匹配与多行累加：手工编码 protobuf，测累加、时间窗外不匹配、cwd 不同不匹配", () => {
  const tmpDir = makeTempDir("relay-agy-usage-");
  try {
    const cwd = "/tmp/workspace/ai-relay/plugins/ai-relay";
    const parentCwd = "/tmp/workspace/ai-relay";
    const dbPath = path.join(tmpDir, "fake-cascade.db");

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
    `);
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)").run(
      "main",
      encodeAgyTrajectoryBlob(cwd, parentCwd),
    );
    // 插入两行模型调用，测试累加：8000 + 3103 = 11103，500 + 615 = 1115
    const insertGen = db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)");
    const row0 = encodeAgyGenRow({ input: 8000, output: 500 });
    const row1 = encodeAgyGenRow({ input: 3103, output: 615 });
    insertGen.run(0, row0, row0.length);
    insertGen.run(1, row1, row1.length);
    db.close();

    const st = fs.statSync(dbPath);
    const birthMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;

    const job = {
      id: "job-agy-1",
      provider: "agy",
      cwd,
      startedAt: new Date(birthMs - 2000).toISOString(),
      finishedAt: new Date(birthMs + 10000).toISOString(),
    };

    const usage = agyUsageFor(job, { agyDir: tmpDir });
    assert.deepEqual(usage, {
      input: 11103,
      output: 1115,
      cacheRead: 0,
      total: 12218,
      source: "fake-cascade.db",
    });

    // 时间窗外（相差超过 30s）不匹配
    const outOfWindowJob = {
      ...job,
      startedAt: new Date(birthMs - 120_000).toISOString(),
      finishedAt: new Date(birthMs - 60_000).toISOString(),
    };
    assert.equal(agyUsageFor(outOfWindowJob, { agyDir: tmpDir }), null);

    // cwd 完全不同不匹配
    const diffCwdJob = {
      ...job,
      cwd: "/tmp/workspace/another-repo",
    };
    assert.equal(agyUsageFor(diffCwdJob, { agyDir: tmpDir }), null);

    // 父目录（git root）与子目录 cwd 不同，不能把子目录会话误匹配给父目录任务
    const parentCwdJob = {
      ...job,
      cwd: parentCwd,
    };
    assert.equal(agyUsageFor(parentCwdJob, { agyDir: tmpDir }), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("4. backfill：回填无 usage 的历史任务并写回磁盘 JSON，跳过已有 usage 与 running 任务", () => {
  const tmpDir = makeTempDir("relay-backfill-");
  try {
    const grokDir = path.join(tmpDir, "grok");
    const agyDir = path.join(tmpDir, "agy");
    const jobsDir = path.join(tmpDir, "jobs");
    fs.mkdirSync(grokDir, { recursive: true });
    fs.mkdirSync(agyDir, { recursive: true });
    fs.mkdirSync(jobsDir, { recursive: true });

    const cwd = "/tmp/workspace/backfill-proj";

    // 造一条 Grok 会话
    const gSession = path.join(grokDir, encodeURIComponent(cwd), "s-1");
    fs.mkdirSync(gSession, { recursive: true });
    fs.writeFileSync(
      path.join(gSession, "summary.json"),
      JSON.stringify({ info: { cwd }, created_at: "2026-11-05T08:00:02.000Z" }),
    );
    fs.writeFileSync(
      path.join(gSession, "usage.json"),
      JSON.stringify({ session: { inputTokens: 1500, outputTokens: 300, cachedReadTokens: 500, totalTokens: 1800 } }),
    );

    // 造一条 agy 会话
    const dbPath = path.join(agyDir, "c-1.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)").run("main", encodeAgyTrajectoryBlob(cwd));
    db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(0, encodeAgyGenRow({ input: 2000, output: 400 }));
    db.close();
    const birthMs = fs.statSync(dbPath).birthtimeMs;

    const jobGrok = {
      id: "20261105080000-grok-aaaa",
      provider: "grok",
      status: "done",
      cwd,
      startedAt: "2026-11-05T08:00:00.000Z",
      finishedAt: "2026-11-05T08:00:10.000Z",
    };
    const jobAgy = {
      id: "20261105090000-agy-bbbb",
      provider: "agy",
      status: "timeout",
      cwd,
      startedAt: new Date(birthMs - 1000).toISOString(),
      finishedAt: new Date(birthMs + 5000).toISOString(),
    };
    const jobUnmatched = {
      id: "20261105070000-grok-cccc",
      provider: "grok",
      status: "done",
      cwd: "/tmp/workspace/missing",
      startedAt: "2026-11-05T07:00:00.000Z",
      finishedAt: "2026-11-05T07:01:00.000Z",
    };
    const jobExisting = {
      id: "20261105060000-agy-dddd",
      provider: "agy",
      status: "done",
      cwd,
      startedAt: "2026-11-05T06:00:00.000Z",
      finishedAt: "2026-11-05T06:01:00.000Z",
      usage: { input: 1, output: 2, cacheRead: 0, total: 3 },
    };

    for (const j of [jobGrok, jobAgy, jobUnmatched, jobExisting]) {
      fs.writeFileSync(path.join(jobsDir, `${j.id}.json`), JSON.stringify(j, null, 2));
    }

    const res = backfill({ jobsDir, grokDir, agyDir });
    assert.equal(res.filled, 2);
    assert.equal(res.unmatched, 1);
    assert.equal(res.skipped, 1);

    const savedGrok = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobGrok.id}.json`), "utf8"));
    assert.deepEqual(savedGrok.usage, { input: 1000, output: 300, cacheRead: 500, total: 1800, source: "s-1" });

    const savedAgy = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobAgy.id}.json`), "utf8"));
    assert.deepEqual(savedAgy.usage, { input: 2000, output: 400, cacheRead: 0, total: 2400, source: "c-1.db" });

    const savedUnmatched = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobUnmatched.id}.json`), "utf8"));
    assert.equal(savedUnmatched.usage, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("5. 两个同秒并发任务分到两个不同的库：按任务 startedAt 升序与候选创建时间升序依次配对不交叉", () => {
  const tmpDir = makeTempDir("relay-concurrent-");
  try {
    const agyDir = path.join(tmpDir, "agy");
    const jobsDir = path.join(tmpDir, "jobs");
    fs.mkdirSync(agyDir, { recursive: true });
    fs.mkdirSync(jobsDir, { recursive: true });

    const cwd = "/tmp/workspace/concurrent-proj";

    // 先创建第一个库 db-early.db
    const db1Path = path.join(agyDir, "db-early.db");
    const db1 = new DatabaseSync(db1Path);
    db1.exec(`
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    db1.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)").run("main", encodeAgyTrajectoryBlob(cwd));
    db1.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(0, encodeAgyGenRow({ input: 5000, output: 500 }));
    db1.close();

    // 间隔 20ms 确保第二个库的 birthtimeMs 严格大于第一个库
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);

    // 再创建第二个库 db-late.db
    const db2Path = path.join(agyDir, "db-late.db");
    const db2 = new DatabaseSync(db2Path);
    db2.exec(`
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    db2.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)").run("main", encodeAgyTrajectoryBlob(cwd));
    db2.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(0, encodeAgyGenRow({ input: 7000, output: 700 }));
    db2.close();

    const birth1 = fs.statSync(db1Path).birthtimeMs;

    // 两个同秒并发任务（相差 80ms，原本离 db-early.db 都比离 db-late.db 近）
    const job1 = {
      id: "20261105140608-agy-1aid",
      provider: "agy",
      status: "timeout",
      cwd,
      startedAt: new Date(birth1 - 2000).toISOString(),
      finishedAt: new Date(birth1 + 10000).toISOString(),
    };
    const job2 = {
      id: "20261105140608-agy-3mm6",
      provider: "agy",
      status: "timeout",
      cwd,
      startedAt: new Date(birth1 - 1920).toISOString(),
      finishedAt: new Date(birth1 + 11000).toISOString(),
    };

    // 故意按逆序传入，验证 backfill 仍按 startedAt 升序与候选创建时间升序配对
    const res = backfill([job2, job1], { agyDir, jobsDir });
    assert.equal(res.filled, 2);
    assert.equal(res.unmatched, 0);
    assert.deepEqual(job1.usage, { input: 5000, output: 500, cacheRead: 0, total: 5500, source: "db-early.db" });
    assert.deepEqual(job2.usage, { input: 7000, output: 700, cacheRead: 0, total: 7700, source: "db-late.db" });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("6. 同一来源不会被两个任务占用：候选数少于任务数或来源已被已有任务占用时不写 usage，--redo 可重算", () => {
  const tmpDir = makeTempDir("relay-unique-source-");
  try {
    const agyDir = path.join(tmpDir, "agy");
    const jobsDir = path.join(tmpDir, "jobs");
    fs.mkdirSync(agyDir, { recursive: true });
    fs.mkdirSync(jobsDir, { recursive: true });

    const cwd = "/tmp/workspace/single-db-proj";
    const dbPath = path.join(agyDir, "only-one.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)").run("main", encodeAgyTrajectoryBlob(cwd));
    db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(0, encodeAgyGenRow({ input: 3000, output: 300 }));
    db.close();
    const birthMs = fs.statSync(dbPath).birthtimeMs;

    // 模拟历史中两个任务都错误地指向了旧 usage（无 source 或重复）
    const job1 = {
      id: "20261105100000-agy-j1",
      provider: "agy",
      status: "done",
      cwd,
      startedAt: new Date(birthMs - 2000).toISOString(),
      finishedAt: new Date(birthMs + 5000).toISOString(),
      usage: { input: 3000, output: 300, cacheRead: 0, total: 3300 },
    };
    const job2 = {
      id: "20261105100000-agy-j2",
      provider: "agy",
      status: "done",
      cwd,
      startedAt: new Date(birthMs - 1500).toISOString(),
      finishedAt: new Date(birthMs + 6000).toISOString(),
      usage: { input: 3000, output: 300, cacheRead: 0, total: 3300 },
    };
    fs.writeFileSync(path.join(jobsDir, `${job1.id}.json`), JSON.stringify(job1, null, 2));
    fs.writeFileSync(path.join(jobsDir, `${job2.id}.json`), JSON.stringify(job2, null, 2));

    // 使用 redo 清掉旧 usage 并重算：只有一个库，job1 拿到 only-one.db，job2 宁可不写 usage 也不重复记
    const res = backfill({ jobsDir, agyDir, redo: true });
    assert.equal(res.filled, 1);
    assert.equal(res.unmatched, 1);
    assert.equal(res.skipped, 0);

    const saved1 = JSON.parse(fs.readFileSync(path.join(jobsDir, `${job1.id}.json`), "utf8"));
    const saved2 = JSON.parse(fs.readFileSync(path.join(jobsDir, `${job2.id}.json`), "utf8"));
    assert.deepEqual(saved1.usage, { input: 3000, output: 300, cacheRead: 0, total: 3300, source: "only-one.db" });
    assert.equal(saved2.usage, undefined);

    // 任务结束时单独调用 agyUsageFor 也先读出 jobsDir 已占用的 source，不会重复占用 only-one.db
    const job3 = {
      id: "20261105100001-agy-j3",
      provider: "agy",
      status: "done",
      cwd,
      startedAt: new Date(birthMs - 1000).toISOString(),
      finishedAt: new Date(birthMs + 7000).toISOString(),
    };
    assert.equal(agyUsageFor(job3, { agyDir, jobsDir }), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("7. executor_metadata 兜底：trajectory_metadata_blob 为空 0 字节或无 file:/// 时从 executor_metadata 匹配目录", () => {
  const tmpDir = makeTempDir("relay-exec-fallback-");
  try {
    const cwd = "/tmp/workspace/subagent-proj/backend";
    const dbPath = path.join(tmpDir, "subagent-session.db");

    // 构造真实 executor_metadata 结构：10 -> 12: file:///<cwd>，后面紧跟字段 13（tag = 0x6a = 'j'）
    const field10 = Buffer.concat([
      encodeBytesField(12, `file://${cwd}`),
      encodeBytesField(13, "next-field"),
    ]);
    const execBlob = encodeBytesField(10, field10);

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    // trajectory_metadata_blob 的 data 为 0 字节空 Buffer
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)").run("main", Buffer.alloc(0));
    db.prepare("INSERT INTO executor_metadata (idx, data) VALUES (?, ?)").run(0, execBlob);
    db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(0, encodeAgyGenRow({ input: 15000, output: 2500 }));
    db.close();

    const birthMs = fs.statSync(dbPath).birthtimeMs;
    const job = {
      id: "job-subagent-1",
      provider: "agy",
      cwd,
      startedAt: new Date(birthMs - 2000).toISOString(),
      finishedAt: new Date(birthMs + 8000).toISOString(),
    };

    const usage = agyUsageFor(job, { agyDir: tmpDir });
    assert.deepEqual(usage, {
      input: 15000,
      output: 2500,
      cacheRead: 0,
      total: 17500,
      source: "subagent-session.db",
    });

    // 父目录或其他目录不误匹配
    const parentJob = { ...job, cwd: "/tmp/workspace/subagent-proj" };
    assert.equal(agyUsageFor(parentJob, { agyDir: tmpDir }), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("8. running 任务的 liveUsage 被算出且不写回 job json，且不持久占用 source", () => {
  const tmpDir = makeTempDir("relay-live-usage-");
  try {
    const grokDir = path.join(tmpDir, "grok");
    const agyDir = path.join(tmpDir, "agy");
    const jobsDir = path.join(tmpDir, "jobs");
    fs.mkdirSync(grokDir, { recursive: true });
    fs.mkdirSync(agyDir, { recursive: true });
    fs.mkdirSync(jobsDir, { recursive: true });

    const cwdAgy = "/tmp/workspace/live-proj/agy";
    const cwdGrok = "/tmp/workspace/live-proj/grok";

    // 构造 agy 会话库
    const dbPath = path.join(agyDir, "live-agy.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)").run("main", encodeAgyTrajectoryBlob(cwdAgy));
    db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(0, encodeAgyGenRow({ input: 12000, output: 800 }));
    db.close();

    // 构造 grok 会话目录
    const gSession = path.join(grokDir, encodeURIComponent(cwdGrok), "live-grok-sid");
    fs.mkdirSync(gSession, { recursive: true });
    fs.writeFileSync(
      path.join(gSession, "summary.json"),
      JSON.stringify({ info: { id: "live-grok-sid", cwd: cwdGrok }, created_at: "2026-11-05T12:00:02.000Z" }),
    );
    fs.writeFileSync(
      path.join(gSession, "usage.json"),
      JSON.stringify({ session: { inputTokens: 5000, outputTokens: 600, cachedReadTokens: 1000, totalTokens: 5600 } }),
    );

    const birthMs = fs.statSync(dbPath).birthtimeMs;
    const runningAgyJob = {
      id: "job-agy-running",
      provider: "agy",
      status: "running",
      cwd: cwdAgy,
      startedAt: new Date(birthMs - 1000).toISOString(),
      finishedAt: null,
    };
    const runningGrokJob = {
      id: "job-grok-running",
      provider: "grok",
      status: "running",
      cwd: cwdGrok,
      startedAt: "2026-11-05T12:00:00.000Z",
      finishedAt: null,
    };
    const doneJob = {
      id: "job-done",
      provider: "agy",
      status: "done",
      cwd: cwdAgy,
      startedAt: "2026-11-05T11:00:00.000Z",
      finishedAt: "2026-11-05T11:01:00.000Z",
    };

    // 写入磁盘 json
    fs.writeFileSync(path.join(jobsDir, `${runningAgyJob.id}.json`), JSON.stringify(runningAgyJob, null, 2));
    fs.writeFileSync(path.join(jobsDir, `${runningGrokJob.id}.json`), JSON.stringify(runningGrokJob, null, 2));
    fs.writeFileSync(path.join(jobsDir, `${doneJob.id}.json`), JSON.stringify(doneJob, null, 2));

    const jobsList = [{ ...runningAgyJob }, { ...runningGrokJob }, { ...doneJob }];
    attachLiveUsage(jobsList, { jobsDir, agyDir, grokDir });

    // 1. liveUsage 被正确算出
    assert.deepEqual(jobsList[0].liveUsage, {
      input: 12000,
      output: 800,
      cacheRead: 0,
      total: 12800,
      source: "live-agy.db",
    });
    assert.deepEqual(jobsList[1].liveUsage, {
      input: 4000,
      output: 600,
      cacheRead: 1000,
      total: 5600,
      source: "live-grok-sid",
    });
    // 已完成任务没有 liveUsage
    assert.equal(jobsList[2].liveUsage, undefined);

    // 2. 磁盘 job json 未被修改（不写回 usage 与 liveUsage）
    const diskAgy = JSON.parse(fs.readFileSync(path.join(jobsDir, `${runningAgyJob.id}.json`), "utf8"));
    assert.equal(diskAgy.usage, undefined);
    assert.equal(diskAgy.liveUsage, undefined);
    assert.equal(diskAgy.status, "running");

    const diskGrok = JSON.parse(fs.readFileSync(path.join(jobsDir, `${runningGrokJob.id}.json`), "utf8"));
    assert.equal(diskGrok.usage, undefined);
    assert.equal(diskGrok.liveUsage, undefined);
    assert.equal(diskGrok.status, "running");

    // 3. 不持久占用 source：任务结束后执行 backfill，该 source 能正常配对写入
    const diskAgyFinished = { ...diskAgy, status: "done", finishedAt: new Date(birthMs + 5000).toISOString() };
    fs.writeFileSync(path.join(jobsDir, `${runningAgyJob.id}.json`), JSON.stringify(diskAgyFinished, null, 2));
    const bf = backfill({ jobsDir, agyDir, grokDir });
    assert.equal(bf.filled, 1);
    assert.deepEqual(bf.items[0], {
      id: runningAgyJob.id,
      provider: "agy",
      usage: { input: 12000, output: 800, cacheRead: 0, total: 12800, source: "live-agy.db" },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
