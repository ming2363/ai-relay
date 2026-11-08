// prompt-hook 测试：复核铁令在每种会注入的模式下都要带上
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt-hook.mjs");

// 在隔离的 AI_RELAY_HOME 下按指定模式跑一次钩子，返回注入的上下文
function runPrompt(mode, prompt) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-prompt-"));
  if (mode) fs.writeFileSync(path.join(home, "mode"), mode + "\n");
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: "s1", prompt }),
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
}

test("自动模式每轮都带复核铁令", () => {
  assert.match(runPrompt("auto", "改个按钮颜色"), /\[复核铁令\].*每一个结果主管都要亲自复核/);
});

test("ulw 和点名外派也带复核铁令", () => {
  assert.match(runPrompt("manual", "ulw 重构登录"), /\[复核铁令\]/);
  assert.match(runPrompt("manual", "让 grok 看一下这个函数"), /\[复核铁令\]/);
});

test("关闭模式、或手动模式没点名时不注入", () => {
  assert.equal(runPrompt("off", "ulw 重构登录"), "");
  assert.equal(runPrompt("manual", "改个按钮颜色"), "");
});
