// codexFlagsOf：全文提取并剥离 --model / --effort（正文写的也要过档位检查，防绕过），只跳过代码块
import test from "node:test";
import assert from "node:assert/strict";
import { codexFlagsOf } from "./brief.mjs";

test("首行提取 --model 与 --effort，同时支持空格与等号写法并保留其他参数", () => {
  const res = codexFlagsOf("--model x --effort xhigh\n角色：implement\n难度：困难\n\n## 目标\n完成任务");
  assert.equal(res.model, "x");
  assert.equal(res.effort, "xhigh");
  assert.deepEqual(res.conflict, []);
  assert.deepEqual(res.others, []);
  assert.equal(res.rest, "角色：implement\n难度：困难\n\n## 目标\n完成任务");

  const eq = codexFlagsOf("  --model=gpt-6.1-terra\t--background  --effort=high\n\n角色：implement");
  assert.equal(eq.model, "gpt-6.1-terra");
  assert.equal(eq.effort, "high");
  assert.deepEqual(eq.others, ["--background"]);
  assert.equal(eq.rest, "角色：implement");
});

test("正文里的 --model 照常提取并剥离，不能绕过档位检查", () => {
  const res = codexFlagsOf("角色：implement\n难度：中等\n用 --model gpt-6-luna 跑");
  assert.equal(res.model, "gpt-6-luna");
  assert.doesNotMatch(res.rest, /--model/);
});

test("代码块里的 --model / --effort 不提取、不删除、不触发冲突", () => {
  const body = [
    "角色：implement",
    "难度：困难",
    "",
    "## 背景",
    "```bash",
    "codex --model y --effort minimal",
    "--model z",
    "```",
    "~~~",
    "--effort low",
    "~~~",
  ].join("\n");
  const res = codexFlagsOf(`--model x --effort xhigh\n\n${body}`);
  assert.equal(res.model, "x");
  assert.equal(res.effort, "xhigh");
  assert.deepEqual(res.conflict, []);
  assert.equal(res.rest, body);
});

test("代码块以外出现两个不同的 --model 判为冲突", () => {
  const res = codexFlagsOf("--model x\n角色：implement\n正文写了 --model y");
  assert.deepEqual(res.conflict, ["model"]);
});
