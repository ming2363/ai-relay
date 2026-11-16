// prompt-hook 测试：复核铁令在每种会注入的模式下都要带上；同一会话切模式要立刻反映在下一条注入里
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt-hook.mjs");

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-prompt-"));
}

// 在隔离的 AI_RELAY_HOME 下按指定模式跑一次钩子，返回注入的上下文。
// 传入同一个 home 就是同一个会话，用来连续切模式。
function runPrompt(mode, prompt, home = makeHome(), sessionId = "s1") {
  if (mode) fs.writeFileSync(path.join(home, "mode"), mode + "\n");
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: sessionId, prompt }),
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
}

function seenMode(home, sessionId = "s1") {
  return fs.readFileSync(path.join(home, "mode-seen", `${sessionId}.txt`), "utf8").trim();
}

test("自动模式每轮都带复核铁令", () => {
  const text = runPrompt("auto", "改个按钮颜色");
  assert.match(text, /\[复核铁令\].*每一个结果主管都要亲自复核/);
  assert.doesNotMatch(text, /已切换为自动模式/);
});

test("ulw 和点名外派也带复核铁令", () => {
  const ulw = runPrompt("manual", "ulw 重构登录");
  assert.match(ulw, /\[复核铁令\]/);
  assert.doesNotMatch(ulw, /已从自动切到手动/);
  const named = runPrompt("manual", "让 grok 看一下这个函数");
  assert.match(named, /\[复核铁令\]/);
  assert.doesNotMatch(named, /已从自动切到手动/);
});

test("关闭模式、或手动模式没点名时不注入", () => {
  assert.equal(runPrompt("off", "ulw 重构登录"), "");
  assert.equal(runPrompt("manual", "改个按钮颜色"), "");
});

test("同一会话先 auto 再 off：第二次提示已切换为纯 Claude，再一条 off 不输出", () => {
  const home = makeHome();
  const first = runPrompt("auto", "改个按钮颜色", home);
  assert.match(first, /\[复核铁令\]/);
  assert.doesNotMatch(first, /已切换为纯 Claude/);
  assert.equal(seenMode(home), "auto");
  assert.equal(fs.readFileSync(path.join(home, "prompts", "s1.txt"), "utf8"), "改个按钮颜色");

  const second = runPrompt("off", "第二条", home);
  assert.match(second, /已切换为纯 Claude 模式：从这条消息起不外派任何任务/);
  assert.match(second, /忽略本会话前面关于外派、分工、节流的 ai-relay 提示/);
  assert.doesNotMatch(second, /复核铁令/);
  assert.equal(seenMode(home), "off");
  assert.equal(fs.readFileSync(path.join(home, "prompts", "s1.txt"), "utf8"), "第二条");

  assert.equal(runPrompt("off", "第三条", home), "");
  assert.equal(seenMode(home), "off");
  assert.equal(fs.readFileSync(path.join(home, "prompts", "s1.txt"), "utf8"), "第三条");
});

test("auto 切到手动、off 切到自动会提示；第一次见到的会话不加切换提示", () => {
  const home = makeHome();
  const first = runPrompt("auto", "改个按钮颜色", home);
  assert.match(first, /你是主管/);
  assert.doesNotMatch(first, /已切换为自动模式/);

  const manual = runPrompt("manual", "让 grok 看一下这个函数", home);
  const switchAt = manual.indexOf("已从自动切到手动：只外派用户点名的部分，前面自动模式的外派要求不再适用。");
  const bodyAt = manual.indexOf("用户提到了其他模型/外派");
  assert.ok(switchAt >= 0 && bodyAt > switchAt);

  const fromOff = makeHome();
  assert.equal(runPrompt("off", "你好", fromOff), "");
  assert.equal(seenMode(fromOff), "off");
  const back = runPrompt("auto", "改个按钮颜色", fromOff);
  const autoAt = back.indexOf("已切换为自动模式：从这条消息起按主管 + 员工方式工作。");
  const leadAt = back.indexOf("你是主管");
  assert.ok(autoAt >= 0 && leadAt > autoAt);

  const fromManual = makeHome();
  assert.equal(runPrompt("manual", "改个按钮颜色", fromManual), "");
  const toAuto = runPrompt("auto", "改个按钮颜色", fromManual);
  assert.match(toAuto, /已切换为自动模式：从这条消息起按主管 \+ 员工方式工作。/);
});

test("非自动且没有点名的分支也会记下当前模式", () => {
  const home = makeHome();
  runPrompt("auto", "改个按钮颜色", home);
  assert.equal(seenMode(home), "auto");
  // 自动切到手动的那一条只输出切换提示（见下一个测试），模式照样记下
  assert.match(runPrompt("manual", "改个按钮颜色", home), /已从自动切到手动/);
  assert.equal(seenMode(home), "manual");
  // 另一个会话互不影响
  assert.equal(runPrompt("off", "旁路", home, "s2"), "");
  assert.equal(seenMode(home, "s2"), "off");
  assert.equal(seenMode(home), "manual");
});

test("自动切到手动且没有 ulw 或点名时，只输出切换提示", () => {
  const home = makeHome();
  runPrompt("auto", "改个按钮颜色", home);
  assert.equal(seenMode(home), "auto");
  const second = runPrompt("manual", "改个按钮颜色", home);
  assert.equal(second, "[ai-relay] 已从自动切到手动：只外派用户点名的部分，前面自动模式的外派要求不再适用。");
  assert.equal(seenMode(home), "manual");
  assert.equal(runPrompt("manual", "第三条也没点名", home), "");
});

// 自动模式有 Claude 额度窗口时，两档节流提示都要带「周期还剩 Y%」；没有重置时间时保持原来的措辞
test("节流提示带上周期还剩 Y%，没有周期数据时保持原文", () => {
  const home = makeHome();
  const now = Date.now();
  const cfg = {
    claudeConserveBelow: 0.2,
    claudeThrottleBelow: 0.5,
    providers: {
      claude: { label: "Claude", self: true, quota: { provider: "claude", pools: ["claude-subscription"] } },
    },
  };
  fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(cfg, null, 2) + "\n");
  const cache = {
    sources: {
      claude: {
        fetchedAt: new Date().toISOString(),
        rows: [
          { provider: "claude", pool_id: "claude-subscription", window_key: "5h", remaining_fraction: 0.4, reset_at: now + 1 * 3600_000, allowance: "available", updated_at: now },
        ],
      },
    },
  };
  fs.writeFileSync(path.join(home, "quota-cache.json"), JSON.stringify(cache, null, 2) + "\n");
  fs.writeFileSync(path.join(home, "mode"), "auto\n");

  const one = runPrompt("auto", "改个按钮颜色", home);
  assert.match(one, /\[节流\] Claude 额度剩 40%，周期还剩 20%/);

  // 2 档：剩 10%，周期还剩 80%
  cache.sources.claude.rows[0] = { provider: "claude", pool_id: "claude-subscription", window_key: "weekly", remaining_fraction: 0.1, reset_at: now + 168 * 0.8 * 3600_000, allowance: "available", updated_at: now };
  fs.writeFileSync(path.join(home, "quota-cache.json"), JSON.stringify(cache, null, 2) + "\n");
  const two = runPrompt("auto", "改个按钮颜色", home);
  assert.match(two, /⚠️ Claude 自身额度剩 10%，周期还剩 80%/);

  // 没有 reset_at 时保持原文，不出现「周期还剩」
  cache.sources.claude.rows[0] = { provider: "claude", pool_id: "claude-subscription", window_key: "5h", remaining_fraction: 0.1, reset_at: null, allowance: "available", updated_at: now };
  fs.writeFileSync(path.join(home, "quota-cache.json"), JSON.stringify(cache, null, 2) + "\n");
  const noCycle = runPrompt("auto", "改个按钮颜色", home);
  assert.match(noCycle, /⚠️ Claude 自身额度剩 10%：进入省 Claude 状态/);
  assert.doesNotMatch(noCycle, /周期还剩/);
});
