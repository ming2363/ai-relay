// 按量计费厂商每日用量上限与 Claude 节流周期剩余
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const relayPath = path.join(scriptsDir, "relay.mjs");

// 独立进程里用临时 HOME 重载 lib.mjs，避免写进用户真实 ~/.claude/ai-relay
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-metered-"));
process.env.AI_RELAY_HOME = home;
const lib = await import(`./lib.mjs?metered=${process.pid}`);
const { recordMeteredUsage, meteredUsedToday, meteredCapReached, claudeThrottle } = lib;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1700000000000;

function localDateKey(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function writeUsage(data) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "metered-usage.json"), JSON.stringify(data, null, 2) + "\n");
}

function readUsage() {
  return JSON.parse(fs.readFileSync(path.join(home, "metered-usage.json"), "utf8"));
}

// 供 relay pick / run 子进程用的隔离 HOME：写入 providers.json，metered 厂商在今日达到上限
function makeRelayHome({ cap = 20000000, used = null, fakeBin = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-metered-cli-"));
  const state = path.join(dir, "ai-relay");
  fs.mkdirSync(state, { recursive: true });
  const cfg = {
    minRemaining: 0.15,
    lowRemaining: 0.3,
    quotaDb: "",
    meteredDailyTokenCap: cap,
    providers: {
      member: {
        label: "会员厂商",
        via: "relay",
        quota: { provider: "member" },
        pools: { m: ["mm"] },
        cli: { bin: fakeBin || "/bin/true", prompt: [], model: [], read: [], write: [], cwd: null, fullAccess: [] },
        caps: { web: false, exec: false, vision: false },
      },
      maas: {
        label: "按量厂商",
        via: "relay",
        billing: "metered",
        quota: { provider: "maas" },
        pools: { maas: ["qwen"] },
        cli: {
          bin: fakeBin || "/bin/true",
          prompt: ["--output-format", "json"],
          model: ["--model", "{model}"],
          read: [],
          write: [],
          cwd: null,
          fullAccess: [],
        },
        caps: { web: false, exec: false, vision: false },
      },
    },
    routes: { implement: ["member:m:mm", "maas:maas:qwen"] },
  };
  fs.writeFileSync(path.join(state, "providers.json"), JSON.stringify(cfg, null, 2) + "\n");
  const usage = {};
  if (used !== null) usage[localDateKey(Date.now())] = { maas: used };
  fs.writeFileSync(path.join(state, "metered-usage.json"), JSON.stringify(usage, null, 2) + "\n");
  return {
    dir,
    state,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runRelay(state, args, { input } = {}) {
  return spawnSync(process.execPath, [relayPath, ...args], {
    encoding: "utf8",
    input,
    cwd: scriptsDir,
    env: {
      PATH: process.env.PATH || "",
      HOME: path.dirname(state),
      AI_RELAY_HOME: state,
      LANG: "C",
      TMPDIR: process.env.TMPDIR || "/tmp",
    },
  });
}

test("两次记录同一天累加，8 天前的记录被清掉", () => {
  recordMeteredUsage("maas", 100, NOW);
  recordMeteredUsage("maas", 50, NOW);
  assert.equal(meteredUsedToday("maas", NOW), 150);

  recordMeteredUsage("maas", 10, NOW - 8 * DAY);
  recordMeteredUsage("maas", 20, NOW);
  const data = readUsage();
  assert.equal(data[localDateKey(NOW)].maas, 170);
  assert.equal(Object.prototype.hasOwnProperty.call(data, localDateKey(NOW - 8 * DAY)), false);
  assert.equal(meteredUsedToday("maas", NOW), 170);
});

test("meteredCapReached：到上限为 true，未到为 false，非按量厂商恒为 false", () => {
  const cfg = {
    meteredDailyTokenCap: 150,
    providers: {
      maas: { billing: "metered" },
      member: { billing: "member" },
    },
  };
  // 前一个测试结束后重新铺数据，确保"今天"从 0 起
  fs.writeFileSync(path.join(home, "metered-usage.json"), "{}");
  recordMeteredUsage("maas", 150, NOW);
  assert.equal(meteredCapReached(cfg, "maas", NOW), true);
  recordMeteredUsage("maas", 10, NOW - DAY); // 昨天不影响今天
  assert.equal(meteredCapReached(cfg, "maas", NOW), true);

  const bigCfg = { ...cfg, meteredDailyTokenCap: 300 };
  assert.equal(meteredCapReached(bigCfg, "maas", NOW), false);
  assert.equal(meteredCapReached(cfg, "member", NOW), false);
});

test("claudeThrottle 返回 cycleLeft：取主模型额度池各窗口中周期剩余比例最小的", () => {
  const cfg = {
    claudeConserveBelow: 0.2,
    claudeThrottleBelow: 0.5,
    providers: {
      claude: { self: true, quota: { provider: "claude", pools: ["claude-subscription"] } },
    },
  };
  const rows = [
    { provider: "claude", pool_id: "claude-subscription", window_key: "5h", remaining_fraction: 0.4, reset_at: NOW + 2 * 3600_000, allowance: "available", updated_at: NOW },
    { provider: "claude", pool_id: "claude-subscription", window_key: "weekly", remaining_fraction: 0.9, reset_at: NOW + 42 * 3600_000, allowance: "available", updated_at: NOW },
  ];
  const t = claudeThrottle(cfg, rows, NOW);
  // 5h 剩 0.4（2/5），weekly 剩 0.25（42/168），取最小 0.25
  assert.equal(t.level, 1);
  assert.equal(t.remaining, 0.4);
  assert.equal(t.cycleLeft, 0.25);

  const noReset = claudeThrottle(cfg, [{ provider: "claude", pool_id: "claude-subscription", window_key: "5h", remaining_fraction: 0.4, reset_at: null, allowance: "available", updated_at: NOW }], NOW);
  assert.equal(noReset.level, 1);
  assert.equal(noReset.cycleLeft, null);

  const none = claudeThrottle({ providers: { claude: { self: true, quota: { provider: "claude", pools: ["claude-subscription"] } } } }, [], NOW);
  assert.equal(none.level, 0);
  assert.equal(none.remaining, null);
  assert.equal(none.cycleLeft, null);
});

test("到上限后 pick 里该厂商被跳过且原因正确；点名 run 不受影响", () => {
  const fakeBin = path.join(scriptsDir, "fake-metered-bin.mjs");
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ result: "ok", is_error: false, usage: { input_tokens: 40, output_tokens: 10 } }));`);
  fs.chmodSync(fakeBin, 0o755);
  try {
    const pickHome = makeRelayHome({ used: 20000000 });
    try {
      const pick = runRelay(pickHome.state, ["pick", "implement", "--level", "中等"]);
      assert.equal(pick.status, 0, pick.stderr);
      assert.match(pick.stdout, /今日按量用量已到上限/);
      assert.match(pick.stdout, /跳过：maas/);
      assert.match(pick.stdout, /→ member/);
    } finally {
      pickHome.cleanup();
    }

    const runHome = makeRelayHome({ used: 20000000, fakeBin });
    try {
      const brief = `角色：implement\n难度：中等\n\n## 目标\n改一个函数\n\n## 验收标准\n能通过测试\n\n## 写入范围\n${runHome.dir}\n`;
      const run = runRelay(runHome.state, ["run", "maas", "--role", "implement", "--model", "qwen", "--level", "中等", "--cwd", runHome.dir, "--write", "--", brief]);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /任务 .*maas/);
      // 点名的按量厂商仍正常跑完，并且本次用量被累加（今日原有 20000000 + 50）
      const usage = JSON.parse(fs.readFileSync(path.join(runHome.state, "metered-usage.json"), "utf8"));
      assert.equal(usage[localDateKey(Date.now())].maas, 20000050);
    } finally {
      runHome.cleanup();
    }
  } finally {
    fs.rmSync(fakeBin, { force: true });
  }
});
