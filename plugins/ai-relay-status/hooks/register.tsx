import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, FsEntry, Register, RenderChildren, SelectOption } from 'claude-code'

import type { AddForm, JobView, PoolView, RelayMode, Round, RoundAgent, Snapshot, Vendor, VendorData, WindowView } from '../types'

// 家目录在会话启动时用 $.env.get('HOME') 读取，不写死，别人安装也能用
let HOME = ''
const roundsDir = () => `${HOME}/.claude/ai-relay/rounds`
const installedPluginsFile = () => `${HOME}/.claude/plugins/installed_plugins.json`
const NODE_CANDIDATES = ['/opt/homebrew/bin/node', '/usr/local/bin/node', 'node']
const REFRESH_MS = 60_000
const PANE = 'relay-quota'
const PANE_TITLE = 'ai-relay'

// 结构变了就换 shape，旧版本存下的值会被丢弃
const snapshot = atom({ plugin: 'ai-relay-status', key: 'snapshot' } as const, null, { shape: 'snapshot-6' })
const switching = atom({ plugin: 'ai-relay-status', key: 'switching' } as const, null)
const tab = atom({ plugin: 'ai-relay-status', key: 'tab' } as const, 'quota')
// 厂商增加最高权限字段，换 shape 丢掉没有该字段的旧缓存
const vendors = atom({ plugin: 'ai-relay-status', key: 'vendors' } as const, null, { shape: 'vendors-2' })
const jobs = atom({ plugin: 'ai-relay-status', key: 'jobs' } as const, null, { shape: 'jobs-2' })
// 本会话的对话轮次，只保留最近 MAX_ROUNDS 轮
const rounds = atom({ plugin: 'ai-relay-status', key: 'rounds' } as const, [] as Round[], { shape: 'rounds-3' })
// 全部会话的对话轮次，最新的在前
const allRounds = atom({ plugin: 'ai-relay-status', key: 'allRounds' } as const, null as Round[] | null, { shape: 'all-rounds-1' })
// 对话筛选：只按项目。去掉环境后换 shape，丢掉旧的 { project, env }
const roundFilter = atom({ plugin: 'ai-relay-status', key: 'roundFilter' } as const, { project: '' }, { shape: 'round-filter-2' })
// 对话页当前详情。换掉按轮次展开后，旧的 expandedRounds 不再读取
const selectedRound = atom({ plugin: 'ai-relay-status', key: 'selectedRound' } as const, null)
// 详情里展开了派单全文的外派 id
const openBriefs = atom({ plugin: 'ai-relay-status', key: 'openBriefs' } as const, [] as string[])
const MAX_ROUNDS = 30
const form = atom({ plugin: 'ai-relay-status', key: 'form' } as const, null)
const confirmRemove = atom({ plugin: 'ai-relay-status', key: 'confirmRemove' } as const, null)
const busy = atom({ plugin: 'ai-relay-status', key: 'busy' } as const, null)
const notice = atom({ plugin: 'ai-relay-status', key: 'notice' } as const, null)

// 会话启动时记下的环境信息，跨钩子共享
let currentSessionId = ''
let currentCwd = ''
let currentProject = { name: '', path: '' }
let initialSurface: string | null = null

const MODES: RelayMode[] = ['off', 'manual', 'auto']
const MODE_TEXT: Record<RelayMode, string> = { off: '纯 Claude', manual: '手动', auto: '自动' }
const MODE_DESC: Record<RelayMode, string> = {
  off: '只用主模型，不派活给其他模型',
  manual: '只在你点名时派活，例如"让 grok 审查"或在需求前加 ulw',
  auto: '主模型当主管，统筹拆解、派发、核验和汇报，也自己干活；其他模型当员工，按任务分工',
}

// 额度池的显示名、所属会员和先后顺序（按会员分组：同一会员的池相邻）
const POOL_META: Record<string, { name: string; provider: string; order: number }> = {
  'claude/claude-subscription': { name: 'Claude', provider: 'Claude Pro · 主模型', order: 0 },
  'codex/codex': { name: 'Codex', provider: 'ChatGPT Plus', order: 1 },
  'agy/gemini': { name: 'Gemini 3.8 Flash', provider: 'Antigravity', order: 2 },
  'agy/gemini-argon': { name: 'Gemini 4 Argon', provider: 'Antigravity', order: 3 },
  'agy/claude-gpt': { name: 'Claude / GPT', provider: 'Antigravity', order: 4 },
  'grok/supergrok-weekly': { name: 'Grok', provider: 'SuperGrok', order: 5 },
}
const PROVIDER_TEXT: Record<string, string> = { codex: 'Codex', agy: 'Antigravity', grok: 'Grok', claude: 'Claude' }
// 新增表单里预设模板的先后顺序
const PRESET_ORDER = ['kimi', 'qwen', 'custom']

// 状态色（dataviz 规范的固定状态色，深浅色主题下都可读）；颜色从不单独表意，总配图标和文字
const STATUS_HEX = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b', none: '#9a9a96' } as const
type Tone = keyof typeof STATUS_HEX
const TONE_THEME: Record<Tone, 'success' | 'warning' | 'error' | 'inactive'> = { good: 'success', warning: 'warning', critical: 'error', none: 'inactive' }
const LEVEL_LABEL: Record<PoolView['level'], { icon: string; text: string; tone: Tone }> = {
  ok: { icon: '●', text: '充足', tone: 'good' },
  low: { icon: '▲', text: '偏低', tone: 'warning' },
  blocked: { icon: '✕', text: '不派', tone: 'critical' },
  unknown: { icon: '?', text: '额度未知', tone: 'none' },
}
const JOB_STATUS: Record<string, { icon: string; text: string; tone: Tone }> = {
  running: { icon: '●', text: '进行中', tone: 'warning' },
  done: { icon: '✓', text: '完成', tone: 'good' },
  failed: { icon: '✕', text: '失败', tone: 'critical' },
  timeout: { icon: '✕', text: '超时', tone: 'critical' },
  cancelled: { icon: '–', text: '已取消', tone: 'none' },
}
// 一轮对话的状态（turn.complete 的 reason）
const ROUND_STATUS: Record<string, { icon: string; text: string; tone: Tone }> = {
  running: { icon: '●', text: '进行中', tone: 'warning' },
  answer: { icon: '✓', text: '完成', tone: 'good' },
  aborted: { icon: '–', text: '已中断', tone: 'none' },
  error: { icon: '✕', text: '出错', tone: 'critical' },
  refusal: { icon: '✕', text: '被拒绝', tone: 'critical' },
}
// 子代理结束原因 → 外派状态
const AGENT_END: Record<string, string> = { answer: 'done', aborted: 'cancelled', error: 'failed', refusal: 'failed' }
const CODEX_AGENT = 'codex:codex-rescue'
// 验收结论
const VERDICT: Record<string, { icon: string; text: string; tone: Tone }> = {
  pass: { icon: '✓', text: '验收通过', tone: 'good' },
  partial: { icon: '▲', text: '部分通过', tone: 'warning' },
  fail: { icon: '✕', text: '验收不通过', tone: 'critical' },
}
const ROLE_TEXT: Record<string, string> = {
  implement: '实现', debug: '排查', review: '审查', read: '阅读', deep: '深度推理', quick: '快速问答', 'claude-backup': 'Claude 替补',
}
/** relay status --json 输出中单个额度池的结构（只取用到的字段） */
type RelayPool = {
  name: string
  pool: string
  level: PoolView['level']
  enabled?: boolean
  source?: string
  stale?: boolean
  windows: { key: string; remaining: number | null; resetAt?: number | null; source?: string | null }[]
}

const pad2 = (n: number) => String(n).padStart(2, '0')

function fmtTime(ms: number) {
  const d = new Date(ms)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function fmtClockTime(ms: number) {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// 重置时间说人话：今天 17:39 / 明天 08:30 / 11-07 01:17
function fmtReset(ms: number | null, now: number) {
  if (!ms) return ''
  const d = new Date(ms)
  const day = (t: number) => Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / 86_400_000)
  const diff = day(ms) - day(now)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (diff === 0) return `今天 ${hm} 重置`
  if (diff === 1) return `明天 ${hm} 重置`
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm} 重置`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function dirName(p: string) {
  if (!p) return ''
  const trimmed = p.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/)
  return parts.pop() || p
}

// 日期分组标题：今天 / 昨天 / 11-03 周一
function fmtDateGroup(ms: number, now: number) {
  const localDay = (t: number) => Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / 86_400_000)
  const diff = localDay(now) - localDay(ms)
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  const d = new Date(ms)
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const w = WEEKDAYS[d.getDay()] ?? ''
  return `${md} ${w}`
}

function toView(p: RelayPool): PoolView {
  const key = `${p.name}/${p.pool}`
  const meta = POOL_META[key]
  const order = (k: string) => (k === '5h' ? 0 : k === 'weekly' ? 1 : 2)
  // 旧版 relay 只在池上标来源：窗口没标时沿用池的（池来源是单一值时）
  const poolSrc = p.source === '自带' || p.source === 'AIQuota5h' ? p.source : null
  const windows: WindowView[] = p.windows.map(w => ({ key: w.key, remaining: w.remaining, resetAt: w.resetAt ?? null, source: w.source ?? poolSrc }))
  // Claude 订阅一定有 5h 窗口；新窗口还没发过请求时 Claude Code 不报它，留一行占位，不让它凭空消失
  if (key === 'claude/claude-subscription' && !windows.some(w => w.key === '5h')) {
    windows.push({ key: '5h', remaining: null, resetAt: null, source: null })
  }
  return {
    // 新增厂商的额度池与厂商同名，直接显示厂商标识
    name: meta?.name ?? (p.pool === p.name ? p.name : key),
    provider: meta?.provider ?? '',
    level: p.level,
    enabled: p.enabled !== false,
    windows: windows.sort((a, b) => order(a.key) - order(b.key)),
    stale: Boolean(p.stale),
    source: p.source ?? '无',
  }
}

const orderOf = (p: RelayPool) => POOL_META[`${p.name}/${p.pool}`]?.order ?? 99

// 额度条右侧的说明：重置时间；已过重置点或没有读数时说明原因
function windowNote(w: WindowView, now: number) {
  if (w.resetAt !== null && w.resetAt <= now) return '已重置，新窗口还没开始'
  if (w.remaining === null && w.resetAt === null) return '暂无读数，下次对话后更新'
  return fmtReset(w.resetAt, now)
}

// claude-opus-5-5 → Opus 5.5；认不出的原样显示
function mainModelText(id: string) {
  const m = id.match(/claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i)
  if (!m) return id || '未知'
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return `${family} ${m[2]}.${m[3]}${/\[1m\]/.test(id) ? '（1M 上下文）' : ''}`
}

// 外派模型 id 转成可读名：gemini-3.8-flash-high → Gemini 3.8 Flash · High
function modelText(provider: string, model: string) {
  if (!model || model === 'default') return PROVIDER_TEXT[provider] ?? provider
  const effort = model.match(/-(high|medium|low)$/)?.[1]
  const base = model.replace(/-(high|medium|low)$/, '')
  const name = base
    .replace(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/i, (_, f: string, a: string, b: string) => `Claude ${f.charAt(0).toUpperCase()}${f.slice(1)} ${a}.${b}`)
    .replace(/^gemini-/i, 'Gemini ')
    .replace(/-(flash|argon|pro)$/i, (_, f: string) => ` ${f.charAt(0).toUpperCase()}${f.slice(1)}`)
    .replace(/-(argon|flash|pro)-/i, (_, f: string) => ` ${f.charAt(0).toUpperCase()}${f.slice(1)} `)
  const effortText = effort ? ` · ${{ high: 'High', medium: 'Medium', low: 'Low' }[effort]}` : ''
  return `${name}${effortText}`
}

// 耗时说人话：45 秒 / 1 分 30 秒 / 1 小时 5 分
function fmtTook(ms: number) {
  const secs = Math.max(0, Math.round(ms / 1000))
  if (secs < 60) return `${secs} 秒`
  if (secs < 3600) return secs % 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs / 60} 分钟`
  return `${Math.floor(secs / 3600)} 小时 ${Math.floor((secs % 3600) / 60)} 分`
}

// 子代理的显示名：Codex 插件的子代理只是转交，真正干活的是 Codex；其他子代理显示它跑的 Claude 模型
function agentText(a: RoundAgent) {
  if (a.subagentType === CODEX_AGENT) return { title: 'Codex', sub: 'ChatGPT Plus · 经 Codex 插件' }
  return { title: mainModelText(a.model), sub: 'Claude Pro' }
}

// relay 外派记录按时间归入轮次：开始时间落在这一轮之内的算这一轮的。
// Codex 由子代理记录覆盖（它走 Agent 工具），这里不重复算
function jobsOfRound(r: Round, list: JobView[]) {
  const end = r.finishedAt ?? Number.POSITIVE_INFINITY
  return list.filter(j => {
    const t = Date.parse(j.startedAt)
    return j.provider !== 'codex' && t >= r.startedAt && t <= end
  })
}

// 一轮里用到的其他模型（去重，按出现先后）
function helperNames(r: Round, list: JobView[]) {
  const names = [
    ...r.agents.map(a => (a.subagentType === CODEX_AGENT ? 'Codex' : `${mainModelText(a.model)} 子代理`)),
    ...jobsOfRound(r, list).map(j => modelText(j.provider, j.model)),
  ]
  return [...new Set(names)]
}

// 每轮答完后显示在回答下方的一行
function roundSummary(r: Round, list: JobView[]) {
  const helpers = helperNames(r, list)
  const main = `本轮模型：${mainModelText(r.mainModel)}（主模型）`
  return helpers.length ? `${main} · 外派 ${helpers.join('、')}` : main
}

// 详情里的分工：有外派列出各验收状态数（大于 0 的项），无外派注明由主管完成
function cardSummary(r: Round, list: JobView[]) {
  const rj = jobsOfRound(r, list)
  const helpers = r.agents.length + rj.length
  if (helpers === 0) {
    return ''
  }

  let pass = 0
  let partial = 0
  let fail = 0
  let pending = 0

  for (const j of rj) {
    if (j.status === 'done') {
      if (j.verdict === 'pass') pass++
      else if (j.verdict === 'partial') partial++
      else if (j.verdict === 'fail') fail++
      else pending++
    }
  }

  for (const a of r.agents) {
    if (a.subagentType === CODEX_AGENT) {
      const rec = list.find(j => j.id === a.toolUseId)
      const st = rec ? (rec.verdict || rec.status === 'done' ? 'done' : a.status) : a.status
      const v = rec?.verdict
      if (st === 'done') {
        if (v === 'pass') pass++
        else if (v === 'partial') partial++
        else if (v === 'fail') fail++
        else pending++
      }
    } else {
      if (a.status === 'done') pass++
      else if (a.status === 'failed') fail++
    }
  }

  const parts = [`外派 ${helpers} 个`]
  if (pass > 0) parts.push(`验收通过 ${pass}`)
  if (partial > 0) parts.push(`部分通过 ${partial}`)
  if (fail > 0) parts.push(`验收不通过 ${fail}`)
  if (pending > 0) parts.push(`待验收 ${pending}`)

  return parts.join(' · ')
}

// 列表上员工名字后面的验收图标：✓ 通过、▲ 部分通过、✕ 不通过或失败、○ 待验收、● 进行中
function staffIcon(status: string, verdict: string | null, claudeAgent: boolean) {
  if (status === 'running') return '●'
  if (status === 'failed' || status === 'timeout' || verdict === 'fail') return '✕'
  if (status === 'cancelled') return '–'
  if (verdict === 'partial') return '▲'
  if (verdict === 'pass' || (claudeAgent && status === 'done')) return '✓'
  if (status === 'done') return '○'
  return '○'
}

// 列表第三行：主管，以及每个员工的模型名和验收图标
function staffLine(r: Round, list: JobView[]) {
  const bits: string[] = []
  for (const a of r.agents) {
    if (a.subagentType === CODEX_AGENT) {
      const rec = list.find(j => j.id === a.toolUseId)
      const status = rec ? (rec.verdict || rec.status === 'done' ? 'done' : a.status) : a.status
      bits.push(`Codex ${staffIcon(status, rec?.verdict ?? null, false)}`)
    } else {
      bits.push(`${agentText(a).title} ${staffIcon(a.status, null, true)}`)
    }
  }
  // 摘要里用简称（去掉 High/Medium/Low 档位），避免和分隔符「 · 」混在一起
  for (const j of jobsOfRound(r, list)) bits.push(`${modelText(j.provider, j.model).replace(/ · (High|Medium|Low)$/, '')} ${staffIcon(j.status, j.verdict, false)}`)
  const main = `${mainModelText(r.mainModel)} 主管`
  // 只有主管一个模型时不写"未外派"，一看就知道
  return bits.length ? `${main} · ${bits.join(' · ')}` : main
}

// 外派「任务」行：角色 · 只读/可写 · 用时 · 改了 N 个文件
function taskMeta(role: string | null, write: boolean | null, took: string | null, changedFiles: number) {
  const parts = [
    role ? ROLE_TEXT[role] ?? role : null,
    write === null ? null : write ? '可写' : '只读',
    took ? `用时 ${took}` : null,
    changedFiles > 0 ? `改了 ${changedFiles} 个文件` : null,
  ].filter((x): x is string => Boolean(x))
  return parts.join(' · ')
}

// 派单里给人看的那一句：优先「## 目标」下的第一段，否则去掉「角色：」行后的第一行
function taskGoal(task: string) {
  const lines = task.replace(/\r\n/g, '\n').split('\n')
  const head = /^[ \t]*##[ \t]*目标(?:[ \t]*[（(][^）)\n]*[）)])?[ \t]*[:：]?[ \t]*$/
  const idx = lines.findIndex(line => head.test(line))
  if (idx >= 0) {
    const para: string[] = []
    for (const line of lines.slice(idx + 1)) {
      if (/^[ \t]*#{1,6}[ \t]*\S/.test(line)) break
      if (line.trim() === '') {
        if (para.length) break
        continue
      }
      para.push(line.trim())
    }
    if (para.length) return para.join('\n')
  }
  for (const line of lines) {
    if (/^[ \t]*角色[ \t]*[:：]/.test(line)) continue
    const text = line.trim()
    if (text) return text
  }
  return ''
}

// 打分串改成「→ 总分」，分号后面的说明各占一行
function formatReason(reason: string) {
  const text = (reason ?? '').trim()
  if (!text) return ''
  return text
    .replace(/→\s*(\d+(?:\.\d+)?)/g, '→ 总分 $1')
    .split(/[；;]/)
    .map(part => part.trim())
    .filter(Boolean)
    .join('\n')
}

// 本会话轮次写到共享目录，任何一个会话的对话页都能读到
async function saveRounds($: Engine) {
  try {
    let sId = currentSessionId
    if (!sId) {
      sId = await $.session.id().catch(() => '')
    }
    if (!sId) return
    const list = await read($, rounds)
    await $.fs.write(`${roundsDir()}/${sId}.json`, JSON.stringify(list.slice(0, MAX_ROUNDS)))
  } catch {
    // 写入共享目录失败时忽略
  }
}

// session.start 时把 $.store 里的旧轮次迁到共享目录；已有文件不覆盖，失败不影响启动
async function migrateStoredRounds($: Engine) {
  try {
    const keys = await $.store.keys()
    for (const key of keys) {
      if (!key.startsWith('rounds:')) continue
      const sessionId = key.slice('rounds:'.length)
      if (!sessionId) continue
      try {
        const path = `${roundsDir()}/${sessionId}.json`
        if (await $.fs.exists(path)) continue
        const text = JSON.stringify(await $.store.get(key))
        if (typeof text !== 'string') continue
        await $.fs.write(path, text)
        await $.store.delete(key)
      } catch {
        // 单项迁移失败忽略
      }
    }
  } catch {
    // 迁移失败时忽略
  }
}

// 读取共享目录里各会话的轮次，按开始时间倒序合并；本会话整份换成内存里的最新值
async function loadAllRounds($: Engine) {
  try {
    let sId = currentSessionId
    if (!sId) {
      sId = await $.session.id().catch(() => '')
    }
    const localRounds = await read($, rounds)
    const FOURTEEN_DAYS = 14 * 86_400_000
    let entries: FsEntry[] = []
    try {
      entries = await $.fs.list(roundsDir())
    } catch {
      // 目录不存在时当作空
      entries = []
    }
    const now = await $.clock.now()
    const files = entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json') && now - entry.mtimeMs <= FOURTEEN_DAYS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 60)

    const merged: Round[] = []
    let currentIncluded = false
    const currentName = sId ? `${sId}.json` : ''

    for (const file of files) {
      if (currentName && file.name === currentName) {
        merged.push(...localRounds)
        currentIncluded = true
        continue
      }
      try {
        const parsed: unknown = JSON.parse(await $.fs.read(`${roundsDir()}/${file.name}`))
        if (Array.isArray(parsed)) merged.push(...(parsed as Round[]))
      } catch {
        // 单个文件读取或解析失败就跳过
      }
    }

    if (!currentIncluded && localRounds.length > 0) {
      merged.push(...localRounds)
    }

    merged.sort((a, b) => b.startedAt - a.startedAt)
    await update($, allRounds, () => merged)
  } catch {
    // 读取全部轮次失败时容错
  }
}

// relay 脚本优先取已安装插件的路径，取不到时用源码路径
async function relayScript($: Engine) {
  try {
    const installed = JSON.parse(await $.fs.read(installedPluginsFile()))
    // 认任何插件市场来源的 ai-relay（ai-relay@<市场名>），不写死市场名
    const key = Object.keys(installed.plugins ?? {}).find(k => k.startsWith('ai-relay@'))
    const path = key ? installed.plugins[key]?.[0]?.installPath : undefined
    if (path) return `${path}/scripts/relay.mjs`
  } catch {
    // 读不到安装记录时走下面的报错
  }
  throw new Error('没有找到 ai-relay 插件，请先安装：claude plugin install ai-relay@ai-relay')
}

async function runRelay($: Engine, args: string[], timeoutMs = 30_000) {
  const script = await relayScript($)
  let lastError: unknown
  for (const node of NODE_CANDIDATES) {
    try {
      return await $.process.run([node, script, ...args], { timeoutMs })
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

const errText = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 120)
// relay 的报错带 "ai-relay 错误：" 前缀，面板里去掉
const cleanErr = (stderr: string) => stderr.trim().replace(/^ai-relay 错误：/, '').slice(0, 160)

async function refresh($: Engine) {
  let next: Snapshot
  let mainModel = ''
  try {
    mainModel = await $.session.model()
  } catch {
    // 读不到主模型时留空
  }
  try {
    // 自带额度：Claude 取当前会话的限额窗口，Codex / agy 由 relay 自己读
    const usage = await $.session.usage()
    const limits = usage.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
    await runRelay($, ['quota', ...(limits.length ? ['--claude-json', JSON.stringify(limits)] : [])], 60_000)
  } catch {
    // 刷新自带额度失败时沿用旧缓存
  }
  const previous = await read($, snapshot)
  try {
    const { exitCode, stdout, stderr } = await runRelay($, ['status', '--json'])
    if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
    const data = JSON.parse(stdout)
    next = {
      mode: data.mode,
      quotaAvailable: data.quotaAvailable,
      pools: [...(data.pools as RelayPool[])].sort((a, b) => orderOf(a) - orderOf(b)).map(toView),
      updatedAt: await $.clock.now(),
      mainModel,
      thresholds: data.thresholds ?? { min: 0.15, low: 0.3 },
    }
  } catch (err) {
    next = {
      mode: previous?.mode ?? 'manual',
      quotaAvailable: false,
      pools: previous?.pools ?? [],
      updatedAt: await $.clock.now(),
      error: errText(err).slice(0, 80),
      mainModel,
      thresholds: previous?.thresholds ?? { min: 0.15, low: 0.3 },
    }
  }
  await update($, snapshot, () => next)
}

async function refreshJobs($: Engine) {
  try {
    const { exitCode, stdout } = await runRelay($, ['jobs', '--json', '--limit', '20'])
    if (exitCode === 0) await update($, jobs, () => JSON.parse(stdout) as JobView[])
  } catch {
    // 读不到记录时保留上次
  }
}

async function refreshVendors($: Engine) {
  try {
    const { exitCode, stdout, stderr } = await runRelay($, ['providers', '--json'])
    if (exitCode !== 0) throw new Error(cleanErr(stderr) || `exit ${exitCode}`)
    const data = JSON.parse(stdout) as VendorData
    // 旧版 relay 没有 fullAccess 字段：补默认值，避免厂商页渲染报错
    data.providers = data.providers.map(p => ({ ...p, fullAccess: p.fullAccess ?? { supported: false, enabled: false, note: '需要更新 ai-relay 插件' } }))
    await update($, vendors, () => data)
  } catch (err) {
    await update($, notice, () => ({ text: `读取厂商列表失败：${errText(err)}`, ok: false }))
  }
}

async function switchMode($: Engine, mode: RelayMode) {
  if ((await read($, switching)) !== null) return
  await update($, switching, () => mode)
  try {
    // 切到或切出 off 时会启停 Codex 插件，claude CLI 可能需要几十秒
    const { exitCode, stderr } = await runRelay($, ['mode', mode], 120_000)
    if (exitCode !== 0) {
      $.ui.toast(`切换失败：${cleanErr(stderr).slice(0, 80)}`)
    } else {
      $.ui.toast(`ai-relay 已切换为「${MODE_TEXT[mode]}」，插件启停在新会话完全生效`)
    }
  } catch (err) {
    $.ui.toast(`切换失败：${errText(err).slice(0, 80)}`)
  } finally {
    await update($, switching, () => null)
    await refresh($)
  }
}

// 厂商操作的统一入口：标记忙碌、执行 relay、写提示、刷新两页数据
async function vendorAction($: Engine, key: string, args: string[], okText: (stdout: string) => string, timeoutMs = 30_000) {
  if ((await read($, busy)) !== null) return false
  await update($, busy, () => key)
  let ok = false
  try {
    const { exitCode, stdout, stderr } = await runRelay($, args, timeoutMs)
    ok = exitCode === 0
    const text = ok ? okText(stdout) : cleanErr(stderr) || cleanErr(stdout) || `失败（退出码 ${exitCode}）`
    await update($, notice, () => ({ text, ok }))
  } catch (err) {
    await update($, notice, () => ({ text: errText(err), ok: false }))
  } finally {
    await update($, busy, () => null)
  }
  await refreshVendors($)
  await refresh($)
  return ok
}

const firstLines = (s: string) => s.trim().split('\n').slice(0, 2).join('；')

async function toggleVendor($: Engine, v: Vendor) {
  await vendorAction($, `toggle:${v.name}`, ['provider', v.enabled ? 'disable' : 'enable', v.name], firstLines)
}

async function setVendorAccess($: Engine, v: Vendor, enabled: boolean) {
  await vendorAction($, `access:${v.name}`, ['provider', 'access', v.name, enabled ? 'on' : 'off'], firstLines)
}

async function removeVendor($: Engine, v: Vendor) {
  await update($, confirmRemove, () => null)
  await vendorAction($, `remove:${v.name}`, ['provider', 'remove', v.name], () => `已删除 ${v.label}，并移出所有角色路由（配置已备份为 providers.json.bak）`)
}

async function testVendor($: Engine, v: Vendor) {
  await vendorAction(
    $,
    `test:${v.name}`,
    ['provider', 'test', v.name, '--json'],
    stdout => {
      const r = JSON.parse(stdout) as { seconds: number; output: string }
      return `${v.label} 试运行成功（${r.seconds} 秒）：${r.output.replace(/\s+/g, ' ').slice(0, 60)}`
    },
    150_000,
  )
  // 试运行失败时 relay 退出码非 0，stdout 里仍是 JSON；这里把原因读出来
  const n = await read($, notice)
  if (n && !n.ok && n.text.startsWith('{')) {
    try {
      const r = JSON.parse(n.text) as { output: string; timedOut: boolean }
      await update($, notice, () => ({ text: `${v.label} 试运行失败${r.timedOut ? '（超时）' : ''}：${r.output.replace(/\s+/g, ' ').slice(0, 120)}`, ok: false }))
    } catch {
      // 保留原提示
    }
  }
}

function blankForm(data: VendorData, presetKey: string): AddForm {
  const p = data.presets[presetKey]
  return {
    preset: presetKey,
    name: presetKey === 'custom' ? '' : presetKey,
    label: p?.label ?? '',
    bin: p?.bin ?? '',
    models: '',
    promptArgs: p ? p.cli.prompt.join(' ') : '-p {prompt}',
    modelArgs: p ? p.cli.model.join(' ') : '--model {model}',
    readArgs: p ? p.cli.read.join(' ') : '',
    writeArgs: p ? p.cli.write.join(' ') : '',
    roles: p?.roles ?? ['read'],
  }
}

async function submitForm($: Engine) {
  const f = await read($, form)
  if (!f) return
  const spec: Record<string, unknown> = { preset: f.preset, name: f.name, label: f.label, bin: f.bin, models: f.models, roles: f.roles }
  if (f.preset === 'custom') Object.assign(spec, { promptArgs: f.promptArgs, modelArgs: f.modelArgs, readArgs: f.readArgs, writeArgs: f.writeArgs })
  const ok = await vendorAction($, 'add', ['provider', 'add', '--json-spec', JSON.stringify(spec)], firstLines)
  if (ok) await update($, form, () => null)
}

// 面板：已打开就关闭，没打开就打开（打开时顺手刷新）
async function togglePane($: Engine) {
  const panes = await $.ui.panes()
  if (panes.some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  void refresh($)
  void refreshVendors($)
  void refreshJobs($)
  void loadAllRounds($)
  return true
}

// 剩余比例对应的状态：低于 min 不派，低于 low 偏低
function toneOf(remaining: number | null, t: { min: number; low: number }): Tone {
  if (remaining === null) return 'none'
  return remaining < t.min ? 'critical' : remaining < t.low ? 'warning' : 'good'
}

// 额度条（dataviz 的 meter）：轨道是同一状态色的浅色，填充是状态色，两端圆角
function meterSvg(remaining: number | null, tone: Tone, width: number) {
  const hex = STATUS_HEX[tone]
  const fill = remaining === null ? 0 : Math.max(remaining > 0 ? 6 : 0, Math.round(width * Math.min(1, remaining)))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6"><rect width="${width}" height="6" rx="3" fill="${hex}" fill-opacity="0.18"/>${fill > 0 ? `<rect width="${fill}" height="6" rx="3" fill="${hex}"/>` : ''}</svg>`
}

// 终端没有 Svg，用字符画额度条
function meterText(remaining: number | null, cells: number) {
  const n = remaining === null ? 0 : Math.round(cells * Math.min(1, remaining))
  return '█'.repeat(n) + '░'.repeat(cells - n)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'relay-bar', description: '打开或关闭 ai-relay 面板（额度 / 任务 / 厂商）' })
    // 早期版本在底部状态栏放过文字，这里清掉，改由底栏按钮承担
    $.ui.status(undefined)
    initialSurface = e.surface
    try {
      HOME = (await $.env.get('HOME')) || HOME
    } catch {}
    try {
      currentSessionId = await $.session.id()
    } catch {}
    try {
      currentCwd = (await $.session.cwd()) || e.cwd || ''
    } catch {
      currentCwd = e.cwd || ''
    }
    try {
      const repo = await $.session.repo()
      const rootPath = repo?.root || currentCwd
      currentProject = {
        name: dirName(rootPath) || 'unknown',
        path: currentCwd,
      }
    } catch {
      currentProject = {
        name: dirName(currentCwd) || 'unknown',
        path: currentCwd,
      }
    }
    await migrateStoredRounds($)
    // 会话重新打开时内存是空的：先从自己那份文件读回历史，免得下一次保存用空列表把它覆盖
    if (currentSessionId && (await read($, rounds)).length === 0) {
      try {
        const saved: unknown = JSON.parse(await $.fs.read(`${roundsDir()}/${currentSessionId}.json`))
        if (Array.isArray(saved) && saved.length) await update($, rounds, () => (saved as Round[]).slice(0, MAX_ROUNDS))
      } catch {
        // 没有文件或读取失败：从空开始
      }
    }
    await refresh($)
    $.clock.every(REFRESH_MS, () => {
      void refresh($)
      void refreshJobs($)
      void loadAllRounds($)
    })
    return next(e)
  })

  on('command.run', { command: 'relay-bar' }, async $ => {
    const opened = await togglePane($)
    return { text: opened ? '已打开 ai-relay 面板' : '已关闭 ai-relay 面板' }
  })

  // 主模型每轮开始：记下你的消息和当时的主模型
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    let mainModel = ''
    try {
      mainModel = await $.session.model()
    } catch {
      // 读不到主模型时留空
    }
    let env = 'headless'
    try {
      const surfaces = await $.session.surfaces()
      if (surfaces && surfaces.length > 0) {
        env = surfaces[0]!
      } else if (initialSurface) {
        env = initialSurface
      }
    } catch {
      if (initialSurface) env = initialSurface
    }
    if (!currentSessionId) {
      try {
        currentSessionId = await $.session.id()
      } catch {}
    }
    if (!currentProject.name) {
      try {
        const repo = await $.session.repo()
        const cwd = currentCwd || (await $.session.cwd().catch(() => ''))
        const rootPath = repo?.root || cwd
        currentProject = { name: dirName(rootPath) || 'unknown', path: cwd }
      } catch {
        currentProject = { name: dirName(currentCwd) || 'unknown', path: currentCwd }
      }
    }
    const project = currentProject.name ? currentProject : { name: dirName(currentCwd) || 'unknown', path: currentCwd }
    const round: Round = {
      id: e.turnId,
      sessionId: currentSessionId,
      project,
      env,
      text: e.text,
      mainModel,
      startedAt: await $.clock.now(),
      finishedAt: null,
      status: 'running',
      agents: [],
      selfLines: 0,
    }
    await update($, rounds, list => [round, ...list.filter(r => r.id !== round.id)].slice(0, MAX_ROUNDS))
    await saveRounds($)
    return result
  })

  // 主模型启动子代理（含 Codex）：记到当前这一轮
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined) return result
    const agent: RoundAgent = {
      id: result.agentId ?? e.tool_use_id,
      toolUseId: e.tool_use_id,
      subagentType: e.subagentType,
      description: e.description,
      model: result.model,
      status: 'running',
      startedAt: await $.clock.now(),
      finishedAt: null,
    }
    await update($, rounds, list => {
      const idx = Math.max(0, list.findIndex(r => r.status === 'running'))
      return list.map((r, i) => (i === idx ? { ...r, agents: [...r.agents, agent] } : r))
    })
    await saveRounds($)
    return result
  })

  // 主模型亲手写入的行数：子代理里的编辑不算
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    // 写在临时 / 草稿目录里的（派单、笔记）不是代码改动，不计入
    const file = e.tool === 'NotebookEdit' ? e.notebook_path : e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : ''
    if (/^(\/private)?\/tmp\/|^\/var\/folders\//.test(file ?? '')) return result
    const text = e.tool === 'Edit' ? e.new_string : e.tool === 'Write' ? e.content : e.tool === 'NotebookEdit' ? e.new_source : ''
    const lines = text ? text.split('\n').length : 0
    if (lines > 0) {
      await update($, rounds, list => {
        const idx = list.findIndex(r => r.status === 'running')
        return idx < 0 ? list : list.map((r, i) => (i === idx ? { ...r, selfLines: (r.selfLines ?? 0) + lines } : r))
      })
      await saveRounds($)
    }
    return result
  })

  // 一轮结束：子代理的标记完成；主模型的收尾这一轮，在回答下方写一行本轮用到的模型，并刷新额度
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const now = await $.clock.now()
    if (e.agentId !== undefined) {
      const status = AGENT_END[e.reason] ?? 'done'
      await update($, rounds, list =>
        list.map(r => (r.agents.some(a => a.id === e.agentId) ? { ...r, agents: r.agents.map(a => (a.id === e.agentId ? { ...a, status, finishedAt: now } : a)) } : r)),
      )
      await saveRounds($)
      return result
    }
    await refreshJobs($)
    const list = (await read($, jobs)) ?? []
    let done: Round | undefined
    await update($, rounds, all => {
      const idx = all.findIndex(r => r.status === 'running')
      if (idx < 0) return all
      done = { ...all[idx]!, status: e.reason, finishedAt: now }
      // 系统触发的继续（没有你的消息）且没用到其他模型的，不单独占一轮
      if (done.text === '' && helperNames(done, list).length === 0) return all.filter((_, i) => i !== idx)
      return all.map((r, i) => (i === idx ? done! : r))
    })
    await saveRounds($)
    await loadAllRounds($)
    // 额度刷新要调外部命令，不拖住这一轮的结束
    void refresh($)
    return done ? { ...result, text: roundSummary(done, list) } : result
  })

  // 输入框底栏右侧放一个小按钮，显示当前模式，点击打开面板
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const snap = await read($, snapshot)
    const { Box, Button, Text } = $.ui.resolve(e)
    // 只显示名称和模式，不加图标；各家额度在面板里看
    const label = snap ? `ai-relay · ${MODE_TEXT[snap.mode]}` : 'ai-relay'
    return (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Button key="relay-quota" label={label} dimColor onPress={() => togglePane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // 有 Svg 的界面（桌面、编辑器、手机）画额度条，终端用字符
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : null
    // 手机端没有输入框和下拉框，新增厂商只能在桌面端或终端里做
    const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : null
    const Select = e.surface !== 'mobile' && 'Select' in els ? els.Select : null
    const current = await read($, tab)
    const snap = await read($, snapshot)
    const busyKey = await read($, busy)
    const note = await read($, notice)
    const now = await $.clock.now()

    // ---------- 公共小部件 ----------
    const tabs = (
      <Box flexDirection="row" columnGap={1}>
        {(
          [
            ['quota', '额度'],
            ['jobs', '对话'],
            ['vendors', '厂商'],
          ] as const
        ).map(([key, text]) => (
          <Button
            key={`tab-${key}`}
            label={text}
            variant={current === key ? 'primary' : 'secondary'}
            onPress={async () => {
              await update($, tab, () => key)
              if (key === 'jobs') {
                await refreshJobs($)
                await loadAllRounds($)
              }
              if (key === 'vendors') await refreshVendors($)
            }}
          />
        ))}
      </Box>
    )
    const section = (title: string, hint?: string) => (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Text size="caption" weight="semibold" dimColor>
          {title}
        </Text>
        {hint && (
          <Text size="caption" dimColor>
            {hint}
          </Text>
        )}
      </Box>
    )
    // 一行「标签：内容」。标签列固定宽，内容默认可换行
    const field = (label: string, value: string, opts?: { wrap?: 'wrap' | 'truncate-end'; color?: 'warning'; dimColor?: boolean }) => (
      <Box flexDirection="row" columnGap={1} alignItems="flex-start" minWidth={0}>
        <Box width={10} flexShrink={0}>
          <Text size="caption" dimColor>
            {label}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text size="footnote" wrap={opts?.wrap ?? 'wrap'} color={opts?.color} dimColor={opts?.dimColor}>
            {value}
          </Text>
        </Box>
      </Box>
    )
    // 只包住独立对象：对话详情里的每个员工、厂商页的每家厂商
    const card = (key: string, ...children: RenderChildren[]) => (
      <Box key={key} borderStyle="round" borderDimColor paddingX={1} flexDirection="column" rowGap={0} minWidth={0}>
        {children}
      </Box>
    )
    const badge = (icon: string, text: string, tone: Tone) => (
      <Text size="caption" weight="medium" color={TONE_THEME[tone]}>
        {icon} {text}
      </Text>
    )
    const noticeBar = note && (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Box flexGrow={1} flexShrink={1}>
          <Text size="caption" color={note.ok ? 'success' : 'error'}>
            {note.ok ? '✓' : '✕'} {note.text}
          </Text>
        </Box>
        <Button key="notice-close" label="关闭" dimColor onPress={() => update($, notice, () => null)} />
      </Box>
    )
    const page = (...children: RenderChildren[]) => (
      <Box flexDirection="column" rowGap={1} paddingX={1}>
        {tabs}
        {children}
      </Box>
    )

    // ---------- 额度页 ----------
    if (current === 'quota') {
      if (snap === null) return page(<Text dimColor>正在读取额度…</Text>)
      const busyMode = await read($, switching)

      const meterRow = (w: WindowView, poolKey: string) => {
        const tone = toneOf(w.remaining, snap.thresholds)
        const label = w.key === '5h' ? '5h' : w.key === 'weekly' ? '周' : w.key
        return (
          <Box key={`${poolKey}-${w.key}`} flexDirection="row" alignItems="center" columnGap={1}>
            <Box width={3}>
              <Text size="caption" dimColor>
                {label}
              </Text>
            </Box>
            {Svg ? (
              <Svg source={meterSvg(w.remaining, tone, 120)} alt={`${label} 剩余 ${w.remaining === null ? '未知' : `${Math.round(w.remaining * 100)}%`}`} width={120} height={6} />
            ) : (
              <Text color={TONE_THEME[tone]}>{meterText(w.remaining, 12)}</Text>
            )}
            <Box width={5} justifyContent="flex-end">
              <Text size="caption" tabular weight="medium">
                {w.remaining === null ? '—' : `${Math.round(w.remaining * 100)}%`}
              </Text>
            </Box>
            <Text size="caption" dimColor>
              {windowNote(w, now)}
            </Text>
          </Box>
        )
      }

      const poolCard = (p: PoolView) => {
        const status = p.enabled ? LEVEL_LABEL[p.level] : { icon: '⏸', text: '已停用', tone: 'none' as Tone }
        return (
          <Box key={`pool-${p.name}`} flexDirection="column">
            <Box flexDirection="row" alignItems="center" justifyContent="space-between">
              <Box flexDirection="row" columnGap={1} alignItems="center">
                <Text weight="semibold" dimColor={!p.enabled}>
                  {p.name}
                </Text>
                {p.provider !== '' && (
                  <Text size="caption" dimColor>
                    {p.provider}
                  </Text>
                )}
              </Box>
              {badge(status.icon, status.text, status.tone)}
            </Box>
            {p.enabled && p.windows.map(w => meterRow(w, p.name))}
            {p.enabled && p.stale && (
              <Text size="caption" color="warning">
                数据已过期，等待刷新
              </Text>
            )}
          </Box>
        )
      }

      // 列出借用 AIQuota5h 数据的窗口：整池借用写池名，只借了个别窗口写"池名 窗口"
      const borrowed = snap.pools
        .filter(p => p.enabled)
        .flatMap(p => {
          const lent = p.windows.filter(w => w.source === 'AIQuota5h')
          if (!lent.length) return []
          if (lent.length === p.windows.length) return [p.name]
          return lent.map(w => `${p.name} ${w.key === 'weekly' ? '周' : w.key}`)
        })
      const footnotes = [`更新于 ${fmtTime(snap.updatedAt).slice(6)}`]
      // 各家额度都由 relay 自己读取；读取失败的窗口才借用 AIQuota5h 的数据作为备用
      if (borrowed.length) {
        footnotes.push(`${borrowed.join('、')} 自查失败，暂用 AIQuota5h 的数据`)
      }

      return page(
        <Box flexDirection="column" rowGap={1}>
          {section('主模型')}
          <Text size="heading" weight="semibold">
            {mainModelText(snap.mainModel)}
          </Text>
          <Text size="caption" dimColor>
            主管：统筹拆解、派发、核验和汇报，也自己干活 · 在输入框的模型菜单里切换
          </Text>
        </Box>,
        <Box flexDirection="column" rowGap={1}>
          {section('协作模式')}
          <Box flexDirection="row" columnGap={1}>
            {MODES.map(m => (
              <Button
                key={`mode-${m}`}
                label={busyMode === m ? `${MODE_TEXT[m]}…` : MODE_TEXT[m]}
                variant={snap.mode === m ? 'primary' : 'secondary'}
                onPress={() => (snap.mode === m ? undefined : switchMode($, m))}
              />
            ))}
          </Box>
          <Text size="caption" dimColor>
            {MODE_DESC[snap.mode]}
          </Text>
        </Box>,
        <Box flexDirection="column" rowGap={1}>
          {section('各模型剩余额度', '低于 30% 偏低，低于 15% 不再派活')}
          {!snap.quotaAvailable && (
            <Text size="caption" color="warning">
              暂无额度数据{snap.error ? `（${snap.error}）` : ''}
            </Text>
          )}
          {snap.pools.map(poolCard)}
        </Box>,
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text size="caption" dimColor>
              {footnotes.join(' · ')}
            </Text>
          </Box>
          <Button key="refresh" label="刷新" dimColor onPress={() => refresh($)} />
        </Box>,
      )
    }

    // ---------- 对话页 ----------
    if (current === 'jobs') {
      const list = (await read($, jobs)) ?? []
      let allRoundsVal = await read($, allRounds)
      if (allRoundsVal === null) {
        await loadAllRounds($)
        allRoundsVal = await read($, allRounds)
      }
      const allRoundsList = allRoundsVal ?? []
      const filter = (await read($, roundFilter)) ?? { project: '' }
      const openBriefIds = new Set(await read($, openBriefs))
      // 选中的轮次或外派已经不在数据里时，回到列表
      let activeId = await read($, selectedRound)
      if (activeId) {
        const picked = activeId
        const alive = picked.startsWith('job:')
          ? list.some(j => j.id === picked.slice('job:'.length))
          : allRoundsList.some(r => r.id === picked)
        if (!alive) {
          await update($, selectedRound, () => null)
          activeId = null
        }
      }

      const projectCounts = new Map<string, number>()
      for (const r of allRoundsList) {
        const name = r.project?.name || 'unknown'
        projectCounts.set(name, (projectCounts.get(name) ?? 0) + 1)
      }
      const projectOptions: SelectOption[] = [
        { label: '全部项目', value: '' },
        ...Array.from(projectCounts.entries()).map(([name, count]) => ({
          label: `${name}（${count}）`,
          value: name,
        })),
      ]
      const filteredRounds = allRoundsList.filter(r => !filter.project || (r.project?.name ?? '') === filter.project)
      const hasMore = filteredRounds.length > 40
      const displayedRounds = filteredRounds.slice(0, 40)
      const grouped: { title: string; rounds: Round[] }[] = []
      for (const r of displayedRounds) {
        const title = fmtDateGroup(r.startedAt, now)
        const last = grouped[grouped.length - 1]
        if (last && last.title === title) last.rounds.push(r)
        else grouped.push({ title, rounds: [r] })
      }
      // 不属于任何一轮的外派。Codex 由子代理覆盖，时间落在已有轮次之后的不重复列出
      const inRounds = new Set(allRoundsList.flatMap(r => jobsOfRound(r, list).map(j => j.id)))
      const earliest = allRoundsList.length ? Math.min(...allRoundsList.map(r => r.startedAt)) : Number.POSITIVE_INFINITY
      const others = list.filter(j => !inRounds.has(j.id) && !(j.provider === 'codex' && Date.parse(j.startedAt) >= earliest))

      const statusOf = (s: string) => JOB_STATUS[s] ?? { icon: '·', text: s, tone: 'none' as Tone }
      // 右侧状态：没结束看运行状态；结束了看验收结论，还没验收标待验收
      const outcome = (status: string, verdict: string | null) => {
        if (status !== 'done') return statusOf(status)
        return verdict ? VERDICT[verdict] ?? statusOf(status) : { icon: '○', text: '完成 · 待验收', tone: 'warning' as Tone }
      }
      const projectOf = (cwd?: string) => (cwd ? dirName(cwd) || '未知' : '未知')
      const toggleBrief = (id: string) => update($, openBriefs, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))

      // 一张员工卡片：任务和目标常显，派单全文要点开
      const jobCard = (j: JobView) => {
        const took = j.finishedAt ? fmtTook(Date.parse(j.finishedAt) - Date.parse(j.startedAt)) : null
        const open = openBriefIds.has(j.id)
        const goal = taskGoal(j.task)
        const why = formatReason(j.reason)
        const note = (j.verdictNote ?? '').trim()
        const help = (j.helpRequest ?? '').trim()
        const title = modelText(j.provider, j.model)
        const member = PROVIDER_TEXT[j.provider] ?? j.provider
        const st = outcome(j.status, j.verdict)
        return card(
          `job-${j.id}`,
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1} minWidth={0}>
            <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1} minWidth={0}>
              <Text weight="semibold" wrap="truncate-end">
                {title}
              </Text>
              {member !== '' && (
                <Text size="caption" dimColor wrap="truncate-end">
                  {member}
                </Text>
              )}
            </Box>
            {badge(st.icon, st.text, st.tone)}
          </Box>,
          field('任务', taskMeta(j.role, j.write, took, j.changedFiles)),
          goal !== '' && field('目标', goal, { wrap: 'wrap' }),
          why !== '' && field('为什么选它', why),
          note !== '' && field('验收意见', note),
          help !== '' && field('需要协助', help, { color: 'warning' }),
          open && field('派单全文', j.task, { wrap: 'wrap' }),
          <Button key={`brief-${j.id}`} label={open ? '收起派单全文' : '查看派单全文'} dimColor onPress={() => toggleBrief(j.id)} />,
        )
      }

      const agentCard = (a: RoundAgent) => {
        const { title, sub } = agentText(a)
        const head = (st: { icon: string; text: string; tone: Tone }) => (
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1} minWidth={0}>
            <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1} minWidth={0}>
              <Text weight="semibold" wrap="truncate-end">
                {title}
              </Text>
              {sub !== '' && (
                <Text size="caption" dimColor wrap="truncate-end">
                  {sub}
                </Text>
              )}
            </Box>
            {badge(st.icon, st.text, st.tone)}
          </Box>
        )
        // Codex 的角色、理由和验收记在 relay 台账里，按 Agent 调用 id 对上
        if (a.subagentType === CODEX_AGENT) {
          const rec = list.find(j => j.id === a.toolUseId)
          const tookMs = rec?.finishedAt ? Date.parse(rec.finishedAt) - Date.parse(rec.startedAt) : a.finishedAt != null ? a.finishedAt - a.startedAt : null
          const took = tookMs != null && Number.isFinite(tookMs) ? fmtTook(tookMs) : null
          const full = rec?.task || a.description
          const st = rec ? outcome(rec.verdict || rec.status === 'done' ? 'done' : a.status, rec.verdict) : statusOf(a.status)
          const briefId = rec?.id ?? a.toolUseId
          const open = openBriefIds.has(briefId)
          const goal = taskGoal(full)
          const why = formatReason(rec?.reason ?? '')
          const note = (rec?.verdictNote ?? '').trim()
          const help = (rec?.helpRequest ?? '').trim()
          return card(
            `agent-${a.id}`,
            head(st),
            field('任务', taskMeta(rec?.role ?? null, rec ? rec.write : null, took, rec?.changedFiles ?? 0)),
            goal !== '' && field('目标', goal, { wrap: 'wrap' }),
            why !== '' && field('为什么选它', why),
            note !== '' && field('验收意见', note),
            help !== '' && field('需要协助', help, { color: 'warning' }),
            open && field('派单全文', full, { wrap: 'wrap' }),
            <Button key={`brief-${briefId}`} label={open ? '收起派单全文' : '查看派单全文'} dimColor onPress={() => toggleBrief(briefId)} />,
          )
        }
        const kind = a.subagentType === 'fork' ? '分身' : a.subagentType
        const took = a.finishedAt ? `用时 ${fmtTook(a.finishedAt - a.startedAt)}` : null
        const taskLine = ['Claude 子代理', kind, took].filter((x): x is string => Boolean(x)).join(' · ')
        return card(
          `agent-${a.id}`,
          head(statusOf(a.status)),
          field('任务', taskLine),
          a.description !== '' && field('目标', a.description, { wrap: 'wrap' }),
        )
      }

      const backButton = <Button key="back" label="‹ 返回列表" dimColor onPress={() => update($, selectedRound, () => null)} />

      if (activeId?.startsWith('job:')) {
        const jobKey = activeId.slice('job:'.length)
        const j = list.find(item => item.id === jobKey)
        if (j) {
          const took = j.finishedAt ? `用时 ${fmtTook(Date.parse(j.finishedAt) - Date.parse(j.startedAt))}` : ''
          const headText = [`◆ ${projectOf(j.cwd)}`, fmtTime(Date.parse(j.startedAt)), took].filter(Boolean).join(' · ')
          const st = outcome(j.status, j.verdict)
          return page(
            backButton,
            <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1} minWidth={0}>
              <Box flexShrink={1} minWidth={0}>
                <Text wrap="wrap">{headText}</Text>
              </Box>
              {badge(st.icon, st.text, st.tone)}
            </Box>,
            jobCard(j),
          )
        }
      }

      if (activeId) {
        const r = allRoundsList.find(item => item.id === activeId)
        if (r) {
          const st = ROUND_STATUS[r.status] ?? ROUND_STATUS.answer!
          const took = r.finishedAt ? `用时 ${fmtTook(r.finishedAt - r.startedAt)}` : ''
          const headText = [`◆ ${r.project?.name || 'unknown'}`, fmtTime(r.startedAt), took].filter(Boolean).join(' · ')
          const message = r.text === '' ? '（系统触发的继续）' : r.text
          const rj = jobsOfRound(r, list)
          return page(
            backButton,
            <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1} minWidth={0}>
              <Box flexShrink={1} minWidth={0}>
                <Text wrap="wrap">{headText}</Text>
              </Box>
              {badge(st.icon, st.text, st.tone)}
            </Box>,
            field('你的消息', message, { wrap: 'wrap' }),
            field('主管', `${mainModelText(r.mainModel)} · 统筹拆解、派发、核验、汇报`),
            cardSummary(r, list) !== '' && field('分工', cardSummary(r, list)),
            ...r.agents.map(agentCard),
            ...rj.map(jobCard),
          )
        }
      }

      const roundItem = (r: Round) => {
        const st = ROUND_STATUS[r.status] ?? ROUND_STATUS.answer!
        const took = r.finishedAt ? fmtTook(r.finishedAt - r.startedAt) : ''
        const timeText = took ? `${fmtClockTime(r.startedAt)} · ${took}` : fmtClockTime(r.startedAt)
        const title = r.text === '' ? '（系统触发的继续）' : r.text.replace(/\s+/g, ' ')
        return (
          <Box key={`round-${r.id}`} flexDirection="column" minWidth={0}>
            <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1} minWidth={0}>
              <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1} minWidth={0}>
                <Text size="caption" color="suggestion" wrap="truncate-end">
                  ◆ {r.project?.name || 'unknown'}
                </Text>
                <Text size="caption" dimColor tabular wrap="truncate-end">
                  {timeText}
                </Text>
              </Box>
              <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
                {badge(st.icon, st.text, st.tone)}
                <Button key={`open-${r.id}`} label="详情 ›" dimColor onPress={() => update($, selectedRound, () => r.id)} />
              </Box>
            </Box>
            <Text weight="semibold" wrap="truncate-end">
              {title}
            </Text>
            <Text size="caption">{staffLine(r, list)}</Text>
          </Box>
        )
      }

      const otherItem = (j: JobView) => {
        const role = j.role ? ROLE_TEXT[j.role] ?? j.role : ''
        const rest = [fmtTime(Date.parse(j.startedAt)), modelText(j.provider, j.model), role].filter(Boolean).join(' · ')
        const st = outcome(j.status, j.verdict)
        return (
          <Box key={`other-${j.id}`} flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1} minWidth={0}>
            <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1} minWidth={0}>
              <Text size="caption" color="suggestion" wrap="truncate-end">
                ◆ {projectOf(j.cwd)}
              </Text>
              <Text size="caption" dimColor wrap="truncate-end">
                {rest}
              </Text>
            </Box>
            <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
              {badge(st.icon, st.text, st.tone)}
              <Button key={`open-job-${j.id}`} label="详情 ›" dimColor onPress={() => update($, selectedRound, () => `job:${j.id}`)} />
            </Box>
          </Box>
        )
      }

      return page(
        <Text size="caption" dimColor>
          所有项目的对话，最新的在前
        </Text>,
        Select && (
          <Select
            key="filter-project"
            label="项目"
            value={filter.project}
            options={projectOptions}
            onSelect={(v: string) => update($, roundFilter, () => ({ project: v }))}
          />
        ),
        displayedRounds.length === 0 ? (
          <Text dimColor>{allRoundsList.length === 0 ? '还没有对话记录，发一条消息后这里会出现' : '没有符合筛选条件的对话记录'}</Text>
        ) : (
          <Box flexDirection="column" rowGap={1}>
            {grouped.map(g => (
              <Box key={`group-${g.title}`} flexDirection="column" rowGap={1}>
                {section(g.title)}
                {g.rounds.map(roundItem)}
              </Box>
            ))}
            {hasMore && (
              <Text size="caption" dimColor>
                只显示最近 40 轮
              </Text>
            )}
          </Box>
        ),
        others.length > 0 && section('未归入对话的外派'),
        others.length > 0 && (
          <Box flexDirection="column" rowGap={1}>
            {others.map(otherItem)}
          </Box>
        ),
        <Box flexDirection="row" justifyContent="flex-end">
          <Button
            key="jobs-refresh"
            label="刷新"
            dimColor
            onPress={async () => {
              await refreshJobs($)
              await loadAllRounds($)
            }}
          />
        </Box>,
      )
    }

    // ---------- 厂商页 ----------
    const data = await read($, vendors)
    if (data === null) return page(noticeBar, <Text dimColor>正在读取厂商…</Text>)
    const f = await read($, form)
    const pendingRemove = await read($, confirmRemove)
    const roleText = (keys: string[]) => keys.map(k => data.roles.find(r => r.key === k)?.text ?? k).join(' · ') || '不参与自动派活'
    const busyLabel = (key: string, text: string) => (busyKey === key ? `${text}…` : text)

    const vendorCard = (v: Vendor) => {
      const status =
        v.via === 'self'
          ? { icon: '★', text: '主模型', tone: 'good' as Tone }
          : v.enabled
            ? { icon: '●', text: '已启用', tone: 'good' as Tone }
            : { icon: '○', text: '已停用', tone: 'none' as Tone }
      const viaBase = v.via === 'codex-plugin' ? 'Codex 官方插件' : v.via === 'self' ? '当前会话' : `官方 CLI · ${v.bin || v.name}`
      const showBin = v.via !== 'self' && v.bin !== ''
      const viaText = showBin ? `${viaBase} · ${v.binFound ? '已安装' : '未安装'}` : viaBase
      const accessText = v.fullAccess.supported
        ? v.fullAccess.enabled
          ? '已开启 · 执行命令不再逐个审批'
          : '已关闭 · 只能改文件'
        : v.fullAccess.note
      const goodAt = v.via === 'self' ? '拆解 · 派发 · 核验 · 汇报' : roleText(v.roles)
      const hasActions = v.canDisable || v.fullAccess.supported || v.canTest || v.canRemove
      return card(
        `vendor-${v.name}`,
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1} minWidth={0}>
          <Text weight="semibold" dimColor={!v.enabled}>
            {v.label}
          </Text>
          {badge(status.icon, status.text, status.tone)}
        </Box>,
        field('调用方式', viaText, showBin && !v.binFound ? { color: 'warning' } : undefined),
        field('擅长', goodAt),
        field('最高权限', accessText, v.fullAccess.supported ? undefined : { dimColor: true }),
        v.note !== '' && field('备注', v.note, { color: 'warning' }),
        pendingRemove === v.name ? (
          <Box flexDirection="row" columnGap={1} alignItems="center" marginTop={1}>
            <Text size="caption" color="error">
              确定删除 {v.label}？
            </Text>
            <Button key={`confirm-remove-${v.name}`} label={busyLabel(`remove:${v.name}`, '删除')} variant="primary" onPress={() => removeVendor($, v)} />
            <Button key={`cancel-remove-${v.name}`} label="取消" dimColor onPress={() => update($, confirmRemove, () => null)} />
          </Box>
        ) : (
          hasActions && (
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} marginTop={1}>
              <Box flexDirection="row" columnGap={1}>
                {v.canDisable && (
                  <Button key={`toggle-${v.name}`} label={busyLabel(`toggle:${v.name}`, v.enabled ? '停用' : '启用')} onPress={() => toggleVendor($, v)} />
                )}
                {v.fullAccess.supported && (
                  <Button
                    key={`access-${v.name}`}
                    label={busyLabel(`access:${v.name}`, v.fullAccess.enabled ? '关闭最高权限' : '开启最高权限')}
                    onPress={() => setVendorAccess($, v, !v.fullAccess.enabled)}
                  />
                )}
                {v.canTest && <Button key={`test-${v.name}`} label={busyLabel(`test:${v.name}`, '试运行')} dimColor onPress={() => testVendor($, v)} />}
              </Box>
              {v.canRemove && <Button key={`remove-${v.name}`} label="删除" dimColor onPress={() => update($, confirmRemove, () => v.name)} />}
            </Box>
          )
        ),
      )
    }

    const setField = (key: keyof AddForm, v: string) => update($, form, cur => (cur ? { ...cur, [key]: v } : cur))
    const formInput = (key: keyof AddForm, text: string, placeholder: string) =>
      Input && (
        <Input
          key={`form-${key}`}
          label={text}
          placeholder={placeholder}
          value={f ? String(f[key]) : ''}
          submitLabel="确定"
          onInput={(v: string) => setField(key, v)}
          onSubmit={(v: string) => setField(key, v)}
        />
      )

    const preset = f ? data.presets[f.preset] : undefined
    const addCard = f && (
      <Box flexDirection="column" rowGap={1}>
        {section('新增厂商')}
        {Select && (
          <Select
            key="form-preset"
            label="模板"
            value={f.preset}
            options={PRESET_ORDER.filter(k => data.presets[k]).map(k => ({ key: k, value: k, label: data.presets[k]!.title }))}
            onSelect={(v: string) => update($, form, () => blankForm(data, v))}
          />
        )}
        {preset?.note && (
          <Text size="caption" dimColor>
            {preset.note}
          </Text>
        )}
        {f.preset !== 'custom' && (
          <Text size="caption" dimColor>
            标识 {f.name} · 命令 {f.bin}
            {preset?.install ? ` · 安装：${preset.install}` : ''}
          </Text>
        )}
        <Box flexDirection="column" rowGap={1}>
          {f.preset === 'custom' && formInput('name', '标识', '小写英文，如 kimi')}
          {formInput('label', '显示名', '如 Kimi 会员')}
          {f.preset === 'custom' && formInput('bin', '命令', '如 kimi')}
          {formInput('models', '模型', '留空用默认；多个用逗号分隔')}
          {f.preset === 'custom' && (
            <>
              {formInput('promptArgs', '提示参数', '必须含 {prompt}，如 -p {prompt}')}
              {formInput('modelArgs', '模型参数', '如 --model {model}')}
              {formInput('readArgs', '只读参数', '如 --approval-mode plan')}
              {formInput('writeArgs', '可写参数', '如 --approval-mode auto-edit')}
            </>
          )}
        </Box>
        <Box flexDirection="column" rowGap={1}>
          <Text size="caption" dimColor>
            参与哪些任务（新厂商排在路由末尾）
          </Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
            {data.roles.map(r => (
              <Button
                key={`role-${r.key}`}
                label={f.roles.includes(r.key) ? `✓ ${r.text}` : r.text}
                variant={f.roles.includes(r.key) ? 'primary' : 'secondary'}
                onPress={() =>
                  update($, form, cur =>
                    cur ? { ...cur, roles: cur.roles.includes(r.key) ? cur.roles.filter(x => x !== r.key) : [...cur.roles, r.key] } : cur,
                  )
                }
              />
            ))}
          </Box>
        </Box>
        <Box flexDirection="row" columnGap={1}>
          <Button key="form-save" label={busyLabel('add', '保存')} variant="primary" onPress={() => submitForm($)} />
          <Button key="form-cancel" label="取消" dimColor onPress={() => update($, form, () => null)} />
        </Box>
      </Box>
    )

    const enabledCount = data.providers.filter(p => p.enabled).length
    const accessCount = data.providers.filter(p => p.fullAccess.enabled).length
    return page(
      noticeBar,
      <Text size="caption" dimColor>
        {data.providers.length} 家 · 启用 {enabledCount} 家 · 最高权限开启 {accessCount} 家
      </Text>,
      <Box flexDirection="column" rowGap={1}>
        {data.providers.map(vendorCard)}
      </Box>,
      addCard ||
        (Input ? (
          <Box flexDirection="row">
            <Button key="add-vendor" label="＋ 新增厂商" onPress={() => update($, form, () => blankForm(data, 'kimi'))} />
          </Box>
        ) : (
          <Text size="caption" dimColor>
            新增厂商请在桌面端或终端里操作
          </Text>
        )),
    )
  })
}
