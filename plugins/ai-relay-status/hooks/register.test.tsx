import { expect, mock, test } from 'claude-code/testing'
import type { Round, RoundAgent } from '../types'
import { foldSystemRounds } from './register'

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

const ABOVE = {
  plugin: 'ai-relay-status',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 4,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 3 },
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

function providersJson(
  grokEnabled: boolean,
  extra: string[] = [],
  access: Record<string, boolean> = {},
  pools: Record<string, readonly Record<string, unknown>[]> = {},
  more: { name: string; label: string; roles?: string[] }[] = [],
  roleList?: { key: string; text: string }[],
) {
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
    modelPools: pools[name] ?? [],
  })
  return JSON.stringify({
    providers: [
      v('claude', 'Claude Pro（主控）', 'self', true, []),
      v('codex', 'Codex · ChatGPT Plus', 'codex-plugin', true, ['implement']),
      v('grok', 'SuperGrok', 'relay', grokEnabled, ['review', 'read']),
      ...extra.map(n => v(n, `${n} 会员`, 'relay', true, ['read'])),
      ...more.map(n => v(n.name, n.label, 'relay', true, n.roles ?? ['read'])),
    ],
    roles: roleList ?? [{ key: 'implement', text: '实现' }, { key: 'review', text: '审查' }, { key: 'read', text: '阅读' }],
    presets: {
      kimi: { title: 'Kimi Code CLI', label: 'Kimi 会员', bin: 'kimi', install: '装 kimi', cli: { prompt: ['--quiet', '-p', '{prompt}'], model: ['-m', '{model}'], read: ['--plan'], write: [], cwd: ['-w', '{cwd}'] }, models: ['default'], roles: ['read', 'review'], note: '只读靠计划模式' },
      qwen: { title: 'Qwen Code', label: '通义千问会员', bin: 'qwen', install: '', cli: { prompt: ['-p', '{prompt}'], model: ['-m', '{model}'], read: ['--approval-mode', 'plan'], write: ['--approval-mode', 'auto-edit'], cwd: null }, models: ['default'], roles: ['read'], note: '' },
      custom: { title: '自定义', label: '', bin: '', install: '', cli: { prompt: ['-p', '{prompt}'], model: ['--model', '{model}'], read: [], write: [], cwd: null }, models: ['default'], roles: ['read'], note: '' },
    },
  })
}

/** 模拟 relay：记录调用，按子命令返回结果，并维护 grok 启停与新增厂商 */
function fakeRelay(on: TestOn) {
  const state = {
    mode: 'manual', grok: true, added: [] as string[], calls: [] as string[][], jobs: '[]',
    claudeWins: undefined as unknown[] | undefined, access: { grok: true } as Record<string, boolean>,
    modelPools: {} as Record<string, Record<string, unknown>[]>,
    moreProviders: [] as { name: string; label: string; roles?: string[] }[],
    roleList: undefined as { key: string; text: string }[] | undefined,
    models: null as unknown,
    // 非 null 时 models 子命令原样返回这段 stdout（用来测解析失败）
    modelsRaw: null as string | null,
    modelSaveFail: '',
    pluginFail: '',
    pluginCalls: [] as string[][],
  }
  on('process.run', (_, e) => {
    if (e.argv[1] === 'plugin') {
      state.pluginCalls.push([...e.argv])
      if (state.pluginFail) return fail(state.pluginFail)
      const action = e.argv[2]
      const pluginId = e.argv[3]
      if (pluginId && (action === 'enable' || action === 'disable')) {
        const settingsPath = `${TEST_HOME}/.claude/settings.json`
        const cur = JSON.parse(fileMap.get(settingsPath)?.text ?? '{}')
        const enabledPlugins = { ...(cur.enabledPlugins ?? {}), [pluginId]: action === 'enable' }
        fileMap.set(settingsPath, { text: JSON.stringify({ ...cur, enabledPlugins }), mtimeMs: 1793712984000 })
        return ok('')
      }
    }
    const argv = [...e.argv].slice(2)
    state.calls.push(argv)
    const [cmd, sub, arg] = argv
    if (cmd === 'status') return ok(statusJson(state.mode, state.grok, state.claudeWins))
    if (cmd === 'quota') return ok('')
    if (cmd === 'jobs') return ok(state.jobs)
    if (cmd === 'providers') return ok(providersJson(state.grok, state.added, state.access, state.modelPools, state.moreProviders, state.roleList))
    if (cmd === 'models') {
      if (state.modelsRaw !== null) return ok(state.modelsRaw)
      return ok(JSON.stringify(state.models ?? { updatedAt: '2026-11-05T00:00:00.000Z', providers: {} }))
    }
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
    if (cmd === 'provider' && sub === 'model') {
      if (state.modelSaveFail) return fail(`ai-relay 错误：${state.modelSaveFail}`)
      const name = arg ?? ''
      const pool = argv[3] ?? ''
      const modelId = argv[4] ?? ''
      const hit = state.modelPools[name]?.find(p => p.pool === pool)
      if (hit) hit.current = modelId === 'default' ? null : modelId
      const shown = modelId === 'default' ? 'CLI 默认' : modelId
      return ok(`${name} 默认模型 → ${shown}（下一单起生效）`)
    }
    return fail('unknown')
  })
  return state
}

let storeMap = new Map<string, unknown>()
let toastLog: string[] = []

// 测试用的家目录，由 env.get('HOME') 提供
const TEST_HOME = '/home/tester'
const ROUNDS_DIR = `${TEST_HOME}/.claude/ai-relay/rounds`
type StoredFile = { text: string; mtimeMs: number }
// 内存版共享目录：路径对应文件内容和修改时间
let fileMap = new Map<string, StoredFile>()

function putRoundFile(sessionId: string, rounds: unknown, mtimeMs: number) {
  fileMap.set(`${ROUNDS_DIR}/${sessionId}.json`, { text: JSON.stringify(rounds), mtimeMs })
}

function baseStubs(
  on: TestOn,
  opened = new Set<string>(),
  now: () => number = () => 1793712984000,
  storeEntries?: Record<string, unknown>,
  initialCwd = '/projects/fj',
  options?: { stubClock?: boolean },
) {
  // 内存版 $.store：测试可以直接读回插件写入的值
  storeMap = new Map(Object.entries(storeEntries ?? {}))
  toastLog = []
  fileMap = new Map()
  on('store.get', (_, e) => ({ value: storeMap.get(e.key) }))
  on('store.set', (_, e) => (storeMap.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', (_, e) => (storeMap.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...storeMap.keys()] }))
  let curCwd = initialCwd
  let curSurface: string | null = 'desktop'
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? TEST_HOME : undefined }))
  on('fs.read', (_, e) => {
    // relay 的安装记录：任意市场来源的 ai-relay
    if (e.path === `${TEST_HOME}/.claude/plugins/installed_plugins.json`) {
      return { value: JSON.stringify({ plugins: { 'ai-relay@test-market': [{ installPath: '/opt/ai-relay' }] } }) }
    }
    const hit = fileMap.get(e.path)
    if (hit) {
      if (new TextEncoder().encode(hit.text).length > 4 * 1024 * 1024) throw new Error('file exceeds 4 MiB')
      return { value: hit.text }
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
    const files: { name: string; size: number; mtimeMs: number }[] = []
    const dirs = new Set<string>()
    for (const [path, file] of fileMap) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (!rest) continue
      const slash = rest.indexOf('/')
      if (slash === -1) files.push({ name: rest, size: file.text.length, mtimeMs: file.mtimeMs })
      else if (rest.slice(0, slash)) dirs.add(rest.slice(0, slash))
    }
    const fileNames = new Set(files.map(file => file.name))
    const value = [
      ...files.map(file => ({ name: file.name, kind: 'file' as const, size: file.size, mtimeMs: file.mtimeMs, isLink: false })),
      ...[...dirs].filter(name => !fileNames.has(name)).map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
    ]
    return { value }
  })
  if (options?.stubClock !== false) {
    on('clock.now', () => ({ value: now() }))
    on('clock.every', () => ({ value: undefined }))
  }
  on('command.register', () => ({ value: { command: 'relay-bar' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toastLog.push(e.text)
    return { value: undefined }
  })
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

async function tokenCells(ui: { drawn: () => Promise<unknown> }, label: string) {
  let cells: string[] = []
  walkDrawn(await ui.drawn(), el => {
    if (nodeKey(el).startsWith('token-row-')) {
      const texts = visibleTexts(el)
      if (texts[0] === label) cells = texts
    }
  })
  return cells
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
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })

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
  expect(await ui.find({ type: 'Text', text: '○ 完成 · 等主管验收' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◐ 主管判部分通过' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /待验收/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '擅长 1.00 · 额度 1.25 · 可靠 0.97 · 速度 0.91 → 总分 1.10' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '为什么选它' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '验收意见' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '漏了空数据分支，主控已补' })).toBeDefined()
  expect(await shownIncludes(ui, '派单全文')).toBe(false)
  // Codex 卡片只出现一次，表格里也只有一行；relay 记录不重复显示。
  const codexCards = visibleNodes(await ui.drawn()).filter(el => nodeKey(el) === 'agent-ag-codex:codex-rescue')
  expect(codexCards).toHaveLength(1)
  expect(await tokenCells(ui, 'Codex')).toHaveLength(2)
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

test('对话页：本轮行数取 relay 统计（含 Bash 写入），详情显示主管自己做的原因', async ($, on) => {
  let t = Date.parse('2026-11-04T07:00:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  const edits = `${TEST_HOME}/.claude/ai-relay/prompts/s-cur.edits.json`

  await $.turn.start({ text: '按这个改', turnId: 'ts1' })
  await $.tool.call({ tool: 'Write', file_path: '/x.ts', content: Array(10).fill('x').join('\n') })
  fileMap.set(edits, { text: JSON.stringify({ lines: 230, warned: true, reads: 0, readWarned: false, decision: 'self', selfReason: '需要本会话前面讨论的结论' }), mtimeMs: t })
  t += 60_000
  await $.turn.complete({ turnId: 'ts1', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  // 外派了的一轮：decision 为 dispatch，不显示原因
  await $.turn.start({ text: '再派一个', turnId: 'ts2' })
  fileMap.set(edits, { text: JSON.stringify({ lines: 0, warned: false, reads: 0, readWarned: false, decision: 'dispatch' }), mtimeMs: t })
  t += 60_000
  await $.turn.complete({ turnId: 'ts2', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  const saved = JSON.parse(fileMap.get(`${ROUNDS_DIR}/s-cur.json`)!.text) as Round[]
  const r1 = saved.find(r => r.id === 'ts1')!
  expect(r1.selfLines).toBe(230)
  expect(r1.selfReason).toBe('需要本会话前面讨论的结论')
  expect(saved.find(r => r.id === 'ts2')!.selfReason).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  await ui.press({ key: 'open-ts1' })
  expect(await ui.find({ type: 'Text', text: '自己做的原因' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '需要本会话前面讨论的结论' })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'open-ts2' })
  expect(await ui.find({ type: 'Text', text: '自己做的原因' })).toBeUndefined()
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
  // 桌面版没选文件夹的会话跑在 spares 临时目录，显示成「本电脑」
  putRoundFile('s-spare', [{ ...otherRound, id: 't-spare', sessionId: 's-spare', text: '没选文件夹的提问',
    project: { name: 'spare-AJP8NA', path: '/Users/me/.claude/spares/spare-AJP8NA' } }], 1793712984000)
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

  // 默认选中当前窗口所在项目，只列本项目的对话；「全部项目」仍可选
  expect((await ui.find({ type: 'Select', key: 'filter-project' }))?.props.value).toBe('fj')
  expect(await ui.find({ type: 'Text', text: '本会话修改前端样式' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '修复报表导出服务 bug' })).toBeUndefined()
  await ui.select({ key: 'filter-project', value: '' })
  expect((await ui.find({ type: 'Select', key: 'filter-project' }))?.props.value).toBe('')

  // 每个项目都显示项目名；本会话不再单独标，环境标签和环境筛选不再出现
  expect(await ui.find({ type: 'Text', text: '◆ fj' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◆ api-server' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◆ 本电脑' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /spare-AJP8NA/ })).toBeUndefined()
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
  await ui.select({ key: 'filter-project', value: '' })
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
  await ui.select({ key: 'filter-project', value: '' })
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

function optionLabels(el: { props?: Record<string, unknown> } | undefined) {
  const options = el?.props?.options
  if (!Array.isArray(options)) return []
  return options.map(item => {
    const opt = item as { value?: string; label?: string }
    return opt.label ?? opt.value ?? ''
  })
}

const NOW = 1793712984000

test('厂商页：默认模型按额度池列出选项和用于说明', async ($, on) => {
  baseStubs(on, new Set<string>(), () => NOW)
  const relay = fakeRelay(on)
  const updatedAt = new Date(NOW - 5 * 60_000).toISOString()
  relay.roleList = [
    { key: 'implement', text: '实现' },
    { key: 'debug', text: '排查' },
    { key: 'review', text: '审查' },
    { key: 'read', text: '阅读' },
  ]
  relay.moreProviders = [{ name: 'agy', label: 'Antigravity', roles: ['read', 'implement'] }]
  relay.modelPools = {
    grok: [{ pool: 'supergrok-weekly', label: 'Grok', current: null, allowCliDefault: true, followRoles: ['review', 'deep'], fixedRoles: [] }],
    codex: [{ pool: 'codex', label: 'Codex', current: 'codex-old', allowCliDefault: true, followRoles: ['implement'], fixedRoles: [] }],
    agy: [
      {
        pool: 'gemini-argon', label: 'Gemini Argon', current: 'gemini-4-argon-high', allowCliDefault: false,
        followRoles: ['debug', 'review', 'deep'], fixedRoles: [{ role: 'read', model: 'gemini-4-argon-medium' }],
      },
      { pool: 'claude-gpt', label: 'Claude / GPT', current: 'claude-sonnet', allowCliDefault: false, followRoles: ['implement'], fixedRoles: [] },
      { pool: 'gemini', label: 'Gemini Flash', current: 'gemini-3.8-flash', allowCliDefault: false, followRoles: [], fixedRoles: [] },
    ],
  }
  relay.models = {
    updatedAt,
    providers: {
      grok: {
        ok: true, error: null, fetchedAt: updatedAt, cliDefault: 'grok-4.7-build-fast',
        models: [
          { id: 'grok-4.7', label: 'grok-4.7', pool: 'supergrok-weekly' },
          { id: 'grok-4.7-build-fast', label: 'Grok 4.7 Build Fast', pool: 'supergrok-weekly' },
          { id: 'orphan', label: 'Orphan', pool: null },
        ],
      },
      codex: {
        ok: true, error: null, fetchedAt: updatedAt, cliDefault: 'codex-default',
        models: [{ id: 'gpt-5.4', label: 'GPT-5.4', pool: 'codex' }],
      },
      agy: {
        ok: true, error: null, fetchedAt: updatedAt, cliDefault: null,
        models: [
          { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)', pool: 'gemini-argon' },
          { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)', pool: 'gemini-argon' },
          { id: 'claude-sonnet', label: 'Claude Sonnet', pool: 'claude-gpt' },
          { id: 'gpt-5', label: 'GPT-5', pool: 'claude-gpt' },
          { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash', pool: 'gemini' },
        ],
      },
    },
  }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-vendors' })

  expect(relay.calls.some(a => a[0] === 'models' && a.includes('--json') && !a.includes('--refresh'))).toBe(true)
  // 刷新按钮只在页首放一个
  expect(await ui.find({ type: 'Button', key: 'models-refresh' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '模型列表更新于 5 分钟前' })).toBeDefined()

  const grok = await ui.find({ type: 'Select', key: 'model-grok-supergrok-weekly' })
  // 单池厂商：区块标题已是「默认模型」，下拉不再重复标题
  expect(grok?.props.label).toBeUndefined()
  expect(grok?.props.value).toBe('default')
  expect(optionLabels(grok)).toEqual([
    '跟随 CLI 默认（grok-4.7-build-fast）',
    'grok-4.7',
    'Grok 4.7 Build Fast · grok-4.7-build-fast',
  ])
  expect(await ui.find({ type: 'Text', text: '用于：审查、深度推理' })).toBeDefined()

  const agyRows: [string, string][] = [
    ['gemini-argon', 'Gemini Argon'],
    ['claude-gpt', 'Claude / GPT'],
    ['gemini', 'Gemini Flash'],
  ]
  for (const [pool, label] of agyRows) {
    expect((await ui.find({ type: 'Select', key: `model-agy-${pool}` }))?.props.label).toBe(label)
  }
  const argon = await ui.find({ type: 'Select', key: 'model-agy-gemini-argon' })
  expect(optionLabels(argon)).toEqual([
    'Gemini 4 Argon (High) · gemini-4-argon-high',
    'Gemini 4 Argon (Medium) · gemini-4-argon-medium',
  ])
  expect(await ui.find({ type: 'Text', text: '用于：排查、审查、深度推理；单独指定：阅读 → gemini-4-argon-medium' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '用于：实现' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '暂无角色使用' })).toBeDefined()

  const codex = await ui.find({ type: 'Select', key: 'model-codex-codex' })
  expect(optionLabels(codex)).toContain('codex-old（清单里已没有）')
  expect(codex?.props.value).toBe('codex-old')

  await ui.press({ key: 'models-refresh' })
  expect(relay.calls.some(a => a[0] === 'models' && a.includes('--refresh') && a.includes('--json'))).toBe(true)
  await ui.unmount()
})

test('厂商页：默认模型保存成功用 relay 的那一行，失败恢复原值', async ($, on) => {
  baseStubs(on, new Set<string>(), () => NOW)
  const relay = fakeRelay(on)
  relay.modelPools = {
    grok: [{ pool: 'supergrok-weekly', label: 'Grok', current: null, allowCliDefault: true, followRoles: ['review'], fixedRoles: [] }],
  }
  relay.models = {
    updatedAt: new Date(NOW).toISOString(),
    providers: {
      grok: {
        ok: true, error: null, fetchedAt: new Date(NOW).toISOString(), cliDefault: 'grok-4.7-build-fast',
        models: [{ id: 'grok-4.7', label: 'grok-4.7', pool: 'supergrok-weekly' }],
      },
    },
  }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-vendors' })

  await ui.select({ key: 'model-grok-supergrok-weekly', value: 'grok-4.7' })
  expect(relay.calls.some(a => a.join(' ') === 'provider model grok supergrok-weekly grok-4.7')).toBe(true)
  expect(toastLog.at(-1)).toBe('grok 默认模型 → grok-4.7（下一单起生效）')
  expect((await ui.find({ type: 'Select', key: 'model-grok-supergrok-weekly' }))?.props.value).toBe('grok-4.7')

  relay.modelSaveFail = '模型不在清单里'
  await ui.select({ key: 'model-grok-supergrok-weekly', value: 'default' })
  expect(toastLog.at(-1)).toBe('模型不在清单里')
  expect((await ui.find({ type: 'Select', key: 'model-grok-supergrok-weekly' }))?.props.value).toBe('grok-4.7')
  await ui.unmount()
})

test('厂商页：模型列表失败时不弄垮页面', async ($, on) => {
  baseStubs(on, new Set<string>(), () => NOW)
  const relay = fakeRelay(on)
  relay.modelPools = {
    grok: [{ pool: 'supergrok-weekly', label: 'Grok', current: 'grok-4.7', allowCliDefault: true, followRoles: ['review'], fixedRoles: [] }],
    codex: [{ pool: 'codex', label: 'Codex', current: 'codex-retired', allowCliDefault: true, followRoles: ['implement'], fixedRoles: [] }],
  }
  relay.models = {
    updatedAt: new Date(NOW - 3_600_000).toISOString(),
    providers: {
      grok: {
        ok: false, error: 'grok 命令超时', fetchedAt: new Date(NOW - 3_600_000).toISOString(), cliDefault: 'grok-4.7-build-fast',
        models: [{ id: 'grok-4.7', label: 'grok-4.7', pool: 'supergrok-weekly' }],
      },
      codex: { ok: false, error: '没有读到', fetchedAt: new Date(NOW - 3_600_000).toISOString(), cliDefault: null, models: [] },
    },
  }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-vendors' })
  expect(await ui.find({ type: 'Text', text: '模型列表获取失败：grok 命令超时，显示的是上次的结果' })).toBeDefined()
  expect(optionLabels(await ui.find({ type: 'Select', key: 'model-grok-supergrok-weekly' }))).toContain('跟随 CLI 默认（grok-4.7-build-fast）')
  expect(optionLabels(await ui.find({ type: 'Select', key: 'model-grok-supergrok-weekly' }))).toContain('grok-4.7')
  expect(await ui.find({ type: 'Text', text: '模型列表更新于 1 小时前' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '模型列表获取失败：没有读到，显示的是上次的结果' })).toBeDefined()
  expect(optionLabels(await ui.find({ type: 'Select', key: 'model-codex-codex' }))).toEqual(['codex-retired（清单里已没有）'])
  expect(await ui.find({ type: 'Text', text: /^Codex · ChatGPT Plus$/ })).toBeDefined()
  await ui.unmount()
})

test('厂商页：模型列表解析失败仍显示厂商和当前值', async ($, on) => {
  baseStubs(on, new Set<string>(), () => NOW)
  const relay = fakeRelay(on)
  relay.modelsRaw = '<<<'
  relay.modelPools = {
    grok: [{ pool: 'supergrok-weekly', label: 'Grok', current: 'grok-4.7', allowCliDefault: true, followRoles: ['review'], fixedRoles: [] }],
  }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-vendors' })
  expect(await ui.find({ type: 'Text', text: /^SuperGrok$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /模型列表获取失败：解析失败/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /显示的是上次的结果/ })).toBeUndefined()
  expect(optionLabels(await ui.find({ type: 'Select', key: 'model-grok-supergrok-weekly' }))).toEqual(['grok-4.7（清单里已没有）'])
  await ui.unmount()
})

test('厂商页：手机端默认模型只显示文字', async ($, on) => {
  baseStubs(on, new Set<string>(), () => NOW)
  const relay = fakeRelay(on)
  relay.moreProviders = [{ name: 'agy', label: 'Antigravity' }]
  relay.modelPools = {
    grok: [{ pool: 'supergrok-weekly', label: 'Grok', current: null, allowCliDefault: true, followRoles: ['review'], fixedRoles: [] }],
    agy: [
      { pool: 'gemini-argon', label: 'Gemini Argon', current: 'gemini-4-argon-high', allowCliDefault: false, followRoles: ['read'], fixedRoles: [] },
    ],
  }
  relay.models = {
    updatedAt: new Date(NOW).toISOString(),
    providers: {
      grok: {
        ok: true, error: null, fetchedAt: new Date(NOW).toISOString(), cliDefault: 'grok-4.7-build-fast',
        models: [{ id: 'grok-4.7', label: 'grok-4.7', pool: 'supergrok-weekly' }],
      },
      agy: {
        ok: true, error: null, fetchedAt: new Date(NOW).toISOString(), cliDefault: null,
        models: [{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)', pool: 'gemini-argon' }],
      },
    },
  }
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ui.press({ key: 'tab-vendors' })
  expect(await ui.find({ type: 'Select', key: 'model-grok-supergrok-weekly' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '默认模型：跟随 CLI 默认（grok-4.7-build-fast）' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '默认模型：Gemini 4 Argon (High) · gemini-4-argon-high' })).toBeDefined()
  await ui.unmount()
})

test('对话页详情：Token 消耗按模型列出主管、子代理、Codex、外派与合计，去重生效，无数据显示无数据', async ($, on) => {
  let t = Date.parse('2026-11-04T07:00:00.000Z')
  const at = (iso: string) => (t = Date.parse(`2026-11-04T${iso}.000Z`))
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  on('agent.spawn', (_, e) => ({ model: e.subagentType === 'Explore' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-5-5', agentId: `ag-${e.subagentType}` }))

  relay.jobs = JSON.stringify([
    {
      id: 'j-agy',
      provider: 'agy',
      model: 'gemini-3.8-flash-high',
      role: 'read',
      write: false,
      status: 'done',
      startedAt: '2026-11-04T07:01:00.000Z',
      finishedAt: '2026-11-04T07:02:00.000Z',
      task: '读取模块',
      changedFiles: 0,
      reason: '',
      verdict: 'pass',
      verdictNote: '',
      usage: { input: 9100, output: 300, cacheRead: 0, total: 9400 },
    },
    {
      id: 'j-grok',
      provider: 'grok',
      model: 'default',
      role: 'review',
      write: false,
      status: 'done',
      startedAt: '2026-11-04T07:02:10.000Z',
      finishedAt: '2026-11-04T07:03:00.000Z',
      task: '审查代码',
      changedFiles: 0,
      reason: '',
      verdict: 'pass',
      verdictNote: '',
    },
    {
      id: 'tu-codex',
      provider: 'codex',
      model: 'default',
      role: 'implement',
      write: true,
      status: 'done',
      startedAt: '2026-11-04T07:01:10.000Z',
      finishedAt: '2026-11-04T07:04:00.000Z',
      task: '实现功能',
      changedFiles: 1,
      reason: '',
      verdict: 'pass',
      verdictNote: '',
    },
  ])

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })

  // 第一轮：07:00:00 ~ 07:05:00，包含主管、Haiku 子代理、Codex、agy（有 usage）、grok（无 usage）
  at('07:00:00')
  await $.turn.start({ text: '第一轮完整协作', turnId: 't-tok-1' })
  await $.agent.spawn({ tool_use_id: 'tu-sub', prompt: '搜索代码', description: '搜索代码', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  await $.agent.spawn({ tool_use_id: 'tu-codex', prompt: '实现功能', description: '实现功能', subagentType: 'codex:codex-rescue', provider: { plugin: 'codex', tier: 'user' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  at('07:00:45')
  await $.turn.complete({ turnId: 't-tok-1', agentId: 'ag-Explore', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  at('07:04:00')
  await $.turn.complete({ turnId: 't-tok-1', agentId: 'ag-codex:codex-rescue', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  at('07:05:00')
  await $.turn.complete({ turnId: 't-tok-1', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  // 第二轮：07:10:00 ~ 07:11:00，没有任何落在该时间段的 usage 记录
  at('07:10:00')
  await $.turn.start({ text: '第二轮无 token 记录', turnId: 't-tok-2' })
  at('07:11:00')
  await $.turn.complete({ turnId: 't-tok-2', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  // 写入假的会话主记录：含轮次外记录、同一 message.id 重复 3 条、另一 message.id 1 条、以及坏 JSON 行
  const sessionJsonl = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T06:50:00.000Z', message: { id: 'msg-old', usage: { input_tokens: 99999, output_tokens: 99999, cache_read_input_tokens: 99999 } } }),
    '<<<损坏的JSON行，不应弄垮面板',
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T07:00:10.000Z', message: { id: 'msg-1', usage: { input_tokens: 2300, cache_creation_input_tokens: 10000, output_tokens: 800, cache_read_input_tokens: 50000 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T07:00:11.000Z', message: { id: 'msg-1', usage: { input_tokens: 2300, cache_creation_input_tokens: 10000, output_tokens: 800, cache_read_input_tokens: 50000 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T07:00:12.000Z', message: { id: 'msg-1', usage: { input_tokens: 2300, cache_creation_input_tokens: 10000, output_tokens: 800, cache_read_input_tokens: 50000 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T07:04:30.000Z', message: { id: 'msg-2', usage: { input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 400, cache_read_input_tokens: 30000 } } }),
  ].join('\n')
  fileMap.set(`${TEST_HOME}/.claude/projects/-projects-fj/s-cur.jsonl`, { text: sessionJsonl, mtimeMs: t })

  // 写入假的子代理记录：同一 message.id 重复 2 条
  const subJsonl = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T07:00:20.000Z', message: { id: 'sub-1', usage: { input_tokens: 500, cache_creation_input_tokens: 1500, output_tokens: 500, cache_read_input_tokens: 10000 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T07:00:25.000Z', message: { id: 'sub-1', usage: { input_tokens: 500, cache_creation_input_tokens: 1500, output_tokens: 500, cache_read_input_tokens: 10000 } } }),
  ].join('\n')
  fileMap.set(`${TEST_HOME}/.claude/projects/-projects-fj/s-cur/subagents/agent-ag-Explore.jsonl`, { text: subJsonl, mtimeMs: t })

  // 写入假的 Codex rollout 记录：含连续相同 total_tokens 的重复事件
  const codexRollout = [
    JSON.stringify({ timestamp: '2026-11-04T07:01:10.000Z', type: 'session_meta', payload: { id: 'cx-1', cwd: '/projects/fj' } }),
    JSON.stringify({
      timestamp: '2026-11-04T07:02:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 15000, cached_input_tokens: 9600, output_tokens: 1100, total_tokens: 16100 },
          last_token_usage: { input_tokens: 15000, cached_input_tokens: 9600, output_tokens: 1100, total_tokens: 16100 },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-04T07:02:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 15000, cached_input_tokens: 9600, output_tokens: 1100, total_tokens: 16100 },
          last_token_usage: { input_tokens: 15000, cached_input_tokens: 9600, output_tokens: 1100, total_tokens: 16100 },
        },
      },
    }),
  ].join('\n')
  fileMap.set(`${TEST_HOME}/.codex/sessions/2026/11/04/rollout-2026-11-04T07-01-10-cx.jsonl`, { text: codexRollout, mtimeMs: t })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })

  // 打开第一轮详情：断言各模型行和合计行
  await ui.press({ key: 'open-t-tok-1' })
  expect(await ui.find({ type: 'Text', text: 'Token 消耗' })).toBeDefined()
  expect(await tokenCells(ui, '模型')).toEqual(['模型', '输入', '输出', '缓存读'])
  expect(await tokenCells(ui, 'Opus 5.5（主管）')).toEqual(['Opus 5.5（主管）', '12.3k', '1.2k', '80k'])
  expect(await tokenCells(ui, 'Haiku 4.5（子代理）')).toEqual(['Haiku 4.5（子代理）', '2k', '500', '10k'])
  expect(await tokenCells(ui, 'Codex')).toEqual(['Codex', '15k', '1.1k', '9.6k'])
  expect(await tokenCells(ui, 'Gemini 3.8 Flash · High')).toEqual(['Gemini 3.8 Flash · High', '9.1k', '300', '0'])
  expect(await tokenCells(ui, 'Grok')).toEqual(['Grok', '无数据'])
  expect(await tokenCells(ui, '合计')).toEqual(['合计', '38.4k', '3.1k', '99.6k'])

  // 已完成的轮次结果缓存在内存里：改写底层 jsonl 后再打开同一轮，仍返回缓存值
  fileMap.set(`${TEST_HOME}/.claude/projects/-projects-fj/s-cur.jsonl`, { text: '', mtimeMs: t })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'open-t-tok-1' })
  expect(await tokenCells(ui, 'Opus 5.5（主管）')).toEqual(['Opus 5.5（主管）', '12.3k', '1.2k', '80k'])
  await ui.press({ key: 'back' })

  // 打开第二轮详情：没有数据时主管和合计都显示「无数据」
  await ui.press({ key: 'open-t-tok-2' })
  expect(await tokenCells(ui, 'Opus 5.5（主管）')).toEqual(['Opus 5.5（主管）', '无数据（本轮时间内没有用量记录）'])
  expect(await tokenCells(ui, '合计')).toEqual(['合计', '无数据'])
  await ui.unmount()
})

test('对话页详情：进行中的轮次每次打开详情重新计算 Token 消耗', async ($, on) => {
  let t = Date.parse('2026-11-04T09:00:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '正在运行的轮次', turnId: 't-running' })

  const sessionFile = `${TEST_HOME}/.claude/projects/-projects-fj/s-cur.jsonl`
  fileMap.set(sessionFile, {
    text: JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-04T09:00:05.000Z',
      message: { id: 'm1', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 } },
    }),
    mtimeMs: t,
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  await ui.press({ key: 'open-t-running' })
  expect(await tokenCells(ui, 'Opus 5.5（主管）')).toEqual(['Opus 5.5（主管）', '1k', '200', '5k'])

  // 进行中轮次新增了一条消息：返回列表再打开详情应重新计算
  fileMap.set(sessionFile, {
    text: [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-04T09:00:05.000Z',
        message: { id: 'm1', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 } },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-04T09:00:15.000Z',
        message: { id: 'm2', usage: { input_tokens: 2500, output_tokens: 800, cache_read_input_tokens: 15000 } },
      }),
    ].join('\n'),
    mtimeMs: t,
  })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'open-t-running' })
  expect(await tokenCells(ui, 'Opus 5.5（主管）')).toEqual(['Opus 5.5（主管）', '3.5k', '1k', '20k'])
  expect(await tokenCells(ui, '合计')).toEqual(['合计', '3.5k', '1k', '20k'])
  await ui.unmount()
})

test('对话页详情：进行中的 relay 外派有 liveUsage 时加"（进行中）"，暂无用量显示暂未匹配到日志，已结束显示无数据', async ($, on) => {
  let t = Date.parse('2026-11-04T08:00:00.000Z')
  const at = (iso: string) => (t = Date.parse(`2026-11-04T${iso}.000Z`))
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))

  relay.jobs = JSON.stringify([
    {
      id: 'j-live-agy',
      provider: 'agy',
      model: 'gemini-3.8-flash-high',
      role: 'implement',
      write: true,
      status: 'running',
      startedAt: '2026-11-04T08:01:00.000Z',
      finishedAt: null,
      task: '实时实现',
      changedFiles: 0,
      reason: '',
      verdict: null,
      verdictNote: '',
      liveUsage: { input: 12000, output: 800, cacheRead: 0, total: 12800 },
    },
    {
      id: 'j-live-grok',
      provider: 'grok',
      model: 'default',
      role: 'debug',
      write: false,
      status: 'running',
      startedAt: '2026-11-04T08:01:30.000Z',
      finishedAt: null,
      task: '实时排查',
      changedFiles: 0,
      reason: '',
      verdict: null,
      verdictNote: '',
    },
    {
      id: 'j-ended-grok',
      provider: 'grok',
      model: 'grok-4.7',
      role: 'read',
      write: false,
      status: 'done',
      startedAt: '2026-11-04T08:00:30.000Z',
      finishedAt: '2026-11-04T08:01:00.000Z',
      task: '已结束任务',
      changedFiles: 0,
      reason: '',
      verdict: 'pass',
      verdictNote: '',
    },
  ])

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  at('08:00:00')
  await $.turn.start({ text: '外派实时用量测试', turnId: 't-live' })
  at('08:05:00')
  await $.turn.complete({ turnId: 't-live', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  // 写入主管用量
  const sessionFile = `${TEST_HOME}/.claude/projects/-projects-fj/s-cur.jsonl`
  fileMap.set(sessionFile, {
    text: JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-04T08:00:05.000Z',
      message: { id: 'm-live-1', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 2000 } },
    }),
    mtimeMs: t,
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  await ui.press({ key: 'open-t-live' })

  // 1. 验证有 liveUsage 的外派行尾加"（进行中）"
  expect(await tokenCells(ui, 'Gemini 3.8 Flash · High（进行中）')).toEqual(['Gemini 3.8 Flash · High（进行中）', '12k', '800', '0'])

  // 2. 验证进行中但暂无 liveUsage 的外派显示"进行中，暂未匹配到日志"
  expect(await tokenCells(ui, 'Grok')).toEqual(['Grok', '进行中，暂未匹配到日志'])

  // 3. 验证已结束且无 usage 的外派显示"无数据"
  expect(await tokenCells(ui, 'grok-4.7')).toEqual(['grok-4.7', '无数据'])

  // 4. 验证合计行包含 liveUsage：主管(1k/200/2k) + agy live(12k/800/0) = 13k/1k/2k
  expect(await tokenCells(ui, '合计')).toEqual(['合计', '13k', '1k', '2k'])

  // 5. 验证进行中轮次每次刷新不走缓存：更新 liveUsage 后刷新，能看到最新数字
  relay.jobs = JSON.stringify([
    {
      id: 'j-live-agy',
      provider: 'agy',
      model: 'gemini-3.8-flash-high',
      role: 'implement',
      write: true,
      status: 'running',
      startedAt: '2026-11-04T08:01:00.000Z',
      finishedAt: null,
      task: '实时实现',
      changedFiles: 0,
      reason: '',
      verdict: null,
      verdictNote: '',
      liveUsage: { input: 20000, output: 1500, cacheRead: 0, total: 21500 },
    },
    {
      id: 'j-live-grok',
      provider: 'grok',
      model: 'default',
      role: 'debug',
      write: false,
      status: 'running',
      startedAt: '2026-11-04T08:01:30.000Z',
      finishedAt: null,
      task: '实时排查',
      changedFiles: 0,
      reason: '',
      verdict: null,
      verdictNote: '',
    },
    {
      id: 'j-ended-grok',
      provider: 'grok',
      model: 'grok-4.7',
      role: 'read',
      write: false,
      status: 'done',
      startedAt: '2026-11-04T08:00:30.000Z',
      finishedAt: '2026-11-04T08:01:00.000Z',
      task: '已结束任务',
      changedFiles: 0,
      reason: '',
      verdict: 'pass',
      verdictNote: '',
    },
  ])

  await ui.press({ key: 'back' })
  await ui.press({ key: 'jobs-refresh' })
  await ui.press({ key: 'open-t-live' })
  expect(await tokenCells(ui, 'Gemini 3.8 Flash · High（进行中）')).toEqual(['Gemini 3.8 Flash · High（进行中）', '20k', '1.5k', '0'])
  expect(await tokenCells(ui, '合计')).toEqual(['合计', '21k', '1.7k', '2k'])

  await ui.unmount()
})

test('对话页：项目名按桌面版会话映射，筛选下拉按映射名分组', async ($, on) => {
  let now = 1793712984000
  // 启动目录和 git 根目录故意不同，确认新轮次不再写成仓库名 fj
  baseStubs(on, new Set<string>(), () => now, undefined, '/work/terminal-app')
  const meta = `${TEST_HOME}/Library/Application Support/Claude/claude-code-sessions/group-a/sess-a/local_1.json`
  const desktopMeta = (originCwd: string) => JSON.stringify({
    cliSessionId: 'sid-cli',
    priorCliSessionIds: ['sid-prior'],
    originCwd,
    title: '无关字段，不应参与项目名',
  })
  fileMap.set(meta, { text: desktopMeta('/Users/me/Documents/workspace/ZS/zc'), mtimeMs: now })
  // 桌面版没选文件夹的会话跑在 scratch-workspaces 临时目录，左侧栏归在「本电脑」
  const scratchCwd = `${TEST_HOME}/Library/Application Support/Claude/scratch-workspaces/env-1/sess-b/scratch-2026-11-08-10b765`
  fileMap.set(`${TEST_HOME}/Library/Application Support/Claude/claude-code-sessions/group-a/sess-b/local_2.json`, {
    text: JSON.stringify({ cliSessionId: 'sid-scratch', originCwd: scratchCwd }),
    mtimeMs: now,
  })
  const round = (id: string, sessionId: string, name: string, path: string, text: string, startedAt: number): Round => ({
    id,
    sessionId,
    project: { name, path },
    env: 'desktop',
    text,
    mainModel: 'claude-sonnet-5-5',
    startedAt,
    finishedAt: startedAt + 1000,
    status: 'answer',
    agents: [],
    selfLines: 0,
  })
  putRoundFile('sid-cli', [round('t-cli', 'sid-cli', 'backend', '/Users/me/Documents/workspace/ZS/zc/backend', '命中当前会话 id', now - 1)], now)
  putRoundFile('sid-prior', [round('t-prior', 'sid-prior', 'zc-knowledge-service', '/Users/me/Documents/workspace/ZS/zc/knowledge', '命中以前的会话 id', now - 2)], now)
  putRoundFile('sid-term', [round('t-term', 'sid-term', 'backend', '/Users/me/work/octop', '终端里的会话', now - 3)], now)
  putRoundFile('sid-spare', [round('t-spare', 'sid-spare', 'spare-AJP8NA', '/Users/me/.claude/spares/spare-AJP8NA', '没选文件夹的提问', now - 4)], now)
  putRoundFile('sid-scratch', [round('t-scratch', 'sid-scratch', 'scratch-2026-11-08-10b765', scratchCwd, '临时会话的提问', now - 5)], now)
  fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))

  await $.session.start({ cwd: '/work/terminal-app', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '新写入的一轮', turnId: 't-new' })
  const saved = JSON.parse(fileMap.get(`${ROUNDS_DIR}/s-cur.json`)!.text) as Round[]
  expect(saved[0]?.project.name).toBe('terminal-app')
  expect(saved[0]?.project.path).toBe('/work/terminal-app')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  await ui.select({ key: 'filter-project', value: '' })

  // 命中 cliSessionId、priorCliSessionIds 都显示 originCwd 末级名；终端回退到启动目录；spares 显示本电脑
  expect(await ui.findAll({ type: 'Text', text: '◆ zc' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: '◆ octop' })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: '◆ 本电脑' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /scratch-2026/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '◆ terminal-app' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◆ backend' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '◆ zc-knowledge-service' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '◆ fj' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /spare-AJP8NA/ })).toBeUndefined()
  expect(optionLabels(await ui.find({ type: 'Select', key: 'filter-project' }))).toEqual([
    '全部项目',
    'terminal-app（1）',
    'zc（2）',
    'octop（1）',
    '本电脑（2）',
  ])

  await ui.press({ key: 'open-t-cli' })
  expect(await ui.find({ type: 'Text', text: /◆ zc/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /backend/ })).toBeUndefined()
  await ui.press({ key: 'back' })

  await ui.select({ key: 'filter-project', value: 'zc' })
  expect(await ui.find({ type: 'Text', text: '命中当前会话 id' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '命中以前的会话 id' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '终端里的会话' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '没选文件夹的提问' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '新写入的一轮' })).toBeUndefined()

  // 60 秒内改了元数据也不重读
  fileMap.set(meta, { text: desktopMeta('/Users/me/Documents/renamed'), mtimeMs: now })
  await ui.select({ key: 'filter-project', value: '' })
  expect(await ui.findAll({ type: 'Text', text: '◆ zc' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: '◆ renamed' })).toBeUndefined()

  now += 60_000
  await ui.select({ key: 'filter-project', value: '' })
  expect(await ui.find({ type: 'Text', text: '◆ zc' })).toBeUndefined()
  expect(await ui.findAll({ type: 'Text', text: '◆ renamed' })).toHaveLength(2)
  expect(optionLabels(await ui.find({ type: 'Select', key: 'filter-project' }))).toEqual([
    '全部项目',
    'terminal-app（1）',
    'renamed（2）',
    'octop（1）',
    '本电脑（2）',
  ])
  await ui.unmount()
})

test('对话页：系统轮次并入同一会话的上一轮，不跨会话合并', async ($, on) => {
  const T0 = Date.parse('2026-11-04T07:00:00.000Z')
  const now = T0 + 86_400_000
  baseStubs(on, new Set<string>(), () => now)
  const agent = (id: string, description: string): Round['agents'][number] => ({
    id,
    toolUseId: `tu-${id}`,
    subagentType: 'Explore',
    description,
    model: 'claude-haiku-4-5-20251001',
    status: 'done',
    startedAt: T0,
    finishedAt: T0 + 1000,
  })
  const round = (part: Pick<Round, 'id' | 'sessionId' | 'text' | 'startedAt' | 'finishedAt' | 'status' | 'agents' | 'selfLines'> & { mainModel?: string }): Round => ({
    id: part.id,
    sessionId: part.sessionId,
    project: { name: 'fj', path: '/projects/fj' },
    env: 'desktop',
    text: part.text,
    mainModel: part.mainModel ?? 'claude-opus-5-5',
    startedAt: part.startedAt,
    finishedAt: part.finishedAt,
    status: part.status,
    agents: part.agents,
    selfLines: part.selfLines,
  })
  // 同一会话：用户一轮后面跟两条任务回报。结束时间、状态和子代理都要并到用户这一轮
  putRoundFile('s-a', [
    round({
      id: 'a-n2',
      sessionId: 's-a',
      text: '<task-notification>\n<task-id>n2</task-id> <tool-use>',
      startedAt: T0 + 40_000,
      finishedAt: T0 + 45_000,
      status: 'error',
      agents: [agent('ag-n2', '甲第二次回报')],
      selfLines: 4,
    }),
    round({
      id: 'a-n1',
      sessionId: 's-a',
      text: '\n<task-notification>\n<task-id>n1</task-id> <tool-use>',
      startedAt: T0 + 20_000,
      finishedAt: T0 + 30_000,
      status: 'answer',
      agents: [agent('ag-n1', '甲第一次回报')],
      selfLines: 3,
    }),
    round({
      id: 'a-user',
      sessionId: 's-a',
      text: '会话甲的问题',
      startedAt: T0,
      finishedAt: T0 + 10_000,
      status: 'answer',
      agents: [agent('ag-user', '甲用户的子代理')],
      selfLines: 2,
    }),
  ], now)
  // 另一个会话的第一条就是系统消息，时间夹在甲的用户轮次和回报之间，不能并进甲
  putRoundFile('s-b', [
    round({
      id: 'b-sys',
      sessionId: 's-b',
      text: '<ci-monitor-event>\nbuild finished',
      startedAt: T0 + 15_000,
      finishedAt: T0 + 18_000,
      status: 'answer',
      agents: [agent('ag-b', '乙会话的子代理')],
      selfLines: 1,
      mainModel: 'claude-sonnet-5-5',
    }),
  ], now)
  // 落在用户结束之后、最后一条回报结束之前：只有折叠延长了窗口才会被算进这一轮
  fileMap.set(`${TEST_HOME}/.claude/projects/-projects-fj/s-a.jsonl`, {
    text: JSON.stringify({
      type: 'assistant',
      timestamp: new Date(T0 + 20_000).toISOString(),
      message: { id: 'msg-between', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0 } },
    }),
    mtimeMs: now,
  })
  fakeRelay(on)

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })

  // 甲的三条合成 1 条，乙单独留下，项目计数按折叠后的 2 轮
  expect(await ui.findAll({ type: 'Text', text: '会话甲的问题' })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: '后台任务回报' })).toHaveLength(1)
  expect(await ui.find({ type: 'Button', key: 'open-a-user' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'open-a-n1' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'open-a-n2' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'open-b-sys' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5 主管 · Haiku 4.5 ✓ · Haiku 4.5 ✓ · Haiku 4.5 ✓' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Sonnet 5.5 主管 · Haiku 4.5 ✓' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✕ 出错' })).toBeDefined()
  expect(await shownIncludes(ui, '<task-notification>')).toBe(false)
  expect(await shownIncludes(ui, '<task-id>')).toBe(false)
  expect(await shownIncludes(ui, '<ci-monitor-event>')).toBe(false)
  expect(optionLabels(await ui.find({ type: 'Select', key: 'filter-project' }))).toEqual(['全部项目', 'fj（2）'])
  expect(await shownIncludes(ui, '只显示最近 40 轮')).toBe(false)
  // 折叠只影响显示，共享目录里的原始轮次还在
  expect(JSON.parse(fileMap.get(`${ROUNDS_DIR}/s-a.json`)!.text)).toHaveLength(3)

  await ui.press({ key: 'open-a-user' })
  expect(await ui.find({ type: 'Text', text: '会话甲的问题' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /用时 45 秒/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /用时 10 秒/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '甲用户的子代理' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '甲第一次回报' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '甲第二次回报' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '乙会话的子代理' })).toBeUndefined()
  expect(await shownIncludes(ui, '<task-notification>')).toBe(false)
  expect(await shownIncludes(ui, '<task-id>')).toBe(false)
  expect(await tokenCells(ui, 'Opus 5.5（主管）')).toEqual(['Opus 5.5（主管）', '1k', '200', '0'])
  await ui.press({ key: 'back' })

  await ui.press({ key: 'open-b-sys' })
  expect(await ui.find({ type: 'Text', text: '后台任务回报' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '乙会话的子代理' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '甲用户的子代理' })).toBeUndefined()
  expect(await shownIncludes(ui, '<ci-monitor-event>')).toBe(false)
  expect(await shownIncludes(ui, 'build finished')).toBe(false)
  await ui.unmount()
})

function foldAgent(id: string): RoundAgent {
  return {
    id,
    toolUseId: `tu-${id}`,
    subagentType: 'Explore',
    description: id,
    model: 'claude-haiku-4-5-20251001',
    status: 'done',
    startedAt: 1_000,
    finishedAt: 2_000,
  }
}

function foldRound(part: Pick<Round, 'id' | 'sessionId' | 'text' | 'startedAt'> & Partial<Round>): Round {
  return {
    id: part.id,
    sessionId: part.sessionId,
    project: part.project ?? { name: 'fj', path: '/projects/fj' },
    env: part.env ?? 'desktop',
    text: part.text,
    mainModel: part.mainModel ?? 'claude-opus-5-5',
    startedAt: part.startedAt,
    finishedAt: part.finishedAt === undefined ? part.startedAt + 1_000 : part.finishedAt,
    status: part.status ?? 'answer',
    agents: part.agents ?? [],
    selfLines: part.selfLines ?? 0,
  }
}

test('headless 轮次并入同一会话的上一条用户轮次', () => {
  const user = foldRound({
    id: 'user',
    sessionId: 's-a',
    text: '可以，出计划',
    startedAt: 1_000,
    finishedAt: 2_000,
    agents: [foldAgent('ag-user')],
    selfLines: 2,
  })
  const head = foldRound({
    id: 'head',
    sessionId: 's-a',
    env: 'headless',
    text: '外派逐任务执行',
    startedAt: 5_000,
    finishedAt: 9_000,
    status: 'error',
    agents: [foldAgent('ag-head')],
    selfLines: 4,
  })
  const other = foldRound({
    id: 'other',
    sessionId: 's-b',
    text: '另一个会话',
    startedAt: 6_000,
    agents: [foldAgent('ag-other')],
  })
  const folded = foldSystemRounds([head, other, user])
  expect(folded.map(round => round.id)).toEqual(['other', 'user'])
  const kept = folded.find(round => round.id === 'user')
  expect(kept?.agents.map(agent => agent.id)).toEqual(['ag-user', 'ag-head'])
  expect(kept?.finishedAt).toBe(9_000)
  expect(kept?.status).toBe('error')
  expect(kept?.selfLines).toBe(6)
  expect(kept?.text).toBe('可以，出计划')
  expect(folded.find(round => round.id === 'other')?.agents.map(agent => agent.id)).toEqual(['ag-other'])
})

test('会话首条就是 headless 时保留', () => {
  const first = foldRound({
    id: 'first',
    sessionId: 's-a',
    env: 'headless',
    text: '跑探针',
    startedAt: 1_000,
    agents: [foldAgent('ag-first')],
  })
  const second = foldRound({
    id: 'second',
    sessionId: 's-a',
    env: 'headless',
    text: '还没人说话',
    startedAt: 2_000,
    agents: [foldAgent('ag-second')],
  })
  const user = foldRound({
    id: 'user',
    sessionId: 's-a',
    text: '构建并安装',
    startedAt: 10_000,
    finishedAt: 11_000,
    agents: [foldAgent('ag-user')],
  })
  const later = foldRound({
    id: 'later',
    sessionId: 's-a',
    env: 'headless',
    text: '外派逐任务执行',
    startedAt: 12_000,
    finishedAt: 15_000,
    agents: [foldAgent('ag-later')],
  })
  const folded = foldSystemRounds([later, user, second, first])
  expect(folded.map(round => round.id)).toEqual(['user', 'second', 'first'])
  expect(folded.find(round => round.id === 'first')?.text).toBe('跑探针')
  expect(folded.find(round => round.id === 'second')?.agents.map(agent => agent.id)).toEqual(['ag-second'])
  expect(folded.find(round => round.id === 'user')?.agents.map(agent => agent.id)).toEqual(['ag-user', 'ag-later'])
  expect(folded.find(round => round.id === 'user')?.finishedAt).toBe(15_000)
})

test('新旧 sessionId 的重复消息只出现一次，子代理合并', () => {
  const groups = new Map<string, string>([
    ['sid-old', 'desk-1'],
    ['sid-new', 'desk-1'],
  ])
  const older = foldRound({
    id: 'old',
    sessionId: 'sid-old',
    text: '记者更新 README',
    startedAt: 10_000,
    finishedAt: 12_000,
    status: 'aborted',
    agents: [foldAgent('ag-old')],
    selfLines: 1,
  })
  const newer = foldRound({
    id: 'new',
    sessionId: 'sid-new',
    text: '记者更新 README',
    startedAt: 22_000,
    finishedAt: 80_000,
    agents: [foldAgent('ag-new')],
    selfLines: 5,
  })
  const unrelated = foldRound({
    id: 'other',
    sessionId: 'sid-other',
    text: '记者更新 README',
    startedAt: 15_000,
    finishedAt: 16_000,
    agents: [foldAgent('ag-other')],
  })
  const folded = foldSystemRounds([newer, unrelated, older], groups)
  expect(folded.map(round => round.id)).toEqual(['other', 'old'])
  const kept = folded.find(round => round.id === 'old')
  expect(kept?.startedAt).toBe(10_000)
  expect(kept?.finishedAt).toBe(80_000)
  expect(kept?.status).toBe('answer')
  expect(kept?.agents.map(agent => agent.id)).toEqual(['ag-old', 'ag-new'])
  expect(kept?.selfLines).toBe(6)
  expect(folded.find(round => round.id === 'other')?.agents.map(agent => agent.id)).toEqual(['ag-other'])

  const again = foldRound({
    id: 'again',
    sessionId: 'sid-same',
    text: '同一句话',
    startedAt: 30_000,
    finishedAt: 40_000,
    agents: [foldAgent('ag-again')],
  })
  const firstCopy = foldRound({
    id: 'copy',
    sessionId: 'sid-same',
    text: '同一句话',
    startedAt: 1_000,
    finishedAt: 2_000,
    agents: [foldAgent('ag-copy')],
  })
  const sameSession = foldSystemRounds([again, firstCopy])
  expect(sameSession.map(round => round.id)).toEqual(['copy'])
  expect(sameSession[0]?.agents.map(agent => agent.id)).toEqual(['ag-copy', 'ag-again'])
})

test('text 相同但相差超过 120 秒的不合并', () => {
  const groups = new Map<string, string>([
    ['sid-old', 'desk-1'],
    ['sid-new', 'desk-1'],
  ])
  const earlier = foldRound({
    id: 'early',
    sessionId: 'sid-old',
    text: 'Commit and push',
    startedAt: 1_000,
    agents: [foldAgent('ag-early')],
  })
  const later = foldRound({
    id: 'late',
    sessionId: 'sid-new',
    text: 'Commit and push',
    startedAt: 1_000 + 120_001,
    agents: [foldAgent('ag-late')],
  })
  const apart = foldSystemRounds([later, earlier], groups)
  expect(apart.map(round => round.id)).toEqual(['late', 'early'])
  expect(apart[0]?.agents.map(agent => agent.id)).toEqual(['ag-late'])
  expect(apart[1]?.agents.map(agent => agent.id)).toEqual(['ag-early'])

  const edge = foldRound({
    id: 'edge',
    sessionId: 'sid-new',
    text: 'Commit and push',
    startedAt: 1_000 + 120_000,
    finishedAt: 130_000,
    agents: [foldAgent('ag-edge')],
  })
  const within = foldSystemRounds([edge, earlier], groups)
  expect(within.map(round => round.id)).toEqual(['early'])
  expect(within[0]?.startedAt).toBe(1_000)
  expect(within[0]?.finishedAt).toBe(130_000)
  expect(within[0]?.agents.map(agent => agent.id)).toEqual(['ag-early', 'ag-edge'])
})

test('换 sessionId 时记下的同一条消息结尾略有不同也只出现一次，保留较长的正文', () => {
  const groups = new Map<string, string>([
    ['sid-old', 'desk-1'],
    ['sid-new', 'desk-1'],
  ])
  const base = '记者更新 README 文件。而且现在 GPT 出了一个 Image 2.6 的模型，可以生成 Gif 图'
  const older = foldRound({ id: 'old', sessionId: 'sid-old', text: `${base}，所以你也可以调用`, startedAt: 10_000, finishedAt: 12_000, agents: [foldAgent('ag-old')] })
  const newer = foldRound({ id: 'new', sessionId: 'sid-new', text: `${base}，所以你也可以调用 Image GPT`, startedAt: 22_000, finishedAt: 80_000, agents: [foldAgent('ag-new')] })
  // 不同消息：开头相同但很快分叉，不合并
  const other = foldRound({ id: 'other', sessionId: 'sid-new', text: '记者更新 README 之外，再看看别的问题吧好不好呀', startedAt: 30_000, finishedAt: 31_000 })
  const out = foldSystemRounds([older, newer, other], groups)
  expect(out.length).toBe(2)
  const kept = out.find(r => r.id === 'old')
  expect(kept?.text).toBe(`${base}，所以你也可以调用 Image GPT`)
  expect(kept?.agents.length).toBe(2)
  expect(out.some(r => r.id === 'other')).toBe(true)
})

function goalTask(text: string) {
  return `角色：review\n\n## 目标\n${text}\n`
}

function runningJob(p: { id: string; provider: string; model: string; startedAt: string; task: string; status?: string }) {
  return {
    id: p.id,
    provider: p.provider,
    model: p.model,
    write: false,
    status: p.status ?? 'running',
    startedAt: p.startedAt,
    finishedAt: null,
    task: p.task,
    changedFiles: 0,
    role: 'review',
    reason: '',
    verdict: null,
    verdictNote: '',
  }
}

async function bandLine(ui: { drawn: () => Promise<unknown> }) {
  return visibleTexts(await ui.drawn()).join('')
}

test('输入框上方：没有进行中的子任务时不渲染提示条', async ($, on) => {
  baseStubs(on)
  // 没有提示条时钩子把绘制交回去。测试里没有引擎的默认绘制，这里补一棵空树
  on('ui.render', () => ({ type: 'Text', children: [] }))
  const relay = fakeRelay(on)
  relay.jobs = JSON.stringify([
    runningJob({ id: 'j-done', provider: 'grok', model: 'default', startedAt: '2026-11-04T07:01:00.000Z', task: goalTask('已经做完'), status: 'done' }),
  ])
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-4-5-20251001', agentId: `ag-${e.subagentType}` }))
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '这一轮没有外派', turnId: 't-empty' })
  await $.turn.complete({ turnId: 't-empty', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  const band = await $.ui.mount({ ...ABOVE, surface: 'desktop' })
  expect(await bandLine(band)).not.toContain('个子任务进行中')
  expect(await band.find({ type: 'Button', key: 'relay-running-view' })).toBeUndefined()
  await band.unmount()

  // 问卷占着输入框上方时，即使有子任务也让开
  await $.turn.start({ text: '问卷优先', turnId: 't-survey' })
  await $.agent.spawn({ tool_use_id: 'tu-survey', prompt: '看一下', description: '看一下', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false })
  const survey = await $.ui.mount({ ...ABOVE, surface: 'desktop', props: { ...ABOVE.props, hasSurvey: true } })
  expect(await bandLine(survey)).not.toContain('个子任务进行中')
  expect(await survey.find({ type: 'Button', key: 'relay-running-view' })).toBeUndefined()
  await survey.unmount()
})

test('输入框上方：两个进行中的外派按「模型 简述 时长」排成一行', async ($, on) => {
  let t = Date.parse('2026-11-04T07:00:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  // 07:05:00 看：Grok 已跑 3 分 12 秒，Gemini 已跑 2 分 40 秒
  relay.jobs = JSON.stringify([
    runningJob({ id: 'j-grok', provider: 'grok', model: 'default', startedAt: '2026-11-04T07:01:48.000Z', task: goalTask('审后端') }),
    runningJob({ id: 'j-gem', provider: 'agy', model: 'gemini-3.8-flash', startedAt: '2026-11-04T07:02:20.000Z', task: goalTask('审前端') }),
  ])
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '派两个人审', turnId: 't-two' })
  t = Date.parse('2026-11-04T07:05:00.000Z')

  const band = await $.ui.mount({ ...ABOVE, surface: 'desktop' })
  expect(await bandLine(band)).toBe('⏳ 2 个子任务进行中 · Grok 审后端 3 分 12 秒 · Gemini 3.8 Flash 审前端 2 分 40 秒')
  const head = await band.find({ type: 'Text', text: '⏳ 2' })
  expect(head?.props.weight).toBe('medium')
  expect(head?.props.dimColor).toBeFalsy()
  const detail = await band.find({ type: 'Text', text: /个子任务进行中/ })
  expect(detail?.props.dimColor).toBe(true)
  expect(detail?.props.wrap).toBe('truncate-end')
  const root = asDrawn(await band.drawn())
  expect(root?.props?.flexDirection).toBe('row')
  expect(root?.props?.flexWrap).toBe('nowrap')
  await band.unmount()
})

test('输入框上方：超过 3 个只列前 3 个，并写等 N 个', async ($, on) => {
  let t = Date.parse('2026-11-04T07:00:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  relay.jobs = JSON.stringify([
    runningJob({ id: 'j-grok', provider: 'grok', model: 'default', startedAt: '2026-11-04T07:01:00.000Z', task: goalTask('审后端') }),
    runningJob({ id: 'j-gem', provider: 'agy', model: 'gemini-3.8-flash', startedAt: '2026-11-04T07:02:00.000Z', task: goalTask('审前端') }),
    runningJob({ id: 'j-argon', provider: 'agy', model: 'gemini-4-argon', startedAt: '2026-11-04T07:03:00.000Z', task: goalTask('看数据') }),
  ])
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', (_, e) => ({ model: 'claude-sonnet-5-5', agentId: `ag-${e.subagentType}` }))
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '四个人一起', turnId: 't-four' })
  await $.agent.spawn({ tool_use_id: 'tu-codex', prompt: '改接口', description: '改接口', subagentType: 'codex:codex-rescue', provider: { plugin: 'codex', tier: 'user' }, parentModel: 'claude-opus-5-5', background: true, fork: false })
  t = Date.parse('2026-11-04T07:05:00.000Z')

  const band = await $.ui.mount({ ...ABOVE, surface: 'desktop' })
  const line = await bandLine(band)
  expect(line).toContain('⏳ 4 个子任务进行中')
  expect(line).toContain('Codex 改接口')
  expect(line).toContain('Grok 审后端')
  expect(line).toContain('Gemini 3.8 Flash 审前端')
  expect(line).toContain('等 1 个')
  expect(line).not.toContain('看数据')
  expect(line).not.toContain('Gemini 4 Argon')
  await band.unmount()
})

test('输入框上方：只算当前会话，其他会话的子任务不算', async ($, on) => {
  let t = Date.parse('2026-11-04T07:00:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  const other: Round = {
    id: 't-other',
    sessionId: 's-other',
    project: { name: 'other', path: '/projects/other' },
    env: 'desktop',
    text: '另一个会话',
    mainModel: 'claude-opus-5-5',
    startedAt: Date.parse('2026-11-04T06:00:00.000Z'),
    finishedAt: null,
    status: 'running',
    agents: [{
      id: 'ag-other',
      toolUseId: 'tu-other',
      subagentType: 'Explore',
      description: '别的会话任务',
      model: 'claude-haiku-4-5-20251001',
      status: 'running',
      startedAt: Date.parse('2026-11-04T06:30:00.000Z'),
      finishedAt: null,
    }],
    selfLines: 0,
  }
  relay.jobs = JSON.stringify([
    runningJob({ id: 'j-mine', provider: 'grok', model: 'default', startedAt: '2026-11-04T07:01:00.000Z', task: goalTask('审后端') }),
    runningJob({ id: 'j-other', provider: 'agy', model: 'gemini-3.8-flash', startedAt: '2026-11-04T02:00:00.000Z', task: goalTask('其他会话外派') }),
  ])
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-4-5-20251001', agentId: `ag-${e.subagentType}` }))
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  putRoundFile('s-other', [other], t)
  await $.turn.start({ text: '只看本会话', turnId: 't-mine' })
  await $.agent.spawn({ tool_use_id: 'tu-mine', prompt: '查找本会话里全部的导出代码', description: '查找本会话里全部的导出代码', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false })
  t = Date.parse('2026-11-04T07:05:00.000Z')
  // 对话页会把其他会话读进 allRounds；提示条不能跟着算进去
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab-jobs' })
  await pane.select({ key: 'filter-project', value: '' })
  expect(await pane.find({ type: 'Text', text: '另一个会话' })).toBeDefined()
  await pane.unmount()

  const band = await $.ui.mount({ ...ABOVE, surface: 'desktop' })
  const line = await bandLine(band)
  expect(line).toContain('⏳ 2 个子任务进行中')
  expect(line).toContain('Haiku 4.5 查找本会话里全部的导出代')
  expect(line).not.toContain('查找本会话里全部的导出代码')
  expect(line).toContain('Grok 审后端')
  expect(line).not.toContain('别的会话任务')
  expect(line).not.toContain('其他会话外派')
  await band.unmount()
})

test('输入框上方：带 sessionId 的他会话外派，时间重叠也不进本会话提示条', async ($, on) => {
  let t = Date.parse('2026-11-04T07:00:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  const other: Round = {
    id: 't-other',
    sessionId: 's-other',
    project: { name: 'other', path: '/projects/other' },
    env: 'desktop',
    text: '另一个会话',
    mainModel: 'claude-sonnet-5-5',
    startedAt: Date.parse('2026-11-04T07:00:00.000Z'),
    finishedAt: null,
    status: 'running',
    agents: [],
    selfLines: 0,
  }
  relay.jobs = JSON.stringify([
    { ...runningJob({ id: 'j-mine', provider: 'grok', model: 'default', startedAt: '2026-11-04T07:01:00.000Z', task: goalTask('本会话外派') }), sessionId: 's-cur' },
    { ...runningJob({ id: 'j-other', provider: 'agy', model: 'gemini-3.8-flash', startedAt: '2026-11-04T07:01:30.000Z', task: goalTask('他会话重叠外派') }), sessionId: 's-other' },
    { ...runningJob({ id: 'j-old', provider: 'agy', model: 'gemini-4-argon', startedAt: '2026-11-04T07:02:00.000Z', task: goalTask('旧记录外派') }), cwd: '/projects/fj' },
  ])
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  putRoundFile('s-other', [other], t)
  await $.turn.start({ text: '本会话这一轮', turnId: 't-mine' })
  t = Date.parse('2026-11-04T07:05:00.000Z')

  const band = await $.ui.mount({ ...ABOVE, surface: 'desktop' })
  const line = await bandLine(band)
  expect(line).toContain('⏳ 2 个子任务进行中')
  expect(line).toContain('Grok 本会话外派')
  expect(line).toContain('Gemini 4 Argon 旧记录外派')
  expect(line).not.toContain('他会话重叠外派')
  expect(line).not.toContain('Gemini 3.8 Flash')
  await band.unmount()

  // 对话页同一套归属：他会话的任务挂到他的轮次，不进本会话
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab-jobs' })
  await pane.select({ key: 'filter-project', value: '' })
  expect(await pane.find({ type: 'Text', text: 'Opus 5.5 主管 · Grok ● · Gemini 4 Argon ●' })).toBeDefined()
  // 没有 sessionId 的旧记录只归同一项目里最近的用户轮次，不再因为时间重叠进另一个项目
  expect(await pane.find({ type: 'Text', text: 'Sonnet 5.5 主管 · Gemini 3.8 Flash ●' })).toBeDefined()
  await pane.press({ key: 'open-t-mine' })
  expect(await shownIncludes(pane, '本会话外派')).toBe(true)
  expect(await shownIncludes(pane, '旧记录外派')).toBe(true)
  expect(await shownIncludes(pane, '他会话重叠外派')).toBe(false)
  await pane.unmount()
})

test('输入框上方：子任务结束后提示条消失', async ($, on) => {
  baseStubs(on)
  on('ui.render', () => ({ type: 'Text', children: [] }))
  fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-4-5-20251001', agentId: `ag-${e.subagentType}` }))
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '先派一个', turnId: 't-end' })
  await $.agent.spawn({ tool_use_id: 'tu-end', prompt: '找导出代码', description: '找导出代码', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false })

  const band = await $.ui.mount({ ...ABOVE, surface: 'desktop' })
  expect(await bandLine(band)).toContain('⏳ 1 个子任务进行中')
  expect(await bandLine(band)).toContain('Haiku 4.5 找导出代码')
  await $.turn.complete({ turnId: 't-end', agentId: 'ag-Explore', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  expect(await bandLine(band)).not.toContain('个子任务进行中')
  expect(await band.find({ type: 'Button', key: 'relay-running-view' })).toBeUndefined()
  await band.unmount()
})

test('输入框上方：查看按钮打开面板并切到对话页', async ($, on) => {
  const opened = baseStubs(on)
  fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-4-5-20251001', agentId: `ag-${e.subagentType}` }))
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '打开对话页', turnId: 't-open' })
  await $.agent.spawn({ tool_use_id: 'tu-open', prompt: '看进度', description: '看进度', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false })

  const band = await $.ui.mount({ ...ABOVE, surface: 'desktop' })
  expect(opened.has('relay-quota')).toBe(false)
  await band.press({ key: 'relay-running-view' })
  expect(opened.has('relay-quota')).toBe(true)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Button', key: 'tab-jobs' }))?.props.variant).toBe('primary')
  expect((await pane.find({ type: 'Button', key: 'tab-quota' }))?.props.variant).toBe('secondary')
  expect(await pane.find({ type: 'Text', text: '所有项目的对话，最新的在前' })).toBeDefined()
  await pane.unmount()
  await band.unmount()

  // 手机端有 Button 时同样显示文字；按钮是次要样式，不比输入框抢眼
  const mobile = await $.ui.mount({ ...ABOVE, surface: 'mobile' })
  expect(await bandLine(mobile)).toContain('个子任务进行中')
  expect((await mobile.find({ type: 'Button', key: 'relay-running-view' }))?.props.dimColor).toBe(true)
  await mobile.unmount()
})

function showAgent(id: string, status: string, startedAt: number, subagentType = 'Explore'): RoundAgent {
  return {
    id,
    toolUseId: `tu-${id}`,
    subagentType,
    description: id,
    model: 'claude-haiku-4-5-20251001',
    status,
    startedAt,
    finishedAt: status === 'running' ? null : startedAt + 1_000,
  }
}

function showRound(part: Pick<Round, 'id' | 'text' | 'startedAt' | 'status'> & Partial<Round>): Round {
  return {
    id: part.id,
    sessionId: part.sessionId ?? 's-show',
    project: part.project ?? { name: 'fj', path: '/projects/fj' },
    env: part.env ?? 'desktop',
    text: part.text,
    mainModel: part.mainModel ?? 'claude-opus-5-5',
    startedAt: part.startedAt,
    finishedAt: part.finishedAt === undefined ? part.startedAt + 60_000 : part.finishedAt,
    status: part.status,
    agents: part.agents ?? [],
    selfLines: part.selfLines ?? 0,
  }
}

function showJob(part: { id: string; status: string; startedAt: string; sessionId?: string; finishedAt?: string | null }) {
  return {
    id: part.id,
    provider: 'agy',
    model: 'gemini-3.8-flash-high',
    role: 'read',
    write: false,
    status: part.status,
    startedAt: part.startedAt,
    finishedAt: part.finishedAt === undefined ? null : part.finishedAt,
    task: '通读这一段',
    changedFiles: 0,
    reason: '',
    verdict: part.status === 'done' ? 'pass' : null,
    verdictNote: '',
    sessionId: part.sessionId ?? 's-show',
  }
}

test('对话页：主轮次已答完但有子代理进行中时列表显示等子任务，用时算到现在', async ($, on) => {
  const T0 = Date.parse('2026-11-06T07:00:00.000Z')
  const now = T0 + 5 * 60_000
  baseStubs(on, new Set<string>(), () => now)
  putRoundFile('s-show', [
    showRound({
      id: 't-wait-agent',
      text: '子代理还在跑',
      startedAt: T0,
      finishedAt: T0 + 60_000,
      status: 'answer',
      agents: [showAgent('ag-run', 'running', T0 + 10_000)],
    }),
    showRound({
      id: 't-self',
      text: '主模型自己还在答',
      startedAt: T0 + 1_000,
      finishedAt: null,
      status: 'running',
      agents: [showAgent('ag-self', 'running', T0 + 2_000)],
    }),
    showRound({
      id: 't-error',
      text: '出错但仍有子代理',
      startedAt: T0 + 2_000,
      finishedAt: T0 + 62_000,
      status: 'error',
      agents: [showAgent('ag-err', 'running', T0 + 3_000)],
    }),
  ], now)
  fakeRelay(on)
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })

  // 答完和出错的两轮都在等子任务；本轮自己还在答的仍是进行中。颜色与进行中相同
  expect(await ui.findAll({ type: 'Text', text: '● 等子任务' })).toHaveLength(2)
  const waiting = await ui.find({ type: 'Text', text: '● 等子任务' })
  const running = await ui.find({ type: 'Text', text: '● 进行中' })
  expect(running).toBeDefined()
  expect(waiting?.props.color).toBe('warning')
  expect(waiting?.props.color).toBe(running?.props.color)
  expect(await ui.find({ type: 'Text', text: '✓ 完成' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '✕ 出错' })).toBeUndefined()
  expect(await shownIncludes(ui, '5 分钟')).toBe(true)
  expect(await shownIncludes(ui, '1 分钟')).toBe(false)
  // 只改显示，文件里的状态还是答完
  const saved = JSON.parse(fileMap.get(`${ROUNDS_DIR}/s-show.json`)!.text) as Round[]
  expect(saved.find(r => r.id === 't-wait-agent')?.status).toBe('answer')

  await ui.press({ key: 'open-t-wait-agent' })
  const head = await ui.find({ type: 'Text', text: '● 等子任务（1 个进行中）' })
  expect(head).toBeDefined()
  expect(head?.props.color).toBe('warning')
  expect(await ui.find({ type: 'Text', text: /用时 5 分钟/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /用时 1 分钟/ })).toBeUndefined()
  await ui.unmount()
})

test('对话页：主轮次已答完但 relay 外派进行中时列表显示等子任务', async ($, on) => {
  const T0 = Date.parse('2026-11-06T08:00:00.000Z')
  const now = T0 + 5 * 60_000
  baseStubs(on, new Set<string>(), () => now)
  putRoundFile('s-show', [
    showRound({
      id: 't-wait-job',
      text: '外派还在跑',
      startedAt: T0,
      finishedAt: T0 + 60_000,
      status: 'answer',
      agents: [showAgent('ag-done', 'done', T0 + 5_000)],
    }),
  ], now)
  const relay = fakeRelay(on)
  relay.jobs = JSON.stringify([
    showJob({ id: 'j-run', status: 'running', startedAt: new Date(T0 + 10_000).toISOString() }),
    // 别的会话时间重叠也不算进这一轮
    showJob({ id: 'j-other', status: 'running', startedAt: new Date(T0 + 10_000).toISOString(), sessionId: 's-other' }),
  ])
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })

  expect(await ui.find({ type: 'Text', text: '● 等子任务' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓ 完成' })).toBeUndefined()
  expect(await shownIncludes(ui, '5 分钟')).toBe(true)
  expect(await shownIncludes(ui, '1 分钟')).toBe(false)

  await ui.press({ key: 'open-t-wait-job' })
  expect(await ui.find({ type: 'Text', text: '● 等子任务（1 个进行中）' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /用时 5 分钟/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '● 进行中' })).toBeDefined()
  await ui.unmount()
})

test('对话页：子任务都结束后轮次显示完成，用时停在结束时间', async ($, on) => {
  const T0 = Date.parse('2026-11-06T09:00:00.000Z')
  const now = T0 + 5 * 60_000
  baseStubs(on, new Set<string>(), () => now)
  putRoundFile('s-show', [
    showRound({
      id: 't-done',
      text: '子任务都结束了',
      startedAt: T0,
      finishedAt: T0 + 60_000,
      status: 'answer',
      agents: [showAgent('ag-done', 'done', T0 + 5_000), showAgent('ag-codex', 'done', T0 + 8_000, 'codex:codex-rescue')],
    }),
  ], now)
  const relay = fakeRelay(on)
  relay.jobs = JSON.stringify([
    showJob({
      id: 'j-done',
      status: 'done',
      startedAt: new Date(T0 + 10_000).toISOString(),
      finishedAt: new Date(T0 + 40_000).toISOString(),
    }),
  ])
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })

  expect(await ui.find({ type: 'Text', text: '✓ 完成' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /等子任务/ })).toBeUndefined()
  expect(await shownIncludes(ui, '1 分钟')).toBe(true)
  expect(await shownIncludes(ui, '5 分钟')).toBe(false)

  await ui.press({ key: 'open-t-done' })
  expect(await ui.find({ type: 'Text', text: '✓ 完成' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /等子任务/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /用时 1 分钟/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /用时 5 分钟/ })).toBeUndefined()
  await ui.unmount()
})

test('对话页：多个子任务进行中时详情头部写出个数', async ($, on) => {
  const T0 = Date.parse('2026-11-06T10:00:00.000Z')
  const now = T0 + 3 * 60_000
  baseStubs(on, new Set<string>(), () => now)
  putRoundFile('s-show', [
    showRound({
      id: 't-two',
      text: '一个子代理加一个外派',
      startedAt: T0,
      finishedAt: T0 + 30_000,
      status: 'answer',
      agents: [showAgent('ag-run', 'running', T0 + 5_000), showAgent('ag-codex', 'running', T0 + 6_000, 'codex:codex-rescue')],
    }),
  ], now)
  const relay = fakeRelay(on)
  relay.jobs = JSON.stringify([
    showJob({ id: 'j-run', status: 'running', startedAt: new Date(T0 + 8_000).toISOString() }),
  ])
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })

  expect(await ui.find({ type: 'Text', text: '● 等子任务' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /个进行中/ })).toBeUndefined()

  await ui.press({ key: 'open-t-two' })
  expect(await ui.find({ type: 'Text', text: '● 等子任务（3 个进行中）' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /用时 3 分钟/ })).toBeDefined()
  await ui.unmount()
})

test('输入框上方：任务开始于轮次结束之后仍归到该轮，提示条显示', async ($, on) => {
  let t = Date.parse('2026-11-06T05:32:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  // 没有 sessionId，目录对得上本项目；开始时间晚于这一轮的结束时间
  relay.jobs = JSON.stringify([
    {
      ...runningJob({ id: 'j-after', provider: 'agy', model: 'gemini-3.8-flash', startedAt: new Date(t + 70_000).toISOString(), task: goalTask('轮次结束后才启动') }),
      cwd: '/projects/fj',
    },
    {
      ...runningJob({ id: 'j-other-proj', provider: 'grok', model: 'default', startedAt: new Date(t + 80_000).toISOString(), task: goalTask('别的项目') }),
      cwd: '/projects/other',
    },
  ])
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '按推荐做', turnId: 't-late' })
  t += 50_000
  await $.turn.complete({ turnId: 't-late', reason: 'answer', answer: '', durationMs: 50_000, isAborted: false })

  const band = await $.ui.mount({ ...ABOVE, surface: 'desktop' })
  const line = await bandLine(band)
  expect(line).toContain('⏳ 1 个子任务进行中')
  expect(line).toContain('Gemini 3.8 Flash 轮次结束后才启动')
  expect(line).not.toContain('别的项目')
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab-jobs' })
  expect(await pane.find({ type: 'Text', text: '● 等子任务' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Opus 5.5 主管 · Gemini 3.8 Flash ●' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '未归入对话的外派' })).toBeDefined()
  await pane.press({ key: 'open-t-late' })
  expect(await shownIncludes(pane, '轮次结束后才启动')).toBe(true)
  expect(await shownIncludes(pane, '别的项目')).toBe(false)
  await pane.unmount()
})

function verdictJob(part: { id: string; verdict: string | null; startedAt: string }) {
  return {
    id: part.id,
    provider: 'agy',
    model: 'gemini-3.8-flash',
    role: 'review',
    write: false,
    status: 'done',
    startedAt: part.startedAt,
    finishedAt: new Date(Date.parse(part.startedAt) + 60_000).toISOString(),
    task: goalTask(part.id),
    changedFiles: 0,
    reason: '',
    verdict: part.verdict,
    verdictNote: '',
    sessionId: 's-show',
  }
}

test('对话页：外派完成只显示主管验收的四种文案，未记结论用次要文字', async ($, on) => {
  const T0 = Date.parse('2026-11-06T11:00:00.000Z')
  const now = T0 + 5 * 60_000
  baseStubs(on, new Set<string>(), () => now)
  putRoundFile('s-show', [
    showRound({
      id: 't-verdict',
      text: '四个外派都结束了',
      startedAt: T0,
      finishedAt: T0 + 60_000,
      status: 'answer',
    }),
  ], now)
  const relay = fakeRelay(on)
  const started = new Date(T0 + 10_000).toISOString()
  relay.jobs = JSON.stringify([
    verdictJob({ id: 'j-none', verdict: null, startedAt: started }),
    verdictJob({ id: 'j-pass', verdict: 'pass', startedAt: new Date(T0 + 11_000).toISOString() }),
    verdictJob({ id: 'j-partial', verdict: 'partial', startedAt: new Date(T0 + 12_000).toISOString() }),
    verdictJob({ id: 'j-fail', verdict: 'fail', startedAt: new Date(T0 + 13_000).toISOString() }),
  ])
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })

  expect(await ui.find({ type: 'Text', text: '✓ 完成' })).toBeDefined()
  const note = await ui.find({ type: 'Text', text: /· 1 个子任务未记验收结论/ })
  expect(note?.props.dimColor).toBe(true)
  expect(note?.props.color).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /待验收/ })).toBeUndefined()

  await ui.press({ key: 'open-t-verdict' })
  expect(await ui.find({ type: 'Text', text: '○ 完成 · 等主管验收' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓ 主管已验收' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◐ 主管判部分通过' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✗ 主管判不通过' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /待验收/ })).toBeUndefined()
  const detailNote = await ui.find({ type: 'Text', text: /· 1 个子任务未记验收结论/ })
  expect(detailNote?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('对话页：子任务都结束且主管还在处理时显示主管验收中', async ($, on) => {
  const T0 = Date.parse('2026-11-06T12:00:00.000Z')
  const now = T0 + 5 * 60_000
  baseStubs(on, new Set<string>(), () => now)
  putRoundFile('s-show', [
    showRound({
      id: 't-user',
      text: '按推荐做',
      startedAt: T0,
      finishedAt: T0 + 50_000,
      status: 'answer',
      agents: [showAgent('ag-done', 'done', T0 + 10_000)],
    }),
    // 并入上面那一轮后，系统轮次仍在进行，显示成主管验收中
    showRound({
      id: 't-sys',
      text: '<task-notification>',
      startedAt: T0 + 60_000,
      finishedAt: null,
      status: 'running',
    }),
    showRound({
      id: 't-review',
      text: '子任务结束了主管还在看',
      startedAt: T0 + 90_000,
      finishedAt: null,
      status: 'running',
      agents: [showAgent('ag-review', 'done', T0 + 91_000)],
    }),
    showRound({
      id: 't-talk',
      text: '还在自己答',
      startedAt: T0 + 120_000,
      finishedAt: null,
      status: 'running',
    }),
  ], now)
  fakeRelay(on)
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })

  expect(await ui.findAll({ type: 'Text', text: '● 主管验收中' })).toHaveLength(2)
  expect(await ui.findAll({ type: 'Text', text: '● 进行中' })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: '<task-notification>' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /等子任务/ })).toBeUndefined()

  await ui.press({ key: 'open-t-user' })
  expect(await ui.find({ type: 'Text', text: '● 主管验收中' })).toBeDefined()
  await ui.unmount()
})

test('输入框上方：60 秒兜底拉取能发现轮次结束后才出现的外派', async ($, on) => {
  const T0 = Date.parse('2026-11-06T05:32:00.000Z')
  let t = T0
  const clock = mock.clock(on, { now: T0 })
  baseStubs(on, new Set<string>(), () => t, undefined, '/projects/fj', { stubClock: false })
  on('ui.render', () => ({ type: 'Text', children: [] }))
  const relay = fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '按推荐做', turnId: 't-poll' })
  await $.turn.complete({ turnId: 't-poll', reason: 'answer', answer: '', durationMs: 50_000, isAborted: false })

  const band = await $.ui.mount({ ...ABOVE, surface: 'desktop' })
  expect(await bandLine(band)).not.toContain('个子任务进行中')

  relay.jobs = JSON.stringify([
    {
      ...runningJob({ id: 'j-late', provider: 'agy', model: 'gemini-3.8-flash', startedAt: new Date(T0 + 70_000).toISOString(), task: goalTask('一分钟内出现') }),
      cwd: '/projects/fj',
    },
  ])
  await clock.advance(5_000)
  t = clock.now()
  expect(await bandLine(band)).not.toContain('个子任务进行中')

  await clock.advance(55_000)
  t = clock.now()
  const line = await bandLine(band)
  expect(line).toContain('⏳ 1 个子任务进行中')
  expect(line).toContain('一分钟内出现')
  await band.unmount()
})

test('settings 中 ai-relay@zm-local:false 时休眠：面板含"总开关"、不含"各模型剩余额度"，底栏 label 为 ai-relay · 已停用，钩子直接放行不写文件', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  // 底层渲染存根，供 AbovePrompt 在放行 (next(e)) 时使用
  on('ui.render', () => ({ type: 'Text', children: [] }))
  // 模拟 settings.json 中停用 ai-relay@zm-local
  fileMap.set(`${TEST_HOME}/.claude/settings.json`, {
    text: JSON.stringify({ enabledPlugins: { 'ai-relay@zm-local': false } }),
    mtimeMs: 1793712984000,
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-4-5-20251001', agentId: `ag-${e.subagentType}` }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '原生回答' }))

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })

  // 1. 底栏 label 检查
  const footer = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await footer.find({ type: 'Button', key: 'relay-quota' }))?.props.label).toBe('ai-relay · 已停用')
  await footer.unmount()

  // 2. 面板检查：含"总开关"，不含"各模型剩余额度"，不显示 tabs，只显示休眠提示
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '总开关' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '各模型剩余额度' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'tab-quota' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '重新启用后，其他页面在重启 Claude Code 后恢复' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^已停用：不再外派、不注入提示、不记录对话；重启 Claude Code 后完全生效$/ })).toBeDefined()
  // 停用状态下"停用"为 primary，"启用"为 secondary
  expect((await ui.find({ type: 'Button', key: 'relay-switch-disable' }))?.props.variant).toBe('primary')
  expect((await ui.find({ type: 'Button', key: 'relay-switch-enable' }))?.props.variant).toBe('secondary')
  await ui.unmount()

  // 3. 验证 session.start 没有启动定时器与调用 refresh
  expect(relay.calls.filter(c => c[0] === 'status' || c[0] === 'jobs')).toHaveLength(0)

  // 4. 钩子放行验证：turn.start 不新增轮次，tool.call 不写行数，agent.spawn 不记录，turn.complete 不改写
  const startRes = await $.turn.start({ text: '用户测试消息', turnId: 't-dormant' })
  expect(startRes).toEqual({ turnId: 't-dormant' })
  // 检查没有保存轮次文件
  expect(fileMap.has(`${ROUNDS_DIR}/s-cur.json`)).toBe(false)

  const agentRes = await $.agent.spawn({
    tool_use_id: 'tu-dormant',
    prompt: '子任务',
    description: '子任务描述',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  expect(agentRes).toEqual({ model: 'claude-haiku-4-5-20251001', agentId: 'ag-Explore' })

  await $.tool.call({ tool: 'Write', file_path: '/projects/fj/test.ts', content: 'test code' })
  expect(fileMap.has(`${ROUNDS_DIR}/s-cur.json`)).toBe(false)

  const completeRes = await $.turn.complete({ turnId: 't-dormant', reason: 'answer', answer: '原生回答', durationMs: 1000, isAborted: false })
  // 不追加汇总行
  expect(completeRes).toEqual({ text: '原生回答' })
  expect(fileMap.has(`${ROUNDS_DIR}/s-cur.json`)).toBe(false)

  // 5. AbovePrompt 不渲染提示条
  const band = await $.ui.mount({ ...ABOVE, surface: 'desktop' })
  expect(await bandLine(band)).toBe('')
  await band.unmount()
})

test('settings 中为 true 时额度页正常且含"总开关"', async ($, on) => {
  baseStubs(on)
  fakeRelay(on)
  fileMap.set(`${TEST_HOME}/.claude/settings.json`, {
    text: JSON.stringify({ enabledPlugins: { 'ai-relay@zm-local': true } }),
    mtimeMs: 1793712984000,
  })

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })

  // 底栏显示模式
  const footer = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await footer.find({ type: 'Button', key: 'relay-quota' }))?.props.label).toBe('ai-relay · 手动')
  await footer.unmount()

  // 面板显示额度页且顶端含总开关
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '总开关' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '各模型剩余额度' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '主模型' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'tab-quota' })).toBeDefined()
  // 启用状态下"启用"为 primary，"停用"为 secondary
  expect((await ui.find({ type: 'Button', key: 'relay-switch-enable' }))?.props.variant).toBe('primary')
  expect((await ui.find({ type: 'Button', key: 'relay-switch-disable' }))?.props.variant).toBe('secondary')
  expect(await ui.find({ type: 'Text', text: /^ai-relay 正在工作：外派任务、注入提示、记录对话和用量$/ })).toBeDefined()
  await ui.unmount()
})

test('点"停用"以 [*, "plugin", "disable", "ai-relay@zm-local"] 调用进程并切换为休眠', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  fileMap.set(`${TEST_HOME}/.claude/settings.json`, {
    text: JSON.stringify({ enabledPlugins: { 'ai-relay@zm-local': true } }),
    mtimeMs: 1793712984000,
  })

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '各模型剩余额度' })).toBeDefined()

  // 点击停用
  await ui.press({ key: 'relay-switch-disable' })

  // 验证进程调用：[*, 'plugin', 'disable', 'ai-relay@zm-local']
  expect(relay.pluginCalls.length).toBeGreaterThan(0)
  const lastCall = relay.pluginCalls[relay.pluginCalls.length - 1]!
  expect(lastCall[1]).toBe('plugin')
  expect(lastCall[2]).toBe('disable')
  expect(lastCall[3]).toBe('ai-relay@zm-local')

  // 验证 toast 提示
  expect(toastLog).toContain('已停用，重启 Claude Code 后完全生效')

  // 验证面板切换为休眠状态
  expect(await ui.find({ type: 'Text', text: '重新启用后，其他页面在重启 Claude Code 后恢复' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '各模型剩余额度' })).toBeUndefined()
  await ui.unmount()

  // 验证底栏切换为已停用
  const footer = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await footer.find({ type: 'Button', key: 'relay-quota' }))?.props.label).toBe('ai-relay · 已停用')
  await footer.unmount()
})

test('ai-relay-status@zm-local:false 不被当成 ai-relay 停用', async ($, on) => {
  baseStubs(on)
  fakeRelay(on)
  fileMap.set(`${TEST_HOME}/.claude/settings.json`, {
    text: JSON.stringify({ enabledPlugins: { 'ai-relay-status@zm-local': false } }),
    mtimeMs: 1793712984000,
  })

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })

  // 底栏正常显示模式，而不是已停用
  const footer = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await footer.find({ type: 'Button', key: 'relay-quota' }))?.props.label).toBe('ai-relay · 手动')
  await footer.unmount()

  // 面板显示完整的额度页
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '总开关' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '各模型剩余额度' })).toBeDefined()
  await ui.unmount()
})

test('由停用切回启用：以 [*, "plugin", "enable", "ai-relay@zm-local"] 调用进程，立即 refresh 并恢复面板', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  fileMap.set(`${TEST_HOME}/.claude/settings.json`, {
    text: JSON.stringify({ enabledPlugins: { 'ai-relay@zm-local': false } }),
    mtimeMs: 1793712984000,
  })

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '各模型剩余额度' })).toBeUndefined()

  // 点击启用
  await ui.press({ key: 'relay-switch-enable' })

  // 验证调用了 plugin enable
  expect(relay.pluginCalls.length).toBeGreaterThan(0)
  const lastCall = relay.pluginCalls[relay.pluginCalls.length - 1]!
  expect(lastCall[1]).toBe('plugin')
  expect(lastCall[2]).toBe('enable')
  expect(lastCall[3]).toBe('ai-relay@zm-local')

  // 验证 toast
  expect(toastLog).toContain('已启用，重启 Claude Code 后完全生效')

  // 验证立即触发了 refresh 和 refreshJobs
  expect(relay.calls.some(c => c[0] === 'status')).toBe(true)
  expect(relay.calls.some(c => c[0] === 'jobs')).toBe(true)

  // 验证面板恢复正常，显示各模型剩余额度
  expect(await ui.find({ type: 'Text', text: '各模型剩余额度' })).toBeDefined()
  await ui.unmount()

  // 验证底栏恢复
  const footer = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await footer.find({ type: 'Button', key: 'relay-quota' }))?.props.label).toBe('ai-relay · 手动')
  await footer.unmount()
})

test('总开关切换失败时显示错误并在按钮解除 busy', async ($, on) => {
  baseStubs(on)
  const relay = fakeRelay(on)
  relay.pluginFail = '模拟的停用失败错误：权限不足或配置冲突'
  fileMap.set(`${TEST_HOME}/.claude/settings.json`, {
    text: JSON.stringify({ enabledPlugins: { 'ai-relay@zm-local': true } }),
    mtimeMs: 1793712984000,
  })

  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'relay-switch-disable' })

  // 验证错误文字显示
  expect(await ui.find({ type: 'Text', text: /模拟的停用失败错误/ })).toBeDefined()
  // 验证按钮解除 busy（文字不再有“…”）
  expect((await ui.find({ type: 'Button', key: 'relay-switch-disable' }))?.props.label).toBe('停用')
  await ui.unmount()
})


test('主管用量：桌面换 session id、从 spares 切项目、跨文件重复 message.id 只计一次', async ($, on) => {
  const now = 1793945873085
  baseStubs(on, new Set<string>(), () => now)
  fakeRelay(on)
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  fileMap.set(`${TEST_HOME}/Library/Application Support/Claude/claude-code-sessions/org/account/local_demo.json`, {
    text: JSON.stringify({ cliSessionId: 's-new', priorCliSessionIds: ['s-old'], originCwd: '/projects/fj' }), mtimeMs: now,
  })
  const line = (id: string, input: number) => JSON.stringify({ type: 'assistant', timestamp: now - 1000, message: { id, usage: { input_tokens: input, output_tokens: 20, cache_read_input_tokens: 30 } } })
  fileMap.set(`${TEST_HOME}/.claude/projects/-home-tester--claude-spares-temp/s-old.jsonl`, { text: line('m1', 100), mtimeMs: now })
  fileMap.set(`${TEST_HOME}/.claude/projects/-projects-fj/s-old.jsonl`, { text: [line('m1', 100), line('m2', 200)].join('\n'), mtimeMs: now })
  fileMap.set(`${TEST_HOME}/.claude/projects/-projects-fj/s-new.jsonl`, { text: [line('m1', 100), line('m3', 300)].join('\n'), mtimeMs: now })
  // 无关会话即使目录、时间都相同也不能混入。
  fileMap.set(`${TEST_HOME}/.claude/projects/-projects-fj/unrelated.jsonl`, { text: line('wrong', 99999), mtimeMs: now })
  const r: Round = { id: 'r-switch', sessionId: 's-old', project: { name: 'java', path: '/projects/fj/src/main/java' }, env: 'desktop', text: '换目录', mainModel: 'claude-opus-5-5', startedAt: now - 5000, finishedAt: now, status: 'answer', agents: [], selfLines: 0 }
  putRoundFile('s-old', [r], now)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  await ui.press({ key: 'open-r-switch' })
  expect(await tokenCells(ui, 'Opus 5.5（主管）')).toEqual(['Opus 5.5（主管）', '600', '60', '90'])
  await ui.unmount()
})

test('主管用量：超过 4 MiB 时流式提取，失败附原因且不缓存，终端表格列对齐、合计加粗', async ($, on) => {
  const now = 1793945873085
  baseStubs(on, new Set<string>(), () => now)
  const r: Round = { id: 'r-large', sessionId: 's-cur', project: { name: 'fj', path: '/projects/fj' }, env: 'terminal', text: '大日志', mainModel: 'claude-opus-5-5', startedAt: now - 5000, finishedAt: now, status: 'answer', agents: [], selfLines: 0 }
  putRoundFile('s-cur', [r], now)
  const file = `${TEST_HOME}/.claude/projects/-projects-fj/s-cur.jsonl`
  fileMap.set(file, { text: 'x'.repeat(4 * 1024 * 1024 + 1), mtimeMs: now })
  let failed = true
  let calls = 0
  on('process.run', (_, e) => {
    if (e.argv[1] !== '-e') return ok('[]')
    calls++
    expect(e.argv[3]).toBe(file)
    expect(e.argv.slice(4)).toEqual([String(r.startedAt), String(r.finishedAt)])
    if (failed) return fail('读取失败')
    const line = JSON.stringify({ type: 'assistant', timestamp: now - 1000, message: { id: 'large-1', usage: { input_tokens: 42, cache_creation_input_tokens: 100, output_tokens: 23, cache_read_input_tokens: 55 } } })
    return ok([line, line].join('\n'))
  })
  await $.session.start({ cwd: '/projects/fj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-jobs' })
  await ui.press({ key: 'open-r-large' })
  expect(await tokenCells(ui, 'Opus 5.5（主管）')).toEqual(['Opus 5.5（主管）', '无数据（会话日志读取失败）'])
  failed = false
  await ui.press({ key: 'back' })
  await ui.press({ key: 'open-r-large' })
  expect(calls).toBeGreaterThan(1)
  expect(await tokenCells(ui, '模型')).toEqual(['模型', '输入', '输出', '缓存读'])
  expect(await tokenCells(ui, 'Opus 5.5（主管）')).toEqual(['Opus 5.5（主管）', '142', '23', '55'])
  expect(await tokenCells(ui, '合计')).toEqual(['合计', '142', '23', '55'])
  const nodes = visibleNodes(await ui.drawn())
  expect(nodes.filter(el => nodeKey(el).startsWith('token-cell-')).every(el => el.props?.width === 8 && el.props?.justifyContent === 'flex-end')).toBe(true)
  const total = nodes.find(el => nodeKey(el) === 'token-row-2')
  expect(visibleNodes(total).filter(el => el.type === 'Text').every(el => el.props?.weight === 'bold')).toBe(true)
  await ui.unmount()
})

test('对话页：一级标题的目标也能取到，返工任务和原任务互相标出返工链', async ($, on) => {
  let t = Date.parse('2026-11-04T12:00:00.000Z')
  baseStubs(on, new Set<string>(), () => t)
  const relay = fakeRelay(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '答完了' }))
  const task = ['# 目标', '为题库出 8 道终端题。', '', '# 验收标准', '自检全部通过。'].join('\n')
  const base = { provider: 'grok', model: 'default', role: 'implement', level: 'easy', write: true, task, changedFiles: 1, reason: '擅长 0.80 → 0.80' }
  relay.jobs = JSON.stringify([
    { ...base, id: 'j-orig', status: 'done', startedAt: '2026-11-04T12:00:10.000Z', finishedAt: '2026-11-04T12:00:40.000Z', verdict: 'partial', verdictNote: '退回返工：term-03 自检没过' },
    { ...base, id: 'j-gpt', provider: 'grok', model: 'gpt-6.1-sol', status: 'done', startedAt: '2026-11-04T12:00:45.000Z', finishedAt: '2026-11-04T12:00:48.000Z', verdict: 'pass', verdictNote: '' },
    { ...base, id: 'j-redo', status: 'running', startedAt: '2026-11-04T12:00:50.000Z', finishedAt: null, verdict: null, verdictNote: '', reworkOf: 'j-orig', reworkRound: 1 },
  ])
  await $.session.start({ cwd: '/projects/fj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '出题', turnId: 't-redo' })
  t = Date.parse('2026-11-04T12:01:00.000Z')
  await $.turn.complete({ turnId: 't-redo', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-jobs' })
  await ui.press({ key: 'open-t-redo' })
  expect(await shownIncludes(ui, '为题库出 8 道终端题。')).toBe(true)
  expect(await shownIncludes(ui, '已退回原员工返工：')).toBe(true)
  expect(await shownIncludes(ui, '第 1 次返工 · 原任务 ')).toBe(true)
  expect(await shownIncludes(ui, '实现 · 简单 · 可写')).toBe(true)
  expect(await shownIncludes(ui, 'GPT-6.1 Sol')).toBe(true)
  await ui.unmount()
})
