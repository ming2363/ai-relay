import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectQuotaExhausted, parseResetMs, markPoolExhausted, cachedRows, loadCache, refreshCache } from "./quota.mjs";
import { poolStatus } from "./lib.mjs";

test("detectQuotaExhausted 正例：能够准确识别各种额度耗尽提示", () => {
  // Grok 原文
  assert.equal(detectQuotaExhausted("You've reached your free Grok Build usage limit"), true);

  // agy 429 原文与各模式
  assert.equal(
    detectQuotaExhausted(
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h52m10s.",
    ),
    true,
  );
  assert.equal(detectQuotaExhausted("Error: resource_exhausted"), true);
  assert.equal(detectQuotaExhausted("Individual quota reached"), true);
  assert.equal(detectQuotaExhausted("Quota reached for this model"), true);

  // 正则各模式覆盖（大小写不敏感）
  assert.equal(detectQuotaExhausted("You have reached your daily usage limit"), true);
  assert.equal(detectQuotaExhausted("reached your organization limit"), true);
  assert.equal(detectQuotaExhausted("usage limit"), true);
  assert.equal(detectQuotaExhausted("Current Usage Limit has been exceeded"), true);
  assert.equal(detectQuotaExhausted("Error: rate limit exceeded"), true);
  assert.equal(detectQuotaExhausted("RATE LIMIT EXCEEDED - please retry later"), true);
  assert.equal(detectQuotaExhausted("HTTP 429: quota exceeded"), true);
  assert.equal(detectQuotaExhausted("You have exceeded your current quota, please check plan"), true);
  assert.equal(detectQuotaExhausted("API error: insufficient_quota"), true);
  assert.equal(detectQuotaExhausted("INSUFFICIENT_QUOTA"), true);
  assert.equal(detectQuotaExhausted("提示：额度已用完，请稍后再试"), true);
  assert.equal(detectQuotaExhausted("当前额度不足"), true);
});

test("parseResetMs：解析 Resets in 3h52m10s、Resets in 45m，无此字样返回 null", () => {
  const now = 1700000000000;
  assert.equal(
    parseResetMs(
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h52m10s.",
      now,
    ),
    now + (3 * 3600 + 52 * 60 + 10) * 1000,
  );
  assert.equal(parseResetMs("Resets in 45m", now), now + 45 * 60 * 1000);
  assert.equal(parseResetMs("Resets in 2h", now), now + 2 * 3600 * 1000);
  assert.equal(parseResetMs("Resets in 15s", now), now + 15 * 1000);
  assert.equal(parseResetMs("HTTP 429: quota exceeded, please try again later", now), null);
  assert.equal(parseResetMs("", now), null);
  assert.equal(parseResetMs(null, now), null);
});

test("detectQuotaExhausted 反例：正常输出不误判，空值安全返回 false", () => {
  assert.equal(detectQuotaExhausted(""), false);
  assert.equal(detectQuotaExhausted(null), false);
  assert.equal(detectQuotaExhausted(undefined), false);
  assert.equal(detectQuotaExhausted("Build succeeded, 0 errors, 0 warnings"), false);
  assert.equal(detectQuotaExhausted("All 158 tests passed"), false);
  assert.equal(detectQuotaExhausted("Process limit set to 1024"), false);
  assert.equal(detectQuotaExhausted("Checking quota balance... ok"), false);
});

test("markPoolExhausted 写入缓存后 cachedRows 能读到该行且 remaining_fraction 为 0", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-quota-limit-"));
  try {
    const now = 1700000000000;
    markPoolExhausted(tempDir, "grok", "supergrok-weekly", now, 24);

    const rows = cachedRows(tempDir);
    assert.equal(rows.length, 1);

    const r = rows[0];
    assert.equal(r.provider, "grok");
    assert.equal(r.pool_id, "supergrok-weekly");
    assert.equal(r.window_key, "cli-limit");
    assert.equal(r.remaining_fraction, 0);
    assert.equal(r.allowance, "exhausted");
    assert.equal(r.reset_at, now + 24 * 3600000);
    assert.equal(r.updated_at, now);

    // 验证 refreshCache 保留 cli-limit: 开头的来源
    refreshCache({ stateDir: tempDir, now: now + 1000 });
    const cacheAfterRefresh = loadCache(tempDir);
    assert.ok(cacheAfterRefresh.sources["cli-limit:grok:supergrok-weekly"]);
    assert.equal(cachedRows(tempDir).some((row) => row.window_key === "cli-limit"), true);

    // 传入第 6 个参数 resetAt 时使用该到期时间，传 null 时回退按 hours 计算
    const customResetAt = parseResetMs("Resets in 3h52m10s", now);
    markPoolExhausted(tempDir, "antigravity", "claude-gpt", now, 24, customResetAt);
    const agyRow = cachedRows(tempDir).find((row) => row.provider === "antigravity" && row.pool_id === "claude-gpt");
    assert.equal(agyRow.reset_at, customResetAt);

    markPoolExhausted(tempDir, "antigravity", "gemini", now, 12, null);
    const geminiRow = cachedRows(tempDir).find((row) => row.provider === "antigravity" && row.pool_id === "gemini");
    assert.equal(geminiRow.reset_at, now + 12 * 3600000);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("用 poolStatus 验证被 markPoolExhausted 的池为 blocked，25 小时后不再 blocked", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-pool-status-"));
  try {
    const now = 1700000000000;
    markPoolExhausted(tempDir, "grok", "supergrok-weekly", now, 24);
    const rows = cachedRows(tempDir);

    const cfg = { minRemaining: 0.15, lowRemaining: 0.3, staleMinutes: 15 };

    // 当前时间：该池处于 blocked 状态
    const stBlocked = poolStatus(cfg, rows, "grok", "supergrok-weekly", now);
    assert.equal(stBlocked.level, "blocked");
    assert.equal(stBlocked.remaining, 0);

    // 25 小时后：过了重置点，不再 blocked
    const nowAfter25h = now + 25 * 3600000;
    const stAfter = poolStatus(cfg, rows, "grok", "supergrok-weekly", nowAfter25h);
    assert.notEqual(stAfter.level, "blocked");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cli-limit 临时窗口过了重置点不参与剩余比例计算，不会被当成剩 100%", () => {
  // 当前 lib.mjs 第 412 行在 resetPassed 时将 remaining 统一赋值为 1 并计入 known 列表
  // 若按第 4 步需求（cli-limit 过了 reset_at 不参与计算）：
  // 在仅有 cli-limit 窗口时，过期后剩余比例应为 null，level 应为 'unknown'
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-pool-check-"));
  try {
    const now = 1700000000000;
    markPoolExhausted(tempDir, "grok", "supergrok-weekly", now, 24);
    const rows = cachedRows(tempDir);
    const cfg = { minRemaining: 0.15, lowRemaining: 0.3, staleMinutes: 15 };

    const nowAfter25h = now + 25 * 3600000;
    const stAfter = poolStatus(cfg, rows, "grok", "supergrok-weekly", nowAfter25h);
    // 现有 lib.mjs 计算结果为 remaining: 1, level: "ok"，而非 null 和 "unknown"
    assert.equal(stAfter.remaining, null);
    assert.equal(stAfter.level, "unknown");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
