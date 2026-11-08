// 自动模式：第一次改项目代码前要定分工；Bash 写入的行数也要计入
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { snapshotDelta, cdTargets } from "./lib.mjs";

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

test("snapshotDelta 按绝对值累加，缺的一边当 0", () => {
  assert.equal(snapshotDelta({ a: 1, b: 5 }, { b: 2, c: 4 }), 8);
  assert.equal(snapshotDelta(null, { a: 3 }), 3);
  assert.equal(snapshotDelta({ a: 3 }, {}), 3);
});

test("auto 模式下还没定分工时，改项目文件被拒，临时目录和 memory 不拒", () => {
  withHome((home) => {
    setMode(home, "auto");
    const denied = runHook(preHook, editInput("s1", "/work/proj/src/app.js"), home);
    assertDenied(denied);

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

test("relay run 之后 decision 为 dispatch", () => {
  withHome((home) => {
    setMode(home, "auto");
    fs.mkdirSync(path.join(home, "prompts"), { recursive: true });
    fs.writeFileSync(editsPath(home, "s-run"), JSON.stringify({
      lines: 0, warned: false, reads: 0, readWarned: false, decision: null, selfReason: "", bashPending: true, repos: null,
    }));
    const res = runHook(postHook, {
      tool_name: "Bash",
      session_id: "s-run",
      cwd: "/work/proj",
      tool_input: { command: `node ${JSON.stringify(relay)} run grok --role implement` },
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
    assert.equal(raw.repos, null);
    assert.equal(via.decision, null);
    assert.equal(via.selfReason, "");
    assert.equal(via.bashPending, false);
    assert.deepEqual(via.repos, []);
    assert.equal(via.reposKnown, false);
    assert.equal(old.lines, 3);
    assert.equal(old.warned, false);
    assert.equal(old.reads, 0);
    assert.equal(old.readWarned, false);
    assert.equal(old.decision, null);
    assert.equal(old.selfReason, "");
    assert.equal(old.bashPending, false);
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
