// 派单各段落解析的结束边界测试：不带 # 的「段名：」写法与带 ## 写法边界一致
import test from "node:test";
import assert from "node:assert/strict";
import { scopeOfBrief, needsOfBrief, stepsOfBrief, verifyOfBrief } from "./brief.mjs";

const ALL_SECTIONS = [
  "目标",
  "背景",
  "相关文件",
  "写入范围",
  "需要的能力",
  "步骤",
  "约束",
  "验收标准",
  "验证命令",
  "交付格式",
];

test("无 # 写法相邻边界：写入范围 → 需要的能力", () => {
  const brief1 = `写入范围：
src/
需要的能力：
无`;
  assert.deepEqual(scopeOfBrief(brief1), ["src"]);
  assert.deepEqual(needsOfBrief(brief1), []);

  const brief2 = `写入范围：plugins/ai-relay/scripts/brief.mjs
需要的能力：执行命令`;
  assert.deepEqual(scopeOfBrief(brief2), ["plugins/ai-relay/scripts/brief.mjs"]);
  assert.deepEqual(needsOfBrief(brief2), ["exec"]);
});

test("无 # 写法相邻边界：需要的能力 → 步骤", () => {
  // 「需要的能力」写无，后续「步骤」里的关键词不能被吞进「需要的能力」
  const briefNoNeeds = `需要的能力：
无
步骤：
1. 联网搜索 src/a.mjs 相关用法
2. 执行命令跑测试 src/b.mjs`;
  assert.deepEqual(needsOfBrief(briefNoNeeds), []);
  assert.deepEqual(stepsOfBrief(briefNoNeeds), [
    "联网搜索 src/a.mjs 相关用法",
    "执行命令跑测试 src/b.mjs",
  ]);

  const briefExec = `需要的能力：执行命令
步骤：
1. 联网查看 docs/spec.md
2. 截图标注 docs/ui.png`;
  assert.deepEqual(needsOfBrief(briefExec), ["exec"]);
  assert.deepEqual(stepsOfBrief(briefExec), [
    "联网查看 docs/spec.md",
    "截图标注 docs/ui.png",
  ]);
});

test("无 # 写法相邻边界：步骤 → 验证命令", () => {
  const brief = `步骤：
1. 修改 plugins/ai-relay/scripts/brief.mjs
2. 新建 plugins/ai-relay/scripts/brief-sections.test.mjs
验证命令：
node --test plugins/ai-relay/scripts/brief-sections.test.mjs`;
  assert.deepEqual(stepsOfBrief(brief), [
    "修改 plugins/ai-relay/scripts/brief.mjs",
    "新建 plugins/ai-relay/scripts/brief-sections.test.mjs",
  ]);
  assert.deepEqual(verifyOfBrief(brief), [
    "node --test plugins/ai-relay/scripts/brief-sections.test.mjs",
  ]);
});

test("四个解析函数遇到任一其它「段名：」（中英文冒号、不带 #）时均能结束本段", () => {
  const cases = [
    {
      section: "写入范围",
      parse: scopeOfBrief,
      body: "src/a.mjs",
      expected: ["src/a.mjs"],
      trailing: "src/should-not-include.mjs",
    },
    {
      section: "需要的能力",
      parse: needsOfBrief,
      body: "无",
      expected: [],
      trailing: "联网 执行命令 看图",
    },
    {
      section: "步骤",
      parse: stepsOfBrief,
      body: "1. 改 src/a.mjs",
      expected: ["改 src/a.mjs"],
      trailing: "2. 不应吞入的步骤 src/b.mjs",
    },
    {
      section: "验证命令",
      parse: verifyOfBrief,
      body: "node --test a.test.mjs",
      expected: ["node --test a.test.mjs"],
      trailing: "node --test should-not-run.test.mjs",
    },
  ];

  for (const { section, parse, body, expected, trailing } of cases) {
    for (const next of ALL_SECTIONS) {
      if (next === section) continue;
      for (const colon of ["：", ":"]) {
        const text = `${section}：\n${body}\n${next}${colon}\n${trailing}`;
        assert.deepEqual(parse(text), expected, `${section} 遇到 ${next}${colon} 应结束`);

        // 段名和冒号之间允许空白，与标题匹配规则一致
        const spacedText = `${section}：\n${body}\n${next} ${colon} ${trailing}`;
        assert.deepEqual(parse(spacedText), expected, `${section} 遇到 ${next} ${colon} 应结束`);
      }
    }
  }
});

test("各解析函数排除自己本段名，不会因正文出现「本段名：」而误断", () => {
  assert.deepEqual(
    scopeOfBrief("写入范围：\nsrc/a.mjs\n写入范围：补充\nsrc/b.mjs"),
    ["src/a.mjs", "写入范围：补充", "src/b.mjs"],
  );
  assert.deepEqual(
    needsOfBrief("需要的能力：\n执行命令\n需要的能力：联网"),
    ["web", "exec"],
  );
  assert.deepEqual(
    stepsOfBrief("步骤：\n1. 改 src/a.mjs\n步骤：补充改 src/b.mjs"),
    ["改 src/a.mjs", "步骤：补充改 src/b.mjs"],
  );
  assert.deepEqual(
    verifyOfBrief("验证命令：\nnode --test a.test.mjs\n验证命令：补充\nnode --test b.test.mjs"),
    ["node --test a.test.mjs", "验证命令：补充", "node --test b.test.mjs"],
  );
});

test("带 ## 的原写法与无 # 写法解析结果一致", () => {
  const withHash = `角色：implement
难度：简单

## 目标
修复分段解析

## 背景
派单支持两种标题写法

## 相关文件
plugins/ai-relay/scripts/brief.mjs

## 写入范围
plugins/ai-relay/scripts/brief.mjs
plugins/ai-relay/scripts/brief-sections.test.mjs

## 需要的能力
执行命令

## 步骤
1. 修改 plugins/ai-relay/scripts/brief.mjs
2. 新增 plugins/ai-relay/scripts/brief-sections.test.mjs

## 约束
不改签名

## 验证命令
node --test plugins/ai-relay/scripts/brief-sections.test.mjs

## 验收标准
全部通过

## 交付格式
结论`;

  const withoutHash = withHash.replace(/^## /gm, "").replace(/^(目标|背景|相关文件|写入范围|需要的能力|步骤|约束|验证命令|验收标准|交付格式)$/gm, "$1：");

  assert.deepEqual(scopeOfBrief(withoutHash), scopeOfBrief(withHash));
  assert.deepEqual(scopeOfBrief(withoutHash), [
    "plugins/ai-relay/scripts/brief.mjs",
    "plugins/ai-relay/scripts/brief-sections.test.mjs",
  ]);
  assert.deepEqual(needsOfBrief(withoutHash), needsOfBrief(withHash));
  assert.deepEqual(needsOfBrief(withoutHash), ["exec"]);
  assert.deepEqual(stepsOfBrief(withoutHash), stepsOfBrief(withHash));
  assert.deepEqual(stepsOfBrief(withoutHash), [
    "修改 plugins/ai-relay/scripts/brief.mjs",
    "新增 plugins/ai-relay/scripts/brief-sections.test.mjs",
  ]);
  assert.deepEqual(verifyOfBrief(withoutHash), verifyOfBrief(withHash));
  assert.deepEqual(verifyOfBrief(withoutHash), [
    "node --test plugins/ai-relay/scripts/brief-sections.test.mjs",
  ]);
});
