/** ai-relay 模式：off 纯 Claude，manual 手动，auto 自动 */
export type RelayMode = 'off' | 'manual' | 'auto'

/** 一个额度窗口（5 小时或每周） */
export type WindowView = {
  /** 5h 或 weekly */
  key: string
  /** 剩余比例 0–1，未知为 null */
  remaining: number | null
  /** 重置时间（毫秒时间戳），未知为 null */
  resetAt: number | null
  /** 这个窗口的数据来源：自带、AIQuota5h；没有读数为 null */
  source: string | null
}

/** 单个额度池在额度页上的展示数据 */
export type PoolView = {
  /** 模型名，如 Claude、Gemini 3.8 Flash */
  name: string
  /** 所属会员，如 Claude Pro、Antigravity */
  provider: string
  /** 额度等级：ok 充足，low 偏低，blocked 耗尽或过低，unknown 未知 */
  level: 'ok' | 'low' | 'blocked' | 'unknown'
  /** 厂商是否启用；停用的行置灰 */
  enabled: boolean
  /** 窗口按 5h、周 的顺序 */
  windows: WindowView[]
  /** 数据是否过期（长时间未刷新） */
  stale: boolean
  /** 额度数据来源：自带、AIQuota5h、无 */
  source: string
}

/** 最近一次读取到的 ai-relay 状态 */
export type Snapshot = {
  mode: RelayMode
  /** 是否读到了 AIQuota5h 的额度数据 */
  quotaAvailable: boolean
  pools: PoolView[]
  /** 读取时间（毫秒时间戳） */
  updatedAt: number
  /** 读取失败时的原因 */
  error?: string
  /** 主模型：当前会话在模型菜单里选的模型，如 claude-opus-5-5 */
  mainModel: string
  /** 额度阈值（来自 relay 配置）：低于 min 不派，低于 low 算偏低 */
  thresholds: { min: number; low: number }
}

/** 单个模型或外派任务的 Token 消耗 */
export type TokenUsage = {
  /** 输入 token 数（含新建缓存） */
  input: number
  /** 输出 token 数 */
  output: number
  /** 缓存命中读取的 token 数 */
  cacheRead: number
  /** 总 token 数 */
  total?: number
}

/** 轮次详情里的一行 Token 消耗 */
export type RoundTokenRow = {
  /** 模型显示名，或最后一行「合计」 */
  label: string
  /** 取不到数据时为 null（界面显示「无数据」） */
  usage: TokenUsage | null
}

/** 一条外派记录 */
export type JobView = {
  id: string
  /** 执行的厂商，如 codex、agy、grok */
  provider: string
  /** 具体模型，default 表示该厂商默认模型 */
  model: string
  write: boolean
  /** running、done、failed、timeout、cancelled */
  status: string
  startedAt: string
  finishedAt: string | null
  task: string
  /** 可写任务改动的文件数 */
  changedFiles: number
  /** 角色键，如 implement、review；早期记录没有为 null */
  role: string | null
  /** 分派理由：打分明细与跳过的候选 */
  reason: string
  /** 主模型的验收结论：pass、partial、fail；未验收为 null */
  verdict: string | null
  /** 验收说明 */
  verdictNote: string
  /** 需要主控协助的说明；没有则不填 */
  helpRequest?: string
  /** 任务执行所在目录 */
  cwd?: string
  /** 任务结束时 CLI 报告的 token 消耗；取不到时不填 */
  usage?: TokenUsage | null
}

/** 一轮对话里主模型启动的子代理（Agent 工具），含经 Codex 插件外派的 Codex */
export type RoundAgent = {
  /** 子代理 id（与它这一轮结束时的 agentId 对应） */
  id: string
  /** 启动它的 Agent 工具调用 id；Codex 的外派记录用它做 id */
  toolUseId: string
  /** 子代理类型，如 Explore、codex:codex-rescue */
  subagentType: string
  /** 主模型给它的简短任务说明 */
  description: string
  /** 子代理实际运行的模型 id */
  model: string
  /** running 进行中，done 完成，failed 失败，cancelled 中断 */
  status: string
  startedAt: number
  finishedAt: number | null
}

/** 一轮对话：从你发出一条消息，到主模型答完 */
export type Round = {
  /** 本轮 turnId */
  id: string
  /** 你发的消息；系统触发的继续为空串 */
  text: string
  /** 本轮的主模型 id */
  mainModel: string
  startedAt: number
  finishedAt: number | null
  /** running 进行中，answer 完成，aborted 中断，error / refusal 出错 */
  status: string
  agents: RoundAgent[]
  /** 主模型这一轮亲手写入的行数（Edit / Write / NotebookEdit） */
  selfLines: number
  /** 会话 id */
  sessionId: string
  /** 所属项目：会话启动目录的末级名和绝对路径 */
  project: { name: string; path: string }
  /** 界面环境：desktop | terminal | vscode | mobile | headless */
  env: string
}

/** relay providers --json 里的单个厂商 */
export type Vendor = {
  /** 标识，如 grok、kimi */
  name: string
  /** 显示名，如 SuperGrok */
  label: string
  /** 调用方式：self 主控，codex-plugin 走 Codex 官方插件，relay 走 relay 调官方 CLI */
  via: string
  enabled: boolean
  /** 能否停用（主控 Claude 不能） */
  canDisable: boolean
  /** 能否删除（主控 Claude 和 Codex 不能） */
  canRemove: boolean
  /** 能否试运行（只有 relay 调用的厂商可以） */
  canTest: boolean
  /** CLI 命令名 */
  bin: string
  /** 本机是否找到该命令 */
  binFound: boolean
  /** 参与的角色键，如 read、review */
  roles: string[]
  /** 备注，如风险提示 */
  note: string
  /** 最高权限：执行命令是否还要逐个审批 */
  fullAccess: {
    /** 能否在面板里开关；主控和 Codex 为 false */
    supported: boolean
    /** 当前是否已开启 */
    enabled: boolean
    /** 不能开关时的原因 */
    note: string
  }
  /** 可设置默认模型的额度池；主模型和没有清单的厂商为空 */
  modelPools: ModelPool[]
}

/** 路由里写死了具体模型的角色 */
export type ModelFixedRole = {
  role: string
  model: string
}

/** 一个额度池的默认模型 */
export type ModelPool = {
  /** 额度池标识，如 supergrok-weekly、gemini-argon */
  pool: string
  /** 行标题，如 Gemini Argon */
  label: string
  /** 当前默认模型 id；跟随 CLI 默认时为 null */
  current: string | null
  /** 能否选「跟随 CLI 默认」；多池厂商为 false */
  allowCliDefault: boolean
  /** 路由里该池写 default 的角色 */
  followRoles: string[]
  /** 路由里该池写了具体模型的角色 */
  fixedRoles: ModelFixedRole[]
}

/** 清单里的一个模型 */
export type CatalogModel = {
  id: string
  label: string
  /** 所属额度池；归不进任何池为 null，不能被选 */
  pool: string | null
}

/** relay models --json 里的单个厂商 */
export type ProviderCatalog = {
  ok: boolean
  error: string | null
  fetchedAt: string
  /** CLI 自己的默认模型，取不到为 null */
  cliDefault: string | null
  models: CatalogModel[]
}

/** 模型清单 */
export type ModelsCatalog = {
  updatedAt: string
  providers: Record<string, ProviderCatalog>
}

/** 面板上的模型清单：整次失败时保留上次的 catalog */
export type ModelsView = {
  catalog: ModelsCatalog | null
  /** idle 未读，loading 进入页面，refreshing 手动刷新，ready 已读到，error 整次失败 */
  status: 'idle' | 'loading' | 'refreshing' | 'ready' | 'error'
  /** 整次调用失败的原因；某一家失败看 catalog 里的 error */
  error: string | null
}

/** 新增厂商可选的模板 */
export type Preset = {
  title: string
  label: string
  bin: string
  install: string
  cli: { prompt: string[]; model: string[]; read: string[]; write: string[]; cwd: string[] | null }
  models: string[]
  roles: string[]
  note: string
}

/** 厂商页的数据 */
export type VendorData = {
  providers: Vendor[]
  /** 所有角色：键和中文名 */
  roles: { key: string; text: string }[]
  presets: Record<string, Preset>
}

/** 新增厂商表单 */
export type AddForm = {
  /** 模板键：kimi、qwen、gemini-cli、custom */
  preset: string
  name: string
  label: string
  bin: string
  /** 模型，逗号分隔，留空用默认 */
  models: string
  /** 以下四项只在自定义模板下填写，空格分隔 */
  promptArgs: string
  modelArgs: string
  readArgs: string
  writeArgs: string
  /** 参与的角色键 */
  roles: string[]
}

/** 面板底部的操作结果提示 */
export type Notice = { text: string; ok: boolean }

declare module 'claude-code' {
  interface PluginState {
    'ai-relay-status': {
      snapshot: Shaped<Snapshot | null>
      switching: RelayMode | null
      /** 面板当前页：quota 额度，jobs 对话，vendors 厂商 */
      tab: 'quota' | 'jobs' | 'vendors'
      vendors: Shaped<VendorData | null>
      /** 最近的外派记录 */
      jobs: Shaped<JobView[] | null>
      /** 本会话最近的对话轮次，最新的在前 */
      rounds: Shaped<Round[]>
      /** 全部会话的对话轮次，最新的在前 */
      allRounds: Shaped<Round[] | null>
      /** 对话筛选条件：只按项目，空串表示全部 */
      roundFilter: Shaped<{ project: string }>
      /** 对话页当前详情：轮次 id，或 job:<外派 id>；null 为列表 */
      selectedRound: string | null
      /** 详情里展开了派单全文的外派 id */
      openBriefs: string[]
      /** 正在填写的新增表单，null 表示没在新增 */
      form: AddForm | null
      /** 等待二次确认删除的厂商标识 */
      confirmRemove: string | null
      /** 进行中的操作，如 "test:kimi"、"add"，用于按钮显示"…" */
      busy: string | null
      notice: Notice | null
      /** 官方 CLI 的模型清单 */
      modelCatalog: Shaped<ModelsView>
      /** 正在保存默认模型的「厂商:额度池」，保存中不再提交 */
      savingModels: string[]
      /** 输入框上方提示条的时长节拍。只有提示条读取，加一就只重绘提示条 */
      bandTick: number
    }
  }
}
