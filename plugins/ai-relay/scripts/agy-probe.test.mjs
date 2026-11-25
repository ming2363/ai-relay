// agy 额度查询退避：登录失效时不能每条消息都去跑 agy（每跑一次就弹一个浏览器登录页）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshCache, shouldProbeAgy, isAgyAuthError } from "./quota.mjs";

function fakeAgy(dir, { auth }) {
  const bin = path.join(dir, "agy");
  const log = path.join(dir, "calls.log");
  const body = auth
    ? 'echo "Authentication required. Please visit the URL to log in:\\n  https://accounts.google.com/o/oauth2/auth?x=1" >&2; exit 1'
    : 'printf "Gemini Models\\tFive hour window\\t50%%\\t\\n"';
  fs.writeFileSync(bin, `#!/bin/sh\necho x >> "${log}"\n${body}\n`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0) };
}

const opts = (stateDir, bin, now, force = false) => ({ stateDir, agyBin: bin, now, force, codexLive: false, codexHome: path.join(stateDir, "nocodex") });

test("登录失效后不再自动重查，只有 --force 才查", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-probe-"));
  const agy = fakeAgy(dir, { auth: true });
  const t0 = Date.now();
  const c1 = refreshCache(opts(dir, agy.bin, t0));
  assert.equal(agy.calls(), 1);
  assert.equal(c1.sources.agy.authRequired, true);
  // 之后每条消息、过了很久，都不再跑 agy
  refreshCache(opts(dir, agy.bin, t0 + 1000));
  refreshCache(opts(dir, agy.bin, t0 + 24 * 3600_000));
  assert.equal(agy.calls(), 1);
  // 用户重新登录后手动 --force
  refreshCache(opts(dir, agy.bin, t0 + 24 * 3600_000 + 60_000, true));
  assert.equal(agy.calls(), 2);
});

test("普通失败也按 5 分钟退避，不是下一条消息马上重查", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-probe-"));
  const bin = path.join(dir, "agy");
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(bin, `#!/bin/sh\necho x >> "${log}"\necho "network error" >&2; exit 1\n`, { mode: 0o755 });
  const calls = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  const t0 = Date.now();
  refreshCache(opts(dir, bin, t0));
  refreshCache(opts(dir, bin, t0 + 60_000));
  assert.equal(calls(), 1);
  refreshCache(opts(dir, bin, t0 + 5 * 60_000 + 1));
  assert.equal(calls(), 2);
});

test("成功后 5 分钟内不重查", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-probe-"));
  const agy = fakeAgy(dir, { auth: false });
  const t0 = Date.now();
  const c = refreshCache(opts(dir, agy.bin, t0));
  assert.equal(c.sources.agy.error, null);
  assert.equal(c.sources.agy.rows.length, 1);
  refreshCache(opts(dir, agy.bin, t0 + 60_000));
  assert.equal(agy.calls(), 1);
});

test("旧缓存里已有登录失效报错时直接不查", () => {
  const err = "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?access_type=offline";
  assert.equal(isAgyAuthError(err), true);
  assert.equal(shouldProbeAgy({ fetchedAt: 1, error: err }, Date.now(), false), false);
  assert.equal(shouldProbeAgy({ fetchedAt: 1, error: "timeout" }, Date.now(), false), true);
});

test("登录失效后选人跳过 agy、状态摘要提示登录，派单失败的输出会标记失效", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-login-"));
  process.env.AI_RELAY_HOME = dir;
  const q = await import(`./quota.mjs?login=${Date.now()}`);
  const lib = await import(`./lib.mjs?login=${Date.now()}`);
  const cfg = {
    providers: {
      claude: { self: true, label: "Claude", quota: { provider: "anthropic", pools: ["claude"] } },
      agy: { label: "Antigravity Pro", cli: { bin: "agy" }, quota: { provider: "antigravity", pools: ["gemini"] } },
    },
    routes: { read: ["agy:gemini:default"] },
  };
  // 正常时能选到 agy、没有提醒
  assert.equal(lib.pickRoute(cfg, [], "read").choice?.provider, "agy");
  assert.equal(lib.loginReminder(cfg), "");
  // 派单时 agy 报登录失效
  q.markAgyLoginRequired(dir, "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x");
  assert.equal(lib.pickRoute(cfg, [], "read").choice, null);
  assert.match(lib.loginReminder(cfg), /Antigravity Pro.*登录已失效.*在终端运行 agy 重新登录/);
  assert.match(lib.compactStatus(cfg, []), /agy：登录已失效（不要派给它）/);
  // 额度查询也不再自动跑
  assert.equal(shouldProbeAgy(q.loadCache(dir).sources.agy, Date.now() + 86400_000, false), false);
  delete process.env.AI_RELAY_HOME;
});

test("派给 agy 的任务报登录失效：记为登录失效", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-run-"));
  const { executeJob } = await import("./relay.mjs");
  const q = await import("./quota.mjs");
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "wt"), { recursive: true });
  const cfg = { providers: { agy: { label: "Antigravity Pro", cli: { bin: "agy" }, quota: { provider: "antigravity", pools: ["gemini"] } } } };
  const job = { id: "job-login", provider: "agy", cwd: path.join(dir, "wt"), task: "x", role: "read", write: false, startedAt: new Date().toISOString(), _jobsDir: path.join(dir, "jobs") };
  const res = await executeJob(job, {
    cfg,
    bin: process.execPath,
    args: ["-e", "process.stderr.write('Authentication required. Please visit the URL to log in:\\n  https://accounts.google.com/o/oauth2/auth?x'); process.exit(1)"],
    stateDir: dir,
    jobsDir: path.join(dir, "jobs"),
    agyDir: path.join(dir, "conv"),
    checkIntervalMs: 50,
  });
  assert.notEqual(res.status, "done");
  assert.equal(res.loginRequired, true);
  assert.deepEqual([...q.loginRequiredProviders(dir)], ["antigravity"]);
});
