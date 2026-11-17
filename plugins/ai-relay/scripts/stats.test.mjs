import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sampleQuotaHistory, lastCycles, workStats } from "./stats.mjs";

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-stats-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("1. 周期转换与同一周期去重：窗口跨周期时追加 cycles，同周期不追加", () => {
  withTempDir((stateDir) => {
    const T1 = 1700000000000;
    const sampleAt1 = T1 - 2 * 3600_000;

    // 第一次采样：剩 0.35，resetAt = T1
    const row1 = {
      provider: "claude",
      pool_id: "claude-sub",
      window_key: "5h",
      remaining_fraction: 0.35,
      reset_at: T1,
      updated_at: sampleAt1,
    };
    const res1 = sampleQuotaHistory(stateDir, [row1]);
    assert.equal(res1.cycles.length, 0, "首次采样无历史周期，不应产生 cycle");
    assert.deepEqual(res1.last["claude|claude-sub|5h"], {
      remaining: 0.35,
      resetAt: T1,
      at: sampleAt1,
    });

    // 同一周期内再次采样：剩 0.20，resetAt 仍为 T1
    const sampleAt2 = T1 - 1 * 3600_000;
    const row2 = {
      provider: "claude",
      pool_id: "claude-sub",
      window_key: "5h",
      remaining_fraction: 0.20,
      reset_at: T1,
      updated_at: sampleAt2,
    };
    const res2 = sampleQuotaHistory(stateDir, [row2]);
    assert.equal(res2.cycles.length, 0, "同一周期重复采样不追加 cycle");
    assert.deepEqual(res2.last["claude|claude-sub|5h"], {
      remaining: 0.20,
      resetAt: T1,
      at: sampleAt2,
    });

    // 新周期：变成剩 1.0，resetAt = T1 + 7 天
    const T2 = T1 + 7 * 24 * 3600_000;
    const sampleAt3 = T1 + 3600_000;
    const row3 = {
      provider: "claude",
      pool_id: "claude-sub",
      window_key: "5h",
      remaining_fraction: 1.0,
      reset_at: T2,
      updated_at: sampleAt3,
    };
    const res3 = sampleQuotaHistory(stateDir, [row3]);
    assert.equal(res3.cycles.length, 1, "跨周期时应追加一条 cycle");
    assert.deepEqual(res3.cycles[0], {
      provider: "claude",
      pool: "claude-sub",
      window: "5h",
      leftover: 0.20,
      endedAt: T1,
      sampledAt: sampleAt2,
    });
    assert.deepEqual(res3.last["claude|claude-sub|5h"], {
      remaining: 1.0,
      resetAt: T2,
      at: sampleAt3,
    });

    // 验证磁盘写入
    const diskData = JSON.parse(fs.readFileSync(path.join(stateDir, "quota-history.json"), "utf8"));
    assert.equal(diskData.cycles.length, 1);
    assert.equal(diskData.cycles[0].leftover, 0.20);
    assert.equal(diskData.cycles[0].endedAt, T1);
  });
});

test("2. lastCycles 按「厂商|额度池|窗口」各取最新一条，同一池不同窗口均保留，采样超 12 小时 reliable 为 false", () => {
  withTempDir((stateDir) => {
    const T1 = 1700000000000;
    const T2 = T1 + 24 * 3600_000;

    // 直接写入包含多条历史记录的文件
    const historyData = {
      last: {},
      cycles: [
        // 池 1 早期 5h 记录（10小时前采样，本应可靠，但不是最新）
        {
          provider: "claude",
          pool: "claude-sub",
          window: "5h",
          leftover: 0.15,
          endedAt: T1,
          sampledAt: T1 - 2 * 3600_000,
        },
        // 池 1 最新 5h 记录（采样距结束 14 小时，> 12 小时，reliable 应为 false）
        {
          provider: "claude",
          pool: "claude-sub",
          window: "5h",
          leftover: 0.40,
          endedAt: T2,
          sampledAt: T2 - 14 * 3600_000,
        },
        // 池 1 的 weekly 窗口记录（同一额度池，weekly 窗口结束，采样距结束 1 小时，reliable 应为 true）
        {
          provider: "claude",
          pool: "claude-sub",
          window: "weekly",
          leftover: 0.80,
          endedAt: T1,
          sampledAt: T1 - 1 * 3600_000,
        },
        // 池 2 最新 weekly 记录（采样距结束 6 小时，<= 12 小时，reliable 应为 true）
        {
          provider: "codex",
          pool: "codex-sub",
          window: "weekly",
          leftover: 0.55,
          endedAt: T1,
          sampledAt: T1 - 6 * 3600_000,
        },
      ],
    };
    fs.writeFileSync(path.join(stateDir, "quota-history.json"), JSON.stringify(historyData));

    const result = lastCycles(stateDir);

    // claude 池 5h 窗口取最新的 T2，reliable 为 false
    assert.deepEqual(result["claude|claude-sub|5h"], {
      window: "5h",
      leftover: 0.40,
      endedAt: T2,
      reliable: false,
    });

    // claude 池 weekly 窗口同时保留（不会被 5h 冲掉），取 T1，reliable 为 true
    assert.deepEqual(result["claude|claude-sub|weekly"], {
      window: "weekly",
      leftover: 0.80,
      endedAt: T1,
      reliable: true,
    });

    // codex 池 weekly 窗口取 T1，reliable 为 true
    assert.deepEqual(result["codex|codex-sub|weekly"], {
      window: "weekly",
      leftover: 0.55,
      endedAt: T1,
      reliable: true,
    });
  });
});

test("3. 超过 60 条只保留最后 60 条；cli-limit 行与非法 remaining_fraction 行被忽略", () => {
  withTempDir((stateDir) => {
    // 构造预存 65 条 cycles 的数据
    const existingCycles = [];
    for (let i = 0; i < 65; i++) {
      existingCycles.push({
        provider: "p",
        pool: "pool",
        window: "w",
        leftover: i * 0.01,
        endedAt: 1000 + i * 10000,
        sampledAt: 1000 + i * 10000 - 100,
      });
    }
    fs.writeFileSync(
      path.join(stateDir, "quota-history.json"),
      JSON.stringify({ last: {}, cycles: existingCycles }),
    );

    // 传入包含 cli-limit、非数值 remaining_fraction 以及一条合法记录的 rows
    const rows = [
      {
        provider: "claude",
        pool_id: "claude-sub",
        window_key: "cli-limit",
        remaining_fraction: 0.8,
        reset_at: 5000,
      },
      {
        provider: "claude",
        pool_id: "claude-sub",
        window_key: "5h",
        remaining_fraction: "invalid",
        reset_at: 5000,
      },
      {
        provider: "claude",
        pool_id: "claude-sub",
        window_key: "5h",
        remaining_fraction: null,
        reset_at: 5000,
      },
      {
        provider: "valid-p",
        pool_id: "valid-pool",
        window_key: "5h",
        remaining_fraction: 0.9,
        reset_at: 6000,
      },
    ];

    const res = sampleQuotaHistory(stateDir, rows);

    // 超过 60 条截断至 60
    assert.equal(res.cycles.length, 60, "cycles 必须只保留最后 60 条");
    // 保留的是最新的（末尾的 60 条，原下标 5 到 64）
    assert.equal(res.cycles[0].leftover, 0.05);
    assert.equal(res.cycles[59].leftover, 0.64);

    // cli-limit 与非法 remaining_fraction 均未写入 last
    assert.equal(res.last["claude|claude-sub|cli-limit"], undefined);
    assert.equal(res.last["claude|claude-sub|5h"], undefined);
    // 合法记录写入 last
    assert.deepEqual(res.last["valid-p|valid-pool|5h"], {
      remaining: 0.9,
      resetAt: 6000,
      at: res.last["valid-p|valid-pool|5h"].at,
    });
  });
});

test("4. workStats：用构造数据核对每个字段，超出 days 的记录不计、分母为 0 时 workerShare 为 null", () => {
  const now = 1700000000000;
  const days = 7;
  const dayMs = 86400_000;

  const jobs = [
    // 3 天前，会话 s1，可写任务，改动 120 行
    {
      id: "j1",
      provider: "agy",
      model: "claude-opus",
      write: true,
      status: "finished",
      startedAt: now - 3 * dayMs,
      changedLines: 120,
      sessionId: "s1",
    },
    // 2 天前，会话 s1，可写任务，改动 80 行
    {
      id: "j2",
      provider: "agy",
      model: "claude-opus",
      write: true,
      status: "finished",
      startedAt: now - 2 * dayMs,
      changedLines: 80,
      sessionId: "s1",
    },
    // 1 天前，会话 s2，可写任务，改动 50 行
    {
      id: "j3",
      provider: "grok",
      model: "grok-3",
      write: true,
      status: "finished",
      startedAt: now - 1 * dayMs,
      changedLines: 50,
      sessionId: "s2",
    },
    // 1 天前，会话 s2，只读任务（write: false），改动 100 行不应计入 workerLines
    {
      id: "j4",
      provider: "grok",
      model: "grok-3",
      write: false,
      status: "finished",
      startedAt: now - 1 * dayMs,
      changedLines: 100,
      sessionId: "s2",
    },
    // 10 天前，超出 7 天范围，不应计入
    {
      id: "j5",
      provider: "codex",
      model: "o3-mini",
      write: true,
      status: "finished",
      startedAt: now - 10 * dayMs,
      changedLines: 300,
      sessionId: "s3",
    },
  ];

  const rounds = [
    // 轮次 1：4 天前开始，1.5 天前结束，包含 j1 和 j2（可写外派），selfLines 为 50
    {
      sessionId: "s1",
      startedAt: now - 4 * dayMs,
      finishedAt: now - 1.5 * dayMs,
      selfLines: 50,
    },
    // 轮次 2：1.2 天前开始，0.5 天前结束，包含 j3（可写外派），selfLines 为 0
    {
      sessionId: "s2",
      startedAt: now - 1.2 * dayMs,
      finishedAt: now - 0.5 * dayMs,
      selfLines: 0,
    },
    // 轮次 3：2 天前开始，无外派任务，selfLines 为 30
    {
      sessionId: "s4",
      startedAt: now - 2 * dayMs,
      finishedAt: now - 1 * dayMs,
      selfLines: 30,
    },
    // 轮次 4：1 天前开始，finishedAt 为空（默认到 now），无外派且 selfLines 为 0
    {
      sessionId: "s5",
      startedAt: now - 1 * dayMs,
      finishedAt: null,
      selfLines: 0,
    },
    // 轮次 5：10 天前，超出 7 天范围，不应计入
    {
      sessionId: "s6",
      startedAt: now - 10 * dayMs,
      finishedAt: now - 9 * dayMs,
      selfLines: 200,
    },
  ];

  const stats = workStats({ jobs, rounds, days, now });

  // 1. workerLines：j1(120) + j2(80) + j3(50) = 250
  assert.equal(stats.workerLines, 250);

  // 2. byWorker：按 provider/model 分组
  assert.deepEqual(stats.byWorker, {
    "agy/claude-opus": 200,
    "grok/grok-3": 50,
  });

  // 3. selfLines：50 + 0 + 30 + 0 = 80
  assert.equal(stats.selfLines, 80);

  // 4. rounds：
  //    edited：round 1 (有外派+self50), round 2 (有外派), round 3 (self30) => 3 轮
  //    withWriteDispatch：round 1, round 2 => 2 轮
  assert.deepEqual(stats.rounds, {
    edited: 3,
    withWriteDispatch: 2,
  });

  // 5. workerShare：250 / (250 + 80) = 250 / 330
  assert.equal(stats.workerShare, 250 / 330);

  // 6. 分母为 0 边界：无任务和轮次
  const emptyStats = workStats({ jobs: [], rounds: [], days, now });
  assert.equal(emptyStats.workerLines, 0);
  assert.deepEqual(emptyStats.byWorker, {});
  assert.equal(emptyStats.selfLines, 0);
  assert.deepEqual(emptyStats.rounds, { edited: 0, withWriteDispatch: 0 });
  assert.equal(emptyStats.workerShare, null, "分母为 0 时 workerShare 应为 null");

  // 7. 默认参数安全调用
  const defaultStats = workStats();
  assert.equal(defaultStats.workerLines, 0);
  assert.equal(defaultStats.workerShare, null);
});

test("5. workStats：支持任务 startedAt 为 ISO 字符串且结果与毫秒数字一致，支持 changedLines 缺失，丢弃非法日期", () => {
  const now = 1700000000000;
  const days = 7;
  const dayMs = 86400_000;

  // 与测试 4 对应的时间与参数，但 startedAt 均使用 ISO 字符串
  const jobs = [
    // 3 天前，会话 s1，可写任务，改动 120 行，startedAt 为 ISO 字符串
    {
      id: "j1",
      provider: "agy",
      model: "claude-opus",
      write: true,
      status: "finished",
      startedAt: new Date(now - 3 * dayMs).toISOString(),
      changedLines: 120,
      sessionId: "s1",
    },
    // 2 天前，会话 s1，可写任务，改动 80 行
    {
      id: "j2",
      provider: "agy",
      model: "claude-opus",
      write: true,
      status: "finished",
      startedAt: new Date(now - 2 * dayMs).toISOString(),
      changedLines: 80,
      sessionId: "s1",
    },
    // 1 天前，会话 s2，可写任务，改动 50 行
    {
      id: "j3",
      provider: "grok",
      model: "grok-3",
      write: true,
      status: "finished",
      startedAt: new Date(now - 1 * dayMs).toISOString(),
      changedLines: 50,
      sessionId: "s2",
    },
    // 1 天前，会话 s2，只读任务（write: false），改动 100 行不应计入 workerLines
    {
      id: "j4",
      provider: "grok",
      model: "grok-3",
      write: false,
      status: "finished",
      startedAt: new Date(now - 1 * dayMs).toISOString(),
      changedLines: 100,
      sessionId: "s2",
    },
    // 1.5 天前，会话 s1，可写任务但缺失 changedLines 字段（应视为 0，不影响总行数）
    {
      id: "j-no-lines",
      provider: "agy",
      model: "claude-opus",
      write: true,
      status: "finished",
      startedAt: new Date(now - 1.5 * dayMs).toISOString(),
      sessionId: "s1",
    },
    // 2 天前，非法的 startedAt 字符串，应被丢弃
    {
      id: "j-invalid-date",
      provider: "agy",
      model: "claude-opus",
      write: true,
      status: "finished",
      startedAt: "invalid-iso-string",
      changedLines: 500,
      sessionId: "s1",
    },
    // 10 天前，超出 7 天范围，不应计入
    {
      id: "j5",
      provider: "codex",
      model: "o3-mini",
      write: true,
      status: "finished",
      startedAt: new Date(now - 10 * dayMs).toISOString(),
      changedLines: 300,
      sessionId: "s3",
    },
  ];

  const rounds = [
    // 轮次 1：4 天前开始，1.5 天前结束，包含 j1, j2, j-no-lines（可写外派），selfLines 为 50
    {
      sessionId: "s1",
      startedAt: now - 4 * dayMs,
      finishedAt: now - 1.5 * dayMs,
      selfLines: 50,
    },
    // 轮次 2：1.2 天前开始，0.5 天前结束，包含 j3（可写外派），selfLines 为 0
    {
      sessionId: "s2",
      startedAt: now - 1.2 * dayMs,
      finishedAt: now - 0.5 * dayMs,
      selfLines: 0,
    },
    // 轮次 3：2 天前开始，无外派任务，selfLines 为 30
    {
      sessionId: "s4",
      startedAt: now - 2 * dayMs,
      finishedAt: now - 1 * dayMs,
      selfLines: 30,
    },
    // 轮次 4：1 天前开始，finishedAt 为空（默认到 now），无外派且 selfLines 为 0
    {
      sessionId: "s5",
      startedAt: now - 1 * dayMs,
      finishedAt: null,
      selfLines: 0,
    },
    // 轮次 5：10 天前，超出 7 天范围，不应计入
    {
      sessionId: "s6",
      startedAt: now - 10 * dayMs,
      finishedAt: now - 9 * dayMs,
      selfLines: 200,
    },
  ];

  const stats = workStats({ jobs, rounds, days, now });

  // 1. workerLines：j1(120) + j2(80) + j3(50) + j-no-lines(0) = 250，与测试 4 一致
  assert.equal(stats.workerLines, 250);

  // 2. byWorker：按 provider/model 分组
  assert.deepEqual(stats.byWorker, {
    "agy/claude-opus": 200,
    "grok/grok-3": 50,
  });

  // 3. selfLines：50 + 0 + 30 + 0 = 80，与测试 4 一致
  assert.equal(stats.selfLines, 80);

  // 4. rounds：
  //    edited：round 1 (有外派+self50), round 2 (有外派), round 3 (self30) => 3 轮
  //    withWriteDispatch：round 1, round 2 => 2 轮
  assert.deepEqual(stats.rounds, {
    edited: 3,
    withWriteDispatch: 2,
  });

  // 5. workerShare：250 / (250 + 80) = 250 / 330，与测试 4 一致
  assert.equal(stats.workerShare, 250 / 330);
});
