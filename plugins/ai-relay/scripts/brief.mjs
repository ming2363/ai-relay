// 派单包：外派的模型看不到主会话的上下文，这里负责把它需要的上下文装进派单
//   1. 项目上下文（自动）：目录、git 分支与未提交改动、项目规则文件（AGENTS.md 等小文件直接附上原文）
//   2. 共享背景（主模型写一次，同一目录的后续派单自动附上）：本次任务已确定的事实、决定、用户偏好
//   3. 派单正文（主模型按模板写）：目标 / 背景 / 相关文件 / 写入范围 / 需要的能力 / 约束 / 验收标准 / 交付格式，缺"目标"或"验收标准"会被退回
//   4. 接力材料（按需）：--with 附上前序外派的结果，--diff 附上当前 git diff（审查用）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseLevel } from "./score.mjs";

// 项目规则文件：小于上限的直接附原文（里面通常是"禁止 git commit"这类硬约束），大的只给路径
const RULE_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "PROJECT_MEMORY.md"];
const RULE_INLINE_MAX = 6 * 1024;
const CHANGED_MAX = 30;
const ATTACH_MAX = 6 * 1024;
const DIFF_MAX = 20 * 1024;
// 共享背景超过这个时长视为上一件事的，不再自动附上
export const CONTEXT_TTL_MS = 6 * 3600_000;

export const BRIEF_TEMPLATE = `角色：<implement|debug|review|read|deep|quick|claude-backup>
难度：<简单|中等|困难>（必填。简单：照样子改、补注释、整理资料这类不用推理的活，优先派便宜、额度多的轻档模型；中等：常规实现和排查；困难：跨模块设计、疑难排查，只派强档模型）

## 目标
<一句话说清要交付什么>

## 背景
<本会话里已经确定的事实、做过的决定、用户的偏好；对方看不到我们的对话，这里不写它就不知道>

## 相关文件
<路径:行号，说明每个文件和任务的关系>

## 写入范围
<可写任务必填：允许改动的文件或目录，每行一个，相对工作目录；并行的可写任务范围不能重叠>

## 需要的能力
<联网 / 执行命令 / 无。只写外派模型自己要用到的；浏览器、Word、连接器等 Claude 专属工具由主控先做好，结果写进背景>

## 约束
<不许做的事、必须遵守的规范、不能碰的文件>

## 验收标准
<逐条可核对的标准，主模型会按这里逐条验收>

## 交付格式
<可省略；默认：结论 / 改动文件 / 验证方式 / 未决问题>`;

const git = (cwd, args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch {
    return null;
  }
};

// 派单正文是否有必填段落：目标、验收标准
// 只认两种写法：1. 一行只有标题（可带 1–4 个 # 和前后空白，允许跟冒号或括注）；2. 以 词： 或 词: 开头的行
export function checkBrief(text) {
  const lines = String(text || "").split(/\r?\n/);
  const has = (word) => {
    // 整行标题；带 # 的标题后面允许括注，如"## 验收标准（主控逐条验证）"，也允许带冒号，如"## 验收标准："
    const titleRe = new RegExp(`^[ \t]*(?:#{1,4}[ \t]*${word}[ \t]*(?:[（(][^\n]*)?[:：]?|${word}[ \t]*)$`);
    const prefixRe = new RegExp(`^[ \t]*(?:#{1,4}[ \t]*)?${word}[:：]`);
    return lines.some((line) => titleRe.test(line) || prefixRe.test(line));
  };
  return ["目标", "验收标准"].filter((w) => !has(w));
}

// 从派单里读出行首的"角色：xxx"（前面可有空白）
export function roleOfBrief(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^[ \t]*角色\s*[:：]\s*([a-z][a-z-]*)/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// 派单里的「难度：简单|中等|困难」，返回 easy / medium / hard；没写或认不出返回 null
export function levelOfBrief(text) {
  // 认不出的（比如没填的模板占位符）跳过，继续找后面的；也接受「## 难度：中等」这种标题写法
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^[ \t]*(?:#{1,6}[ \t]*)?难度\s*[:：]\s*([^\s（(，,。]+)/);
    const level = m ? parseLevel(m[1]) : null;
    if (level) return level;
  }
  return null;
}

// 派给 Codex 的 prompt 里的运行参数。codex-rescue 会把全文任何位置的 --model / --effort 当运行参数，
// 所以这里全文查找（--model x 和 --model=x 两种写法），全部拿出来交给钩子检查，并从正文里去掉；
// 开头整行的其他参数（如 --background）原样保留。
// 返回 { model, effort, conflict（同一参数写了不同的值）, others, rest（去掉参数后的派单正文） }
export function codexFlagsOf(text) {
  const values = { model: new Set(), effort: new Set() };
  const cleaned = String(text || "").replace(/(^|[ \t])--(model|effort)(?:=|[ \t]+)([^\s]+)/gm, (_, lead, key, value) => {
    values[key].add(value);
    return lead;
  });
  const lines = cleaned.split(/\r?\n/);
  const others = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith("--")) break;
    others.push(...line.split(/\s+/));
  }
  const conflict = [...Object.entries(values)].filter(([, set]) => set.size > 1).map(([key]) => key);
  return {
    model: [...values.model][0] || null,
    effort: [...values.effort][0] || null,
    conflict,
    others,
    rest: lines.slice(i).join("\n"),
  };
}

// 从派单里读出写入范围
export function scopeOfBrief(text) {
  const lines = String(text || "").split(/\r?\n/);
  let inScope = false;
  const result = [];

  const titleWithHash = /^[ \t]*#{1,6}[ \t]*写入范围(?:\s*[（(][^）\n]*[）)])?[ \t]*[:：]?[ \t]*(.*)$/;
  const titleNoHash = /^[ \t]*写入范围[ \t]*[:：][ \t]*(.*)$/;

  const addPath = (raw) => {
    let s = raw.replace(/^[\s\-*`]+/, "").replace(/[`\s]+$/, "");
    if (!s || s === "无" || s.startsWith("<")) return;
    let p = s.replace(/\/+$/, "");
    while (p.startsWith("./")) p = p.slice(2);
    if (!p && s.startsWith(".")) p = ".";
    if (p && !result.includes(p)) result.push(p);
  };

  const parseLine = (str) => {
    if (!str || !str.trim()) return;
    const parts = str.includes(",") || str.includes("，") ? str.split(/[,，]/) : [str];
    for (const part of parts) {
      addPath(part);
    }
  };

  for (const rawLine of lines) {
    if (!inScope) {
      const mHash = rawLine.match(titleWithHash);
      const mNoHash = rawLine.match(titleNoHash);
      const m = mHash || mNoHash;
      if (m) {
        inScope = true;
        if (m[1]) {
          parseLine(m[1]);
        }
      }
      continue;
    }
    if (/^[ \t]*#/.test(rawLine) || /^[ \t]*(?:目标|背景|相关文件|约束|验收标准|交付格式)[:：]/.test(rawLine)) {
      break;
    }
    parseLine(rawLine);
  }
  return result;
}

// 从「需要的能力」段落读出外派模型自己要用的能力：web 联网，exec 执行命令
// 标题规则与 scopeOfBrief 一致（可带 #、括注、冒号）。没有这一段，或正文就是「无」，返回空数组
export function needsOfBrief(text) {
  const lines = String(text || "").split(/\r?\n/);
  let inSection = false;
  const chunks = [];
  const titleWithHash = /^[ \t]*#{1,6}[ \t]*需要的能力(?:\s*[（(][^）\n]*[）)])?[ \t]*[:：]?[ \t]*(.*)$/;
  const titleNoHash = /^[ \t]*需要的能力[ \t]*[:：][ \t]*(.*)$/;

  for (const rawLine of lines) {
    if (!inSection) {
      const m = rawLine.match(titleWithHash) || rawLine.match(titleNoHash);
      if (m) {
        inSection = true;
        if (m[1] && m[1].trim()) chunks.push(m[1]);
      }
      continue;
    }
    if (/^[ \t]*#/.test(rawLine) || /^[ \t]*(?:目标|背景|相关文件|写入范围|约束|验收标准|交付格式)[:：]/.test(rawLine)) {
      break;
    }
    chunks.push(rawLine);
  }
  if (!inSection) return [];
  const body = chunks.join("\n").trim();
  if (!body || body === "无" || body === "无。") return [];
  const needs = [];
  if (/联网|搜索|网页/.test(body)) needs.push("web");
  if (/执行命令|跑测试|运行测试|构建/.test(body)) needs.push("exec");
  return needs;
}

// 从外派输出里取出「需要主控协助」的正文。空、无、无。视为没有请求，最多 1000 字
export function helpRequestOf(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  let inline = null;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[ \t]*(?:\d+\.[ \t]*)?需要主控协助[ \t]*[:：]?[ \t]*(.*)$/);
    if (m) {
      start = i;
      inline = m[1];
      break;
    }
  }
  if (start < 0) return "";
  const kept = [inline];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[ \t]*(?:\d+\.|#{1,6}(?:[ \t]|$))/.test(lines[i])) break;
    kept.push(lines[i]);
  }
  const result = kept.join("\n").trim();
  if (!result || result === "无" || result === "无。") return "";
  return Array.from(result).slice(0, 1000).join("");
}

// 项目上下文：自动收集，不需要主模型写
export function projectContext(cwd) {
  const lines = [`工作目录：${cwd}`];
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (root) {
    const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = (git(cwd, ["status", "--porcelain"]) || "").split("\n").filter(Boolean);
    lines.push(`git：分支 ${branch || "?"}，未提交改动 ${status.length} 处${status.length ? "（用户的改动，不要覆盖或回滚）" : ""}`);
    for (const l of status.slice(0, CHANGED_MAX)) lines.push(`  ${l}`);
    if (status.length > CHANGED_MAX) lines.push(`  …另有 ${status.length - CHANGED_MAX} 处`);
  } else {
    lines.push("git：不是 git 仓库");
  }
  // 规则文件：工作目录和仓库根各找一遍
  const dirs = [...new Set([cwd, root].filter(Boolean))];
  const inline = [];
  const refs = [];
  for (const dir of dirs) {
    for (const name of RULE_FILES) {
      const p = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(p);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size <= RULE_INLINE_MAX && name !== "PROJECT_MEMORY.md") inline.push({ p, text: fs.readFileSync(p, "utf8").trim() });
      else refs.push(p);
    }
  }
  if (refs.length) lines.push(`项目资料（开工前先读与任务相关的部分）：\n${refs.map((p) => `  ${p}`).join("\n")}`);
  for (const f of inline) lines.push(`项目规则 ${f.p}（必须遵守）：\n${f.text}`);
  return lines.join("\n");
}

// 共享背景：按工作目录存一份，主模型用 relay context set 写
export function contextFile(stateDir, cwd) {
  const key = crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12);
  return path.join(stateDir, "context", `${key}.json`);
}

export function readSharedContext(stateDir, cwd, now = Date.now()) {
  try {
    const c = JSON.parse(fs.readFileSync(contextFile(stateDir, cwd), "utf8"));
    if (now - c.updatedAt > CONTEXT_TTL_MS) return null;
    return c;
  } catch {
    return null;
  }
}

export function writeSharedContext(stateDir, cwd, text, now = Date.now()) {
  const file = contextFile(stateDir, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ cwd: path.resolve(cwd), text: text.trim(), updatedAt: now }, null, 2));
  return file;
}

export function clearSharedContext(stateDir, cwd) {
  try {
    fs.unlinkSync(contextFile(stateDir, cwd));
    return true;
  } catch {
    return false;
  }
}

const tail = (text, max) => (text.length > max ? `…（前文省略）\n${text.slice(-max)}` : text);

// 接力材料：前序外派的结果（取日志尾部）
export function attachJobs(jobs) {
  return jobs
    .map((j) => `### 前序结果：${j.id}（${j.provider}${j.model && j.model !== "default" ? " / " + j.model : ""}，${j.role || "未注明角色"}）\n${tail(String(j.output || "").trim(), ATTACH_MAX)}`)
    .join("\n\n");
}

export function gitDiff(cwd) {
  const d = git(cwd, ["diff", "HEAD"]) ?? git(cwd, ["diff"]);
  return d ? tail(d, DIFF_MAX) : null;
}

// 组装最终发给外派模型的完整提示
// caps 为 { web, exec } 时覆盖 canRunCommands；不传 caps 时执行命令仍由 canRunCommands 决定
export function buildDispatchPrompt({ task, cwd, write, role, shared, attachments, diff, canRunCommands = false, caps } = {}) {
  const hasCaps = caps !== undefined && caps !== null;
  const allowExec = hasCaps ? !!caps.exec : !!canRunCommands;
  const parts = [
    "[由 Claude 主控委派的子任务 · ai-relay]",
    `你的角色：${role || "未注明"}。你看不到主控和用户的对话，下面的上下文就是你需要知道的全部；信息不够时在汇报里写明缺什么，不要臆测。`,
    write
      ? "权限：可写——只在工作目录内修改与任务相关的文件；不要执行 git add / commit / push，不要删除或回滚与任务无关的文件。"
      : "权限：只读——不要修改、创建或删除任何文件，只做阅读、分析和回答。",
  ];
  if (!allowExec) parts.push("不要执行任何终端命令（无人值守模式下命令会被拒绝并导致任务中断）；运行测试等验证由主控负责。");
  parts.push("任务需要时可以读取配置和密钥文件（如数据库连接信息），但汇报和任何输出里都不要写出密钥、令牌、密码的值。");
  if (allowExec) {
    // 员工有最高权限、命令不再逐个批准：用户的本地规则和项目规则全靠这里约束
    parts.push(
      "",
      "## 硬性规则（你有直接执行命令、改文件的权限，没有人逐条审批，以下任何一条都不得违反）",
      "1. 遵守下文附上的用户全局规则和项目规则（AGENTS.md / CLAUDE.md 等），它们优先于派单里的一般要求。",
      "2. git 只读：可以 status / diff / log / show；禁止 add / commit / push / merge / rebase / reset / checkout 改分支 / tag / stash 和创建 PR，改动保持未暂存。提交代码只由主控在用户明确要求时执行。",
      "3. 数据库和服务器：只有派单里明确授权（写明目标库或主机、允许做什么）时才能连接，且只做只读查询和查看（SELECT、查看日志和状态）；任何写库（DDL、DML、迁移）、改服务器文件或配置、重启服务都不做，把要执行的 SQL 或命令写进汇报交回主控。",
      "4. 密钥和配置：可以按需读取，但不要修改，不要在汇报或日志里写出它们的值，不要发送到任何外部地址。",
      "5. 只读任务不得创建、修改、删除任何文件；可写任务只改写入范围内的文件，不删除、不回滚范围外的任何东西。",
      "6. 禁止 rm -rf、sudo、修改系统设置、全局安装软件（npm -g、brew install 等）、修改 ~/.claude、~/.codex、~/.grok 等工具配置。",
      "7. 命令只用于本任务需要的阅读、构建、测试和授权范围内的查询；不要访问与任务无关的网络地址，不要上传项目内容。",
      "8. 拿不准某个操作是否安全时，不要做，写进汇报的「需要主控协助」。",
    );
    const globalRules = userGlobalRules();
    if (globalRules) parts.push("", "## 用户全局规则（~/.claude/CLAUDE.md，必须遵守）", globalRules);
  }
  if (hasCaps) {
    const mark = (on) => (on ? "✓" : "✗");
    parts.push(`你能用的能力：联网 ${mark(!!caps.web)}，执行命令 ${mark(!!caps.exec)}。浏览器操作、Office 文档、Claude 的连接器你都用不了。`);
    parts.push("遇到做不到的部分，不要硬做，也不要臆测，写进汇报的\"需要主控协助\"。");
  }
  parts.push("", "## 项目上下文（自动附上）", projectContext(cwd));
  const skills = userSkills();
  if (skills.length) {
    parts.push(
      "",
      "## 用户的本地技能（与本任务相关的，开工前先读对应文件并照做；比如写 Java 后端就读后端编码规范）",
      ...skills.map((s) => `- ${s.name}：${s.desc}（${s.file}）`),
    );
  }
  if (shared?.text) parts.push("", "## 本次任务的共享背景（主控整理）", shared.text);
  if (attachments) parts.push("", "## 接力材料", attachments);
  if (diff) parts.push("", "## 当前改动（git diff）", "```diff", diff, "```");
  parts.push("", "## 派单", task.trim());
  parts.push(
    "",
    "## 汇报要求",
    "用中文按以下结构汇报，主控会逐条核对：",
    "1. 结论：完成了什么 / 发现了什么（审查类逐条写：问题、文件:行号、依据、严重程度）",
    "2. 改动文件：列出路径（只读任务写\"无\"）",
    "3. 对照验收标准：逐条写满足 / 未满足 / 无法确认",
    "4. 未决问题与没把握的地方",
    "5. 需要主控协助：列出你需要但用不了的工具或信息（如联网查什么、运行哪个测试、操作哪个网页），说明要什么、为什么；没有就写\"无\"",
  );
  return parts.join("\n");
}

// 用户全局规则（~/.claude/CLAUDE.md）：员工有最高权限时附上原文，过大时只给路径
export function userGlobalRules(home = os.homedir()) {
  const p = path.join(home, ".claude", "CLAUDE.md");
  try {
    const text = fs.readFileSync(p, "utf8").trim();
    return text.length <= RULE_INLINE_MAX ? text : `内容较长，开工前先读：${p}`;
  } catch {
    return "";
  }
}

// 用户的本地技能（~/.claude/skills/*/SKILL.md）：员工用不了 Claude 的技能机制，但能直接读这些文件。
// 列出名称、用途和路径，让员工先读与任务相关的再动手
export function userSkills(home = os.homedir()) {
  const dir = path.join(home, ".claude", "skills");
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name, "SKILL.md");
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const desc = text.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "").trim() || "";
    out.push({ name, desc: desc.length > 90 ? `${desc.slice(0, 90)}…` : desc, file });
  }
  return out;
}
