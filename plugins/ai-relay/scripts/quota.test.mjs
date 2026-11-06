// Grok 额度响应解析的单元测试：手工拼出 gRPC-web + protobuf 响应
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGrokCredits, codexRows, rowsFromCodexSnapshot } from "./quota.mjs";
import { poolStatus } from "./lib.mjs";

const varint = (n) => {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
};
const tag = (field, wire) => varint(field * 8 + wire);
const msg = (field, body) => Buffer.concat([tag(field, 2), varint(body.length), body]);
const int = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const float = (field, f) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(f);
  return Buffer.concat([tag(field, 5), b]);
};
const frame = (flags, body) => {
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};
const start = 1793324820, end = start + 7 * 86400;
const period = (kind = 2) => Buffer.concat([int(1, kind), msg(2, int(1, start)), msg(3, int(1, end))]);
const response = (configParts) => frame(0, msg(1, Buffer.concat(configParts)));

test("解析已用百分比和周期", () => {
  const r = parseGrokCredits(response([float(1, 24), msg(8, period()), int(11, 1)]));
  assert.equal(Math.round(r.usedPercent), 24);
  assert.equal(r.periodStart, start * 1000);
  assert.equal(r.periodEnd, end * 1000);
});

test("统一周额度账户省略百分比时按 0 处理，其他账户按未知", () => {
  assert.equal(parseGrokCredits(response([msg(8, period()), int(11, 1)])).usedPercent, 0);
  assert.equal(parseGrokCredits(response([msg(8, period())])).usedPercent, null);
});

test("不是按周的周期、尾帧报错时抛错", () => {
  assert.throws(() => parseGrokCredits(response([msg(8, period(1))])), /不是按周/);
  const trailer = frame(0x80, Buffer.from("grpc-status: 16\r\n"));
  assert.throws(() => parseGrokCredits(Buffer.concat([response([msg(8, period())]), trailer])), /grpc-status 16/);
});

// 会话里的 token_count 事件。只放额度字段，不带身份信息
const codexEvent = (timestamp, limits) => JSON.stringify({
  timestamp,
  type: "event_msg",
  payload: { type: "token_count", rate_limits: { limit_id: "codex", plan_type: "plus", ...limits } },
});

const windowOf = (rows, key) => rows.find((r) => r.window_key === key);

test("Codex 额度按记录时间取最新一条，不看会话文件的修改时间", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-codex-"));
  try {
    const freshDir = path.join(home, ".codex", "sessions", "2026", "11", "06");
    const staleDir = path.join(home, ".codex", "sessions", "2026", "11", "03");
    fs.mkdirSync(freshDir, { recursive: true });
    fs.mkdirSync(staleDir, { recursive: true });
    // 先写真正最新的额度：5 小时已用 98%（剩 2%），每周已用 47%（剩 53%）
    const fresh = path.join(freshDir, "fresh.jsonl");
    fs.writeFileSync(fresh, [
      "不是 json",
      codexEvent("2026-11-06T03:30:00.000Z", {
        primary: { used_percent: 80, window_minutes: 300, resets_at: 1793951647 },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1794463675 },
      }),
      codexEvent("2026-11-06T03:38:23.716Z", {
        primary: { used_percent: 98, window_minutes: 300, resets_at: 1793951647 },
        secondary: { used_percent: 47, window_minutes: 10080, resets_at: 1794463675 },
      }),
    ].join("\n") + "\n");
    // 后写的文件修改时间更新，但额度还停在上一个 5 小时窗口：已用 5% / 70%
    const stale = path.join(staleDir, "stale.jsonl");
    fs.writeFileSync(stale, [
      codexEvent("2026-11-04T04:56:36.527Z", {
        primary: { used_percent: 5, window_minutes: 300, resets_at: 1793785678 },
        secondary: { used_percent: 70, window_minutes: 10080, resets_at: 1793985443 },
      }),
      JSON.stringify({ timestamp: "2026-11-06T05:37:19.685Z", type: "event_msg", payload: { type: "other" } }),
    ].join("\n") + "\n");
    assert.ok(fs.statSync(stale).mtimeMs >= fs.statSync(fresh).mtimeMs);

    const rows = codexRows(home);
    const five = windowOf(rows, "5h");
    const week = windowOf(rows, "weekly");
    assert.equal(five.remaining_fraction, 0.02);
    assert.equal(five.reset_at, 1793951647 * 1000);
    assert.equal(week.remaining_fraction, 0.53);
    assert.equal(week.reset_at, 1794463675 * 1000);

    // 对照：若误用旧快照，5 小时重置点已过，状态会被抬成 100%
    const now = Date.parse("2026-11-06T05:53:00Z");
    const staleOnly = rowsFromCodexSnapshot({
      limit_id: "codex",
      primary: { used_percent: 5, window_minutes: 300, resets_at: 1793785678 },
      secondary: { used_percent: 70, window_minutes: 10080, resets_at: 1793985443 },
    }, Date.parse("2026-11-04T04:56:36.527Z"));
    const cfg = { minRemaining: 0.15, lowRemaining: 0.3, staleMinutes: 15 };
    const wrong = poolStatus(cfg, staleOnly, "codex", "codex", now);
    assert.equal(wrong.windows.find((w) => w.key === "5h").remaining, 1);
    const right = poolStatus(cfg, rows, "codex", "codex", now);
    assert.equal(right.windows.find((w) => w.key === "5h").remaining, 0.02);
    assert.equal(right.windows.find((w) => w.key === "5h").resetPassed, false);
    assert.equal(right.windows.find((w) => w.key === "weekly").remaining, 0.53);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("更新的非 codex 额度桶不会盖住 codex，窗口按长度区分", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-codex-"));
  try {
    const dir = path.join(home, ".codex", "sessions", "2026", "11", "06");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "mixed.jsonl");
    fs.writeFileSync(file, [
      codexEvent("2026-11-06T03:38:23.716Z", {
        primary: { used_percent: 98, window_minutes: 300, resets_at: 1793951647 },
        secondary: { used_percent: 47, window_minutes: 10080, resets_at: 1794463675 },
      }),
      JSON.stringify({
        timestamp: "2026-11-06T04:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "other",
            primary: { used_percent: 1, window_minutes: 300, resets_at: 1793959999 },
            secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1794470000 },
          },
        },
      }),
    ].join("\n") + "\n");
    const rows = codexRows(home);
    assert.equal(windowOf(rows, "5h").remaining_fraction, 0.02);
    assert.equal(windowOf(rows, "weekly").remaining_fraction, 0.53);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("app-server 的实时快照：已用 100% 是 5 小时剩 0，已用 47% 是每周剩 53%", () => {
  const now = Date.parse("2026-11-06T06:10:00Z");
  const rows = rowsFromCodexSnapshot({
    limitId: "codex",
    planType: "plus",
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1793951644 },
    secondary: { usedPercent: 47, windowDurationMins: 10080, resetsAt: 1794463672 },
  }, now);
  assert.equal(windowOf(rows, "5h").remaining_fraction, 0);
  assert.equal(windowOf(rows, "5h").allowance, "exhausted");
  assert.equal(windowOf(rows, "5h").reset_at, 1793951644 * 1000);
  assert.equal(windowOf(rows, "weekly").remaining_fraction, 0.53);
  assert.equal(windowOf(rows, "weekly").reset_at, 1794463672 * 1000);
  assert.equal(rowsFromCodexSnapshot({ limitId: "other", primary: { usedPercent: 1, windowDurationMins: 300 } }, now).length, 0);
});
