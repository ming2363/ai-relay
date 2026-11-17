// 自动模式：第一次改项目代码前要定分工；Bash 写入的行数也要计入
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { snapshotDelta, cdTargets, bashReadCount } from "./lib.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const preHook = path.join(dir, "pretool-hook.mjs");
const postHook = path.join(dir, "posttool-hook.mjs");
const relay = path.join(dir, "relay.mjs");
const lib = path.join(dir, "lib.mjs");

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-self-"));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function setMode(home, mode) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "mode"), mode + "\n");
}

// 默认清掉 CLAUDE_PROJECT_DIR，免得在 Claude Code 里跑测试时把真实项目也纳入快照
function runHook(script, input, home, env = {}) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: home, CLAUDE_PROJECT_DIR: "", ...env },
  });
}

function editsPath(home, sessionId) {
  return path.join(home, "prompts", `${sessionId}.edits.json`);
}

function readEdits(home, sessionId) {
  return JSON.parse(fs.readFileSync(editsPath(home, sessionId), "utf8"));
}

function assertAllowed(res) {
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "");
}

function assertDenied(res) {
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /先定分工/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /self "<一句话原因>"/);
  return out.hookSpecificOutput.permissionDecisionReason;
}

function editInput(sessionId, filePath, extra = {}) {
  return {
    tool_name: "Edit",
    session_id: sessionId,
    cwd: "/work/proj",
    tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
    ...extra,
  };
}

function git(cwd, args) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(res.status, 0, `${args.join(" ")}\n${res.stderr}`);
  return res.stdout;
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "line\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
}

test("snapshotDelta 只计后面还在的文件，前有后无计 0，可减去 HEAD 移动的行数", () => {
  assert.equal(snapshotDelta({ a: 1, b: 5 }, { b: 2, c: 4 }), 7);
  assert.equal(snapshotDelta(null, { a: 3 }), 3);
  assert.equal(snapshotDelta({ a: 3 }, {}), 0);
  assert.equal(snapshotDelta({ files: { a: { n: 10 } } }, { files: { a: { n: 110 }, b: { n: 4 } } }, { a: 100 }), 4);
});

test("auto 模式下还没定分工时，改项目文件被拒，临时目录和 memory 不拒", () => {
  withHome((home) => {
    setMode(home, "auto");
    const denied = runHook(preHook, editInput("s1", "/work/proj/src/app.js"), home);
    const reason = assertDenied(denied);
    assert.match(reason, /relay run --write/);
    assert.match(reason, /只派只读任务不算定分工/);

    assertAllowed(runHook(preHook, editInput("s1", "/tmp/ai-relay-note.js"), home));
    assertAllowed(runHook(preHook, editInput("s1", "/private/tmp/ai-relay-note.js"), home));
    const memory = path.join(os.homedir(), ".claude", "projects", "demo", "memory", "note.md");
    assertAllowed(runHook(preHook, editInput("s1", memory), home));
    const plan = path.join(os.homedir(), ".claude", "plans", "today.md");
    assertAllowed(runHook(preHook, editInput("s1", plan), home));
  });
});

test("manual 和 off 不拦截编辑，子代理里的编辑也不拦截", () => {
  withHome((home) => {
    setMode(home, "manual");
    assertAllowed(runHook(preHook, editInput("s-manual", "/work/proj/src/app.js"), home));
    setMode(home, "off");
    assertAllowed(runHook(preHook, editInput("s-off", "/work/proj/src/app.js"), home));
    setMode(home, "auto");
    assertAllowed(runHook(preHook, editInput("s-agent", "/work/proj/src/app.js", { agent_id: "agent-1" }), home));
  });
});

test("PostToolUse Bash 看到 relay self 的输出后记下原因，随后编辑放行", () => {
  withHome((home) => {
    setMode(home, "auto");
    const command = `node ${JSON.stringify(relay)} self 需要会话上下文`;
    const posted = runHook(postHook, {
      tool_name: "Bash",
      session_id: "s-self",
      cwd: "/work/proj",
      tool_input: { command },
      tool_response: { stdout: "[relay-self] 需要会话上下文\n已记录，本轮可以继续自己改\n", stderr: "" },
    }, home);
    assert.equal(posted.status, 0, posted.stderr);
    const stat = readEdits(home, "s-self");
    assert.equal(stat.decision, "self");
    assert.equal(stat.selfReason, "需要会话上下文");
    assert.equal(stat.bashPending, false);
    assertAllowed(runHook(preHook, editInput("s-self", "/work/proj/src/app.js"), home));

    const asText = runHook(postHook, {
      tool_name: "Bash",
      session_id: "s-self-text",
      cwd: "/work/proj",
      tool_input: { command },
      tool_response: "[relay-self] 需要会话上下文\n已记录，本轮可以继续自己改\n",
    }, home);
    assert.equal(asText.status, 0, asText.stderr);
    assert.equal(readEdits(home, "s-self-text").selfReason, "需要会话上下文");
  });
});

test("带 --write 的 relay run 之后 decision 为 dispatch", () => {
  withHome((home) => {
    setMode(home, "auto");
    fs.mkdirSync(path.join(home, "prompts"), { recursive: true });
    fs.writeFileSync(editsPath(home, "s-run"), JSON.stringify({
      lines: 0, warned: false, reads: 0, readWarned: false, decision: null, selfReason: "", bashPending: true, limitReset: false, repos: null,
    }));
    const res = runHook(postHook, {
      tool_name: "Bash",
      session_id: "s-run",
      cwd: "/work/proj",
      tool_input: { command: `node ${JSON.stringify(relay)} run grok --role implement --write` },
      tool_response: { stdout: "已启动\n" },
    }, home);
    assert.equal(res.status, 0, res.stderr);
    const stat = readEdits(home, "s-run");
    assert.equal(stat.decision, "dispatch");
    assert.equal(stat.bashPending, false);
    assertAllowed(runHook(preHook, editInput("s-run", "/work/proj/src/app.js"), home));
  });
});

test("临时仓库里 Bash 写入计入行数，随后非 relay 的 Bash 被拒、relay 不被拒", () => {
  withHome((home) => {
    setMode(home, "auto");
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-repo-"));
    try {
      initRepo(repo);
      const command = "python3 - <<'PY'\nprint('write')\nPY";
      const pre = runHook(preHook, {
        tool_name: "Bash",
        session_id: "s-bash",
        cwd: repo,
        tool_input: { command },
      }, home);
      assertAllowed(pre);
      assert.equal(fs.existsSync(path.join(home, "prompts", "s-bash.bashsnap.json")), true);

      fs.appendFileSync(path.join(repo, "tracked.txt"), "n1\nn2\nn3\nn4\nn5\n");
      const fresh = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
      fs.writeFileSync(path.join(repo, "fresh.js"), fresh);

      const post = runHook(postHook, {
        tool_name: "Bash",
        session_id: "s-bash",
        cwd: repo,
        tool_input: { command },
        tool_response: { stdout: "" },
      }, home);
      assert.equal(post.status, 0, post.stderr);
      assert.match(post.stdout, /已改了项目代码/);
      assert.equal(fs.existsSync(path.join(home, "prompts", "s-bash.bashsnap.json")), false);
      const stat = readEdits(home, "s-bash");
      assert.equal(stat.lines, 35, `lines=${stat.lines}`);
      assert.equal(stat.bashPending, true);
      assert.equal(stat.decision, null);

      assertDenied(runHook(preHook, {
        tool_name: "Bash",
        session_id: "s-bash",
        cwd: repo,
        tool_input: { command: "echo hi" },
      }, home));
      assertAllowed(runHook(preHook, {
        tool_name: "Bash",
        session_id: "s-bash",
        cwd: repo,
        tool_input: { command: `node ${JSON.stringify(relay)} self 先补原因` },
      }, home));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("cwd 不是仓库、子目录是仓库时，Bash 写入也能计入", () => {
  withHome((home) => {
    setMode(home, "auto");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-parent-"));
    try {
      const top = spawnSync("git", ["-C", parent, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
      assert.notEqual(top.status, 0, `临时目录落在仓库里，无法验证子目录发现：${top.stdout}`);
      const child = path.join(parent, "proj");
      initRepo(child);
      const command = "echo write";
      assertAllowed(runHook(preHook, {
        tool_name: "Bash",
        session_id: "s-sub",
        cwd: parent,
        tool_input: { command },
      }, home));
      const body = Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
      fs.writeFileSync(path.join(child, "added.js"), body);
      const post = runHook(postHook, {
        tool_name: "Bash",
        session_id: "s-sub",
        cwd: parent,
        tool_input: { command },
        tool_response: "",
      }, home);
      assert.equal(post.status, 0, post.stderr);
      const stat = readEdits(home, "s-sub");
      assert.equal(stat.lines, 10, `lines=${stat.lines} repos=${JSON.stringify(stat.repos)}`);
      assert.ok(Array.isArray(stat.repos) && stat.repos.some((p) => p === child || p.endsWith(`${path.sep}proj`)));
      assert.equal(stat.bashPending, true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

test("原因里带 run 的 relay self 不当成 relay run", () => {
  withHome((home) => {
    setMode(home, "auto");
    const command = `node ${JSON.stringify(relay)} self "不要 run 太早"`;
    assertAllowed(runHook(preHook, {
      tool_name: "Bash",
      session_id: "s-word",
      cwd: "/work/a",
      tool_input: { command },
    }, home));
    const pending = path.join(home, "pending-dispatch");
    const files = fs.existsSync(pending) ? fs.readdirSync(pending).filter((name) => name.endsWith(".json")) : [];
    assert.deepEqual(files, []);
    const post = runHook(postHook, {
      tool_name: "Bash",
      session_id: "s-word",
      cwd: "/work/a",
      tool_input: { command },
      tool_response: { stdout: "[relay-self] 不要 run 太早\n已记录，本轮可以继续自己改\n" },
    }, home);
    assert.equal(post.status, 0, post.stderr);
    const stat = readEdits(home, "s-word");
    assert.equal(stat.decision, "self");
    assert.equal(stat.selfReason, "不要 run 太早");
  });
});

test("cwd 下第 3 层的仓库也能计入 Bash 写入", () => {
  withHome((home) => {
    setMode(home, "auto");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-deep-"));
    try {
      const top = spawnSync("git", ["-C", parent, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
      assert.notEqual(top.status, 0, `临时目录落在仓库里：${top.stdout}`);
      const child = path.join(parent, "a", "b", "proj");
      initRepo(child);
      const command = "echo write";
      assertAllowed(runHook(preHook, {
        tool_name: "Bash",
        session_id: "s-deep",
        cwd: parent,
        tool_input: { command },
      }, home));
      fs.writeFileSync(path.join(child, "added.js"), "one\ntwo\nthree\n");
      const post = runHook(postHook, {
        tool_name: "Bash",
        session_id: "s-deep",
        cwd: parent,
        tool_input: { command },
        tool_response: "",
      }, home);
      assert.equal(post.status, 0, post.stderr);
      const stat = readEdits(home, "s-deep");
      assert.equal(stat.lines, 3, `lines=${stat.lines} repos=${JSON.stringify(stat.repos)}`);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

test("savePrompt 重置分工字段；旧文件缺字段时读出来有默认值", () => {
  withHome((home) => {
    const runner = path.join(home, "_reset.mjs");
    const spec = pathToFileURL(lib).href;
    fs.writeFileSync(runner, `
import fs from "node:fs";
import path from "node:path";
import { savePrompt, readSelfEdits, writeSelfEdits } from ${JSON.stringify(spec)};
const home = process.env.AI_RELAY_HOME;
writeSelfEdits("sess-reset", {
  lines: 12,
  warned: true,
  reads: 4,
  readWarned: true,
  decision: "self",
  selfReason: "旧原因",
  bashPending: true,
  limitReset: true,
  repos: ["/tmp/repo"],
  reposKnown: true,
});
savePrompt("sess-reset", "新的用户消息");
const raw = JSON.parse(fs.readFileSync(path.join(home, "prompts", "sess-reset.edits.json"), "utf8"));
const via = readSelfEdits("sess-reset");
fs.mkdirSync(path.join(home, "prompts"), { recursive: true });
fs.writeFileSync(path.join(home, "prompts", "old.edits.json"), JSON.stringify({ lines: 3, warned: false }));
const old = readSelfEdits("old");
process.stdout.write(JSON.stringify({ raw, via, old }));
`);
    const res = spawnSync(process.execPath, [runner], {
      encoding: "utf8",
      env: { ...process.env, AI_RELAY_HOME: home },
    });
    assert.equal(res.status, 0, res.stderr);
    const { raw, via, old } = JSON.parse(res.stdout);
    assert.equal(raw.lines, 0);
    assert.equal(raw.warned, false);
    assert.equal(raw.reads, 0);
    assert.equal(raw.readWarned, false);
    assert.equal(raw.decision, null);
    assert.equal(raw.selfReason, "");
    assert.equal(raw.bashPending, false);
    assert.equal(raw.limitReset, false);
    assert.equal(raw.repos, null);
    assert.equal(via.decision, null);
    assert.equal(via.selfReason, "");
    assert.equal(via.bashPending, false);
    assert.equal(via.limitReset, false);
    assert.deepEqual(via.repos, []);
    assert.equal(via.reposKnown, false);
    assert.equal(old.lines, 3);
    assert.equal(old.warned, false);
    assert.equal(old.reads, 0);
    assert.equal(old.readWarned, false);
    assert.equal(old.decision, null);
    assert.equal(old.selfReason, "");
    assert.equal(old.bashPending, false);
    assert.equal(old.limitReset, false);
    assert.equal(old.reposKnown, false);
  });
});

test("relay self 打印原因；空原因失败；帮助里有这条命令", () => {
  const ok = spawnSync(process.execPath, [relay, "self", "需要会话上下文"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^\[relay-self\] 需要会话上下文\n已记录，本轮可以继续自己改\n/);

  const multiline = spawnSync(process.execPath, [relay, "self", "第一行\n第二行"], { encoding: "utf8" });
  assert.equal(multiline.status, 0, multiline.stderr);
  assert.match(multiline.stdout, /^\[relay-self\] 第一行 第二行\n/);

  const empty = spawnSync(process.execPath, [relay, "self"], { encoding: "utf8" });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /self <原因>/);

  const help = spawnSync(process.execPath, [relay], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /self <原因>/);
});

// 一条 Bash 的前后两次钩子：前钩子拍快照，执行 act，后钩子算差值
function bashRound(home, sessionId, cwd, command, act, env = {}) {
  assertAllowed(runHook(preHook, { tool_name: "Bash", session_id: sessionId, cwd, tool_input: { command } }, home, env));
  act();
  const post = runHook(postHook, {
    tool_name: "Bash", session_id: sessionId, cwd, tool_input: { command }, tool_response: "",
  }, home, env);
  assert.equal(post.status, 0, post.stderr);
  return readEdits(home, sessionId);
}

function withWorkspace(fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-ws-"));
  try {
    const top = spawnSync("git", ["-C", ws, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    assert.notEqual(top.status, 0, `临时目录落在仓库里：${top.stdout}`);
    const a = path.join(ws, "backend", "svc");
    const b = path.join(ws, "frontend", "web");
    initRepo(a);
    initRepo(b);
    return fn(ws, a, b);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("snapshotDelta 行数没变但签名变了算 1 行；兼容旧的纯数字格式", () => {
  assert.equal(snapshotDelta({ files: { a: { n: 4, sig: "1:1" } } }, { files: { a: { n: 4, sig: "1:2" } } }), 1);
  assert.equal(snapshotDelta({ files: { a: { n: 4, sig: "1:1" } } }, { files: { a: { n: 4, sig: "1:1" } } }), 0);
  assert.equal(snapshotDelta({ a: 2 }, { files: { a: { n: 5, sig: "x" } } }), 3);
});

test("cdTargets 取出命令里 cd 的目录", () => {
  assert.deepEqual(cdTargets('cd /a/b && ls; (cd "c d" && pwd)', "/w"), ["/a/b", "/w/c d"]);
  assert.deepEqual(cdTargets("cd ~/x && cd - && cd $HOME", "/w"), [path.join(os.homedir(), "x")]);
  assert.deepEqual(cdTargets("echo abcd /x", "/w"), []);
});

test("多仓库工作区：本轮第一条命令在 A 仓库，之后在 B 仓库写入也能拦住", () => {
  withHome((home) => withWorkspace((ws, a, b) => {
    setMode(home, "auto");
    bashRound(home, "s-multi", a, "ls", () => {});
    const stat = bashRound(home, "s-multi", b, "python3 - <<'PY'\nPY", () => {
      fs.appendFileSync(path.join(b, "tracked.txt"), "x\ny\n");
    });
    assert.equal(stat.lines, 2, `lines=${stat.lines} repos=${JSON.stringify(stat.repos)}`);
    assert.equal(stat.bashPending, true);
    assertDenied(runHook(preHook, { tool_name: "Bash", session_id: "s-multi", cwd: b, tool_input: { command: "echo hi" } }, home));
  }));
});

test("命令里先 cd 到别的仓库再写入，也能计入", () => {
  withHome((home) => withWorkspace((ws, a, b) => {
    setMode(home, "auto");
    bashRound(home, "s-cd", a, "ls", () => {});
    const stat = bashRound(home, "s-cd", a, `cd ${JSON.stringify(b)} && python3 - <<'PY'\nPY`, () => {
      fs.appendFileSync(path.join(b, "tracked.txt"), "x\n");
    });
    assert.equal(stat.lines, 1, `lines=${stat.lines} repos=${JSON.stringify(stat.repos)}`);
  }));
});

test("项目根目录下的所有仓库都纳入快照，即使当前目录在其中一个仓库里", () => {
  withHome((home) => withWorkspace((ws, a, b) => {
    setMode(home, "auto");
    const env = { CLAUDE_PROJECT_DIR: ws };
    bashRound(home, "s-proj", a, "ls", () => {}, env);
    const stat = bashRound(home, "s-proj", a, "python3 /tmp/x.py", () => {
      fs.writeFileSync(path.join(b, "new.js"), "1\n2\n3\n");
    }, env);
    assert.equal(stat.lines, 3, `lines=${stat.lines} repos=${JSON.stringify(stat.repos)}`);
  }));
});

test("命令里提交已有改动不算写入；改一行还没提交的新增行算写入", () => {
  withHome((home) => withWorkspace((ws, a) => {
    setMode(home, "auto");
    fs.appendFileSync(path.join(a, "tracked.txt"), "one\ntwo\nthree\n");
    let stat = bashRound(home, "s-commit", a, "git commit -am wip", () => {
      git(a, ["-c", "commit.gpgsign=false", "commit", "-qam", "wip"]);
    });
    assert.equal(stat.lines, 0, `提交被算成了写入：lines=${stat.lines}`);
    assert.equal(stat.bashPending, false);

    fs.appendFileSync(path.join(a, "tracked.txt"), "four\n");
    stat = bashRound(home, "s-same", a, "sed -i '' s/four/FOUR/ tracked.txt", () => {
      const f = path.join(a, "tracked.txt");
      const later = new Date(Date.now() + 5000);
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("four", "FOUR"));
      fs.utimesSync(f, later, later);
    });
    assert.equal(stat.lines, 1, `原地改未提交的行没算上：lines=${stat.lines}`);
    assert.equal(stat.bashPending, true);
  }));
});

function textLines(n) {
  return Array.from({ length: n }, () => "x").join("\n");
}

function manyFile(n) {
  return Array.from({ length: n }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
}

function postEdit(home, sessionId, lines, file = "/work/proj/src/app.js") {
  return runHook(postHook, {
    tool_name: "Edit",
    session_id: sessionId,
    cwd: "/work/proj",
    tool_input: { file_path: file, old_string: "a", new_string: textLines(lines) },
  }, home);
}

function postSelf(home, sessionId, reason) {
  const command = `node ${JSON.stringify(relay)} self ${JSON.stringify(reason)}`;
  return runHook(postHook, {
    tool_name: "Bash",
    session_id: sessionId,
    cwd: "/work/proj",
    tool_input: { command },
    tool_response: { stdout: `[relay-self] ${reason}\n已记录，本轮可以继续自己改\n` },
  }, home);
}

function assertOverLimitDenied(res) {
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /超过上限 40 行/);
  assert.match(reason, /relay run --write/);
  assert.match(reason, /再运行一次/);
  assert.doesNotMatch(reason, /第一次改项目代码前/);
  return reason;
}

// 指走额度库，避免本机额度把档位从 0 抬上去
function hideQuota(home) {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "..", "config", "providers.default.json"), "utf8"));
  cfg.quotaDb = path.join(home, "missing.sqlite");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(cfg));
}

function withRepo(fn) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-count-"));
  try {
    const top = spawnSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    assert.notEqual(top.status, 0, `临时目录落在仓库里：${top.stdout}`);
    initRepo(repo);
    return fn(repo);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test("bashReadCount 只计段首的读文件命令", () => {
  assert.equal(bashReadCount("cat a && grep x b"), 2);
  assert.equal(bashReadCount("node x | grep y"), 0);
  assert.equal(bashReadCount("git diff --numstat"), 0);
  assert.equal(bashReadCount("git diff | head"), 0);
  assert.equal(bashReadCount("cat a | head"), 1);
  assert.equal(bashReadCount("sed -n '1,5p' a.txt"), 1);
  assert.equal(bashReadCount("sed 's/a/b/' a.txt"), 0);
  assert.equal(bashReadCount("FOO=1 cat a && rg x b"), 2);
  assert.equal(bashReadCount(`node ${JSON.stringify(relay)} run grok --role review`), 0);
  assert.equal(bashReadCount("head a.txt\nnl b.txt"), 2);
});

test("同一条命令里先改文件再 commit 只计一次", () => {
  withHome((home) => withRepo((repo) => {
    setMode(home, "auto");
    const stat = bashRound(home, "s-once", repo, "append && git commit -am wip", () => {
      fs.appendFileSync(path.join(repo, "tracked.txt"), "a\nb\nc\nd\ne\n");
      git(repo, ["-c", "commit.gpgsign=false", "commit", "-qam", "wip"]);
    });
    assert.equal(stat.lines, 5, `提交被算了两次或没算上：lines=${stat.lines}`);
  }));
});

test("git pull 快进带来的上游改动不计入手写行数", () => {
  withHome((home) => {
    setMode(home, "auto");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-pull-"));
    try {
      const top = spawnSync("git", ["-C", parent, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
      assert.notEqual(top.status, 0, `临时目录落在仓库里：${top.stdout}`);
      const up = path.join(parent, "up");
      initRepo(up);
      const local = path.join(parent, "local");
      git(parent, ["clone", "-q", up, local]);
      fs.writeFileSync(path.join(up, "big.txt"), manyFile(300));
      git(up, ["add", "big.txt"]);
      git(up, ["-c", "commit.gpgsign=false", "commit", "-qm", "big"]);
      const stat = bashRound(home, "s-pull", local, "git pull --ff-only origin main", () => {
        git(local, ["pull", "--ff-only", "-q", "origin", "main"]);
      });
      assert.equal(stat.lines, 0, `pull 被算成手写：lines=${stat.lines}`);
      assert.equal(stat.bashPending, false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

test("git checkout 切分支带来的改动不计入手写行数", () => {
  withHome((home) => withRepo((repo) => {
    setMode(home, "auto");
    git(repo, ["checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(path.join(repo, "big.txt"), manyFile(300));
    git(repo, ["add", "big.txt"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "feature"]);
    git(repo, ["checkout", "-q", "main"]);
    const stat = bashRound(home, "s-branch", repo, "git checkout feature", () => {
      git(repo, ["checkout", "-q", "feature"]);
    });
    assert.equal(stat.lines, 0, `切分支被算成手写：lines=${stat.lines}`);
  }));
});

test("git checkout -- file 丢弃改动计 0", () => {
  withHome((home) => withRepo((repo) => {
    setMode(home, "auto");
    fs.appendFileSync(path.join(repo, "tracked.txt"), "d\n".repeat(8));
    const stat = bashRound(home, "s-restore", repo, "git checkout -- tracked.txt", () => {
      git(repo, ["checkout", "-q", "--", "tracked.txt"]);
    });
    assert.equal(stat.lines, 0, `丢弃改动被算成手写：lines=${stat.lines}`);
  }));
});

test("git stash 和 stash pop 计 0", () => {
  withHome((home) => withRepo((repo) => {
    setMode(home, "auto");
    fs.appendFileSync(path.join(repo, "tracked.txt"), "z\n".repeat(12));
    let stat = bashRound(home, "s-stash", repo, "git stash push -m t", () => {
      git(repo, ["stash", "push", "-m", "t"]);
    });
    assert.equal(stat.lines, 0, `stash 被算成手写：lines=${stat.lines}`);
    stat = bashRound(home, "s-stash", repo, "git stash pop", () => {
      git(repo, ["stash", "pop"]);
    });
    assert.equal(stat.lines, 0, `stash pop 被算成手写：lines=${stat.lines}`);
    assert.equal(stat.bashPending, false);
  }));
});

test("同一条命令里普通写入仍计数", () => {
  withHome((home) => withRepo((repo) => {
    setMode(home, "auto");
    fs.appendFileSync(path.join(repo, "tracked.txt"), "d\n".repeat(8));
    const stat = bashRound(home, "s-mix", repo, "write mine.js && git checkout -- tracked.txt", () => {
      fs.writeFileSync(path.join(repo, "mine.js"), "1\n2\n3\n4\n");
      git(repo, ["checkout", "-q", "--", "tracked.txt"]);
    });
    assert.equal(stat.lines, 4, `普通写入没单独计上：lines=${stat.lines}`);
  }));
  withHome((home) => {
    setMode(home, "auto");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-mixpull-"));
    try {
      const top = spawnSync("git", ["-C", parent, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
      assert.notEqual(top.status, 0, `临时目录落在仓库里：${top.stdout}`);
      const up = path.join(parent, "up");
      initRepo(up);
      const local = path.join(parent, "local");
      git(parent, ["clone", "-q", up, local]);
      fs.writeFileSync(path.join(up, "big.txt"), manyFile(200));
      git(up, ["add", "big.txt"]);
      git(up, ["-c", "commit.gpgsign=false", "commit", "-qm", "big"]);
      const stat = bashRound(home, "s-mixpull", local, "write mine.js && git pull --ff-only origin main", () => {
        fs.writeFileSync(path.join(local, "mine.js"), "1\n2\n3\n4\n5\n");
        git(local, ["pull", "--ff-only", "-q", "origin", "main"]);
      });
      assert.equal(stat.lines, 5, `pull 把普通写入吃掉了：lines=${stat.lines}`);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

test("只读 relay run 之后编辑仍被拦", () => {
  withHome((home) => {
    setMode(home, "auto");
    const res = runHook(postHook, {
      tool_name: "Bash",
      session_id: "s-ro",
      cwd: "/work/proj",
      tool_input: { command: `node ${JSON.stringify(relay)} run grok --role review` },
      tool_response: { stdout: "已启动\n" },
    }, home);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readEdits(home, "s-ro").decision, null);
    assertDenied(runHook(preHook, editInput("s-ro", "/work/proj/src/app.js"), home));
  });
});

test("relay self 超限后要重新定分工，再次 self 才放行且不再重置", () => {
  withHome((home) => {
    setMode(home, "auto");
    const session = "s-limit";
    let res = postSelf(home, session, "需要会话上下文");
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readEdits(home, session).decision, "self");

    res = postEdit(home, session, 41);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /已亲手写了 41 行，超过上限 40 行/);
    let stat = readEdits(home, session);
    assert.equal(stat.decision, null);
    assert.equal(stat.limitReset, true);
    assert.equal(stat.bashPending, true);
    assert.equal(stat.selfReason, "需要会话上下文");
    assert.equal(stat.lines, 41);

    assertOverLimitDenied(runHook(preHook, editInput(session, "/work/proj/src/app.js"), home));
    assertOverLimitDenied(runHook(preHook, {
      tool_name: "Bash",
      session_id: session,
      cwd: "/work/proj",
      tool_input: { command: "echo hi" },
    }, home));

    res = postSelf(home, session, "剩下的还是自己改");
    assert.equal(res.status, 0, res.stderr);
    stat = readEdits(home, session);
    assert.equal(stat.decision, "self");
    assert.equal(stat.selfReason, "需要会话上下文；超 40 行后：剩下的还是自己改");
    assert.equal(stat.limitReset, true);
    assert.equal(stat.bashPending, false);
    assertAllowed(runHook(preHook, editInput(session, "/work/proj/src/app.js"), home));

    res = postEdit(home, session, 10);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /超过上限/);
    stat = readEdits(home, session);
    assert.equal(stat.decision, "self");
    assert.equal(stat.limitReset, true);
    assert.equal(stat.bashPending, false);
    assert.equal(stat.lines, 51);
  });
});

test("decision 为 dispatch 时超限不重置", () => {
  withHome((home) => {
    setMode(home, "auto");
    const session = "s-disp";
    const resRun = runHook(postHook, {
      tool_name: "Bash",
      session_id: session,
      cwd: "/work/proj",
      tool_input: { command: `node ${JSON.stringify(relay)} run grok --role implement --write` },
      tool_response: { stdout: "已启动\n" },
    }, home);
    assert.equal(resRun.status, 0, resRun.stderr);
    assert.equal(readEdits(home, session).decision, "dispatch");
    let res = postEdit(home, session, 41);
    assert.match(res.stdout, /已亲手写了 41 行/);
    assert.match(res.stdout, /考虑交给更合适的员工模型/);
    assert.doesNotMatch(res.stdout, /超过上限/);
    let stat = readEdits(home, session);
    assert.equal(stat.decision, "dispatch");
    assert.equal(stat.limitReset, false);
    assert.equal(stat.warned, true);
    res = postEdit(home, session, 5);
    assert.equal(res.stdout, "");
    stat = readEdits(home, session);
    assert.equal(stat.decision, "dispatch");
    assert.equal(stat.limitReset, false);
    assert.equal(stat.lines, 46);
  });
});

test("Bash 读文件计入次数，管道、git 和 relay 不计", () => {
  withHome((home) => {
    setMode(home, "auto");
    const post = (command) => runHook(postHook, {
      tool_name: "Bash",
      session_id: "s-read",
      cwd: "/work/proj",
      tool_input: { command },
      tool_response: "",
    }, home);
    assert.equal(post("cat a && grep x b").status, 0);
    assert.equal(readEdits(home, "s-read").reads, 2);
    assert.equal(post("node x | grep y").status, 0);
    assert.equal(readEdits(home, "s-read").reads, 2);
    assert.equal(post("git diff --numstat").status, 0);
    assert.equal(readEdits(home, "s-read").reads, 2);
    assert.equal(post(`node ${JSON.stringify(relay)} run grok --role review`).status, 0);
    assert.equal(readEdits(home, "s-read").reads, 2);
  });
});

test("档位 0 读文件超过上限提醒一次", () => {
  withHome((home) => {
    setMode(home, "auto");
    hideQuota(home);
    const cmd = Array.from({ length: 9 }, (_, i) => `cat f${i}`).join(" && ");
    const first = runHook(postHook, {
      tool_name: "Bash",
      session_id: "s-r0",
      cwd: "/work/proj",
      tool_input: { command: cmd },
      tool_response: "",
    }, home);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /\[ai-relay 自动模式\] 这一轮你已读了 9 次文件/);
    assert.match(first.stdout, /relay pick read --level <难度>/);
    assert.equal(readEdits(home, "s-r0").readWarned, true);
    assert.equal(readEdits(home, "s-r0").reads, 9);
    const second = runHook(postHook, {
      tool_name: "Bash",
      session_id: "s-r0",
      cwd: "/work/proj",
      tool_input: { command: "cat f" },
      tool_response: "",
    }, home);
    assert.equal(second.stdout, "");
    assert.equal(readEdits(home, "s-r0").reads, 10);
    assert.equal(readEdits(home, "s-r0").readWarned, true);

    fs.mkdirSync(path.join(home, "prompts"), { recursive: true });
    fs.writeFileSync(editsPath(home, "s-r0b"), JSON.stringify({
      lines: 0, warned: false, reads: 8, readWarned: false,
      decision: null, selfReason: "", bashPending: false, limitReset: false, repos: null,
    }));
    const read1 = runHook(postHook, {
      tool_name: "Read",
      session_id: "s-r0b",
      tool_input: { file_path: "/work/a.js" },
    }, home);
    assert.match(read1.stdout, /\[ai-relay 自动模式\] 这一轮你已读了 9 次文件/);
    const read2 = runHook(postHook, {
      tool_name: "Read",
      session_id: "s-r0b",
      tool_input: { file_path: "/work/b.js" },
    }, home);
    assert.equal(read2.stdout, "");
    assert.equal(readEdits(home, "s-r0b").reads, 10);
    assert.equal(readEdits(home, "s-r0b").readWarned, true);
  });
});

test("子代理和非自动模式的阅读不计数", () => {
  withHome((home) => {
    setMode(home, "manual");
    let res = runHook(postHook, {
      tool_name: "Read",
      session_id: "s-manual-read",
      tool_input: { file_path: "/work/a.js" },
    }, home);
    assert.equal(res.stdout, "");
    assert.equal(fs.existsSync(editsPath(home, "s-manual-read")), false);
    setMode(home, "auto");
    res = runHook(postHook, {
      tool_name: "Bash",
      session_id: "s-agent-read",
      agent_id: "agent-1",
      cwd: "/work/proj",
      tool_input: { command: "cat a" },
      tool_response: "",
    }, home);
    assert.equal(res.stdout, "");
    assert.equal(fs.existsSync(editsPath(home, "s-agent-read")), false);
  });
});

test("Codex 只有可写派单才算定分工", () => {
  withHome((home) => {
    setMode(home, "auto");
    hideQuota(home);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "providers.json"), "utf8"));
    cfg.providers.codex.quota.provider = "codex-test-none";
    fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify(cfg));
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-codex-"));
    // realpath 去掉 /var 与 /private/var 的差别，否则沙箱根和写入范围对不上
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-codex-repo-")));
    try {
      fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-6-luna"\n');
      initRepo(repo);
      const body = "\n\n## 目标\n改一处文案\n\n## 验收标准\n文案改好";
      const call = (sessionId, prompt) => runHook(preHook, {
        tool_name: "Agent",
        session_id: sessionId,
        cwd: repo,
        tool_input: { subagent_type: "codex:codex-rescue", prompt, description: "派单" },
      }, home, { CODEX_HOME: codexHome });
      const readOnly = call("s-codex-ro", "角色：review\n难度：简单" + body);
      assert.equal(readOnly.status, 0, readOnly.stderr);
      const ro = JSON.parse(readOnly.stdout || "{}").hookSpecificOutput || {};
      assert.equal(ro.permissionDecision, "allow", readOnly.stdout);
      assert.equal(fs.existsSync(editsPath(home, "s-codex-ro")), false);
      // 临时目录算草稿，编辑闸门不看它；用项目路径确认只读派单没有放行
      assertDenied(runHook(preHook, editInput("s-codex-ro", "/work/proj/src/app.js"), home));

      const writable = call("s-codex-w", "角色：implement\n难度：简单" + body);
      assert.equal(writable.status, 0, writable.stderr);
      const wr = JSON.parse(writable.stdout || "{}").hookSpecificOutput || {};
      assert.equal(wr.permissionDecision, "allow", writable.stdout);
      assert.equal(readEdits(home, "s-codex-w").decision, "dispatch");
      assertAllowed(runHook(preHook, editInput("s-codex-w", "/work/proj/src/app.js"), home));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

test("bashReadCount 不把 heredoc 写文件算成读文件", () => {
  assert.equal(bashReadCount("cat > notes.md <<'EOF'\ngrep 是一个命令\nhead 也是\nEOF"), 0);
  assert.equal(bashReadCount("cat <<EOF > a.txt\nx\nEOF\ncat a.txt"), 1);
  assert.equal(bashReadCount("python3 - <<'PY'\nhead = 1\ntail = 2\nPY"), 0);
  assert.equal(bashReadCount("cat a.txt && sed -n '1,5p' b.txt"), 2);
});

// 在隔离 home 里写一条运行中的可写任务记录，供 Bash 行数统计排除用。
function writeRunningJob(home, over = {}) {
  const job = {
    id: "20261117000000-grok-writer",
    provider: "grok",
    pool: "supergrok-weekly",
    model: "default",
    role: "implement",
    reason: "测试用",
    write: true,
    cwd: "",
    task: "测试任务",
    scope: null,
    status: "running",
    startedAt: new Date().toISOString(),
    ...over,
  };
  fs.mkdirSync(path.join(home, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(home, "jobs", `${job.id}.json`), JSON.stringify(job, null, 2));
  return job;
}

test("运行中的可写任务 scope 内的文件不算主管手写，范围外照常计", () => {
  withHome((home) => withRepo((repo) => {
    setMode(home, "auto");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    writeRunningJob(home, { cwd: repo, scope: ["src"] });
    const stat = bashRound(home, "s-worker-scope", repo, "python3 - <<'PY'\nPY", () => {
      fs.writeFileSync(path.join(repo, "src", "a.js"), "1\n2\n3\n4\n5\n6\n");
      fs.writeFileSync(path.join(repo, "b.js"), "1\n2\n3\n");
    });
    assert.equal(stat.lines, 3, `scope 内员工写的行被算进主管：lines=${stat.lines}`);
  }));
});

test("运行中的可写任务没有 scope 时，该仓库这次 Bash 计 0", () => {
  withHome((home) => withRepo((repo) => {
    setMode(home, "auto");
    writeRunningJob(home, { cwd: repo, scope: null });
    const stat = bashRound(home, "s-worker-whole", repo, "python3 - <<'PY'\nPY", () => {
      fs.writeFileSync(path.join(repo, "tracked.txt"), "1\n2\n3\n4\n5\n");
    });
    assert.equal(stat.lines, 0, `没有 scope 的员工被算成主管手写：lines=${stat.lines}`);
  }));
});

test("任务在 Bash 期间结束（前快照在跑、后快照已结束）仍然排除", () => {
  withHome((home) => withRepo((repo) => {
    setMode(home, "auto");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const job = writeRunningJob(home, { cwd: repo, scope: ["src"] });
    // 前快照由 pretool 自己拍，会把当时 running 的任务 id 记进去；act 里把任务改成 done 模拟 Bash 期间结束
    const stat = bashRound(home, "s-worker-ended", repo, "python3 - <<'PY'\nPY", () => {
      fs.writeFileSync(path.join(repo, "src", "a.js"), "1\n2\n3\n4\n5\n");
      const p = path.join(home, "jobs", `${job.id}.json`);
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      j.status = "done";
      j.finishedAt = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    });
    assert.equal(stat.lines, 0, `Bash 期间结束的任务漏排除：lines=${stat.lines}`);
  }));
});

test("没有运行中任务时计数不变", () => {
  withHome((home) => withRepo((repo) => {
    setMode(home, "auto");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const stat = bashRound(home, "s-no-worker", repo, "python3 - <<'PY'\nPY", () => {
      fs.writeFileSync(path.join(repo, "src", "a.js"), "1\n2\n3\n4\n");
      fs.writeFileSync(path.join(repo, "b.js"), "1\n2\n");
    });
    assert.equal(stat.lines, 6, `没有任务时计数变了：lines=${stat.lines}`);
  }));
});
