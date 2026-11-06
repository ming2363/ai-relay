// PreToolUse 钩子：Bash 里的 relay run 只写待认领记录，不改命令
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(dir, "pretool-hook.mjs");
const lib = path.join(dir, "lib.mjs");

const relayRun = 'node "/plugin/scripts/relay.mjs" run grok --role review';

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-pending-"));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runHook(input, home) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: home },
  });
}

function pendingDir(home) {
  return path.join(home, "pending-dispatch");
}

function pendingFiles(home) {
  const folder = pendingDir(home);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => name.endsWith(".json")).sort();
}

function readPending(home) {
  return pendingFiles(home).map((name) => ({
    name,
    rec: JSON.parse(fs.readFileSync(path.join(pendingDir(home), name), "utf8")),
  }));
}

// 在独立进程里认领，避免本进程把 STATE_DIR 固定到真实家目录
function claim(home, cwd) {
  const runner = path.join(home, "_claim.mjs");
  const spec = pathToFileURL(lib).href;
  fs.writeFileSync(
    runner,
    `import { claimPendingDispatch } from ${JSON.stringify(spec)};\nprocess.stdout.write(claimPendingDispatch(${JSON.stringify(cwd)}));\n`,
  );
  const res = spawnSync(process.execPath, [runner], {
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: home },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

test("relay run 时 stdout 为空，并写出待认领记录", () => {
  withHome((home) => {
    const res = runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      session_id: "sess-1",
      cwd: "/work/a",
      tool_input: { command: relayRun, description: "外派审查" },
    }, home);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "");
    const files = readPending(home);
    assert.equal(files.length, 1);
    assert.equal(files[0].rec.sessionId, "sess-1");
    assert.equal(files[0].rec.cwd, "/work/a");
    assert.equal(typeof files[0].rec.at, "number");
    assert.match(files[0].name, /^\d+-[0-9a-f]+\.json$/);
  });
});

test("普通 Bash 不写记录", () => {
  withHome((home) => {
    const res = runHook({
      tool_name: "Bash",
      session_id: "sess-1",
      cwd: "/work/a",
      tool_input: { command: "ls" },
    }, home);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "");
    assert.deepEqual(pendingFiles(home), []);
  });
});

test("relay 的其他子命令不写记录", () => {
  withHome((home) => {
    const res = runHook({
      tool_name: "Bash",
      session_id: "sess-1",
      cwd: "/work/a",
      tool_input: { command: 'node "/plugin/scripts/relay.mjs" jobs --json' },
    }, home);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "");
    assert.deepEqual(pendingFiles(home), []);
  });
});

test("没有会话 id 时不写记录", () => {
  withHome((home) => {
    const res = runHook({
      tool_name: "Bash",
      cwd: "/work/a",
      tool_input: { command: relayRun },
    }, home);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "");
    assert.deepEqual(pendingFiles(home), []);
  });
});

test("relay 认领后记录被删", () => {
  withHome((home) => {
    const res = runHook({
      tool_name: "Bash",
      session_id: "sess-claim",
      cwd: "/work/claim",
      tool_input: { command: relayRun },
    }, home);
    assert.equal(res.stdout, "");
    assert.equal(pendingFiles(home).length, 1);
    assert.equal(claim(home, "/work/claim"), "sess-claim");
    assert.deepEqual(pendingFiles(home), []);
    assert.equal(claim(home, "/work/claim"), "");
  });
});

test("两条记录时按 cwd 选对，没有相同 cwd 时取最新", () => {
  withHome((home) => {
    runHook({
      tool_name: "Bash",
      session_id: "sess-match",
      cwd: "/proj/match",
      tool_input: { command: relayRun },
    }, home);
    runHook({
      tool_name: "Bash",
      session_id: "sess-new",
      cwd: "/proj/new",
      tool_input: { command: relayRun },
    }, home);
    const now = Date.now();
    for (const item of readPending(home)) {
      item.rec.at = item.rec.sessionId === "sess-new" ? now : now - 1000;
      fs.writeFileSync(path.join(pendingDir(home), item.name), JSON.stringify(item.rec));
    }
    assert.equal(claim(home, "/proj/match"), "sess-match");
    const left = readPending(home);
    assert.equal(left.length, 1);
    assert.equal(left[0].rec.sessionId, "sess-new");
    assert.equal(claim(home, "/proj/other"), "sess-new");
    assert.deepEqual(pendingFiles(home), []);
  });
});

test("认领时删掉超过 5 分钟的记录，30 秒外的不认领", () => {
  withHome((home) => {
    const folder = pendingDir(home);
    fs.mkdirSync(folder);
    const now = Date.now();
    fs.writeFileSync(path.join(folder, `${now}-old.json`), JSON.stringify({ sessionId: "old", cwd: "/p", at: now - 6 * 60 * 1000 }));
    fs.writeFileSync(path.join(folder, `${now}-stale.json`), JSON.stringify({ sessionId: "stale", cwd: "/p", at: now - 31 * 1000 }));
    fs.writeFileSync(path.join(folder, `${now}-fresh.json`), JSON.stringify({ sessionId: "fresh", cwd: "/p", at: now }));
    assert.equal(claim(home, "/p"), "fresh");
    assert.deepEqual(pendingFiles(home), [`${now}-stale.json`]);
  });
});

test("钩子读到坏 JSON 时什么都不输出", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-relay-pending-"));
  try {
    const res = spawnSync(process.execPath, [hook], {
      input: "{",
      encoding: "utf8",
      env: { ...process.env, AI_RELAY_HOME: home },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
    assert.deepEqual(pendingFiles(home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
