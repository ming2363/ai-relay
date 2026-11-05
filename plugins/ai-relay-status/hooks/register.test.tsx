import { expect, test } from 'claude-code/testing'
import type { Round } from '../types'

type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const FOOTER = {
  plugin: 'ai-relay-status',
  component: 'SessionMode',
  props: { modes: [] as string[] },
} as const

const PANE = {
  plugin: 'ai-relay-status',
  component: 'Pane',
  requestId: 'relay-quota',
  props: {
    title: 'ai-relay',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })

// relay status --json 的最小样例：手动模式，Codex 偏低，Argon 耗尽，Grok 已停用
function statusJson(mode: string, grokEnabled: boolean, claudeWins?: unknown[]) {
  return JSON.stringify({
    mode,
    quotaAvailable: true,
    pools: [
      // 故意乱序，验证额度页按固定顺序排列
      { name: 'agy', pool: 'gemini-argon', level: 'blocked', enabled: true, limitingResetAt: 1793807912000, windows: [{ key: 'weekly', remaining: 0 }] },
      { name: 'grok', pool: 'supergrok-weekly', level: 'ok', enabled: grokEnabled, source: 'AIQuota5h', windows: [{ key: 'weekly', remaining: 0.89 }] },
      { name: 'claude', pool: 'claude-subscription', level: 'ok', enabled: true, windows: claudeWins ?? [{ key: 'weekly', remaining: 0.55 }, { key: '5h', remaining: 0.77 }] },
      { name: 'codex', pool: 'codex', level: 'low', enabled: true, windows: [{ key: '5h', remaining: 0.78 }, { key: 'weekly', remaining: 0.28 }] },
    ],
  })
}

function providersJson(grokEnabled: boolean, extra: string[] = [], access: Record<string, boolean> = {}) {
  const fullAccess = (name: string, via: string) => {
    if (via === 'self') return { supported: false, enabled: false, note: '主模型的权限在输入框的模式菜单里设置' }
    if (via === 'codex-plugin') return { supported: false, enabled: false, note: '由 Codex 插件固定为只能写当前项目的沙箱' }
    return { supported: true, enabled: access[name] ?? false, note: '' }
  }
  const v = (name: string, label: string, via: string, enabled: boolean, roles: string[]) => ({
    name, label, via, enabled,
    canDisable: via !== 'self', canRemove: via === 'relay', canTest: via === 'relay',
    bin: name, binFound: name !== 'kimi', roles, note: name === 'kimi' ? '只读靠计划模式' : '',
    fullAccess: fullAccess(name, via),
  })
  return JSON.stringify({
    providers: [
      v('claude', 'Claude Pro（主控）', 'self', true, []),
      v('codex', 'Codex · ChatGPT Plus', 'codex-plugin', true, ['implement']),
      v('grok', 'SuperGrok', 'relay', grokEnabled, ['review', 'read']),
      ...extra.map(n => v(n, `${n} 会员`, 'relay', true, ['read'])),
    ],
    roles: [{ key: 'implement', text: '实现' }, { key: 'review', text: '审查' }, { key: 'read', text: '阅读' }],
    presets: {
      kimi: { title: 'Kimi Code CLI', label: 'Kimi 会员', bin: 'kimi', install: '装 kimi', cli: { prompt: ['--quiet', '-p', '{prompt}'], model: ['-m', '{model}'], read: ['--plan'], write: [], cwd: ['-w', '{cwd}'] }, models: ['default'], roles: ['read', 'review'], note: '只读靠计划模式' },
      qwen: { title: 'Qwen Code', label: '通义千问会员', bin: 'qwen', install: '', cli: { prompt: ['-p', '{prompt}'], model: ['-m', '{model}'], read: ['--approval-mode', 'plan'], write: ['--approval-mode', 'auto-edit'], cwd: null }, models: ['default'], roles: ['read'], note: '' },
      custom: { title: '自定义', label: '', bin: '', install: '', cli: { prompt: ['-p', '{prompt}'], model: ['--model', '{model}'], read: [], write: [], cwd: null }, models: ['default'], roles: ['read'], note: '' },
    },
  })
}

/** 模拟 relay：记录调用，按子命令返回结果，并维护 grok 启停与新增厂商 */
function fakeRelay(on: TestOn) {
  const state = { mode: 'manual', grok: true, added: [] as string[], calls: [] as string[][], jobs: '[]', claudeWins: undefined as unknown[] | undefined, access: { grok: true } as Record<string, boolean> }
  on('process.run', (_, e) => {
    const argv = [...e.argv].slice(2)
    state.calls.push(argv)
    const [cmd, sub, arg] = argv
    if (cmd === 'status') return ok(statusJson(state.mode, state.grok, state.claudeWins))
    if (cmd === 'quota') return ok('')
    if (cmd === 'jobs') return ok(state.jobs)
    if (cmd === 'providers') return ok(providersJson(state.grok, state.added, state.access))
    if (cmd === 'mode') {
      state.mode = sub ?? state.mode
      return ok('')
    }
    if (cmd === 'provider' && (sub === 'disable' || sub === 'enable')) {
      state.grok = sub === 'enable'
      return ok(`SuperGrok 已${sub === 'enable' ? '启用' : '停用'}`)
    }
    if (cmd === 'provider' && sub === 'add') {
      const spec = JSON.parse(argv[3] ?? '{}') as { name: string }
      if (!spec.name) return fail('ai-relay 错误：标识只能用小写字母、数字和短横线')
      state.added.push(spec.name)
      return ok(`已添加 ${spec.name}`)
    }
    if (cmd === 'provider' && sub === 'remove') {
      state.added = state.added.filter(n => n !== arg)
      return ok('')
    }
    if (cmd === 'provider' && sub === 'access') {
      const name = arg ?? ''
      const turnOn = argv[3] === 'on'
      state.access[name] = turnOn
      return ok(turnOn ? `已开启 ${name} 的最高权限` : `已关闭 ${name} 的最高权限`)
    }
    return fail('unknown')
  })
  return state
}

let storeMap = new Map<string, unknown>()

// 测试用的家目录，由 env.get('HOME') 提供
const TEST_HOME = '/home/tester'
const ROUNDS_DIR = `${TEST_HOME}/.claude/ai-relay/rounds`
type StoredFile = { text: string; mtimeMs: number }
// 内存版共享目录：路径对应文件内容和修改时间
let fileMap = new Map<string, StoredFile>()

function putRoundFile(sessionId: string, rounds: unknown, mtimeMs: number) {
  fileMap.set(`${ROUNDS_DIR}/${sessionId}.json`, { text: JSON.stringify(rounds), mtimeMs })
}

function baseStubs(on: TestOn, opened = new Set<string>(), now: () => number = () => 1793712984000, storeEntries?: Record<string, unknown>) {
  // 内存版 $.store：测试可以直接读回插件写入的值
  storeMap = new Map(Object.entries(storeEntries ?? {}))
  fileMap = new Map()
  on('store.get', (_, e) => ({ value: storeMap.get(e.key) }))
  on('store.set', (_, e) => (storeMap.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', (_, e) => (storeMap.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...storeMap.keys()] }))
  let curCwd = '/projects/fj'
  let curSurface: string | null = 'desktop'
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? TEST_HOME : undefined }))
  on('fs.read', (_, e) => {
    // relay 的安装记录：任意市场来源的 ai-relay
    if (e.path === `${TEST_HOME}/.claude/plugins/installed_plugins.json`) {
      return { value: JSON.stringify({ plugins: { 'ai-relay@test-market': [{ installPath: '/opt/ai-relay' }] } }) }
    }
    if (e.path.startsWith(`${ROUNDS_DIR}/`)) {
      const hit = fileMap.get(e.path)
      return { value: hit ? hit.text : '{}' }
    }
    return { value: '{}' }
  })
  on('fs.write', (_, e) => {
    fileMap.set(e.path, { text: e.text, mtimeMs: now() })
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: fileMap.has(e.path) }))
  on('fs.list', (_, e) => {
    const prefix = e.path.endsWith('/') ? e.path : `${e.path}/`
    const value = [...fileMap.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, file]) => ({
        name: path.slice(prefix.length),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      }))
    return { value }
  })
  on('clock.now', () => ({ value: now() }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'relay-bar' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    opened.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    opened.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...opened].map(id => ({ id, title: '', isShown: true, isFocused: false, isPlaced: true })) }))
  on('session.id', () => ({ value: 's-cur' }))
  on('session.cwd', () => ({ value: curCwd }))
  on('session.repo', () => ({ value: { root: '/projects/fj', remote: null, internal: false, name: 'fj' } }))
  on('session.surfaces', () => ({ value: curSurface ? [curSurface as 'desktop'] : [] }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [{ kind: 'five_hour', percentUsed: 53, resetsAt: '2026-11-04T09:00:00Z' }] },
  }))
  on('session.start', (_, e) => {
    if (e.cwd) curCwd = e.cwd
    if (e.surface !== undefined) curSurface = e.surface
    return { cwd: e.cwd }
  })
  return opened
}

type DrawnNode = {
  type?: string
  key?: string
  props?: Record<string, unknown>
  hover?: { display?: string }
  text?: string
  children?: unknown[]
}

function asDrawn(value: unknown): DrawnNode | null {
  if (!value || typeof value !== 'object') return null
  return value as DrawnNode
}

function collectText(node: unknown): string {
  if (typeof node === 'string') return node
  const el = asDrawn(node)
  if (!el) return ''
  const parts: string[] = []
  if (typeof el.text === 'string') parts.push(el.text)
  for (const child of el.children ?? []) parts.push(collectText(child))
  return parts.join('\n')
}

// 跳过 display:none，只看收起时屏幕上有的字
function visibleTexts(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  const el = asDrawn(node)
  if (!el || el.props?.display === 'none') return []
  const out: string[] = []
  if (typeof el.text === 'string' && el.text) out.push(el.text)
  for (const child of el.children ?? []) out.push(...visibleTexts(child))
  return out
}

function walkDrawn(node: unknown, visit: (el: DrawnNode) => void) {
  const el = asDrawn(node)
  if (!el) return
  if (el.type) visit(el)
  for (const child of el.children ?? []) walkDrawn(child, visit)
}

function visibleNodes(node: unknown, out: DrawnNode[] = []) {
  if (typeof node === 'string') return out
  const el = asDrawn(node)
  if (!el || el.props?.display === 'none') return out
  if (el.type) out.push(el)
  for (const child of el.children ?? []) visibleNodes(child, out)
  return out
}

async function shownIncludes(ui: { drawn: () => Promise<unknown> }, needle: string | RegExp) {
  return visibleTexts(await ui.drawn()).some(text => (typeof needle === 'string' ? text.includes(needle) : needle.test(text)))
}

function nodeKey(el: DrawnNode) {
  if (typeof el.key === 'string') return el.key
  const key = el.props?.key
  return typeof key === 'string' ? key : ''
}

// 操作行：justify 为两端对齐，且删除按钮是这一行的直接子节点
function actionRowOf(node: unknown, buttonKey: string): DrawnNode | null {
  let found: DrawnNode | null = null
  const visit = (current: unknown): boolean => {
    const el = asDrawn(current)
    if (!el) return false
    const children = el.children ?? []
    const direct = children.some(child => {
      const drawn = asDrawn(child)
      return drawn?.type === 'Button' && nodeKey(drawn) === buttonKey
    })
    if (el.type === 'Box' && el.props?.justifyContent === 'space-between' && direct) {
      found = el
      return true
    }
    return children.some(child => visit(child))
  }
  visit(node)
  return found
}

test('底栏按钮只显示名称和模式，点击打开 / 关闭面板', async ($, on) => {
  const opened = baseStubs(on)
  fakeRelay(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const footer = await $.ui.mount({ ...FOOTER, surface })
    expect((await footer.find({ type: 'Button', key: 'relay-quota' }))?.props.label).toBe('ai-relay · 手动')
    await footer.unmount()
  }
  const footer = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  await footer.press({ key: 'relay-quota' })
  expect(opened.has('relay-quota')).toBe(true)
  await footer.press({ key: 'relay-quota' })
  expect(opened.has('relay-quota')).toBe(false)
  await footer.unmount()
})

test('额度页：按会员分组的固定顺序、每个窗口一条额度条、停用的置灰', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  relay.grok = false
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const names = (await ui.findAll({ type: 'Text', text: /^(Claude|Codex|Gemini 4 Argon|Grok)$/ })).map(t => t.text)
  expect(names).toEqual(['Claude', 'Codex', 'Gemini 4 Argon', 'Grok'])
  // 状态用图标 + 文字，不只靠颜色
  expect(await ui.find({ type: 'Text', text: '▲ 偏低' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✕ 不派' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '⏸ 已停用' })).toBeDefined()
  // Claude 两个窗口 + Codex 两个 + Argon 一个 = 5 条额度条；停用的 Grok 不画
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(5)
  expect(await ui.find({ type: 'Text', text: '28%' })).toBeDefined()
  await ui.unmount()

  // 终端没有 Svg，用字符画额度条
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /^█+░+$/ })).toBeDefined()
  await term.unmount()
})

test('额度页切换模式，并显示当前模式的说明', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^只在你点名时派活/ })).toBeDefined()
  await ui.press({ key: 'mode-auto' })
  expect(relay.calls.some(a => a[0] === 'mode' && a[1] === 'auto')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^主模型当主管，统筹拆解、派发、核验和汇报/ })).toBeDefined()
  await ui.unmount()
})

test('厂商页：停用 Grok、两步删除、按模板新增', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  relay.added = ['kimi']
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-vendors' })
  // 主控不能停用、Codex 不能删除
  expect(await ui.find({ type: 'Button', key: 'toggle-claude' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'remove-codex' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '★ 主模型' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '官方 CLI · kimi · 未安装' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '官方 CLI · kimi · 未安装' }))?.props.color).toBe('warning')

  await ui.press({ key: 'toggle-grok' })
  expect(relay.calls.some(a => a.join(' ') === 'provider disable grok')).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'toggle-grok' }))?.props.label).toBe('启用')
  expect(await ui.find({ type: 'Text', text: /SuperGrok 已停用/ })).toBeDefined()

  // 删除要点两次
  await ui.press({ key: 'remove-kimi' })
  expect(relay.calls.some(a => a[1] === 'remove')).toBe(false)
  expect(await ui.find({ type: 'Text', text: '确定删除 kimi 会员？' })).toBeDefined()
  await ui.press({ key: 'confirm-remove-kimi' })
  expect(relay.calls.some(a => a.join(' ') === 'provider remove kimi')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^kimi 会员$/ })).toBeUndefined()

  // 新增：下拉选 Qwen 模板，改显示名，再勾一个角色，保存
  await ui.press({ key: 'add-vendor' })
  await ui.select({ key: 'form-preset', value: 'qwen' })
  // 模板厂商的标识和命令只读展示，不给输入框
  expect(await ui.find({ type: 'Input', key: 'form-name' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^标识 qwen · 命令 qwen/ })).toBeDefined()
  await ui.input({ key: 'form-label', text: '千问会员', kind: 'change' })
  await ui.press({ key: 'role-review' })
  await ui.press({ key: 'form-save' })
  const add = relay.calls.find(a => a[1] === 'add')
  expect(add).toBeDefined()
  const spec = JSON.parse(add![3]!) as { preset: string; name: string; label: string; roles: string[]; promptArgs?: string }
  expect(spec).toMatchObject({ preset: 'qwen', name: 'qwen', label: '千问会员', roles: ['read', 'review'] })
  // 非自定义模板不传命令参数，用模板自带的
  expect(spec.promptArgs).toBeUndefined()
  // 保存成功后表单收起，新厂商出现在列表里
  expect(await ui.find({ type: 'Button', key: 'form-save' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^qwen 会员$/ })).toBeDefined()
  await ui.unmount()
})

test('新增失败时保留表单并显示原因', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-vendors' })
  await ui.press({ key: 'add-vendor' })
  await ui.select({ key: 'form-preset', value: 'custom' })
  expect(await ui.find({ type: 'Input', key: 'form-name' })).toBeDefined()
  await ui.press({ key: 'form-save' })
  expect(relay.added).toEqual([])
  expect(await ui.find({ type: 'Text', text: /标识只能用小写字母/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'form-save' })).toBeDefined()
  await ui.unmount()
})

test('手机端没有输入框：不显示新增按钮', async ($, on) => {
  baseStubs(on)
  fakeRelay(on)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ui.press({ key: 'tab-vendors' })
  expect(await ui.find({ type: 'Button', key: 'add-vendor' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /新增厂商请在桌面端/ })).toBeDefined()
  await ui.unmount()
})

test('额度页显示主模型和额度来源，刷新时把 Claude 额度交给 relay', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const quota = relay.calls.find(a => a[0] === 'quota')
  expect(quota?.[1]).toBe('--claude-json')
  expect(JSON.parse(quota![2]!)).toEqual([{ kind: 'five_hour', percentUsed: 53, resetsAt: '2026-11-04T09:00:00Z' }])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^更新于 .*Grok 自查失败，暂用 AIQuota5h 的数据$/ })).toBeDefined()
  await ui.unmount()
})

test('Claude 的 5h 窗口：没有读数时占位，已过重置点说明已重置，借用的窗口单独注明', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  // 5h 刚重置、新窗口还没发过请求：Claude Code 只报了周额度
  relay.claudeWins = [{ key: 'weekly', remaining: 0.5, resetAt: 1794056400000, source: '自带' }]
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '暂无读数，下次对话后更新' })).toBeDefined()
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(6)
  await ui.unmount()

  // 沿用上次的 5h 读数，但已过重置点；周额度借用 AIQuota5h
  relay.claudeWins = [
    { key: '5h', remaining: 1, resetAt: 1793700000000, source: '自带' },
    { key: 'weekly', remaining: 0.5, resetAt: 1794056400000, source: 'AIQuota5h' },
  ]
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: '已重置，新窗口还没开始' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Claude 周、Grok 自查失败，暂用 AIQuota5h 的数据/ })).toBeDefined()
  await ui.unmount()
})

test('对话页：按轮次列出主模型、子代理、Codex 和 relay 外派，回答下方写本轮模型', async ($, on) => {
  // 时钟由测试按步骤拨动（UTC 时间）
  let t = Date.parse('2026-11-04T06:59:00.000Z')
  const at = (iso: string) => (t = Date.parse(`2026-11-04T${iso}.000Z`))
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('agent.spawn', (_, e) => ({ model: e.subagentType === 'Explore' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-5-5', agentId: `ag-${e.subagentType}` }))
  // relay 记录：一条落在本轮之内（agy），一条是上午其他会话的（grok），一条本轮的 codex 由子代理覆盖
  relay.jobs = JSON.stringify([
    { id: 'j1', provider: 'agy', model: 'gemini-3.8-flash-high', role: 'read', write: false, status: 'done', startedAt: '2026-11-04T07:01:00.000Z', finishedAt: '2026-11-04T07:02:30.000Z', task: '通读报告模块', changedFiles: 0, reason: '擅长 1.00 · 额度 1.25 · 可靠 0.97 · 速度 0.91 → 1.10', verdict: null, verdictNote: '' },
    { id: 'tu2', provider: 'codex', model: 'default', role: 'implement', write: true, status: 'done', startedAt: '2026-11-04T07:01:10.000Z', finishedAt: null, task: '实现导出', changedFiles: 0, reason: '主模型指定 Codex', verdict: 'partial', verdictNote: '漏了空数据分支，主控已补' },
    { id: 'j0', provider: 'grok', model: 'default', role: null, write: false, status: 'failed', startedAt: '2026-11-04T02:00:00.000Z', finishedAt: '2026-11-04T02:00:20.000Z', task: '上午的审查', changedFiles: 0, reason: '', verdict: null, verdictNote: '' },
  ])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  at('07:00:00')
  await $.turn.start({ text: '实现按月导出并审查', turnId: 't1' })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: '找导出相关代码', description: '找导出代码', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  await $.agent.spawn({ tool_use_id: 'tu2', prompt: '实现导出', description: '实现按月导出', subagentType: 'codex:codex-rescue', provider: { plugin: 'codex', tier: 'user' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  // 主模型亲手写了 45 行（子代理里的编辑不算）
  await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: Array(45).fill('x').join('\n') })
  await $.tool.call({ tool: 'Write', file_path: '/y.ts', content: Array(99).fill('y').join('\n'), agentId: 'ag-Explore' })
  at('07:00:45')
  await $.turn.complete({ turnId: 't1', agentId: 'ag-Explore', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  at('07:05:00')
  const end = await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  expect(end.text).toBe('本轮模型：Opus 5.5（主模型） · 外派 Haiku 4.5 子代理、Codex、Gemini 3.8 Flash · High')

  // 第二轮什么都没外派
  at('07:10:00')
  await $.turn.start({ text: '这里改个文案', turnId: 't2' })
  at('07:11:00')
  const end2 = await $.turn.complete({ turnId: 't2', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  expect(end2.text).toBe('本轮模型：Opus 5.5（主模型）')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  // 最新的一轮在前。列表只放摘要，项目名即使只有一个也常驻
  const titles = (await ui.findAll({ type: 'Text', text: /^(实现按月导出并审查|这里改个文案)$/ })).map(x => x.text)
  const orderedTitles = titles.filter((text, index) => titles.indexOf(text) === index)
  expect(orderedTitles).toEqual(['这里改个文案', '实现按月导出并审查'])
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5 主管' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5 主管 · Haiku 4.5 ✓ · Codex ▲ · Gemini 3.8 Flash ○' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◆ fj' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'open-t1' }))?.props.label).toBe('详情 ›')
  expect(await shownIncludes(ui, '为什么选它')).toBe(false)
  expect(await shownIncludes(ui, '验收意见')).toBe(false)
  expect(await shownIncludes(ui, '派单全文')).toBe(false)
  expect(await ui.find({ type: 'Text', text: '★ 主导' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▲ 亲手写得偏多' })).toBeUndefined()
  // 亲手改动的行数仍会计入，但不再显示；本会话也不再单独标
  expect(await ui.find({ type: 'Text', text: '亲手改动' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '45 行（偏多，成块的活可考虑交给员工模型）' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '● 本会话' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '未归入对话的外派' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✕ 失败' })).toBeDefined()
  expect(await shownIncludes(ui, '上午的审查')).toBe(false)

  await ui.press({ key: 'open-t1' })
  expect(await ui.find({ type: 'Text', text: /外派 3 个/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Haiku 4.5$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Claude 子代理 · Explore · 用时 45 秒' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ChatGPT Plus · 经 Codex 插件' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Gemini 3.8 Flash · High' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^阅读 · 只读 · 用时 1 分 30 秒$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^实现 · 可写$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '○ 完成 · 待验收' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▲ 部分通过' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '擅长 1.00 · 额度 1.25 · 可靠 0.97 · 速度 0.91 → 总分 1.10' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '为什么选它' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '验收意见' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '漏了空数据分支，主控已补' })).toBeDefined()
  expect(await shownIncludes(ui, '派单全文')).toBe(false)
  // Codex 只出现一次（子代理那条），relay 里的 codex 记录不重复显示。Claude 子代理没有派单全文
  expect(await ui.findAll({ type: 'Text', text: /^Codex$/ })).toHaveLength(1)
  expect(await ui.find({ type: 'Button', key: 'brief-ag-Explore' })).toBeUndefined()
  await ui.press({ key: 'back' })

  await ui.press({ key: 'open-t2' })
  // 没有外派时详情里不显示「分工」
  expect(await ui.find({ type: 'Text', text: '分工' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /用时 1 分钟/ })).toBeDefined()
  await ui.press({ key: 'back' })

  await ui.press({ key: 'open-job-j0' })
  expect(await ui.find({ type: 'Text', text: '上午的审查' })).toBeDefined()
  await ui.unmount()
})

test('对话页：跨会话展示所有项目、按项目筛选、写入跨会话存储', async ($, on) => {
  const otherRound: Round = {
    id: 't-other',
    sessionId: 's-other',
    project: { name: 'api-server', path: '/projects/api-server' },
    env: 'terminal',
    text: '修复报表导出服务 bug',
    mainModel: 'claude-sonnet-5-5',
    startedAt: 1793700000000,
    finishedAt: 1793700180000,
    status: 'answer',
    agents: [],
    selfLines: 0,
  }

  baseStubs(on, new Set<string>(), () => 1793712984000)
  putRoundFile('s-other', [otherRound], 1793712984000)
  fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })

  // 本会话的一轮
  await $.turn.start({ text: '本会话修改前端样式', turnId: 't-cur' })
  await $.turn.complete({ turnId: 't-cur', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  // 断言本会话的轮次写进了共享目录的 <sessionId>.json
  const savedText = fileMap.get(`${ROUNDS_DIR}/s-cur.json`)?.text
  const saved = savedText ? (JSON.parse(savedText) as Round[]) : undefined
  expect(saved).toBeDefined()
  expect(Array.isArray(saved)).toBe(true)
  expect(saved![0]?.id).toBe('t-cur')
  expect(saved![0]?.sessionId).toBe('s-cur')
  expect(saved![0]?.project.name).toBe('fj')
  expect(saved![0]?.env).toBe('desktop')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })

  // 每个项目都显示项目名；本会话不再单独标，环境标签和环境筛选不再出现
  expect(await ui.find({ type: 'Text', text: '◆ fj' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◆ api-server' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▣ 桌面端' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▣ 终端' })).toBeUndefined()
  expect(await ui.find({ type: 'Select', key: 'filter-env' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '● 本会话' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '亲手改动' })).toBeUndefined()

  expect(await ui.find({ type: 'Text', text: 'Opus 5.5 主管' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Sonnet 5.5 主管' })).toBeDefined()

  // 筛选后只剩这个项目的对话，项目名仍然显示
  await ui.select({ key: 'filter-project', value: 'fj' })
  expect(await ui.find({ type: 'Text', text: '本会话修改前端样式' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '修复报表导出服务 bug' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5 主管' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Sonnet 5.5 主管' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '◆ fj' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◆ api-server' })).toBeUndefined()

  await ui.unmount()
})

test('对话页：详情里看到完整标题和为什么选它，派单全文收起后消失', async ($, on) => {
  let t = Date.parse('2026-11-04T08:00:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  const longTitle = '请把对话页面改成可以展开的卡片，标题必须完整显示，不能只看到被截断的一小段，模型行也要改成带标签的格式，让每一段文字的含义一眼就能看懂。'
  const task = ['角色：implement', '', '## 目标', '把对话卡片改成可展开，并让模型行的每一项都带标签。', '', '## 验收标准', '展开后能看到全文。'].join('\n')
  relay.jobs = JSON.stringify([
    {
      id: 'j-long',
      provider: 'grok',
      model: 'default',
      role: 'implement',
      write: true,
      status: 'done',
      startedAt: '2026-11-04T08:00:30.000Z',
      finishedAt: '2026-11-04T08:03:15.000Z',
      task,
      changedFiles: 2,
      reason: '擅长 0.85 · 可靠 0.97 · 额度 1.22 · 速度 0.92 → 0.95；跳过 grok 额度不足',
      verdict: 'pass',
      verdictNote: '5 条验收全部通过',
    },
  ])
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: longTitle, turnId: 't-long' })
  t = Date.parse('2026-11-04T08:05:00.000Z')
  await $.turn.complete({ turnId: 't-long', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  expect(longTitle.length).toBeGreaterThan(60)
  expect(await shownIncludes(ui, '派单全文')).toBe(false)
  expect(await shownIncludes(ui, '为什么选它')).toBe(false)
  expect(await ui.find({ type: 'Text', text: '实现 · 可写 · 用时 2 分 45 秒 · 改了 2 个文件' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '◆ fj' })).toBeDefined()

  await ui.press({ key: 'open-t-long' })
  expect(await ui.find({ type: 'Text', text: longTitle })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '实现 · 可写 · 用时 2 分 45 秒 · 改了 2 个文件' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '为什么选它' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /擅长 0\.85 · 可靠 0\.97 · 额度 1\.22 · 速度 0\.92 → 总分 0\.95/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '跳过 grok 额度不足' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '把对话卡片改成可展开，并让模型行的每一项都带标签。' })).toBeDefined()
  expect(await shownIncludes(ui, '派单全文')).toBe(false)
  expect(await shownIncludes(ui, /角色：implement/)).toBe(false)
  expect(await shownIncludes(ui, /## 验收标准/)).toBe(false)

  await ui.press({ key: 'brief-j-long' })
  expect((await ui.find({ type: 'Button', key: 'brief-j-long' }))?.props.label).toBe('收起派单全文')
  expect(await ui.find({ type: 'Text', text: '派单全文' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /角色：implement/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /## 验收标准/ })).toBeDefined()

  await ui.press({ key: 'brief-j-long' })
  expect((await ui.find({ type: 'Button', key: 'brief-j-long' }))?.props.label).toBe('查看派单全文')
  expect(await shownIncludes(ui, '派单全文')).toBe(false)
  expect(await shownIncludes(ui, /角色：implement/)).toBe(false)
  expect(await shownIncludes(ui, '为什么选它')).toBe(true)
  expect(await shownIncludes(ui, '跳过 grok 额度不足')).toBe(true)
  await ui.unmount()
})

test('对话页：详情里的目标保留原文，派单全文要点开，单项目也显示项目名', async ($, on) => {
  let t = Date.parse('2026-11-04T10:00:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  on('tool.call', () => ({ result: 'ok' }))
  const task = [
    '角色：implement',
    '',
    '## 目标',
    '**修好** `fieldRow` 的溢出，只留这一句。',
    '- 这一行是列表，收起时不该出现',
    '1. 这一行也是',
    '',
    '## 验收标准',
    '不要把整段列表铺出来。',
  ].join('\n')
  relay.jobs = JSON.stringify([
    {
      id: 'j-goal',
      provider: 'grok',
      model: 'default',
      role: 'implement',
      write: true,
      status: 'done',
      startedAt: '2026-11-04T10:00:20.000Z',
      finishedAt: '2026-11-04T10:01:00.000Z',
      task,
      changedFiles: 1,
      reason: '擅长 0.90 → 0.90',
      verdict: 'pass',
      verdictNote: '目标只显示一句',
      cwd: '/projects/fj',
    },
    {
      id: 'j-old',
      provider: 'agy',
      model: 'default',
      role: 'read',
      write: false,
      status: 'done',
      startedAt: '2020-01-01T00:00:00.000Z',
      finishedAt: '2020-01-01T00:01:00.000Z',
      task: '看看同项目的旧任务',
      changedFiles: 0,
      reason: '',
      verdict: null,
      verdictNote: '',
      cwd: '/projects/fj',
    },
  ])
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '把对话卡片的目标收成一句', turnId: 't-goal' })
  await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: Array(45).fill('x').join('\n') })
  t = Date.parse('2026-11-04T10:02:00.000Z')
  await $.turn.complete({ turnId: 't-goal', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })

  expect(await ui.find({ type: 'Text', text: '● 本会话' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '亲手改动' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '45 行（偏多，成块的活可考虑交给员工模型）' })).toBeUndefined()
  // 只有一个项目也显示项目名；项目名单独一格，不写进时间文字里
  expect(await ui.find({ type: 'Text', text: '◆ fj' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fj ·/ })).toBeUndefined()

  expect(await shownIncludes(ui, '**修好**')).toBe(false)
  expect(await shownIncludes(ui, '`fieldRow`')).toBe(false)
  expect(await shownIncludes(ui, '这一行是列表')).toBe(false)
  expect(await shownIncludes(ui, '这一行也是')).toBe(false)
  expect(await shownIncludes(ui, '## 验收标准')).toBe(false)
  expect(await shownIncludes(ui, '派单全文')).toBe(false)

  await ui.press({ key: 'open-t-goal' })
  const root = await ui.drawn()
  const goalTexts = visibleNodes(root).filter(el => el.type === 'Text' && collectText(el).includes('**修好**'))
  expect(goalTexts.length).toBeGreaterThan(0)
  expect(goalTexts.some(el => el.props?.wrap === 'wrap')).toBe(true)
  const contentBoxes = (await ui.findAll({ type: 'Box' })).filter(box => Number(box.props.minWidth) === 0 && Number(box.props.flexGrow) === 1 && Number(box.props.flexShrink) === 1)
  expect(contentBoxes.length).toBeGreaterThan(0)
  expect(await shownIncludes(ui, '**修好**')).toBe(true)
  expect(await shownIncludes(ui, '`fieldRow`')).toBe(true)
  expect(await shownIncludes(ui, '这一行是列表，收起时不该出现')).toBe(true)
  expect(await shownIncludes(ui, '## 验收标准')).toBe(false)
  expect(await shownIncludes(ui, '派单全文')).toBe(false)

  await ui.press({ key: 'brief-j-goal' })
  expect(await shownIncludes(ui, '## 验收标准')).toBe(true)
  expect(await ui.find({ type: 'Text', text: '派单全文' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '亲手改动' })).toBeUndefined()
  await ui.unmount()
})

test('对话页：有两个项目时显示项目标签，未归入外派的项目名也同样处理', async ($, on) => {
  const otherRound: Round = {
    id: 't-other',
    sessionId: 's-other',
    project: { name: 'api-server', path: '/projects/api-server' },
    env: 'terminal',
    text: '修复报表导出服务 bug',
    mainModel: 'claude-sonnet-5-5',
    startedAt: 1793700000000,
    finishedAt: 1793700180000,
    status: 'answer',
    agents: [],
    selfLines: 12,
  }
  baseStubs(on, new Set<string>(), () => 1793712984000)
  putRoundFile('s-other', [otherRound], 1793712984000)
  const relay = fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  relay.jobs = JSON.stringify([
    {
      id: 'old-a',
      provider: 'grok',
      model: 'default',
      role: 'review',
      write: false,
      status: 'done',
      startedAt: '2020-01-01T00:00:00.000Z',
      finishedAt: '2020-01-01T00:00:10.000Z',
      task: '旧审查甲',
      changedFiles: 0,
      reason: '',
      verdict: null,
      verdictNote: '',
      cwd: '/work/proj-alpha',
    },
    {
      id: 'old-b',
      provider: 'agy',
      model: 'default',
      role: 'read',
      write: false,
      status: 'done',
      startedAt: '2020-01-02T00:00:00.000Z',
      finishedAt: '2020-01-02T00:00:10.000Z',
      task: '旧审查乙',
      changedFiles: 0,
      reason: '',
      verdict: null,
      verdictNote: '',
      cwd: '/work/proj-beta',
    },
  ])
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '本会话修改前端样式', turnId: 't-cur' })
  await $.turn.complete({ turnId: 't-cur', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  expect(await ui.find({ type: 'Text', text: '◆ fj' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◆ api-server' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '● 本会话' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '亲手改动' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /proj-alpha/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /proj-beta/ })).toBeDefined()
  await ui.unmount()
})

test('厂商页：支持最高权限的厂商可单独开关，不支持的只显示原因', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-vendors' })

  const accessLabels = (await ui.findAll({ type: 'Text', text: '最高权限' })).map(asDrawn).filter((el): el is DrawnNode => Boolean(el))
  expect(accessLabels.length).toBeGreaterThan(0)
  for (const label of accessLabels) {
    expect(label.props?.size).toBe('caption')
    expect(label.props?.dimColor).toBe(true)
  }

  expect((await ui.find({ type: 'Button', key: 'access-grok' }))?.props.label).toBe('关闭最高权限')
  expect(await ui.find({ type: 'Text', text: '已开启 · 执行命令不再逐个审批' })).toBeDefined()
  await ui.press({ key: 'access-grok' })
  expect(relay.calls.some(a => a.join(' ') === 'provider access grok off')).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'access-grok' }))?.props.label).toBe('开启最高权限')
  expect(await ui.find({ type: 'Text', text: '已关闭 · 只能改文件' })).toBeDefined()

  expect(await ui.find({ type: 'Button', key: 'access-claude' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'access-codex' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '主模型的权限在输入框的模式菜单里设置' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '由 Codex 插件固定为只能写当前项目的沙箱' })).toBeDefined()

  // 厂商停用后，最高权限这一行和开关仍在
  await ui.press({ key: 'toggle-grok' })
  expect((await ui.find({ type: 'Button', key: 'toggle-grok' }))?.props.label).toBe('启用')
  expect(await ui.find({ type: 'Button', key: 'access-grok' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '已关闭 · 只能改文件' })).toBeDefined()
  await ui.unmount()
})

test('对话页：详情里目标给到下一段标题之前，派单细节只在派单全文里', async ($, on) => {
  let t = Date.parse('2026-11-04T11:00:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  const task = ['角色：implement', '', '## 目标', '第一句收起时看得到。', '第二句只在悬停的完整目标里。', '', '## 派单细节', '这段只属于派单全文。'].join('\n')
  relay.jobs = JSON.stringify([
    {
      id: 'j-hover',
      provider: 'grok',
      model: 'default',
      role: 'implement',
      write: true,
      status: 'done',
      startedAt: '2026-11-04T11:00:20.000Z',
      finishedAt: '2026-11-04T11:01:00.000Z',
      task,
      changedFiles: 1,
      reason: '擅长 0.80 → 0.80',
      verdict: 'pass',
      verdictNote: '验收说明只在悬停里',
    },
  ])
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '悬停只看这一行的补充', turnId: 't-hover' })
  t = Date.parse('2026-11-04T11:02:00.000Z')
  await $.turn.complete({ turnId: 't-hover', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  expect(await shownIncludes(ui, '任务')).toBe(false)
  expect(await shownIncludes(ui, '第一句收起时看得到。')).toBe(false)
  expect(await shownIncludes(ui, '派单全文')).toBe(false)

  await ui.press({ key: 'open-t-hover' })
  expect(await shownIncludes(ui, '任务')).toBe(true)
  expect(await shownIncludes(ui, '第一句收起时看得到。')).toBe(true)
  expect(await shownIncludes(ui, '第二句只在悬停的完整目标里。')).toBe(true)
  expect(await shownIncludes(ui, '为什么选它')).toBe(true)
  expect(await shownIncludes(ui, '验收意见')).toBe(true)
  expect(await shownIncludes(ui, '验收说明只在悬停里')).toBe(true)
  expect(await shownIncludes(ui, '派单全文')).toBe(false)
  expect(await shownIncludes(ui, '这段只属于派单全文。')).toBe(false)

  await ui.press({ key: 'brief-j-hover' })
  expect(await ui.find({ type: 'Text', text: '派单全文' })).toBeDefined()
  expect(await shownIncludes(ui, '这段只属于派单全文。')).toBe(true)
  await ui.unmount()
})

test('对话页：同一项目的对话也显示项目名，未归入外派各自显示项目', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  relay.jobs = JSON.stringify([
    {
      id: 'old-a',
      provider: 'grok',
      model: 'default',
      role: 'review',
      write: false,
      status: 'done',
      startedAt: '2020-01-01T00:00:00.000Z',
      finishedAt: '2020-01-01T00:00:10.000Z',
      task: '旧审查甲',
      changedFiles: 0,
      reason: '',
      verdict: null,
      verdictNote: '',
      cwd: '/work/proj-alpha',
    },
    {
      id: 'old-b',
      provider: 'agy',
      model: 'default',
      role: 'read',
      write: false,
      status: 'done',
      startedAt: '2020-01-02T00:00:00.000Z',
      finishedAt: '2020-01-02T00:00:10.000Z',
      task: '旧审查乙',
      changedFiles: 0,
      reason: '',
      verdict: null,
      verdictNote: '',
      cwd: '/work/proj-beta',
    },
  ])
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '第一轮都在 fj', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  await $.turn.start({ text: '第二轮还是 fj', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  expect(await ui.find({ type: 'Text', text: '第一轮都在 fj' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '第二轮还是 fj' })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: '◆ fj' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /proj-alpha/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /proj-beta/ })).toBeDefined()
  await ui.unmount()
})

test('对话页：列表每轮都显示项目名和详情按钮，渲染树里没有悬停', async ($, on) => {
  baseStubs(on)
  fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '第一轮只在 fj', turnId: 't-a' })
  await $.turn.complete({ turnId: 't-a', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  await $.turn.start({ text: '第二轮还是 fj', turnId: 't-b' })
  await $.turn.complete({ turnId: 't-b', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  expect(await ui.findAll({ type: 'Text', text: '◆ fj' })).toHaveLength(2)
  expect((await ui.find({ type: 'Button', key: 'open-t-a' }))?.props.label).toBe('详情 ›')
  expect((await ui.find({ type: 'Button', key: 'open-t-b' }))?.props.label).toBe('详情 ›')
  const hovered: DrawnNode[] = []
  walkDrawn(await ui.drawn(), el => {
    if (el.type === 'Box' && (el.hover !== undefined || el.props?.hover !== undefined)) hovered.push(el)
  })
  expect(hovered).toHaveLength(0)
  await ui.unmount()
})

test('对话页：点详情看到完整消息和员工字段，派单全文默认不显示，返回后回到列表', async ($, on) => {
  let t = Date.parse('2026-11-04T08:00:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  const message = '请把对话页改成列表进详情，这条消息要完整显示。'
  const task = ['角色：implement', '', '## 目标', '把列表和详情拆开。', '', '## 验收标准', '派单全文默认不出现。'].join('\n')
  relay.jobs = JSON.stringify([
    {
      id: 'j-detail',
      provider: 'grok',
      model: 'default',
      role: 'implement',
      write: true,
      status: 'done',
      startedAt: '2026-11-04T08:00:10.000Z',
      finishedAt: '2026-11-04T08:02:00.000Z',
      task,
      changedFiles: 1,
      reason: '擅长 0.90 → 0.90',
      verdict: 'pass',
      verdictNote: '',
    },
  ])
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: message, turnId: 't-detail' })
  t = Date.parse('2026-11-04T08:03:00.000Z')
  await $.turn.complete({ turnId: 't-detail', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  expect(await shownIncludes(ui, '派单全文')).toBe(false)
  expect(await shownIncludes(ui, '为什么选它')).toBe(false)
  await ui.press({ key: 'open-t-detail' })
  expect(await ui.find({ type: 'Text', text: message })).toBeDefined()
  const messageNodes = visibleNodes(await ui.drawn()).filter(el => el.type === 'Text' && collectText(el).includes(message))
  expect(messageNodes.some(el => el.props?.wrap === 'wrap')).toBe(true)
  expect(await ui.find({ type: 'Text', text: '任务' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '目标' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '把列表和详情拆开。' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '为什么选它' })).toBeDefined()
  expect(await shownIncludes(ui, '派单全文')).toBe(false)
  expect(await shownIncludes(ui, '派单全文默认不出现。')).toBe(false)
  await ui.press({ key: 'brief-j-detail' })
  expect((await ui.find({ type: 'Button', key: 'brief-j-detail' }))?.props.label).toBe('收起派单全文')
  expect(await ui.find({ type: 'Text', text: '派单全文' })).toBeDefined()
  expect(await shownIncludes(ui, '派单全文默认不出现。')).toBe(true)
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'open-t-detail' })).toBeDefined()
  expect(await shownIncludes(ui, '派单全文')).toBe(false)
  await ui.unmount()
})

test('厂商页：汇总正确，Claude 没有操作按钮，Grok 的删除在右侧', async ($, on) => {
  baseStubs(on)
  fakeRelay(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-vendors' })

  expect(await ui.find({ type: 'Text', text: '3 家 · 启用 3 家 · 最高权限开启 1 家' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'toggle-claude' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'access-claude' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'test-claude' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'remove-claude' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'toggle-grok' }))?.props.label).toBe('停用')
  expect((await ui.find({ type: 'Button', key: 'access-grok' }))?.props.label).toBe('关闭最高权限')
  expect((await ui.find({ type: 'Button', key: 'test-grok' }))?.props.label).toBe('试运行')

  const row = actionRowOf(await ui.drawn(), 'remove-grok')
  expect(row).not.toBeNull()
  const kids = (row!.children ?? []).map(asDrawn).filter((el): el is DrawnNode => Boolean(el?.type))
  expect(nodeKey(kids[kids.length - 1]!)).toBe('remove-grok')
  const leftKeys: string[] = []
  walkDrawn(kids[0], el => {
    if (el.type === 'Button') leftKeys.push(nodeKey(el))
  })
  expect(leftKeys).toEqual(['toggle-grok', 'access-grok', 'test-grok'])
  await ui.unmount()
})

test('对话页：共享目录里其他会话的项目和本会话一起显示', async ($, on) => {
  const now = 1793712984000
  const zcRound: Round = {
    id: 't-zc',
    sessionId: 's-zc',
    project: { name: 'zc', path: '/projects/zc' },
    env: 'desktop',
    text: 'zc 项目里的对话',
    mainModel: 'claude-sonnet-5-5',
    startedAt: now - 60_000,
    finishedAt: now - 30_000,
    status: 'answer',
    agents: [],
    selfLines: 0,
  }
  baseStubs(on, new Set<string>(), () => now)
  putRoundFile('s-zc', [zcRound], now)
  fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '本会话修改前端样式', turnId: 't-cur' })
  await $.turn.complete({ turnId: 't-cur', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  expect(await ui.find({ type: 'Text', text: '◆ zc' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◆ fj' })).toBeDefined()
  await ui.unmount()
})

test('启动时把 $.store 的旧轮次写成文件并删除旧键', async ($, on) => {
  const oldRound: Round = {
    id: 't-old',
    sessionId: 's-old',
    project: { name: 'legacy', path: '/projects/legacy' },
    env: 'terminal',
    text: '迁出来的旧对话',
    mainModel: 'claude-sonnet-5-5',
    startedAt: 1793700000000,
    finishedAt: 1793700180000,
    status: 'answer',
    agents: [],
    selfLines: 0,
  }
  baseStubs(on, new Set<string>(), () => 1793712984000, { 'rounds:s-old': [oldRound] })
  fakeRelay(on)

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })

  expect(storeMap.has('rounds:s-old')).toBe(false)
  const written = fileMap.get(`${ROUNDS_DIR}/s-old.json`)
  expect(written).toBeDefined()
  expect(JSON.parse(written!.text)).toEqual([oldRound])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  expect(await ui.find({ type: 'Text', text: '◆ legacy' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '迁出来的旧对话' })).toBeDefined()
  await ui.unmount()
})

test('对话页：修改时间超过 14 天的文件不显示', async ($, on) => {
  const now = 1793712984000
  const day = 86_400_000
  const freshRound: Round = {
    id: 't-fresh',
    sessionId: 's-fresh',
    project: { name: 'fresh-proj', path: '/projects/fresh-proj' },
    env: 'desktop',
    text: '还在 14 天内的对话',
    mainModel: 'claude-sonnet-5-5',
    startedAt: now - 1000,
    finishedAt: now,
    status: 'answer',
    agents: [],
    selfLines: 0,
  }
  const ancientRound: Round = {
    id: 't-ancient',
    sessionId: 's-ancient',
    project: { name: 'ancient', path: '/projects/ancient' },
    env: 'desktop',
    text: '太旧的对话',
    mainModel: 'claude-sonnet-5-5',
    startedAt: now - 1000,
    finishedAt: now,
    status: 'answer',
    agents: [],
    selfLines: 0,
  }
  baseStubs(on, new Set<string>(), () => now)
  putRoundFile('s-fresh', [freshRound], now)
  putRoundFile('s-ancient', [ancientRound], now - 14 * day - 1)
  fakeRelay(on)

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  expect(await ui.find({ type: 'Text', text: '◆ fresh-proj' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '还在 14 天内的对话' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◆ ancient' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '太旧的对话' })).toBeUndefined()
  await ui.unmount()
})
