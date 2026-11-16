// 模式切换：cmdMode 默认不启停 Codex 插件；mode-seen 按会话记下上次注入的模式，并跟提问记录一起清理
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(DIR, "relay.mjs");

// 在 PATH 最前面放一个会把参数记到日志的假 claude，确认有没有真的去启停插件
function runMode(args, mode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mode-"));
  if (mode) fs.writeFileSync(path.join(home, "mode"), mode + "\n");
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fake-claude-"));
  const log = path.join(bin, "calls.log");
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  fs.chmodSync(path.join(bin, "claude"), 0o755);
  const r = spawnSync(process.execPath, [RELAY, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_RELAY_HOME: home,
      CLAUDE_PROJECT_DIR: "",
      PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    },
    timeout: 20000,
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  return { r, home, calls };
}

function runLib(home, script) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: DIR,
    encoding: "utf8",
    env: { ...process.env, AI_RELAY_HOME: home },
    timeout: 20000,
  });
}

test("mode 不带 --sync 不调用 claude，并提示从下一条消息起生效", () => {
  const off = runMode(["mode", "off"], "auto");
  assert.equal(off.r.status, 0, off.r.stderr);
  assert.match(off.r.stdout, /ai-relay 模式：auto → off，从下一条消息起生效/);
  assert.doesNotMatch(off.r.stdout, /新会话/);
  assert.equal(off.calls, "");
  assert.equal(fs.readFileSync(path.join(off.home, "mode"), "utf8").trim(), "off");

  const manual = runMode(["mode", "manual"], "auto");
  assert.equal(manual.r.status, 0, manual.r.stderr);
  assert.match(manual.r.stdout, /ai-relay 模式：auto → manual，从下一条消息起生效/);
  assert.equal(manual.calls, "");

  const back = runMode(["mode", "auto"], "off");
  assert.equal(back.r.status, 0, back.r.stderr);
  assert.match(back.r.stdout, /ai-relay 模式：off → auto，从下一条消息起生效/);
  assert.equal(back.calls, "");
});

test("mode --sync 才调用 claude 启停 Codex 插件", () => {
  const enable = runMode(["mode", "auto", "--sync"], "off");
  assert.equal(enable.r.status, 0, enable.r.stderr);
  assert.match(enable.r.stdout, /ai-relay 模式：off → auto，从下一条消息起生效/);
  assert.match(enable.r.stdout, /Codex 插件已启用/);
  assert.match(enable.calls, /plugin enable codex@openai-codex/);
  assert.doesNotMatch(enable.r.stdout, /新会话/);

  const disable = runMode(["mode", "off", "--sync"], "auto");
  assert.equal(disable.r.status, 0, disable.r.stderr);
  assert.match(disable.r.stdout, /ai-relay 模式：auto → off，从下一条消息起生效/);
  assert.match(disable.calls, /plugin disable codex@openai-codex/);
});

test("getModeSeen / setModeSeen 按会话读写，空会话和非法内容当作没见过", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mode-seen-"));
  const r = runLib(home, `
    import fs from "node:fs";
    import path from "node:path";
    import { getModeSeen, setModeSeen } from "./lib.mjs";
    const dir = path.join(process.env.AI_RELAY_HOME, "mode-seen");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.txt"), "banana\\n");
    console.log("missing=" + JSON.stringify(getModeSeen("nope")));
    console.log("empty=" + JSON.stringify(getModeSeen("")));
    console.log("bad=" + JSON.stringify(getModeSeen("bad")));
    setModeSeen("s1", "auto");
    setModeSeen("s2", "off");
    setModeSeen("", "manual");
    setModeSeen("s1", "nope");
    console.log("s1=" + JSON.stringify(getModeSeen("s1")));
    console.log("s2=" + JSON.stringify(getModeSeen("s2")));
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /missing=""/);
  assert.match(r.stdout, /empty=""/);
  assert.match(r.stdout, /bad=""/);
  assert.match(r.stdout, /s1="auto"/);
  assert.match(r.stdout, /s2="off"/);
  assert.equal(fs.existsSync(path.join(home, "mode-seen", ".txt")), false);
  assert.equal(fs.readFileSync(path.join(home, "mode-seen", "s1.txt"), "utf8").trim(), "auto");
});

test("mode-seen 过期文件按提问记录的保留天数清理，没过期的留下", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mode-clean-"));
  const r = runLib(home, `
    import fs from "node:fs";
    import path from "node:path";
    import { setModeSeen, cleanup, RETENTION_DAYS } from "./lib.mjs";
    const dir = path.join(process.env.AI_RELAY_HOME, "mode-seen");
    setModeSeen("fresh", "auto");
    setModeSeen("stale", "manual");
    const old = new Date(Date.now() - (RETENTION_DAYS.prompts + 1) * 86_400_000);
    fs.utimesSync(path.join(dir, "stale.txt"), old, old);
    cleanup(Date.now());
    console.log("fresh=" + fs.existsSync(path.join(dir, "fresh.txt")));
    console.log("stale=" + fs.existsSync(path.join(dir, "stale.txt")));
    console.log("days=" + RETENTION_DAYS.prompts);
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fresh=true/);
  assert.match(r.stdout, /stale=false/);
  assert.match(r.stdout, /days=7/);
});
