// 系统消息识别与 UserPromptSubmit 钩子状态保留测试
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isSystemPrompt } from "./lib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(DIR, "prompt-hook.mjs");

// 创建隔离的 HOME 与 AI_RELAY_HOME，避免读写宿主机真实的 ~/.claude/ai-relay
function withIsolatedState(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-sys-prompt-"));
  const stateDir = path.join(root, ".claude", "ai-relay");
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    return fn({ root, stateDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runPromptHook(stateDir, root, { mode = "auto", sessionId = "s-sys", prompt = "" } = {}) {
  if (mode) {
    fs.writeFileSync(path.join(stateDir, "mode"), `${mode}\n`);
  }
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: sessionId, prompt }),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      AI_RELAY_HOME: stateDir,
      CLAUDE_PROJECT_DIR: "",
    },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput.additionalContext : "";
}

test("isSystemPrompt：识别前导空白、带属性标签等系统消息，排除普通文本与非标签 < 开头内容", () => {
  // 正例：常见系统消息标签、前导空白、带属性标签
  assert.equal(isSystemPrompt("<task-notification>\n<task-id>t1</task-id>\n</task-notification>"), true);
  assert.equal(isSystemPrompt("  \n\t <task-notification>mvn test 完成</task-notification>"), true);
  assert.equal(isSystemPrompt('<agent-message from="worker-1" role="implement">已完成修改</agent-message>'), true);
  assert.equal(isSystemPrompt("\n  <side-sessions-event type=\"done\">\n详情"), true);
  assert.equal(isSystemPrompt("<ci-monitor-event>build passed</ci-monitor-event>"), true);
  assert.equal(isSystemPrompt("<notification>ok</notification>"), true);

  // 反例：普通中文消息、以 < 开头但不是小写连字符标签、标签不在句首、空值
  assert.equal(isSystemPrompt("帮我修一下分页查询的 SQL"), false);
  assert.equal(isSystemPrompt("<5 个参数时直接返回"), false);
  assert.equal(isSystemPrompt("< 5 个"), false);
  assert.equal(isSystemPrompt("<TaskNotification>大写标签不算</TaskNotification>"), false);
  assert.equal(isSystemPrompt("<-leading-dash>"), false);
  assert.equal(isSystemPrompt("<trailing-dash->"), false);
  assert.equal(isSystemPrompt("<double--dash>"), false);
  assert.equal(isSystemPrompt("<snake_case>"), false);
  assert.equal(isSystemPrompt("<unclosed"), false);
  assert.equal(isSystemPrompt("<>空尖括号"), false);
  assert.equal(isSystemPrompt("请排查为什么会出现 <task-notification> 这段输出"), false);
  assert.equal(isSystemPrompt(""), false);
  assert.equal(isSystemPrompt("   \n\t  "), false);
  assert.equal(isSystemPrompt(null), false);
  assert.equal(isSystemPrompt(undefined), false);
});

test("prompt-hook：收到 <task-notification> 等系统消息时不重置 edits 状态、不覆盖 prompts 文件，普通消息照常重置", () => {
  withIsolatedState(({ root, stateDir }) => {
    const sessionId = "s1";
    const promptFile = path.join(stateDir, "prompts", `${sessionId}.txt`);
    const editsFile = path.join(stateDir, "prompts", `${sessionId}.edits.json`);

    // 1. 先送一条普通用户消息
    const userMsg = "修一下登录接口的空指针，顺便跑下 mvn test";
    const ctx1 = runPromptHook(stateDir, root, { mode: "auto", sessionId, prompt: userMsg });
    assert.match(ctx1, /\[ai-relay 自动模式\]/);
    assert.equal(fs.readFileSync(promptFile, "utf8"), userMsg);
    assert.equal(JSON.parse(fs.readFileSync(editsFile, "utf8")).decision, null);

    // 2. 模拟本轮中途已定分工为 self，并累计了亲写行数与读文件次数
    const midRoundEdits = {
      lines: 22,
      warned: false,
      reads: 5,
      readWarned: false,
      decision: "self",
      selfReason: "改动只有几行，直接在当前会话修",
      bashPending: false,
      limitReset: false,
      repos: ["/work/demo"],
    };
    fs.writeFileSync(editsFile, JSON.stringify(midRoundEdits));

    // 3. 送入后台任务通知与带属性的子代理消息
    const taskNotif = "  \n<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n<summary>mvn test 通过</summary>\n</task-notification>";
    const ctx2 = runPromptHook(stateDir, root, { mode: "auto", sessionId, prompt: taskNotif });
    assert.match(ctx2, /\[ai-relay 自动模式\]/);
    assert.match(ctx2, /\[复核铁令\]/);
    assert.equal(fs.readFileSync(promptFile, "utf8"), userMsg);
    assert.deepEqual(JSON.parse(fs.readFileSync(editsFile, "utf8")), midRoundEdits);

    const agentMsg = '<agent-message from="codex-1">子任务已完成</agent-message>';
    runPromptHook(stateDir, root, { mode: "auto", sessionId, prompt: agentMsg });
    assert.equal(fs.readFileSync(promptFile, "utf8"), userMsg);
    assert.deepEqual(JSON.parse(fs.readFileSync(editsFile, "utf8")), midRoundEdits);

    // 4. 下一轮收到新的普通用户消息时，照常更新原话并重置 edits 状态
    const nextUserMsg = "<5 个字段的小表也加上校验";
    runPromptHook(stateDir, root, { mode: "auto", sessionId, prompt: nextUserMsg });
    assert.equal(fs.readFileSync(promptFile, "utf8"), nextUserMsg);
    const resetEdits = JSON.parse(fs.readFileSync(editsFile, "utf8"));
    assert.equal(resetEdits.decision, null);
    assert.equal(resetEdits.selfReason, "");
    assert.equal(resetEdits.lines, 0);
    assert.equal(resetEdits.reads, 0);
  });
});

test("prompt-hook：系统消息期间切换模式仍正常更新 mode-seen 并注入切换说明", () => {
  withIsolatedState(({ root, stateDir }) => {
    const sessionId = "s-mode";
    runPromptHook(stateDir, root, { mode: "auto", sessionId, prompt: "先看下问题" });
    const switchCtx = runPromptHook(stateDir, root, {
      mode: "off",
      sessionId,
      prompt: "<task-notification>后台命令结束</task-notification>",
    });
    assert.match(switchCtx, /已切换为纯 Claude 模式/);
    assert.equal(fs.readFileSync(path.join(stateDir, "mode-seen", `${sessionId}.txt`), "utf8").trim(), "off");
    assert.equal(fs.readFileSync(path.join(stateDir, "prompts", `${sessionId}.txt`), "utf8"), "先看下问题");
  });
});
