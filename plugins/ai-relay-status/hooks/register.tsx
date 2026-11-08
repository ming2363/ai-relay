import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, FsEntry, Register, RenderChildren, SelectOption } from 'claude-code'

import type { AddForm, JobView, ModelPool, ModelsCatalog, ModelsView, PoolView, ProviderCatalog, RelayMode, Round, RoundAgent, RoundTokenRow, Snapshot, TokenUsage, Vendor, VendorData, WindowView } from '../types'

// 家目录在会话启动时用 $.env.get('HOME') 读取，不写死，别人安装也能用
let HOME = ''
const roundsDir = () => `${HOME}/.claude/ai-relay/rounds`
const jobsDir = () => `${HOME}/.claude/ai-relay/jobs`
const projectsDir = () => `${HOME}/.claude/projects`
const codexSessionsDir = () => `${HOME}/.codex/sessions`
const installedPluginsFile = () => `${HOME}/.claude/plugins/installed_plugins.json`
const NODE_CANDIDATES = ['/opt/homebrew/bin/node', '/usr/local/bin/node', 'node']
const REFRESH_MS = 60_000
// 提示条上的已运行时长：5 秒跳一次，不每秒重绘
const BAND_TICK_MS = 5_000
const BAND_SHOW = 3
const BRIEF_CHARS = 12
const PANE = 'relay-quota'
const PANE_TITLE = 'ai-relay'

// 结构变了就换 shape，旧版本存下的值会被丢弃
const snapshot = atom({ plugin: 'ai-relay-status', key: 'snapshot' } as const, null, { shape: 'snapshot-6' })
const switching = atom({ plugin: 'ai-relay-status', key: 'switching' } as const, null)
const tab = atom({ plugin: 'ai-relay-status', key: 'tab' } as const, 'quota')
// 厂商增加默认模型字段，换 shape 丢掉没有该字段的旧缓存
const vendors = atom({ plugin: 'ai-relay-status', key: 'vendors' } as const, null, { shape: 'vendors-3' })
const jobs = atom({ plugin: 'ai-relay-status', key: 'jobs' } as const, null, { shape: 'jobs-2' })
// 本会话的对话轮次，只保留最近 MAX_ROUNDS 轮
const rounds = atom({ plugin: 'ai-relay-status', key: 'rounds' } as const, [] as Round[], { shape: 'rounds-3' })
// 全部会话的对话轮次，最新的在前
const allRounds = atom({ plugin: 'ai-relay-status', key: 'allRounds' } as const, null as Round[] | null, { shape: 'all-rounds-1' })
// 对话筛选：只按项目。去掉环境后换 shape，丢掉旧的 { project, env }
// project 为 null：还没手动选过，默认选中当前窗口所在项目；'' 是用户选的「全部项目」
const roundFilter = atom({ plugin: 'ai-relay-status', key: 'roundFilter' } as const, { project: null } as { project: string | null }, { shape: 'round-filter-3' })
// 对话页当前详情。换掉按轮次展开后，旧的 expandedRounds 不再读取
const selectedRound = atom({ plugin: 'ai-relay-status', key: 'selectedRound' } as const, null)
// 详情里展开了派单全文的外派 id
const openBriefs = atom({ plugin: 'ai-relay-status', key: 'openBriefs' } as const, [] as string[])
const MAX_ROUNDS = 30
const form = atom({ plugin: 'ai-relay-status', key: 'form' } as const, null)
const confirmRemove = atom({ plugin: 'ai-relay-status', key: 'confirmRemove' } as const, null)
const busy = atom({ plugin: 'ai-relay-status', key: 'busy' } as const, null)
const notice = atom({ plugin: 'ai-relay-status', key: 'notice' } as const, null)
const MODEL_CATALOG_INIT: ModelsView = { catalog: null, status: 'idle', error: null }
const modelCatalog = atom({ plugin: 'ai-relay-status', key: 'modelCatalog' } as const, MODEL_CATALOG_INIT, { shape: 'model-catalog-1' })
/** 正在保存的「厂商:额度池」。Select 没有禁用，保存中卸下下拉框，避免重复提交 */
const savingModels = atom({ plugin: 'ai-relay-status', key: 'savingModels' } as const, [] as string[])
// 提示条的时长节拍。只让提示条订阅，避免每 5 秒把整个面板重绘一遍
const bandTick = atom({ plugin: 'ai-relay-status', key: 'bandTick' } as const, 0)
// 插件总开关：记录在 ~/.claude/settings.json 的 enabledPlugins 中
const relayEnabled = atom({ plugin: 'ai-relay-status', key: 'relayEnabled' } as const, true)
// 启停切换状态：切换中标记 busy，失败记录 error，成功记录 text
const relayToggle = atom({ plugin: 'ai-relay-status', key: 'relayToggle' } as const, null as { busy: boolean; error?: string; text?: string } | null)
// 同步锁：状态写回去之前拦住同一行的下一次选择
const savingLock = new Set<string>()
const NO_MODEL = '__none__'

// 会话启动时记下的环境信息，跨钩子共享
let currentSessionId = ''
let currentCwd = ''
let currentProject = { name: '', path: '' }
let initialSurface: string | null = null
// 桌面版左侧栏项目名：sessionId → originCwd 的末级目录名。只在打开对话页时读，60 秒内不重读
let desktopProjectNames = new Map<string, string>()
// 同一个桌面会话的 sessionId → 代表 id。cliSessionId 和 priorCliSessionIds 算同一组
let desktopSessionGroups = new Map<string, string>()
let desktopProjectsReadAt = 0
// 提示条后台刷新外派台账时，上一次还没回来就不再叠一次
let bandPollBusy = false
// 上次成功发起 relay jobs 的时刻。提示条用它做 60 秒兜底，不依赖当时是否已经看见进行中的任务
let bandPollAt = 0

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
// 验收结论。只认主管用 relay verdict 记下的结论，没有 verdict 不算通过
const VERDICT: Record<string, { icon: string; text: string; tone: Tone }> = {
  pass: { icon: '✓', text: '主管已验收', tone: 'good' },
  partial: { icon: '◐', text: '主管判部分通过', tone: 'warning' },
  fail: { icon: '✗', text: '主管判不通过', tone: 'critical' },
}
const ROLE_TEXT: Record<string, string> = {
  implement: '实现', debug: '排查', review: '审查', read: '阅读', deep: '深度推理', quick: '快速问答', 'claude-backup': 'Claude 替补',
}
// 厂商页角色名优先用 relay 给的 roles；没有时用这张表
const MODEL_ROLE_TEXT: Record<string, string> = {
  implement: '实现', debug: '排查', review: '审查', read: '阅读', deep: '深度推理', quick: '快问', 'claude-backup': '顶替 Claude',
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

// 外派记录上的会话 id。旧记录没有这个字段，按空串处理
function jobSessionId(j: JobView) {
  const id = (j as { sessionId?: unknown }).sessionId
  return typeof id === 'string' ? id.trim() : ''
}

function normPath(p: string) {
  let s = p.trim().replace(/[/\\]+$/, '')
  if (s.startsWith('/private/')) s = s.slice('/private'.length)
  return s
}

function jobCwd(j: JobView) {
  return typeof j.cwd === 'string' ? normPath(j.cwd) : ''
}

// 派单目录和轮次的项目路径相同才算同一项目。轮次没记下路径时，才退回末级目录名
function sameProject(cwd: string, r: Round) {
  const roundPath = normPath(r.project?.path ?? '')
  if (cwd && roundPath && cwd === roundPath) return true
  if (!roundPath) {
    const name = (r.project?.name ?? '').trim()
    return name !== '' && name === dirName(cwd)
  }
  return false
}

// 用户亲自发的一轮。系统标签和后台续跑并进它前面的用户轮次，不单独领任务
function isUserRound(r: Round) {
  return !isCarriedRound(r)
}

/**
 * 一条外派只归一轮，且不再要求开始时间落在该轮 finishedAt 之前。
 * 主管经常是先把任务派出去、这一轮就结束，任务的开始时间会晚于 finishedAt。
 * 有 sessionId：归到该会话里、开始时间不晚于任务的最近一轮。
 * 没有 sessionId：归到同一项目里、开始时间不晚于任务的最近一个用户轮次。
 * 连目录都没有的旧记录，退回「最近一个用户轮次」，避免从提示条上消失。
 * Codex 走 Agent 工具，不在这里归。
 */
function pickRoundForJob(j: JobView, rounds: readonly Round[]): Round | null {
  if (j.provider === 'codex') return null
  const t = Date.parse(j.startedAt)
  if (!Number.isFinite(t)) return null
  const sid = jobSessionId(j)
  let candidates: Round[]
  if (sid) {
    candidates = rounds.filter(r => (r.sessionId || '') === sid && r.startedAt <= t)
  } else {
    const cwd = jobCwd(j)
    const users = rounds.filter(r => isUserRound(r) && r.startedAt <= t)
    candidates = cwd ? users.filter(r => sameProject(cwd, r)) : users
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1))
  return candidates[0] ?? null
}

// 归入这一轮的 relay 外派。pool 是用来比较的全部轮次；不传时只拿这一轮自己比
function jobsOfRound(r: Round, list: JobView[], pool?: readonly Round[]) {
  const rounds = pool && pool.length > 0 ? pool : [r]
  return list.filter(j => pickRoundForJob(j, rounds)?.id === r.id)
}

// 一轮里用到的其他模型（去重，按出现先后）
function helperNames(r: Round, list: JobView[], pool?: readonly Round[]) {
  const names = [
    ...r.agents.map(a => (a.subagentType === CODEX_AGENT ? 'Codex' : `${mainModelText(a.model)} 子代理`)),
    ...jobsOfRound(r, list, pool).map(j => modelText(j.provider, j.model)),
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
function cardSummary(r: Round, list: JobView[], pool?: readonly Round[]) {
  const rj = jobsOfRound(r, list, pool)
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
  if (pending > 0) parts.push(`等主管验收 ${pending}`)

  return parts.join(' · ')
}

// 列表上员工名字后面的图标：✓ 主管已验收、▲ 部分通过、✕ 不通过或失败、○ 等主管验收、● 进行中
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
function staffLine(r: Round, list: JobView[], pool?: readonly Round[]) {
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
  for (const j of jobsOfRound(r, list, pool)) bits.push(`${modelText(j.provider, j.model).replace(/ · (High|Medium|Low)$/, '')} ${staffIcon(j.status, j.verdict, false)}`)
  const main = `${mainModelText(r.mainModel)} 主管`
  // 只有主管一个模型时不写"未外派"，一看就知道
  return bits.length ? `${main} · ${bits.join(' · ')}` : main
}

// 还在跑的子任务数。子代理和 Codex 看 agent 状态；relay 外派看归入本轮的 job（不含 Codex 台账）
function runningSubtaskCount(r: Round, list: JobView[], pool?: readonly Round[]) {
  let n = 0
  for (const a of r.agents ?? []) {
    if (a.status === 'running') n++
  }
  for (const j of jobsOfRound(r, list, pool)) {
    if (j.status === 'running') n++
  }
  return n
}

// 已经结束、主管还没记结论的外派。Claude 子代理没有 verdict 字段，不在这里计
function missingVerdictCount(r: Round, list: JobView[], pool?: readonly Round[]) {
  let n = 0
  for (const j of jobsOfRound(r, list, pool)) {
    if (j.status === 'running' || j.verdict) continue
    n++
  }
  for (const a of r.agents ?? []) {
    if (a.subagentType !== CODEX_AGENT || a.status === 'running') continue
    const rec = list.find(item => item.id === a.toolUseId)
    if (!rec || rec.status === 'running' || rec.verdict) continue
    n++
  }
  return n
}

// 只改显示，不改存储里的 status。
// 还有子任务在跑：本轮未结束是进行中，本轮已结束是等子任务。
// 子任务都结束了、本轮或并入的系统轮次仍在进行：主管验收中。
// 主管也结束了：用原来的状态。完成时若还有外派没记结论，pendingVerdicts 给界面加次要说明。
function roundShownStatus(r: Round, list: JobView[], pool?: readonly Round[]) {
  const running = runningSubtaskCount(r, list, pool)
  const pendingVerdicts = missingVerdictCount(r, list, pool)
  const runningView = ROUND_STATUS.running!
  if (running > 0) {
    if (r.status === 'running') return { icon: runningView.icon, text: runningView.text, tone: runningView.tone, running, pendingVerdicts }
    return { icon: runningView.icon, text: '等子任务', tone: runningView.tone, running, pendingVerdicts }
  }
  const hadSubtasks = (r.agents?.length ?? 0) + jobsOfRound(r, list, pool).length > 0
  if (r.status === 'running' && hadSubtasks) {
    return { icon: runningView.icon, text: '主管验收中', tone: runningView.tone, running: 0, pendingVerdicts }
  }
  const base = ROUND_STATUS[r.status] ?? ROUND_STATUS.answer!
  return { icon: base.icon, text: base.text, tone: base.tone, running: 0, pendingVerdicts }
}

// 等子任务时用时算到现在，不停在主模型回话那一刻；其他已结束的轮次仍停在结束时间
function roundElapsed(r: Round, waiting: boolean, now: number) {
  const end = waiting ? now : r.finishedAt
  if (end == null) return null
  return Math.max(0, end - r.startedAt)
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

// ---------- Token 消耗计算与按需缓存 ----------

// 已结束轮次的 Token 消耗缓存（key 为轮次 id）；进行中的轮次每次打开重新算
const roundTokenCache = new Map<string, RoundTokenRow[]>()

// 数字用 k / M 缩写，保留一位小数（末尾 .0 省略，如 12.3k、1.2k、80k）
function fmtTokens(n: number) {
  const v = Math.max(0, Math.round(n))
  if (v < 1000) return String(v)
  if (v < 999_950) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

function fmtUsage(u: TokenUsage | null, opts?: { live?: boolean; emptyText?: string }) {
  if (!u) return opts?.emptyText || '无数据'
  const text = `输入 ${fmtTokens(u.input)} · 输出 ${fmtTokens(u.output)} · 缓存读 ${fmtTokens(u.cacheRead)}`
  return opts?.live ? `${text}（进行中）` : text
}

const toNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const encodeProjectPath = (p: string) => p.replace(/[^a-zA-Z0-9-]/g, '-')

function extractClaudeUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const u = raw as Record<string, unknown>
  const hasTokenField =
    typeof u.input_tokens === 'number' ||
    typeof u.output_tokens === 'number' ||
    typeof u.cache_read_input_tokens === 'number' ||
    typeof u.cache_creation_input_tokens === 'number'
  if (!hasTokenField) return null
  let input = toNum(u.input_tokens) + toNum(u.cache_creation_input_tokens)
  let output = toNum(u.output_tokens)
  let cacheRead = toNum(u.cache_read_input_tokens)
  // 某些记录顶层全为 0，真实读数在 iterations[0] 里
  if (input === 0 && output === 0 && cacheRead === 0 && Array.isArray(u.iterations) && u.iterations.length > 0) {
    const it0 = u.iterations[0]
    if (it0 && typeof it0 === 'object' && !Array.isArray(it0)) {
      const it = it0 as Record<string, unknown>
      input = toNum(it.input_tokens) + toNum(it.cache_creation_input_tokens)
      output = toNum(it.output_tokens)
      cacheRead = toNum(it.cache_read_input_tokens)
    }
  }
  return { input, output, cacheRead, total: input + output + cacheRead }
}

// 从 Claude 会话或子代理的 jsonl 文本中累加 assistant 条目的 usage；按 message.id 去重
function sumClaudeJsonlUsage(jsonlText: string, startMs?: number, endMs?: number): TokenUsage | null {
  if (!jsonlText) return null
  const byMsgId = new Map<string, TokenUsage>()
  let seq = 0
  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      entry = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.type !== 'assistant') continue
    if (startMs !== undefined || endMs !== undefined) {
      const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : typeof entry.timestamp === 'number' ? entry.timestamp : Number.NaN
      if (!Number.isFinite(ts)) continue
      if (startMs !== undefined && ts < startMs) continue
      if (endMs !== undefined && ts > endMs) continue
    }
    const msg = entry.message && typeof entry.message === 'object' ? (entry.message as Record<string, unknown>) : null
    if (!msg) continue
    const usage = extractClaudeUsage(msg.usage)
    if (!usage) continue
    const msgId = typeof msg.id === 'string' && msg.id ? msg.id : `__line_${++seq}`
    byMsgId.set(msgId, usage)
  }
  if (byMsgId.size === 0) return null
  let input = 0
  let output = 0
  let cacheRead = 0
  for (const u of byMsgId.values()) {
    input += u.input
    output += u.output
    cacheRead += u.cacheRead
  }
  return { input, output, cacheRead, total: input + output + cacheRead }
}

// 兜底：从主会话 jsonl 里的 Agent 工具返回结果（toolUseResult.usage）提取子代理消耗
function findSubagentUsageFromMainJsonl(jsonlText: string, a: RoundAgent): TokenUsage | null {
  if (!jsonlText) return null
  const rawId = a.id.replace(/^agent-/, '')
  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      entry = parsed as Record<string, unknown>
    } catch {
      continue
    }
    const tur = entry.toolUseResult && typeof entry.toolUseResult === 'object' ? (entry.toolUseResult as Record<string, unknown>) : null
    if (!tur) continue
    const turAgentId = typeof tur.agentId === 'string' ? tur.agentId.replace(/^agent-/, '') : ''
    let matched = Boolean(turAgentId && (turAgentId === rawId || turAgentId === a.id))
    if (!matched && a.toolUseId && entry.message && typeof entry.message === 'object') {
      const content = (entry.message as Record<string, unknown>).content
      if (Array.isArray(content)) {
        matched = content.some(c => c && typeof c === 'object' && (c as Record<string, unknown>).tool_use_id === a.toolUseId)
      }
    }
    if (matched) {
      const u = extractClaudeUsage(tur.usage)
      if (u) return u
    }
  }
  return null
}

// 桌面版会换 id、跨项目目录写日志，同组的所有主记录都要参与去重统计。
async function findSessionJsonl($: Engine, r: Round): Promise<{ dir: string; file: string; id: string }[]> {
  if (!HOME || !r.sessionId) return []
  await loadDesktopProjects($)
  const ids = new Set([r.sessionId])
  const group = desktopSessionGroups.get(r.sessionId)
  if (group) for (const [id, root] of desktopSessionGroups) if (root === group) ids.add(id)
  const base = projectsDir()
  const dirs = new Set<string>()
  if (r.project?.path) dirs.add(`${base}/${encodeProjectPath(r.project.path)}`)
  try {
    for (const entry of await $.fs.list(base)) if (entry.kind === 'dir') dirs.add(`${base}/${entry.name}`)
  } catch {}
  const found: { dir: string; file: string; id: string }[] = []
  for (const dir of dirs) for (const id of ids) {
    const file = `${dir}/${id}.jsonl`
    try {
      if (await $.fs.exists(file)) found.push({ dir, file, id })
    } catch {}
  }
  return found
}

// $.fs.read 限制 4 MiB；大日志在本机流式提取用量，避免把正文搬进插件。
const CLAUDE_USAGE_READER = `
const fs = require('node:fs');
const readline = require('node:readline');
(async () => {
  const [file, start, end] = process.argv.slice(1);
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const t = typeof e.timestamp === 'number' ? e.timestamp : Date.parse(e.timestamp);
    if (!e.toolUseResult?.usage) {
      if (start !== '' && (!Number.isFinite(t) || t < Number(start))) continue;
      if (end !== '' && (!Number.isFinite(t) || t > Number(end))) continue;
    }
    const m = e.message;
    const u = e.toolUseResult;
    if (e.type !== 'assistant' && !u?.usage) continue;
    console.log(JSON.stringify({ type: e.type, timestamp: e.timestamp,
      message: m && { id: m.id, usage: m.usage, content: Array.isArray(m.content) ? m.content.filter(c => c && typeof c === 'object' && c.tool_use_id).map(c => ({ tool_use_id: c.tool_use_id })) : undefined },
      toolUseResult: u?.usage ? { agentId: u.agentId, usage: u.usage } : undefined }));
  }
})().catch(() => { process.exitCode = 1; });
`

async function readClaudeUsageJsonl($: Engine, file: string, startMs?: number, endMs?: number): Promise<string> {
  try {
    return await $.fs.read(file)
  } catch {
    for (const node of NODE_CANDIDATES) {
      let result
      try {
        result = await $.process.run([node, '-e', CLAUDE_USAGE_READER, file, startMs === undefined ? '' : String(startMs), endMs === undefined ? '' : String(endMs)])
      } catch {
        continue
      }
      if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error('会话日志读取失败或用量过大')
      return result.stdout
    }
    throw new Error('未找到可读取会话日志的 Node')
  }
}

// 从 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 按时间和 cwd 匹配 Codex 的 token_count 事件
async function findCodexUsage($: Engine, r: Round, a: RoundAgent, rec?: JobView): Promise<TokenUsage | null> {
  if (rec?.usage && typeof rec.usage.input === 'number') {
    return rec.usage
  }
  if (!HOME) return null
  const startMs = a.startedAt || r.startedAt
  const endMs = a.finishedAt ?? r.finishedAt ?? Number.POSITIVE_INFINITY
  const targetCwd = rec?.cwd || r.project?.path || ''
  const finiteEnd = Number.isFinite(endMs) ? endMs : Math.max(startMs, await $.clock.now().catch(() => startMs))
  const dayDirs = new Set<string>()
  const base = codexSessionsDir()
  for (let t = startMs - 86_400_000; t <= finiteEnd + 86_400_000; t += 43_200_000) {
    const d = new Date(t)
    dayDirs.add(`${base}/${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}`)
    dayDirs.add(`${base}/${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`)
  }

  let input = 0
  let output = 0
  let cacheRead = 0
  let matchedEvents = 0

  for (const dir of dayDirs) {
    let entries: FsEntry[] = []
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    const rolloutFiles = entries.filter(e => e.kind === 'file' && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
    for (const file of rolloutFiles) {
      let text = ''
      try {
        text = await $.fs.read(`${dir}/${file.name}`)
      } catch {
        continue
      }
      if (!text) continue
      const lines = text.split('\n')
      let cwdOk = !targetCwd
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const entry = JSON.parse(trimmed) as Record<string, unknown>
          if (entry.type === 'session_meta' && entry.payload && typeof entry.payload === 'object') {
            const metaCwd = (entry.payload as Record<string, unknown>).cwd
            if (typeof metaCwd === 'string' && metaCwd && targetCwd) {
              const normMeta = metaCwd.replace(/\/+$/, '')
              const normTarget = targetCwd.replace(/\/+$/, '')
              cwdOk = normMeta === normTarget || normMeta.startsWith(`${normTarget}/`) || normTarget.startsWith(`${normMeta}/`)
            }
            break
          }
        } catch {}
      }
      if (!cwdOk) continue

      let prevTotalTokens: number | null = null
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let entry: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(trimmed)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
          entry = parsed as Record<string, unknown>
        } catch {
          continue
        }
        if (entry.type !== 'event_msg') continue
        const payload = entry.payload && typeof entry.payload === 'object' ? (entry.payload as Record<string, unknown>) : null
        if (!payload || payload.type !== 'token_count') continue
        const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : typeof entry.timestamp === 'number' ? entry.timestamp : Number.NaN
        if (!Number.isFinite(ts)) continue
        if (ts < startMs - 2000 || ts > endMs + 5000) continue
        const info = payload.info && typeof payload.info === 'object' ? (entry.info ?? payload.info) as Record<string, unknown> : null
        if (!info) continue
        const totalObj = info.total_token_usage && typeof info.total_token_usage === 'object' ? (info.total_token_usage as Record<string, unknown>) : null
        const lastObj = info.last_token_usage && typeof info.last_token_usage === 'object' ? (info.last_token_usage as Record<string, unknown>) : null
        const curTotal = totalObj && typeof totalObj.total_tokens === 'number' ? totalObj.total_tokens : null
        // Codex 单轮末尾可能连续写出两条 total_tokens 完全相同的 token_count 事件，跳过重复条
        if (curTotal !== null && prevTotalTokens !== null && curTotal === prevTotalTokens) {
          continue
        }
        if (curTotal !== null) prevTotalTokens = curTotal
        const src = lastObj ?? totalObj
        if (!src) continue
        input += toNum(src.input_tokens)
        output += toNum(src.output_tokens)
        cacheRead += toNum(src.cached_input_tokens)
        matchedEvents++
      }
    }
  }

  if (matchedEvents === 0) return null
  return { input, output, cacheRead, total: input + output }
}

// 读取 relay 外派任务（agy / grok）的 usage 字段
async function findJobUsage($: Engine, j: JobView): Promise<TokenUsage | null> {
  if (j.usage && typeof j.usage.input === 'number' && typeof j.usage.output === 'number' && typeof j.usage.cacheRead === 'number') {
    return {
      input: toNum(j.usage.input),
      output: toNum(j.usage.output),
      cacheRead: toNum(j.usage.cacheRead),
      total: toNum(j.usage.total ?? j.usage.input + j.usage.output + j.usage.cacheRead),
    }
  }
  if (!HOME || !j.id) return null
  try {
    const file = `${jobsDir()}/${j.id}.json`
    if (!(await $.fs.exists(file))) return null
    const parsed = JSON.parse(await $.fs.read(file)) as Record<string, unknown>
    const u = parsed?.usage && typeof parsed.usage === 'object' ? (parsed.usage as Record<string, unknown>) : null
    if (!u || typeof u.input !== 'number') return null
    const input = toNum(u.input)
    const output = toNum(u.output)
    const cacheRead = toNum(u.cacheRead)
    return { input, output, cacheRead, total: toNum(u.total ?? input + output + cacheRead) }
  } catch {
    return null
  }
}

async function computeRoundTokens($: Engine, r: Round, list: JobView[], pool?: readonly Round[]): Promise<RoundTokenRow[]> {
  if (!HOME) {
    try {
      HOME = (await $.env.get('HOME')) || ''
    } catch {}
  }
  const rows: RoundTokenRow[] = []
  const sessionInfos = await findSessionJsonl($, r)
  const texts: string[] = []
  let readFailed = false
  for (const info of sessionInfos) {
    try {
      texts.push(await readClaudeUsageJsonl($, info.file, r.startedAt, r.finishedAt))
    } catch {
      readFailed = true
    }
  }
  const sessionText = texts.join('\n')

  // 1. 主管 Claude
  let mainUsage: TokenUsage | null = null
  try {
    mainUsage = sumClaudeJsonlUsage(sessionText, r.startedAt, r.finishedAt ?? Number.POSITIVE_INFINITY)
  } catch {
    mainUsage = null
  }
  const mainEmptyText = readFailed ? '无数据（会话日志读取失败）' : sessionInfos.length === 0 ? '无数据（未找到会话日志）' : '无数据（本轮时间内没有用量记录）'
  rows.push({ label: `${mainModelText(r.mainModel)}（主管）`, usage: readFailed ? null : mainUsage, emptyText: mainEmptyText } as RoundTokenRow)

  // 2. 各子代理（Claude 子代理与 Codex）
  for (const a of r.agents) {
    if (a.subagentType === CODEX_AGENT) {
      const rec = list.find(j => j.id === a.toolUseId)
      let codexUsage: TokenUsage | null = null
      try {
        codexUsage = await findCodexUsage($, r, a, rec)
      } catch {
        codexUsage = null
      }
      rows.push({ label: 'Codex', usage: codexUsage })
    } else {
      let subUsage: TokenUsage | null = null
      try {
        for (const sessionInfo of sessionInfos) {
          const subDir = `${sessionInfo.dir}/${sessionInfo.id}/subagents`
          const rawId = a.id.replace(/^agent-/, '')
          const candidates = [`${subDir}/agent-${rawId}.jsonl`, `${subDir}/${a.id}.jsonl`]
          for (const cand of candidates) {
            if (await $.fs.exists(cand)) {
              subUsage = sumClaudeJsonlUsage(await readClaudeUsageJsonl($, cand))
              if (subUsage) break
            }
          }
          if (!subUsage) {
            try {
              const entries = await $.fs.list(subDir)
              for (const entry of entries) {
                if (!entry.name.endsWith('.meta.json')) continue
                try {
                  const meta = JSON.parse(await $.fs.read(`${subDir}/${entry.name}`)) as Record<string, unknown>
                  if ((a.toolUseId && meta.toolUseId === a.toolUseId) || (a.id && meta.agentId === a.id)) {
                    const jsonlFile = `${subDir}/${entry.name.replace(/\.meta\.json$/, '.jsonl')}`
                    if (await $.fs.exists(jsonlFile)) {
                      subUsage = sumClaudeJsonlUsage(await readClaudeUsageJsonl($, jsonlFile))
                      if (subUsage) break
                    }
                  }
                } catch {}
              }
            } catch {}
          }
          if (subUsage) break
        }
        if (!subUsage && sessionText) {
          subUsage = findSubagentUsageFromMainJsonl(sessionText, a)
        }
      } catch {
        subUsage = null
      }
      rows.push({ label: `${mainModelText(a.model)}（子代理）`, usage: subUsage })
    }
  }

  // 3. relay 外派（agy / Grok 等）
  for (const j of jobsOfRound(r, list, pool)) {
    let jobUsage: TokenUsage | null = null
    let isLive = false
    try {
      jobUsage = await findJobUsage($, j)
    } catch {
      jobUsage = null
    }
    if (!jobUsage) {
      const live = (j as { liveUsage?: TokenUsage | null }).liveUsage
      if (live && typeof live.input === 'number' && typeof live.output === 'number' && typeof live.cacheRead === 'number') {
        jobUsage = {
          input: toNum(live.input),
          output: toNum(live.output),
          cacheRead: toNum(live.cacheRead),
          total: toNum(live.total ?? live.input + live.output + live.cacheRead),
        }
        isLive = true
      }
    }
    const emptyText = j.status === 'running' ? '进行中，暂未匹配到日志' : '无数据'
    rows.push({
      label: modelText(j.provider, j.model),
      usage: jobUsage,
      live: isLive,
      emptyText,
    } as RoundTokenRow)
  }

  // 4. 本轮合计
  const available = rows.map(row => row.usage).filter((u): u is TokenUsage => u !== null)
  const totalUsage: TokenUsage | null =
    available.length > 0
      ? available.reduce(
          (acc, u) => ({
            input: acc.input + u.input,
            output: acc.output + u.output,
            cacheRead: acc.cacheRead + u.cacheRead,
            total: (acc.total ?? 0) + (u.total ?? u.input + u.output + u.cacheRead),
          }),
          { input: 0, output: 0, cacheRead: 0, total: 0 },
        )
      : null
  rows.push({ label: '合计', usage: totalUsage })
  return rows
}

// 结束时间或并进来的子代理变了就换一把钥匙，折叠延长的窗口不会继续用旧结果
function roundTokenCacheKey(r: Round) {
  return `${r.id}:${r.status}:${r.finishedAt ?? 'open'}:${r.agents?.length ?? 0}:${[...desktopSessionGroups].filter(([, group]) => group === desktopSessionGroups.get(r.sessionId)).map(([id]) => id).sort().join(',')}`
}

async function getRoundTokens($: Engine, r: Round, list: JobView[], pool?: readonly Round[]): Promise<RoundTokenRow[]> {
  const isRunning = r.status === 'running' || runningSubtaskCount(r, list, pool) > 0
  const key = roundTokenCacheKey(r)
  if (!isRunning && roundTokenCache.has(key)) {
    return roundTokenCache.get(key)!
  }
  const rows = await computeRoundTokens($, r, list, pool)
  if (!isRunning && rows[0]?.usage !== null) {
    roundTokenCache.set(key, rows)
  } else {
    roundTokenCache.delete(key)
  }
  return rows
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

function roleName(roles: { key: string; text: string }[], key: string) {
  return roles.find(r => r.key === key)?.text || MODEL_ROLE_TEXT[key] || key
}

/** 额度池下面那行：用于哪些角色，以及写死了模型的角色 */
function poolUsage(roles: { key: string; text: string }[], pool: ModelPool) {
  const follow = pool.followRoles ?? []
  const fixed = pool.fixedRoles ?? []
  const used = follow.length ? `用于：${follow.map(k => roleName(roles, k)).join('、')}` : '暂无角色使用'
  if (!fixed.length) return used
  return `${used}；单独指定：${fixed.map(f => `${roleName(roles, f.role)} → ${f.model}`).join('、')}`
}

function catalogLabel(id: string, label?: string) {
  if (!label || label === id) return id
  return `${label} · ${id}`
}

function cliOption(entry: ProviderCatalog | undefined): SelectOption {
  const cli = entry?.cliDefault
  return { value: 'default', label: cli ? `跟随 CLI 默认（${cli}）` : '跟随 CLI 默认' }
}

/** 下拉选项：CLI 默认在最前，其余保持清单顺序；当前值被下架时仍留在末尾 */
function poolOptions(pool: ModelPool, entry: ProviderCatalog | undefined): SelectOption[] {
  const known = (entry?.models ?? []).filter(m => m.pool === pool.pool)
  const options: SelectOption[] = []
  const seen = new Set<string>()
  const push = (opt: SelectOption) => {
    if (seen.has(opt.value)) return
    seen.add(opt.value)
    options.push(opt)
  }
  if (known.length > 0 && pool.allowCliDefault) push(cliOption(entry))
  for (const m of known) push({ value: m.id, label: catalogLabel(m.id, m.label) })
  if (pool.current && !seen.has(pool.current)) {
    const anywhere = (entry?.models ?? []).find(m => m.id === pool.current)
    push({ value: pool.current, label: `${catalogLabel(pool.current, anywhere?.label)}（清单里已没有）` })
  }
  // 没有上次的清单时，只留当前值这一个选项
  if (known.length === 0 && !pool.current && pool.allowCliDefault) push(cliOption(entry))
  if (!options.length) push({ value: NO_MODEL, label: '暂无可用模型' })
  return options
}

function poolValue(pool: ModelPool, options: SelectOption[]) {
  if (pool.current && options.some(o => o.value === pool.current)) return pool.current
  if (!pool.current && options.some(o => o.value === 'default')) return 'default'
  return options[0]?.value ?? NO_MODEL
}

function poolCurrentLabel(pool: ModelPool, entry: ProviderCatalog | undefined) {
  if (!pool.current) return pool.allowCliDefault ? (cliOption(entry).label ?? '跟随 CLI 默认') : '未设置'
  const inPool = (entry?.models ?? []).find(m => m.id === pool.current && m.pool === pool.pool)
  if (inPool) return catalogLabel(inPool.id, inPool.label)
  const anywhere = (entry?.models ?? []).find(m => m.id === pool.current)
  return `${catalogLabel(pool.current, anywhere?.label)}（清单里已没有）`
}

function fmtAgo(iso: string, now: number) {
  const t = Date.parse(iso)
  if (!iso || Number.isNaN(t)) return ''
  const min = Math.max(0, Math.floor((now - t) / 60_000))
  if (min < 1) return '更新于刚刚'
  if (min < 60) return `更新于 ${min} 分钟前`
  if (min < 24 * 60) return `更新于 ${Math.floor(min / 60)} 小时前`
  return `更新于 ${Math.floor(min / (24 * 60))} 天前`
}

function normalizeModelPools(raw: unknown): ModelPool[] {
  if (!Array.isArray(raw)) return []
  const out: ModelPool[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    if (typeof p.pool !== 'string' || p.pool === '') continue
    const fixedRoles: ModelPool['fixedRoles'] = []
    if (Array.isArray(p.fixedRoles)) {
      for (const f of p.fixedRoles) {
        if (!f || typeof f !== 'object') continue
        const fr = f as Record<string, unknown>
        if (typeof fr.role !== 'string' || typeof fr.model !== 'string') continue
        fixedRoles.push({ role: fr.role, model: fr.model })
      }
    }
    out.push({
      pool: p.pool,
      label: typeof p.label === 'string' && p.label ? p.label : p.pool,
      current: typeof p.current === 'string' && p.current ? p.current : null,
      allowCliDefault: p.allowCliDefault === true,
      followRoles: Array.isArray(p.followRoles) ? p.followRoles.filter((x): x is string => typeof x === 'string') : [],
      fixedRoles,
    })
  }
  return out
}

function parseModels(stdout: string): ModelsCatalog {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch (err) {
    throw new Error(`解析失败：${errText(err)}`)
  }
  if (!data || typeof data !== 'object') throw new Error('解析失败：不是对象')
  const root = data as Record<string, unknown>
  const providers: Record<string, ProviderCatalog> = {}
  if (root.providers && typeof root.providers === 'object') {
    for (const [name, value] of Object.entries(root.providers as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const p = value as Record<string, unknown>
      const models: ProviderCatalog['models'] = []
      if (Array.isArray(p.models)) {
        for (const item of p.models) {
          if (!item || typeof item !== 'object') continue
          const m = item as Record<string, unknown>
          if (typeof m.id !== 'string' || m.id === '') continue
          models.push({
            id: m.id,
            label: typeof m.label === 'string' && m.label ? m.label : m.id,
            pool: typeof m.pool === 'string' && m.pool ? m.pool : null,
          })
        }
      }
      providers[name] = {
        ok: p.ok !== false,
        error: typeof p.error === 'string' ? p.error : null,
        fetchedAt: typeof p.fetchedAt === 'string' ? p.fetchedAt : '',
        cliDefault: typeof p.cliDefault === 'string' && p.cliDefault ? p.cliDefault : null,
        models,
      }
    }
  }
  return { updatedAt: typeof root.updatedAt === 'string' ? root.updatedAt : '', providers }
}

function catalogProblem(view: ModelsView, name: string) {
  // 整次调用失败优先：这是最新的错误；某一家 ok:false 只在清单本身读到了的时候显示
  if (view.status === 'error' && view.error) {
    return view.catalog ? `模型列表获取失败：${view.error}，显示的是上次的结果` : `模型列表获取失败：${view.error}`
  }
  const entry = view.catalog?.providers?.[name]
  if (entry && entry.ok === false) return `模型列表获取失败：${entry.error || '未知原因'}，显示的是上次的结果`
  return ''
}

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

async function stampJobPoll($: Engine) {
  try {
    bandPollAt = await $.clock.now()
  } catch {
    // 读不到时钟时保持原值，下一次兜底仍会再拉
  }
}

async function refreshJobs($: Engine) {
  await stampJobPoll($)
  try {
    const { exitCode, stdout } = await runRelay($, ['jobs', '--json', '--limit', '20'])
    if (exitCode !== 0) return
    const next = JSON.parse(stdout) as JobView[]
    const prev = await read($, jobs)
    // 内容没变就不写状态，避免提示条的定时刷新把订阅了 jobs 的页面一起重绘
    if (JSON.stringify(prev) === JSON.stringify(next)) return
    await update($, jobs, () => next)
  } catch {
    // 读不到记录时保留上次
  }
}

async function refreshVendors($: Engine) {
  try {
    const { exitCode, stdout, stderr } = await runRelay($, ['providers', '--json'])
    if (exitCode !== 0) throw new Error(cleanErr(stderr) || `exit ${exitCode}`)
    const data = JSON.parse(stdout) as VendorData
    // 旧版 relay 没有 fullAccess / modelPools：补默认值，避免厂商页渲染报错
    data.providers = (data.providers ?? []).map(p => ({
      ...p,
      fullAccess: p.fullAccess ?? { supported: false, enabled: false, note: '需要更新 ai-relay 插件' },
      modelPools: normalizeModelPools(p.modelPools),
    }))
    await update($, vendors, () => data)
  } catch (err) {
    await update($, notice, () => ({ text: `读取厂商列表失败：${errText(err)}`, ok: false }))
  }
}

// 进入厂商页或点刷新时取模型清单。失败只改这块的状态，不拖垮面板
async function loadModels($: Engine, refresh = false) {
  const cur = await read($, modelCatalog)
  if (cur.status === 'loading' || cur.status === 'refreshing') return
  try {
    const status: ModelsView['status'] = refresh ? 'refreshing' : 'loading'
    await update($, modelCatalog, (s): ModelsView => ({ ...s, status, error: null }))
    const args = refresh ? ['models', '--refresh', '--json'] : ['models', '--json']
    const { exitCode, stdout, stderr } = await runRelay($, args, refresh ? 120_000 : 60_000)
    if (exitCode !== 0) throw new Error(cleanErr(stderr) || cleanErr(stdout) || `退出码 ${exitCode}`)
    const catalog = parseModels(stdout)
    await update($, modelCatalog, (): ModelsView => ({ catalog, status: 'ready', error: null }))
  } catch (err) {
    await update($, modelCatalog, (s): ModelsView => ({ catalog: s.catalog, status: 'error', error: errText(err) }))
  }
}

async function applyPoolCurrent($: Engine, name: string, pool: string, current: string | null) {
  await update($, vendors, data => {
    if (!data) return data
    return {
      ...data,
      providers: data.providers.map(p =>
        p.name !== name ? p : { ...p, modelPools: (p.modelPools ?? []).map(mp => (mp.pool === pool ? { ...mp, current } : mp)) },
      ),
    }
  })
}

// 选完立即保存。先改界面；失败改回并 toast。同一行保存中直接忽略后续选择
async function setPoolModel($: Engine, name: string, pool: string, value: string) {
  if (!value || value === NO_MODEL) return
  const key = `${name}:${pool}`
  if (savingLock.has(key)) return
  savingLock.add(key)
  let prev: string | null = null
  let started = false
  try {
    const before = await read($, vendors)
    const meta = before?.providers.find(p => p.name === name)?.modelPools?.find(mp => mp.pool === pool)
    if (!meta) return
    prev = meta.current
    const currentValue = meta.current ?? (meta.allowCliDefault ? 'default' : '')
    if (value === currentValue) return
    started = true
    await update($, savingModels, xs => (xs.includes(key) ? xs : [...xs, key]))
    await applyPoolCurrent($, name, pool, value === 'default' ? null : value)
    const { exitCode, stdout, stderr } = await runRelay($, ['provider', 'model', name, pool, value])
    if (exitCode !== 0) throw new Error(cleanErr(stderr) || cleanErr(stdout) || `失败（退出码 ${exitCode}）`)
    const line = stdout.trim().split('\n').map(s => s.trim()).find(Boolean) ?? ''
    $.ui.toast(line || '已保存默认模型')
    await refreshVendors($)
  } catch (err) {
    if (started) await applyPoolCurrent($, name, pool, prev)
    $.ui.toast(errText(err) || '保存失败')
  } finally {
    savingLock.delete(key)
    await update($, savingModels, xs => xs.filter(k => k !== key))
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

// 打开面板并切到对话页。已经开着就只切页，不把面板关掉
async function openConversation($: Engine) {
  try {
    await update($, tab, () => 'jobs')
    const panes = await $.ui.panes()
    if (!panes.some(p => p.id === PANE)) {
      await $.ui.open({ id: PANE, title: PANE_TITLE })
      void refresh($)
      void refreshVendors($)
    }
    void refreshJobs($)
    void loadAllRounds($)
  } catch {
    // 打不开面板也不影响输入框
  }
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

// 系统自动发起的轮次：去掉首尾空白后，以 <小写字母和连字符组成的标签名> 开头。
// 标签可以直接闭合，也可以先带属性再闭合，例如 <task-notification>、<agent-message from="…">。
const SYSTEM_ROUND_TAG = /^<[a-z]+(?:-[a-z]+)*(?:\s[^>]*)?>/

export function isSystemRoundText(text: string) {
  return SYSTEM_ROUND_TAG.test(String(text ?? '').trim())
}

// 有一边还没结束时，合并后的这一轮也还没结束，Token 窗口保持敞开。
// 两边都结束了，取较晚的那个，把后面系统轮次的耗时算进来。
function laterFinishedAt(a: number | null, b: number | null) {
  if (a == null || b == null) return null
  return Math.max(a, b)
}

// 进行中优先；否则用后并入的那条的状态
function mergedRoundStatus(current: string, incoming: string) {
  if (current === 'running' || incoming === 'running') return 'running'
  return incoming
}

// 桌面版更换底层 sessionId 后，同一条消息会在两个 id 下各记一次，开始时间通常只差几秒到一两分钟
const DEDUPE_WINDOW_MS = 120_000

// 不是用户亲自发的：系统标签，以及没有界面时由后台续上的轮次
function isCarriedRound(round: Round) {
  return isSystemRoundText(round.text) || round.env === 'headless'
}

function mergedRound(base: Round, incoming: Round, startedAt: number): Round {
  return {
    ...base,
    startedAt,
    finishedAt: laterFinishedAt(base.finishedAt, incoming.finishedAt),
    status: mergedRoundStatus(base.status, incoming.status),
    agents: [...(base.agents ?? []), ...(incoming.agents ?? [])],
    selfLines: (base.selfLines ?? 0) + (incoming.selfLines ?? 0),
    ...(base.selfReason || incoming.selfReason ? { selfReason: base.selfReason || incoming.selfReason } : {}),
  }
}

/**
 * 显示用折叠，不改原对象，也不改存储。结果保留输入里存活轮次的顺序。
 * 同一 sessionId 内，系统轮次和 headless 轮次并入它之前最近的用户轮次。
 * 会话里还没有用户轮次时，这些轮次原样留下。
 * sessionGroups 把同一个桌面会话的 sessionId 收成同一个代表 id。
 * 正文相同、开始时间相差不超过 120 秒、且代表 id 相同（或 sessionId 相同）的，只留较早的那条。
 */
export function foldSystemRounds(list: Round[], sessionGroups?: ReadonlyMap<string, string>) {
  const bySession = new Map<string, { round: Round; index: number }[]>()
  list.forEach((round, index) => {
    const key = round.sessionId ?? ''
    const bucket = bySession.get(key)
    const item = { round, index }
    if (bucket) bucket.push(item)
    else bySession.set(key, [item])
  })

  const replaced = new Map<number, Round>()
  const dropped = new Set<number>()

  for (const items of bySession.values()) {
    // 同一时刻的，输入里靠后的视为更早（列表本身是新的在前）
    const chrono = [...items].sort((a, b) => a.round.startedAt - b.round.startedAt || b.index - a.index)
    let lastUser: { round: Round; index: number } | null = null
    for (const item of chrono) {
      if (!isCarriedRound(item.round)) {
        lastUser = { round: replaced.get(item.index) ?? item.round, index: item.index }
        continue
      }
      if (!lastUser) continue
      const merged = mergedRound(lastUser.round, item.round, lastUser.round.startedAt)
      replaced.set(lastUser.index, merged)
      lastUser = { round: merged, index: lastUser.index }
      dropped.add(item.index)
    }
  }

  // 先按会话折完，再跨 sessionId 去掉桌面版换 id 时记下的重复消息
  const byIdentity = new Map<string, { round: Round; index: number }[]>()
  list.forEach((round, index) => {
    if (dropped.has(index)) return
    const current = replaced.get(index) ?? round
    const group = sessionGroups?.get(current.sessionId) || current.sessionId || ''
    // 同组的轮次放一起，下面再按时间窗口和正文相近程度判断是不是同一条消息
    const key = group
    const bucket = byIdentity.get(key)
    const item = { round: current, index }
    if (bucket) bucket.push(item)
    else byIdentity.set(key, [item])
  })

  for (const items of byIdentity.values()) {
    if (items.length < 2) continue
    const chrono = [...items].sort((a, b) => a.round.startedAt - b.round.startedAt || b.index - a.index)
    const first = chrono[0]
    if (!first) continue
    let anchor = first
    for (const item of chrono.slice(1)) {
      if (item.round.startedAt - anchor.round.startedAt > DEDUPE_WINDOW_MS || !sameMessage(anchor.round.text, item.round.text)) {
        anchor = item
        continue
      }
      const longer = item.round.text.length > anchor.round.text.length ? item.round.text : anchor.round.text
      const merged = { ...mergedRound(anchor.round, item.round, anchor.round.startedAt), text: longer }
      replaced.set(anchor.index, merged)
      anchor = { round: merged, index: anchor.index }
      dropped.add(item.index)
    }
  }

  const out: Round[] = []
  list.forEach((round, index) => {
    if (dropped.has(index)) return
    out.push(replaced.get(index) ?? round)
  })
  return out
}

// 把若干 sessionId 收成同一组。每组用其中一个 id 当代表，供折叠时判断是不是同一个桌面会话
export function desktopSessionGroupMap(links: readonly (readonly string[])[]): Map<string, string> {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (true) {
      const next = parent.get(root)
      if (!next || next === root) return root
      root = next
    }
  }
  for (const ids of links) {
    const uniq: string[] = []
    for (const id of ids) {
      if (typeof id !== 'string' || id === '' || uniq.includes(id)) continue
      uniq.push(id)
    }
    const first = uniq[0]
    if (!first || uniq.length < 2) continue
    const root = find(first)
    for (const id of uniq.slice(1)) {
      const other = find(id)
      if (other !== root) parent.set(other, root)
    }
  }
  const out = new Map<string, string>()
  for (const id of parent.keys()) out.set(id, find(id))
  for (const root of out.values()) {
    if (!out.has(root)) out.set(root, root)
  }
  return out
}

// 列表标题：系统轮次不把原始标签露出来
export function roundListTitle(r: Round) {
  if (r.text === '') return '（系统触发的继续）'
  if (isSystemRoundText(r.text)) return '后台任务回报'
  return r.text.replace(/\s+/g, ' ')
}

// 详情里的「你的消息」：被留下的系统轮次同样不展示原始标签；用户原文保持换行
export function roundDetailText(r: Round) {
  if (r.text === '') return '（系统触发的继续）'
  if (isSystemRoundText(r.text)) return '后台任务回报'
  return r.text
}

export { computeRoundTokens, fmtTokens, fmtUsage, readRelayEnabled, setRelayEnabled }

type RunningSubtask = { id: string; name: string; brief: string; startedAt: number }

// 提示条上的任务简述：空白收成一格，最多 12 个字
function briefOf(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  if (chars.length <= BRIEF_CHARS) return flat
  return chars.slice(0, BRIEF_CHARS).join('')
}

function subtaskNameForJob(j: JobView) {
  return modelText(j.provider, j.model).replace(/ · (High|Medium|Low)$/, '')
}

// 归属用的轮次池：全部会话里的轮次，再用本会话内存里的最新值盖掉同 id 的旧副本
function assignmentPool(sessionRounds: Round[], all: Round[] | null | undefined): Round[] {
  if (!all || all.length === 0) return sessionRounds
  const byId = new Map<string, Round>()
  for (const r of all) byId.set(r.id, r)
  for (const r of sessionRounds) byId.set(r.id, r)
  return [...byId.values()]
}

// 本会话还在跑的子代理、Codex 和 relay 外派。外派归属与对话页同一套
function collectRunningSubtasks(sessionRounds: Round[], list: JobView[], sessionId: string, pool?: readonly Round[]): RunningSubtask[] {
  const items: RunningSubtask[] = []
  const seen = new Set<string>()
  for (const r of sessionRounds) {
    if (sessionId && r.sessionId && r.sessionId !== sessionId) continue
    for (const a of r.agents ?? []) {
      if (a.status !== 'running' || seen.has(`a:${a.id}`)) continue
      seen.add(`a:${a.id}`)
      let brief = a.description ?? ''
      if (a.subagentType === CODEX_AGENT) {
        const goal = taskGoal(list.find(j => j.id === a.toolUseId)?.task ?? '')
        if (goal) brief = goal
      }
      items.push({ id: a.id, name: agentText(a).title, brief: briefOf(brief), startedAt: a.startedAt })
    }
    for (const j of jobsOfRound(r, list, pool)) {
      if (j.status !== 'running' || seen.has(`j:${j.id}`)) continue
      seen.add(`j:${j.id}`)
      const started = Date.parse(j.startedAt)
      items.push({
        id: j.id,
        name: subtaskNameForJob(j),
        brief: briefOf(taskGoal(j.task) || ''),
        startedAt: Number.isFinite(started) ? started : r.startedAt,
      })
    }
  }
  items.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  return items
}

function runningBandDetail(items: RunningSubtask[], now: number) {
  const shown = items.slice(0, BAND_SHOW)
  const parts = shown.map(it => [it.name, it.brief, fmtTook(Math.max(0, now - it.startedAt))].filter(Boolean).join(' '))
  const extra = items.length - shown.length
  if (extra > 0) parts.push(`等 ${extra} 个`)
  return parts.join(' · ')
}

// 上次拉到的 jobs 里有进行中的，或本会话还有进行中的轮次/子任务，就每 5 秒拉一次。
// 否则也每 60 秒拉一次：任务若在轮次结束之后才出现，不能因为当时没看见就再也不查。
async function tickRunningBand($: Engine) {
  try {
    const now = await $.clock.now()
    const sessionRounds = await read($, rounds)
    const list = (await read($, jobs)) ?? []
    const pool = assignmentPool(sessionRounds, await read($, allRounds))
    const items = collectRunningSubtasks(sessionRounds, list, currentSessionId, pool)
    const roundOpen = sessionRounds.some(r => r.status === 'running' && (!currentSessionId || !r.sessionId || r.sessionId === currentSessionId))
    const jobsRunning = list.some(j => j.status === 'running')
    const fast = jobsRunning || items.length > 0 || roundOpen
    const fallbackDue = bandPollAt === 0 || now - bandPollAt >= REFRESH_MS
    if (!fast && !fallbackDue) return
    if (items.length > 0) await update($, bandTick, n => n + 1)
    if (bandPollBusy) return
    bandPollBusy = true
    try {
      await refreshJobs($)
      if (items.length === 0) {
        const latest = (await read($, jobs)) ?? []
        const found = collectRunningSubtasks(sessionRounds, latest, currentSessionId, assignmentPool(sessionRounds, await read($, allRounds)))
        if (found.length > 0) await update($, bandTick, n => n + 1)
      }
    } finally {
      bandPollBusy = false
    }
  } catch {
    bandPollBusy = false
  }
}

/** 从 ~/.claude/settings.json 读取 ai-relay 启用状态和插件标识 */
async function readRelayEnabled($: Engine): Promise<{ enabled: boolean; pluginId: string }> {
  let home = ''
  try {
    home = (await $.env.get('HOME')) || HOME
  } catch {
    home = HOME
  }
  if (home && !HOME) HOME = home
  const settingsFile = `${home}/.claude/settings.json`
  try {
    const raw = await $.fs.read(settingsFile)
    const json = JSON.parse(raw)
    const enabledPlugins = json?.enabledPlugins
    if (enabledPlugins && typeof enabledPlugins === 'object') {
      const entry = Object.entries(enabledPlugins).find(([k]) => k.startsWith('ai-relay@') && !k.startsWith('ai-relay-status@'))
      if (entry) {
        const [pluginId, val] = entry
        return {
          enabled: val !== false,
          pluginId,
        }
      }
    }
  } catch {
    // 没找到、读失败、true 均按 true 处理
  }
  return { enabled: true, pluginId: 'ai-relay@zm-local' }
}

let timersStarted = false

/** 启动定时器：防重复注册 */
function startTimers($: Engine) {
  if (timersStarted) return
  timersStarted = true
  $.clock.every(REFRESH_MS, () => {
    void refresh($)
    void refreshJobs($)
    void loadAllRounds($)
  })
  // 时长 5 秒跳一次。回调里才读台账，ui.render 不碰文件
  $.clock.every(BAND_TICK_MS, () => {
    void tickRunningBand($)
  })
}

/** 启停 ai-relay 插件：依次尝试 claude 命令路径，执行 plugin enable/disable */
async function setRelayEnabled($: Engine, on: boolean) {
  const curToggle = await read($, relayToggle)
  if (curToggle?.busy) return
  await update($, relayToggle, () => ({ busy: true }))
  const wasEnabled = await read($, relayEnabled)

  try {
    const { pluginId } = await readRelayEnabled($)
    let home = HOME
    if (!home) {
      try {
        home = (await $.env.get('HOME')) || ''
        if (home) HOME = home
      } catch {}
    }
    const candidates = [
      `${home}/.local/bin/claude`,
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      'claude',
    ]
    const action = on ? 'enable' : 'disable'
    let success = false
    let lastStderr = ''
    for (const bin of candidates) {
      try {
        const res = await $.process.run([bin, 'plugin', action, pluginId], { timeoutMs: 60_000 })
        if (res.exitCode === 0) {
          success = true
          break
        }
        lastStderr = res.stderr || res.stdout || `退出码 ${res.exitCode}`
      } catch (err) {
        lastStderr = String(err instanceof Error ? err.message : err)
      }
    }

    if (!success) {
      const errMsg = (lastStderr || '操作失败').slice(0, 160)
      await update($, relayToggle, () => ({ busy: false, error: errMsg }))
      $.ui.toast(errMsg)
      return
    }

    // exitCode 0 后重新 readRelayEnabled 写回 atom（以文件为准）
    const nextState = await readRelayEnabled($)
    await update($, relayEnabled, () => nextState.enabled)
    const msg = on ? '已启用，重启 Claude Code 后完全生效' : '已停用，重启 Claude Code 后完全生效'
    await update($, relayToggle, () => ({ busy: false, text: msg }))
    $.ui.toast(msg)

    // 由停用切回启用时，本会话立即 refresh、refreshJobs、startTimers
    if (!wasEnabled && nextState.enabled) {
      await refresh($)
      await refreshJobs($)
      startTimers($)
    }
  } catch (err) {
    const errMsg = String(err instanceof Error ? err.message : err).slice(0, 160)
    await update($, relayToggle, () => ({ busy: false, error: errMsg }))
    $.ui.toast(errMsg)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    roundTokenCache.clear()
    timersStarted = false
    await $.command.register({ name: 'relay-bar', description: '打开或关闭 ai-relay 面板（额度 / 任务 / 厂商）' })
    try {
      HOME = (await $.env.get('HOME')) || HOME
    } catch {}
    const { enabled } = await readRelayEnabled($)
    await update($, relayEnabled, () => enabled)
    if (!enabled) {
      $.ui.status(undefined)
      return next(e)
    }
    // 早期版本在底部状态栏放过文字，这里清掉，改由底栏按钮承担
    $.ui.status(undefined)
    initialSurface = e.surface
    try {
      currentSessionId = await $.session.id()
    } catch {}
    try {
      currentCwd = (await $.session.cwd()) || e.cwd || ''
    } catch {
      currentCwd = e.cwd || ''
    }
    // 项目名用会话启动目录，不用 git 根目录；桌面版左侧栏的名字在显示时再按会话 id 映射
    desktopProjectNames = new Map()
    desktopSessionGroups = new Map()
    desktopProjectsReadAt = 0
    bandPollBusy = false
    bandPollAt = 0
    currentProject = { name: dirName(currentCwd) || 'unknown', path: currentCwd }
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
    // 先读一次外派台账，不等到 60 秒后提示条才知道有任务
    await refreshJobs($)
    startTimers($)
    return next(e)
  })

  on('command.run', { command: 'relay-bar' }, async $ => {
    const opened = await togglePane($)
    return { text: opened ? '已打开 ai-relay 面板' : '已关闭 ai-relay 面板' }
  })

  // 主模型每轮开始：记下你的消息和当时的主模型
  on('turn.start', async ($, e, next) => {
    if (!(await read($, relayEnabled))) return next(e)
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
    // 每轮重新取会话目录：桌面版会先在 ~/.claude/spares 临时目录预启动会话，用户选了项目后才切过去，
    // 只用开局时记下的目录会把整段对话记成临时目录
    try {
      const nowCwd = await $.session.cwd()
      if (nowCwd && nowCwd !== currentCwd) {
        currentCwd = nowCwd
        currentProject = { name: dirName(nowCwd) || 'unknown', path: nowCwd }
      }
    } catch {}
    if (!currentProject.name) {
      let cwd = currentCwd
      try {
        cwd = currentCwd || (await $.session.cwd()) || ''
      } catch {
        cwd = currentCwd
      }
      currentProject = { name: dirName(cwd) || 'unknown', path: cwd }
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
    if (!(await read($, relayEnabled))) return next(e)
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
    if (!(await read($, relayEnabled))) return next(e)
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
    if (!(await read($, relayEnabled))) {
      const passed = await next(e)
      // 轮次进行中途停用：把已开始记录的这一轮 / 子代理收尾，免得永远停在"进行中"；不追加汇总行
      const list = await read($, rounds)
      const stale =
        e.agentId !== undefined
          ? list.some(r => r.agents.some(a => a.id === e.agentId && a.status === 'running'))
          : list.some(r => r.status === 'running')
      if (stale) {
        const now = await $.clock.now()
        await update($, rounds, all =>
          e.agentId !== undefined
            ? all.map(r => ({ ...r, agents: r.agents.map(a => (a.id === e.agentId ? { ...a, status: AGENT_END[e.reason] ?? 'done', finishedAt: now } : a)) }))
            : all.map(r => (r.status === 'running' ? { ...r, status: e.reason, finishedAt: now } : r)),
        )
        await saveRounds($)
      }
      return passed
    }
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
    const selfStat = await readSelfStat($, currentSessionId)
    let done: Round | undefined
    await update($, rounds, all => {
      const idx = all.findIndex(r => r.status === 'running')
      if (idx < 0) return all
      done = { ...all[idx]!, status: e.reason, finishedAt: now }
      // 用户消息开始的这一轮：行数取 relay 钩子的统计（含 Bash 写入），并带上主管自己做的原因
      if (selfStat && !isCarriedRound(done)) {
        done = {
          ...done,
          selfLines: Math.max(done.selfLines ?? 0, selfStat.lines),
          ...(selfStat.reason ? { selfReason: selfStat.reason } : {}),
        }
      }
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

  // 输入框正上方：本会话还有子任务在跑时显示一行，没有就让出这块，不占位
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (!(await read($, relayEnabled))) return next(e)
      // 问卷占着这块时让开，不盖住它
      if (e.props.hasSurvey) return next(e)
      // 订阅节拍。没有进行中的子任务时计数不动，这里不会跟着重绘
      await read($, bandTick)
      const now = await $.clock.now()
      const sessionRounds = await read($, rounds)
      const items = collectRunningSubtasks(sessionRounds, (await read($, jobs)) ?? [], currentSessionId, assignmentPool(sessionRounds, await read($, allRounds)))
      if (items.length === 0) return next(e)
      const els = $.ui.resolve(e)
      const { Box, Text } = els
      // 没有按钮的界面（类型表里没给 Button）只留文字
      const Button = 'Button' in els ? els.Button : null
      return (
        <Box flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={1} minWidth={0}>
          <Box flexDirection="row" flexWrap="nowrap" alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="caption" weight="medium" wrap="truncate-end">{`⏳ ${items.length}`}</Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text size="caption" dimColor wrap="truncate-end">{` 个子任务进行中 · ${runningBandDetail(items, now)}`}</Text>
            </Box>
          </Box>
          {Button ? (
            <Box flexShrink={0}>
              <Button key="relay-running-view" label="查看" dimColor onPress={() => openConversation($)} />
            </Box>
          ) : null}
        </Box>
      )
    } catch {
      return next(e)
    }
  })

  // 输入框底栏右侧放一个小按钮，显示当前模式，点击打开面板
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const isRelayEnabled = await read($, relayEnabled)
    const snap = isRelayEnabled ? await read($, snapshot) : null
    const { Box, Button, Text } = $.ui.resolve(e)
    // 只显示名称和模式，不加图标；休眠时显示已停用，各家额度在面板里看
    const label = !isRelayEnabled ? 'ai-relay · 已停用' : snap ? `ai-relay · ${MODE_TEXT[snap.mode]}` : 'ai-relay'
    return (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Button key="relay-quota" label={label} dimColor onPress={() => togglePane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const isRelayEnabled = await read($, relayEnabled)
    const toggle = await read($, relayToggle)
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // 有 Svg 的界面（桌面、编辑器、手机）画额度条，终端用字符
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : null
    // 手机端没有输入框和下拉框，新增厂商只能在桌面端或终端里做
    const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : null
    const Select = e.surface !== 'mobile' && 'Select' in els ? els.Select : null

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

    const enableLabel = toggle?.busy && !isRelayEnabled ? '启用…' : '启用'
    const disableLabel = toggle?.busy && isRelayEnabled ? '停用…' : '停用'
    const switchSection = (
      <Box flexDirection="column" rowGap={1}>
        {section('总开关')}
        <Box flexDirection="row" columnGap={1}>
          <Button
            key="relay-switch-enable"
            label={enableLabel}
            variant={isRelayEnabled ? 'primary' : 'secondary'}
            onPress={() => (isRelayEnabled || toggle?.busy ? undefined : setRelayEnabled($, true))}
          />
          <Button
            key="relay-switch-disable"
            label={disableLabel}
            variant={!isRelayEnabled ? 'primary' : 'secondary'}
            onPress={() => (!isRelayEnabled || toggle?.busy ? undefined : setRelayEnabled($, false))}
          />
        </Box>
        <Text size="caption" dimColor>
          {isRelayEnabled
            ? 'ai-relay 正在工作：外派任务、注入提示、记录对话和用量'
            : '已停用：不再外派、不注入提示、不记录对话；重启 Claude Code 后完全生效'}
        </Text>
        {toggle?.error && (
          <Text size="caption" color="error">
            {toggle.error}
          </Text>
        )}
        {toggle?.text && (
          <Text size="caption" color="success">
            {toggle.text}
          </Text>
        )}
      </Box>
    )

    // 休眠时不管 tab，面板只渲染"总开关"节 + 一行"重新启用后，其他页面在重启 Claude Code 后恢复"，不显示 tabs、不读 snapshot
    if (!isRelayEnabled) {
      return (
        <Box flexDirection="column" rowGap={1} paddingX={1}>
          {switchSection}
          <Text size="caption" dimColor>
            重新启用后，其他页面在重启 Claude Code 后恢复
          </Text>
        </Box>
      )
    }

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
              if (key === 'vendors') {
                await refreshVendors($)
                void loadModels($, false)
              }
            }}
          />
        ))}
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
      if (snap === null) return page(switchSection, <Text dimColor>正在读取额度…</Text>)
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
        switchSection,
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
      await loadDesktopProjects($)
      const list = (await read($, jobs)) ?? []
      let allRoundsVal = await read($, allRounds)
      if (allRoundsVal === null) {
        await loadAllRounds($)
        allRoundsVal = await read($, allRounds)
      }
      // 系统轮次、后台续跑和换 sessionId 的重复记录只在显示时折叠，计数和「最近 40 轮」都按折叠后的算
      const allRoundsList = foldSystemRounds(allRoundsVal ?? [], desktopSessionGroups)
      const filter = (await read($, roundFilter)) ?? { project: null }
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
        const name = projectName(r.project, r.sessionId)
        projectCounts.set(name, (projectCounts.get(name) ?? 0) + 1)
      }
      const projectOptions: SelectOption[] = [
        { label: '全部项目', value: '' },
        ...Array.from(projectCounts.entries()).map(([name, count]) => ({
          label: `${name}（${count}）`,
          value: name,
        })),
      ]
      // 筛选值对不上任何项目（例如项目名规则改过后残留的旧名）时按「全部项目」处理，不显示空列表
      const wantedProject = filter.project ?? (currentProject.path || currentSessionId ? projectName(currentProject, currentSessionId) : '')
      const activeProject = projectCounts.has(wantedProject) ? wantedProject : ''
      const filteredRounds = allRoundsList.filter(r => !activeProject || projectName(r.project, r.sessionId) === activeProject)
      const hasMore = filteredRounds.length > 40
      const displayedRounds = filteredRounds.slice(0, 40)
      const grouped: { title: string; rounds: Round[] }[] = []
      for (const r of displayedRounds) {
        const title = fmtDateGroup(r.startedAt, now)
        const last = grouped[grouped.length - 1]
        if (last && last.title === title) last.rounds.push(r)
        else grouped.push({ title, rounds: [r] })
      }
      // 不属于任何一轮的外派。Codex 由子代理覆盖，已经归进某轮的不重复列出
      const inRounds = new Set(allRoundsList.flatMap(r => jobsOfRound(r, list, allRoundsList).map(j => j.id)))
      const earliest = allRoundsList.length ? Math.min(...allRoundsList.map(r => r.startedAt)) : Number.POSITIVE_INFINITY
      const others = list.filter(j => !inRounds.has(j.id) && !(j.provider === 'codex' && Date.parse(j.startedAt) >= earliest))

      const statusOf = (s: string) => JOB_STATUS[s] ?? { icon: '·', text: s, tone: 'none' as Tone }
      // 右侧状态：没结束看运行状态；结束了只认主管记的结论
      const outcome = (status: string, verdict: string | null) => {
        if (status !== 'done') return statusOf(status)
        return verdict ? VERDICT[verdict] ?? statusOf(status) : { icon: '○', text: '完成 · 等主管验收', tone: 'warning' as Tone }
      }
      // 轮次「完成」后面的未记结论用次要文字，不跟状态色走
      const roundMark = (st: { icon: string; text: string; tone: Tone; pendingVerdicts: number }, label?: string) => {
        const text = label ?? st.text
        const note = text === '完成' && st.pendingVerdicts > 0 ? ` · ${st.pendingVerdicts} 个子任务未记验收结论` : ''
        return (
          <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1} minWidth={0}>
            {badge(st.icon, text, st.tone)}
            {note !== '' && (
              <Text size="caption" dimColor wrap="truncate-end">
                {note}
              </Text>
            )}
          </Box>
        )
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
          const st = roundShownStatus(r, list, allRoundsList)
          const waiting = r.status !== 'running' && st.running > 0
          const elapsed = roundElapsed(r, waiting, now)
          const took = elapsed == null ? '' : `用时 ${fmtTook(elapsed)}`
          const headLabel = waiting ? `等子任务（${st.running} 个进行中）` : st.text
          const headText = [`◆ ${projectName(r.project, r.sessionId)}`, fmtTime(r.startedAt), took].filter(Boolean).join(' · ')
          const message = roundDetailText(r)
          const rj = jobsOfRound(r, list, allRoundsList)
          const tokenRows = await getRoundTokens($, r, list, allRoundsList)
          return page(
            backButton,
            <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1} minWidth={0}>
              <Box flexShrink={1} minWidth={0}>
                <Text wrap="wrap">{headText}</Text>
              </Box>
              {roundMark(st, headLabel)}
            </Box>,
            field('你的消息', message, { wrap: 'wrap' }),
            field('主管', `${mainModelText(r.mainModel)} · 统筹拆解、派发、核验、汇报`),
            !!r.selfReason && field('自己做的原因', r.selfReason, { wrap: 'wrap' }),
            cardSummary(r, list, allRoundsList) !== '' && field('分工', cardSummary(r, list, allRoundsList)),
            <Box flexDirection="column" rowGap={1}>
              {section('Token 消耗')}
              <Box flexDirection="column" rowGap={0} minWidth={0}>
                {[{ label: '模型', usage: null }, ...tokenRows].map((row, idx) => {
                  const extra = row as RoundTokenRow & { live?: boolean; emptyText?: string }
                  const weight = idx === 0 || row.label === '合计' ? 'bold' : undefined
                  return (
                    <Box key={`token-row-${idx}`} flexDirection="row" columnGap={1} minWidth={0}>
                      <Box flexGrow={1} flexShrink={1} minWidth={0}>
                        <Text size="footnote" weight={weight} wrap="wrap">{`${row.label}${extra.live ? '（进行中）' : ''}`}</Text>
                      </Box>
                      {idx === 0 || row.usage ? (
                        (idx === 0 ? ['输入', '输出', '缓存读'] : [row.usage!.input, row.usage!.output, row.usage!.cacheRead].map(fmtTokens)).map((value, col) => (
                          <Box key={`token-cell-${idx}-${col}`} width={8} flexShrink={0} justifyContent="flex-end" flexDirection="row">
                            <Text size="footnote" weight={weight} tabular>{value}</Text>
                          </Box>
                        ))
                      ) : (
                        <Box width={26} flexShrink={0}>
                          <Text size="footnote" dimColor wrap="wrap">{extra.emptyText || '无数据'}</Text>
                        </Box>
                      )}
                    </Box>
                  )
                })}
              </Box>
            </Box>,
            ...r.agents.map(agentCard),
            ...rj.map(jobCard),
          )
        }
      }

      const roundItem = (r: Round) => {
        const st = roundShownStatus(r, list, allRoundsList)
        const waiting = r.status !== 'running' && st.running > 0
        const elapsed = roundElapsed(r, waiting, now)
        const took = elapsed == null ? '' : fmtTook(elapsed)
        const timeText = took ? `${fmtClockTime(r.startedAt)} · ${took}` : fmtClockTime(r.startedAt)
        const title = roundListTitle(r)
        return (
          <Box key={`round-${r.id}`} flexDirection="column" minWidth={0}>
            <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1} minWidth={0}>
              <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1} minWidth={0}>
                <Text size="caption" color="suggestion" wrap="truncate-end">
                  ◆ {projectName(r.project, r.sessionId)}
                </Text>
                <Text size="caption" dimColor tabular wrap="truncate-end">
                  {timeText}
                </Text>
              </Box>
              <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
                {roundMark(st)}
                <Button key={`open-${r.id}`} label="详情 ›" dimColor onPress={() => update($, selectedRound, () => r.id)} />
              </Box>
            </Box>
            <Text weight="semibold" wrap="truncate-end">
              {title}
            </Text>
            <Text size="caption">{staffLine(r, list, allRoundsList)}</Text>
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
            value={activeProject}
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
    // 模型清单在后台取，不挡住厂商卡片
    const modelsView = await read($, modelCatalog)
    const savingNow = await read($, savingModels)
    if (modelsView.status === 'idle') void loadModels($, false)
    const data = await read($, vendors)
    if (data === null) return page(noticeBar, <Text dimColor>正在读取厂商…</Text>)
    const f = await read($, form)
    const pendingRemove = await read($, confirmRemove)
    const roleText = (keys: string[]) => keys.map(k => data.roles.find(r => r.key === k)?.text ?? k).join(' · ') || '不参与自动派活'
    const busyLabel = (key: string, text: string) => (busyKey === key ? `${text}…` : text)

    // 默认模型：标题一行（刷新、更新时间），每个额度池一行下拉和一句说明
    const modelsAgo = fmtAgo(modelsView.catalog?.updatedAt ?? '', now)
    const modelSection = (v: Vendor) => {
      const pools = v.modelPools ?? []
      const entry = modelsView.catalog?.providers?.[v.name]
      const problem = catalogProblem(modelsView, v.name)
      const waiting = !modelsView.catalog && (modelsView.status === 'idle' || modelsView.status === 'loading')
      return (
        <Box key={`model-block-${v.name}`} flexDirection="column" rowGap={0}>
          <Text size="caption" dimColor>
            默认模型
          </Text>
          {pools.map(pool => {
            // 单池厂商的区块标题已经是「默认模型」，下拉不再重复标题
            const rowTitle = pools.length === 1 ? undefined : pool.label
            const options = poolOptions(pool, entry)
            const rowSaving = savingNow.includes(`${v.name}:${pool.pool}`)
            return (
              <Box key={`model-row-${v.name}-${pool.pool}`} flexDirection="column">
                {waiting ? (
                  <Box flexDirection="row" columnGap={1} alignItems="center" minWidth={0}>
                    {pools.length > 1 && (
                      <Text size="caption" dimColor>
                        {pool.label}
                      </Text>
                    )}
                    <Text size="caption" dimColor>
                      正在获取模型列表…
                    </Text>
                  </Box>
                ) : Select && !rowSaving ? (
                  <Select
                    key={`model-${v.name}-${pool.pool}`}
                    label={rowTitle}
                    options={options}
                    value={poolValue(pool, options)}
                    onSelect={(picked: string) => void setPoolModel($, v.name, pool.pool, picked)}
                  />
                ) : (
                  <Box flexDirection="column">
                    {pools.length > 1 && (
                      <Text size="caption" dimColor>
                        {pool.label}
                      </Text>
                    )}
                    <Text size="footnote">{`默认模型：${poolCurrentLabel(pool, entry)}`}</Text>
                  </Box>
                )}
                <Text size="caption" dimColor wrap="wrap">
                  {poolUsage(data.roles ?? [], pool)}
                </Text>
              </Box>
            )
          })}
          {problem !== '' && (
            <Text size="caption" dimColor wrap="wrap">
              {problem}
            </Text>
          )}
        </Box>
      )
    }

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
        (v.modelPools?.length ?? 0) > 0 && modelSection(v),
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
          {f.preset === 'custom' && formInput('promptArgs', '提示参数', '必须含 {prompt}，如 -p {prompt}')}
          {f.preset === 'custom' && formInput('modelArgs', '模型参数', '如 --model {model}')}
          {f.preset === 'custom' && formInput('readArgs', '只读参数', '如 --approval-mode plan')}
          {f.preset === 'custom' && formInput('writeArgs', '可写参数', '如 --approval-mode auto-edit')}
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
      // 统计和模型清单刷新放在页首同一行：刷新会更新全部厂商，按钮只放一个
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} minWidth={0}>
        <Text size="caption" dimColor>
          {data.providers.length} 家 · 启用 {enabledCount} 家 · 最高权限开启 {accessCount} 家
        </Text>
        <Box flexDirection="row" columnGap={1} alignItems="center">
          {modelsAgo !== '' && (
            <Text size="caption" dimColor>
              {`模型列表${modelsAgo}`}
            </Text>
          )}
          <Button
            key="models-refresh"
            label={modelsView.status === 'refreshing' ? '刷新中…' : '刷新模型列表'}
            dimColor
            onPress={() => {
              if (modelsView.status === 'loading' || modelsView.status === 'refreshing') return
              void loadModels($, true)
            }}
          />
        </Box>
      </Box>,
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

// 项目显示名。桌面版按会话 id 用左侧栏的 originCwd 末级名；
// 对不上的（终端里跑的）用记录里的启动目录，不用 git 根目录名。
// 没选文件夹的临时目录（spares、scratch-workspaces）统一显示成「本电脑」
function projectName(p?: { name?: string; path?: string }, sessionId?: string) {
  if (sessionId) {
    const mapped = desktopProjectNames.get(sessionId)
    if (mapped) return mapped
  }
  if (p?.path) {
    const label = folderLabel(p.path)
    if (label) return label
  }
  return p?.name || 'unknown'
}

// relay 钩子每条用户消息重置的本轮统计：lines 含 Edit/Write 和 Bash 写入；decision 为 self 时 selfReason 是「relay self」记下的原因。
// 文件不在或读不了返回 null，沿用面板自己的计数
async function readSelfStat($: Engine, sessionId: string): Promise<{ lines: number; reason: string } | null> {
  if (!HOME || !sessionId) return null
  try {
    const data = JSON.parse(await $.fs.read(`${HOME}/.claude/ai-relay/prompts/${sessionId}.edits.json`)) as Record<string, unknown>
    const lines = typeof data.lines === 'number' && data.lines > 0 ? Math.round(data.lines) : 0
    const reason = data.decision === 'self' && typeof data.selfReason === 'string' ? data.selfReason.trim() : ''
    return { lines, reason }
  } catch {
    return null
  }
}

function desktopSessionsDir() {
  return `${HOME}/Library/Application Support/Claude/claude-code-sessions`
}

// 打开对话页时读一次。距上次不足 60 秒就用缓存；这次失败保留上次读到的映射
async function loadDesktopProjects($: Engine) {
  if (!HOME) return
  let now = 0
  try {
    now = await $.clock.now()
  } catch {
    now = Date.now()
  }
  if (desktopProjectsReadAt !== 0 && now - desktopProjectsReadAt < REFRESH_MS) return
  desktopProjectsReadAt = now
  try {
    const next = await readDesktopProjects($)
    if (next) {
      desktopProjectNames = next.names
      desktopSessionGroups = next.groups
    }
  } catch {
    // 整次读取失败，沿用上次的映射
  }
}

// 扫桌面版会话目录 */*/local_*.json。目录本身读不到时返回 null，调用方保留旧映射
async function readDesktopProjects($: Engine): Promise<{ names: Map<string, string>; groups: Map<string, string> } | null> {
  const root = desktopSessionsDir()
  let projects: FsEntry[]
  try {
    projects = await $.fs.list(root)
  } catch {
    return null
  }
  const map = new Map<string, string>()
  const links: string[][] = []
  for (const project of projects) {
    if (project.kind !== 'dir') continue
    const projectDir = `${root}/${project.name}`
    let sessions: FsEntry[]
    try {
      sessions = await $.fs.list(projectDir)
    } catch {
      continue
    }
    for (const session of sessions) {
      if (session.kind !== 'dir') continue
      const sessionDir = `${projectDir}/${session.name}`
      let files: FsEntry[]
      try {
        files = await $.fs.list(sessionDir)
      } catch {
        continue
      }
      for (const file of files) {
        if (file.kind !== 'file' || !file.name.startsWith('local_') || !file.name.endsWith('.json')) continue
        try {
          addDesktopSession(map, links, await $.fs.read(`${sessionDir}/${file.name}`))
        } catch {
          // 单个文件失败就跳过
        }
      }
    }
  }
  return { names: map, groups: desktopSessionGroupMap(links) }
}

// 只取 cliSessionId、priorCliSessionIds、originCwd。项目名进 names，同一桌面会话的 id 进 links
function addDesktopSession(map: Map<string, string>, links: string[][], text: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
  const rec = parsed as Record<string, unknown>
  const originCwd = rec.originCwd
  const cliSessionId = rec.cliSessionId
  const priorCliSessionIds = rec.priorCliSessionIds
  const ids: string[] = []
  if (typeof cliSessionId === 'string' && cliSessionId !== '') ids.push(cliSessionId)
  if (Array.isArray(priorCliSessionIds)) {
    for (const id of priorCliSessionIds) {
      if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id)
    }
  }
  if (ids.length >= 2) links.push(ids)
  if (typeof originCwd !== 'string' || originCwd === '') return
  const name = folderLabel(originCwd)
  if (!name) return
  for (const id of ids) map.set(id, name)
}

// 没选文件夹的会话（spares 预热目录、桌面版 scratch-workspaces 临时目录）和左侧栏一样归到「本电脑」；
// 其他路径取末级目录名
function folderLabel(path: string) {
  if (/\/\.claude\/spares\//.test(path)) return '本电脑'
  if (/\/Claude\/scratch-workspaces\//.test(path)) return '本电脑'
  return dirName(path)
}

// 桌面版换 sessionId 时会把同一条消息再记一次，两份正文可能只是结尾不同（一份是另一份的前缀，或后半截被改过）。
// 完全相同，或较短的一份至少 20 字且前 90% 都与另一份相同，视为同一条消息
function sameMessage(a: string, b: string) {
  if (a === b) return true
  const shorter = Math.min(a.length, b.length)
  if (shorter < 20) return false
  let common = 0
  while (common < shorter && a[common] === b[common]) common++
  return common >= shorter * 0.9
}
