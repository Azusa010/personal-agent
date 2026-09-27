import { useEffect, useState } from 'react'
import {
  BookOpen,
  Bot,
  Cpu,
  Database,
  FileText,
  Globe,
  KeyRound,
  Save,
  Settings as SettingsIcon,
  Sparkles
} from 'lucide-react'
import type {
  AgentProfileView,
  ModelSettingsView,
  SetAgentProfileInput,
  SetModelSettingsInput,
  SetModelSettingsResult
} from '../../../shared/ipc-contract'
import { cn } from '@renderer/lib/utils'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

export interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

type SettingsTab = 'profile' | 'model' | 'knowledge' | 'storage' | 'typesafe' | 'mineru' | 'tavily'

interface NavItem {
  id: SettingsTab
  label: string
  description: string
  icon: typeof Bot
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'profile',
    label: '助手人设',
    description: '称呼与口吻设定',
    icon: Bot
  },
  {
    id: 'model',
    label: '通用大模型',
    description: 'OpenAI 兼容接口',
    icon: KeyRound
  },
  {
    id: 'knowledge',
    label: '知识库与 RAG',
    description: 'Embedding, Reranker 与评审',
    icon: BookOpen
  },
  {
    id: 'storage',
    label: '存储与维基',
    description: 'PostgreSQL 与 Viking 存储',
    icon: Database
  },
  {
    id: 'typesafe',
    label: 'TypeSafe AI',
    description: 'Jev 决策模型与 API',
    icon: Cpu
  },
  {
    id: 'mineru',
    label: 'MinerU 解析',
    description: 'PDF 高精度版面识别',
    icon: FileText
  },
  {
    id: 'tavily',
    label: '联网搜索',
    description: 'Tavily 搜索 API 与端点',
    icon: Globe
  }
]

function SettingsBody({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile')

  const [modelView, setModelView] = useState<ModelSettingsView | null>(null)
  const [profileView, setProfileView] = useState<AgentProfileView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 模型配置
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiProtocol, setApiProtocol] = useState<'responses' | 'chat_completions'>('responses')
  const [contextWindow, setContextWindow] = useState('128000')

  // TypeSafe / Jev 配置
  const [typesafeModel, setTypesafeModel] = useState('')
  const [typesafeBaseUrl, setTypesafeBaseUrl] = useState('')
  const [typesafeApiKey, setTypesafeApiKey] = useState('')

  // MinerU 解析配置
  const [mineruApiUrl, setMineruApiUrl] = useState('')
  const [mineruApiKey, setMineruApiKey] = useState('')

  // 知识库与 RAG 配置
  const [bgeM3Path, setBgeM3Path] = useState('')
  const [bgeRerankerPath, setBgeRerankerPath] = useState('')
  const [proposerModel, setProposerModel] = useState('')
  const [reviewerModel, setReviewerModel] = useState('')

  // 存储与维基配置
  const [postgresHost, setPostgresHost] = useState('')
  const [postgresPort, setPostgresPort] = useState('')
  const [postgresUser, setPostgresUser] = useState('')
  const [postgresPassword, setPostgresPassword] = useState('')
  const [postgresDatabase, setPostgresDatabase] = useState('')
  const [vikingStoreRoot, setVikingStoreRoot] = useState('')

  // Tavily 搜索配置
  const [tavilyApiKey, setTavilyApiKey] = useState('')
  const [tavilyEndpoint, setTavilyEndpoint] = useState('')

  // 人设配置
  const [name, setName] = useState('')
  const [persona, setPersona] = useState('')
  const [reasoningSummary, setReasoningSummary] = useState(false)

  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const applyLoaded = (
    modelRes: Awaited<ReturnType<typeof window.personalAgent.getModelSettings>>,
    profileRes: Awaited<ReturnType<typeof window.personalAgent.getAgentProfile>>
  ): void => {
    if (modelRes.ok) {
      setModelView(modelRes.settings)
      setModel(modelRes.settings.model ?? '')
      setBaseUrl(modelRes.settings.baseUrl ?? '')
      setApiKey('')
      setApiProtocol(modelRes.settings.apiProtocol ?? 'responses')
      setContextWindow(
        modelRes.settings.contextWindow ? String(modelRes.settings.contextWindow) : '128000'
      )

      setTypesafeModel(modelRes.settings.typesafeModel ?? '')
      setTypesafeBaseUrl(modelRes.settings.typesafeBaseUrl ?? '')
      setTypesafeApiKey('')

      setMineruApiUrl(modelRes.settings.mineruApiUrl ?? '')
      setMineruApiKey('')

      setBgeM3Path(modelRes.settings.bgeM3Path ?? '')
      setBgeRerankerPath(modelRes.settings.bgeRerankerPath ?? '')
      setProposerModel(modelRes.settings.proposerModel ?? '')
      setReviewerModel(modelRes.settings.reviewerModel ?? '')

      setPostgresHost(modelRes.settings.postgresHost ?? '')
      setPostgresPort(modelRes.settings.postgresPort ? String(modelRes.settings.postgresPort) : '')
      setPostgresUser(modelRes.settings.postgresUser ?? '')
      setPostgresPassword('')
      setPostgresDatabase(modelRes.settings.postgresDatabase ?? '')
      setVikingStoreRoot(modelRes.settings.vikingStoreRoot ?? '')

      setTavilyApiKey('')
      setTavilyEndpoint(modelRes.settings.tavilyEndpoint ?? '')
    } else {
      setLoadError(`[${modelRes.code}] ${modelRes.message}`)
    }

    if (profileRes.ok) {
      setProfileView(profileRes.profile)
      setName(profileRes.profile.name)
      setPersona(profileRes.profile.persona)
      setReasoningSummary(profileRes.profile.reasoningSummary)
    } else {
      setLoadError(`[${profileRes.code}] ${profileRes.message}`)
    }
  }

  const reload = async (): Promise<void> => {
    try {
      const [modelRes, profileRes] = await Promise.all([
        window.personalAgent.getModelSettings(),
        window.personalAgent.getAgentProfile()
      ])
      applyLoaded(modelRes, profileRes)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.personalAgent.getModelSettings(),
      window.personalAgent.getAgentProfile()
    ])
      .then(([modelRes, profileRes]) => {
        if (!cancelled) {
          applyLoaded(modelRes, profileRes)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const describeApplied = (applied: 'restarted' | 'on-next-restart'): string =>
    applied === 'restarted'
      ? '人设已更新；模型配置已保存且 runtime 已重启生效。'
      : '人设已更新；当前有任务正在运行，模型配置将在任务结束后生效。'

  const submit = async (
    modelInput: SetModelSettingsInput,
    profileInput: SetAgentProfileInput
  ): Promise<void> => {
    setSaving(true)
    setFailure(null)
    setMessage(null)

    try {
      // 1. 保存人设（立即可用）
      const profileRes = await window.personalAgent.setAgentProfile(profileInput)
      if (!profileRes.ok) {
        setFailure(`[${profileRes.code}] ${profileRes.message}`)
        setSaving(false)
        return
      }

      // 2. 保存模型配置
      const modelRes: SetModelSettingsResult =
        await window.personalAgent.setModelSettings(modelInput)
      if (!modelRes.ok) {
        setFailure(`[${modelRes.code}] ${modelRes.message}`)
        setSaving(false)
        return
      }

      setMessage(describeApplied(modelRes.applied))
      onSaved()
      await reload()
    } catch (err) {
      setFailure(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleSave = (): void => {
    const parsedWindow = parseInt(contextWindow.trim(), 10)
    const validWindow = Number.isInteger(parsedWindow) && parsedWindow > 0 ? parsedWindow : 128000
    const parsedPgPort = parseInt(postgresPort.trim(), 10)
    const validPgPort = Number.isInteger(parsedPgPort) && parsedPgPort > 0 ? parsedPgPort : null

    void submit(
      {
        model: model.trim() === '' ? null : model.trim(),
        baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
        apiKey: apiKey.trim() === '' ? undefined : apiKey.trim(),
        apiProtocol,
        contextWindow: validWindow,
        typesafeModel: typesafeModel.trim() === '' ? null : typesafeModel.trim(),
        typesafeBaseUrl: typesafeBaseUrl.trim() === '' ? null : typesafeBaseUrl.trim(),
        typesafeApiKey: typesafeApiKey.trim() === '' ? undefined : typesafeApiKey.trim(),
        mineruApiUrl: mineruApiUrl.trim() === '' ? null : mineruApiUrl.trim(),
        mineruApiKey: mineruApiKey.trim() === '' ? undefined : mineruApiKey.trim(),
        bgeM3Path: bgeM3Path.trim() === '' ? null : bgeM3Path.trim(),
        bgeRerankerPath: bgeRerankerPath.trim() === '' ? null : bgeRerankerPath.trim(),
        proposerModel: proposerModel.trim() === '' ? null : proposerModel.trim(),
        reviewerModel: reviewerModel.trim() === '' ? null : reviewerModel.trim(),
        postgresHost: postgresHost.trim() === '' ? null : postgresHost.trim(),
        postgresPort: validPgPort,
        postgresUser: postgresUser.trim() === '' ? null : postgresUser.trim(),
        postgresPassword: postgresPassword.trim() === '' ? undefined : postgresPassword.trim(),
        postgresDatabase: postgresDatabase.trim() === '' ? null : postgresDatabase.trim(),
        vikingStoreRoot: vikingStoreRoot.trim() === '' ? null : vikingStoreRoot.trim(),
        tavilyApiKey: tavilyApiKey.trim() === '' ? undefined : tavilyApiKey.trim(),
        tavilyEndpoint: tavilyEndpoint.trim() === '' ? null : tavilyEndpoint.trim()
      },
      {
        name: name.trim() || 'PersonalAgent',
        persona: persona.trim(),
        reasoningSummary
      }
    )
  }

  const handleClearKey = (): void => {
    void submit(
      { clearApiKey: true },
      {
        name: name.trim() || 'PersonalAgent',
        persona: persona.trim(),
        reasoningSummary
      }
    )
  }

  const handleClearTypesafeKey = (): void => {
    void submit(
      { clearTypesafeApiKey: true },
      {
        name: name.trim() || 'PersonalAgent',
        persona: persona.trim(),
        reasoningSummary
      }
    )
  }

  const handleClearMineruKey = (): void => {
    void submit(
      { clearMineruApiKey: true },
      {
        name: name.trim() || 'PersonalAgent',
        persona: persona.trim(),
        reasoningSummary
      }
    )
  }

  const handleClearTavilyKey = (): void => {
    void submit(
      { clearTavilyApiKey: true },
      {
        name: name.trim() || 'PersonalAgent',
        persona: persona.trim(),
        reasoningSummary
      }
    )
  }

  const handleClearPostgresPassword = (): void => {
    void submit(
      { clearPostgresPassword: true },
      {
        name: name.trim() || 'PersonalAgent',
        persona: persona.trim(),
        reasoningSummary
      }
    )
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* 左侧 Sidebar 选项框 */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-muted/20 select-none">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-4">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-secondary text-foreground">
            <SettingsIcon size={14} />
          </div>
          <div>
            <h2 className="m-0 text-[13px] font-semibold text-foreground">设置</h2>
            <p className="m-0 text-[11px] text-muted-foreground">个人偏好与服务</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-2.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const isActive = activeTab === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveTab(item.id)
                  setFailure(null)
                }}
                className={cn(
                  'group flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs transition-colors',
                  isActive
                    ? 'bg-secondary font-medium text-foreground shadow-xs'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                )}
              >
                <Icon
                  size={15}
                  className={cn(
                    'shrink-0 transition-colors',
                    isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium leading-none">{item.label}</div>
                  <div className="mt-1 truncate text-[10px] text-muted-foreground">
                    {item.description}
                  </div>
                </div>
              </button>
            )
          })}
        </nav>
      </aside>

      {/* 右侧具体配置区域 */}
      <main className="flex flex-1 flex-col min-w-0 bg-background">
        {/* 右侧分区标头 */}
        <header className="border-b border-border/60 px-6 py-4 pr-12">
          {activeTab === 'profile' ? (
            <div>
              <h3 className="m-0 flex items-center gap-2 text-[14px] font-semibold text-foreground">
                <Bot size={16} className="text-primary" />
                助手人设
              </h3>
              <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
                自定义助手的对外称呼、角色口吻与思维链行为，人设设定即时生效。
              </p>
            </div>
          ) : activeTab === 'model' ? (
            <div>
              <h3 className="m-0 flex items-center gap-2 text-[14px] font-semibold text-foreground">
                <KeyRound size={16} className="text-primary" />
                通用大模型服务 (OpenAI 兼容接口)
              </h3>
              <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
                配置通用大模型接入点、认证凭证与协议模式。保存后自动重启 runtime 刷新生效。
              </p>
            </div>
          ) : activeTab === 'knowledge' ? (
            <div>
              <h3 className="m-0 flex items-center gap-2 text-[14px] font-semibold text-foreground">
                <BookOpen size={16} className="text-primary" />
                知识库与 RAG 检索模型
              </h3>
              <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
                配置 BGE 稠密嵌入模型、重排序 Reranker 以及维基自主进化的提案与审核 Agent 模型。
              </p>
            </div>
          ) : activeTab === 'storage' ? (
            <div>
              <h3 className="m-0 flex items-center gap-2 text-[14px] font-semibold text-foreground">
                <Database size={16} className="text-primary" />
                存储与 OpenViking 维基
              </h3>
              <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
                配置 PostgreSQL 关系及向量数据库连接凭证与 OpenViking 本地存储根路径。
              </p>
            </div>
          ) : activeTab === 'typesafe' ? (
            <div>
              <h3 className="m-0 flex items-center gap-2 text-[14px] font-semibold text-foreground">
                <Cpu size={16} className="text-primary" />
                TypeSafe AI / Jev 决策模型
              </h3>
              <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
                配置专用于结构化决策与任务规划的 TypeSafe API 接入点与 Key，同等级系统安全加密。
              </p>
            </div>
          ) : (
            <div>
              <h3 className="m-0 flex items-center gap-2 text-[14px] font-semibold text-foreground">
                <FileText size={16} className="text-primary" />
                MinerU 文档解析服务
              </h3>
              <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
                配置用于 PDF 高精度版面识别、表格与公式提取的 MinerU API 端点与凭证。
              </p>
            </div>
          )}
        </header>

        {/* 内容滚动区 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 text-[13px]">
          {loadError !== null ? (
            <div className="flex h-full items-center justify-center text-[12px] text-destructive">
              读取设置失败：{loadError}
            </div>
          ) : modelView === null || profileView === null ? (
            <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
              读取设置中…
            </div>
          ) : activeTab === 'profile' ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="profile-name">助手称呼</Label>
                <Input
                  id="profile-name"
                  value={name}
                  maxLength={40}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="PersonalAgent"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="profile-persona">角色设定与口吻</Label>
                <Textarea
                  id="profile-persona"
                  value={persona}
                  maxLength={2000}
                  rows={5}
                  onChange={(e) => setPersona(e.target.value)}
                  placeholder="例如：你是一位专注文件整理与摘要总结的严肃助手，回答条理清晰、言简意赅…"
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  设定将作为背景提示词下发，硬要求（能力白名单、真实事实溯源）始终严格优先于角色设定。
                </p>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="profile-reasoning"
                  checked={reasoningSummary}
                  onChange={(e) => setReasoningSummary(e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <Label htmlFor="profile-reasoning" className="cursor-pointer font-normal">
                  <span className="flex items-center gap-1.5">
                    <Sparkles size={13} className="text-amber-500" />
                    开启思维链摘要（仅推理模型可用，流式接收 thinking delta）
                  </span>
                </Label>
              </div>
            </div>
          ) : activeTab === 'model' ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="settings-api-key">API Key</Label>
                <Input
                  id="settings-api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={modelView.apiKeySet ? '已配置，留空保持不变' : '未配置，粘贴 sk-...'}
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  以系统密钥库加密保存在本机，已保存的 Key 不回显、不进日志。
                  {modelView.apiKeySet && ' 需要换掉时直接粘贴新的，需要删除时点下方清除按钮。'}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-model">模型名称</Label>
                <Input
                  id="settings-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-4o-mini"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-context-window">上下文窗口 (Tokens)</Label>
                <Input
                  id="settings-context-window"
                  type="number"
                  min={1000}
                  step={1000}
                  value={contextWindow}
                  onChange={(e) => setContextWindow(e.target.value)}
                  placeholder="128000"
                  spellCheck={false}
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  模型最大上下文窗口（Tokens），默认 128K (128,000)。当多轮历史与工具执行负荷达到
                  75% 时自动启动记忆提炼与安全压缩。
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-base-url">API Base URL</Label>
                <Input
                  id="settings-base-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="留空用官方地址；用中转站时填它的 /v1 地址"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-1.5">
                <Label>接口协议 / 格式</Label>
                <div className="grid grid-cols-2 gap-2">
                  <label
                    className={cn(
                      'flex cursor-pointer items-center justify-center rounded border p-2.5 text-xs transition-colors',
                      apiProtocol === 'responses'
                        ? 'border-primary bg-primary/10 font-medium text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    )}
                  >
                    <input
                      type="radio"
                      name="apiProtocol"
                      value="responses"
                      checked={apiProtocol === 'responses'}
                      onChange={() => setApiProtocol('responses')}
                      className="sr-only"
                    />
                    Responses API (推荐)
                  </label>
                  <label
                    className={cn(
                      'flex cursor-pointer items-center justify-center rounded border p-2.5 text-xs transition-colors',
                      apiProtocol === 'chat_completions'
                        ? 'border-primary bg-primary/10 font-medium text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    )}
                  >
                    <input
                      type="radio"
                      name="apiProtocol"
                      value="chat_completions"
                      checked={apiProtocol === 'chat_completions'}
                      onChange={() => setApiProtocol('chat_completions')}
                      className="sr-only"
                    />
                    Chat Completions API
                  </label>
                </div>
                <p className="m-0 text-[11px] text-muted-foreground">
                  Responses API 支持原生结构化决策与思考流（适合官方模型）；Chat Completions API 走
                  Function Calling（适合第三方中转站）。
                </p>
              </div>
            </div>
          ) : activeTab === 'knowledge' ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="settings-bge-m3">BGE-M3 嵌入模型路径或标识</Label>
                <Input
                  id="settings-bge-m3"
                  value={bgeM3Path}
                  onChange={(e) => setBgeM3Path(e.target.value)}
                  placeholder="BAAI/bge-m3 (留空使用默认)"
                  spellCheck={false}
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  对应环境变量 BGE_M3_PATH。可填写本地模型权重绝对路径或 HuggingFace / ModelScope
                  标识。
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-bge-reranker">BGE-Reranker 重排模型路径或标识</Label>
                <Input
                  id="settings-bge-reranker"
                  value={bgeRerankerPath}
                  onChange={(e) => setBgeRerankerPath(e.target.value)}
                  placeholder="BAAI/bge-reranker-v2-m3 (留空使用默认)"
                  spellCheck={false}
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  对应环境变量 BGE_RERANKER_PATH。用于多路召回后的精准 Cross-Encoder 重排序。
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-proposer-model">
                  知识提案 Agent 模型 (Proposer Model)
                </Label>
                <Input
                  id="settings-proposer-model"
                  value={proposerModel}
                  onChange={(e) => setProposerModel(e.target.value)}
                  placeholder="留空自动继承通用大模型"
                  spellCheck={false}
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  对应环境变量
                  PERSONAL_AGENT_PROPOSER_MODEL。从会话历史与任务交付物中提取候选维基更新。
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-reviewer-model">
                  知识审核 Agent 模型 (Reviewer Model)
                </Label>
                <Input
                  id="settings-reviewer-model"
                  value={reviewerModel}
                  onChange={(e) => setReviewerModel(e.target.value)}
                  placeholder="留空自动继承通用大模型"
                  spellCheck={false}
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  对应环境变量
                  PERSONAL_AGENT_REVIEWER_MODEL。独立审查提案真实性与冲突检测（防幻觉）。
                </p>
              </div>
            </div>
          ) : activeTab === 'storage' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="settings-postgres-host">PostgreSQL 主机 / Host</Label>
                  <Input
                    id="settings-postgres-host"
                    value={postgresHost}
                    onChange={(e) => setPostgresHost(e.target.value)}
                    placeholder="localhost"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settings-postgres-port">端口 / Port</Label>
                  <Input
                    id="settings-postgres-port"
                    type="number"
                    value={postgresPort}
                    onChange={(e) => setPostgresPort(e.target.value)}
                    placeholder="5432"
                    spellCheck={false}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="settings-postgres-user">数据库用户 / User</Label>
                  <Input
                    id="settings-postgres-user"
                    value={postgresUser}
                    onChange={(e) => setPostgresUser(e.target.value)}
                    placeholder="postgres"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settings-postgres-db">数据库名 / Database</Label>
                  <Input
                    id="settings-postgres-db"
                    value={postgresDatabase}
                    onChange={(e) => setPostgresDatabase(e.target.value)}
                    placeholder="personal_agent"
                    spellCheck={false}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-postgres-password">PostgreSQL 密码</Label>
                <Input
                  id="settings-postgres-password"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={postgresPassword}
                  onChange={(e) => setPostgresPassword(e.target.value)}
                  placeholder={
                    modelView.postgresPasswordSet
                      ? '已配置，留空保持不变'
                      : '未配置，输入数据库密码'
                  }
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  以系统密钥库加密保存在本机，已保存的密码不回显。对应环境变量 POSTGRES_PASSWORD。
                </p>
              </div>

              <div className="space-y-1.5 pt-1 border-t border-border/40">
                <Label htmlFor="settings-viking-root">OpenViking 本地存储根目录</Label>
                <Input
                  id="settings-viking-root"
                  value={vikingStoreRoot}
                  onChange={(e) => setVikingStoreRoot(e.target.value)}
                  placeholder="留空使用工作区默认 .viking 目录"
                  spellCheck={false}
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  对应环境变量 PERSONAL_AGENT_VIKING_ROOT。L0/L1/L2 知识维基的实际持久化根路径。
                </p>
              </div>
            </div>
          ) : activeTab === 'typesafe' ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="settings-typesafe-api-key">TypeSafe API Key</Label>
                <Input
                  id="settings-typesafe-api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={typesafeApiKey}
                  onChange={(e) => setTypesafeApiKey(e.target.value)}
                  placeholder={
                    modelView.typesafeApiKeySet
                      ? '已配置，留空保持不变'
                      : '未配置，粘贴 TypeSafe API Key'
                  }
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  以系统安全密钥库加密保存在本机（与 OpenAI Key 等级相同），已保存的 Key
                  不回显、不进日志。
                  {modelView.typesafeApiKeySet &&
                    ' 需要换掉时直接粘贴新的，需要删除时点下方清除按钮。'}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-typesafe-model">TypeSafe / Jev 模型名称</Label>
                <Input
                  id="settings-typesafe-model"
                  value={typesafeModel}
                  onChange={(e) => setTypesafeModel(e.target.value)}
                  placeholder="留空使用 SDK 默认模型"
                  spellCheck={false}
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  对应运行时环境变量 TYPESAFE_DEFAULT_MODEL。留空时使用 TypeSafe SDK 内部默认值。
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-typesafe-base-url">API Base URL</Label>
                <Input
                  id="settings-typesafe-base-url"
                  value={typesafeBaseUrl}
                  onChange={(e) => setTypesafeBaseUrl(e.target.value)}
                  placeholder="留空用官方默认端点；私有化或反代时填它的 Base URL"
                  spellCheck={false}
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  对应运行时环境变量 TYPESAFE_BASE_URL。
                </p>
              </div>
            </div>
          ) : activeTab === 'mineru' ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="settings-mineru-api-key">MinerU API Token (Key)</Label>
                <Input
                  id="settings-mineru-api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={mineruApiKey}
                  onChange={(e) => setMineruApiKey(e.target.value)}
                  placeholder={
                    modelView.mineruApiKeySet
                      ? '已配置，留空保持不变'
                      : '未配置，粘贴 MinerU API Token'
                  }
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  以系统安全密钥库加密保存在本机，已保存的 Token 不回显、不进日志。
                  {modelView.mineruApiKeySet &&
                    ' 需要换掉时直接粘贴新的，需要删除时点下方清除按钮。'}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-mineru-api-url">API 端点 (Base URL)</Label>
                <Input
                  id="settings-mineru-api-url"
                  value={mineruApiUrl}
                  onChange={(e) => setMineruApiUrl(e.target.value)}
                  placeholder="https://mineru.net/api/v4"
                  spellCheck={false}
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  对应运行时环境变量 MINERU_API_URL。留空使用官方云端地址
                  https://mineru.net/api/v4；私有化或本地 Docker 部署时填写实际服务地址。
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3.5 space-y-1">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <Globe size={14} className="text-primary" />
                  <span>Tavily AI 智能搜索引擎</span>
                </div>
                <p className="m-0 text-[11px] text-muted-foreground leading-relaxed">
                  为 Agent 提供实时的互联网搜索能力（<code>web_search</code> 工具）。 获取 API Key
                  可访问{' '}
                  <a
                    href="https://tavily.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline underline-offset-2"
                  >
                    tavily.com
                  </a>
                  。
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-tavily-api-key">Tavily API Key</Label>
                <Input
                  id="settings-tavily-api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={tavilyApiKey}
                  onChange={(e) => setTavilyApiKey(e.target.value)}
                  placeholder={
                    modelView.tavilyApiKeySet ? '已配置，留空保持不变' : '未配置，粘贴 tvly-...'
                  }
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  以系统安全密钥库加密保存在本机，已保存的 Key 不回显、不进日志。
                  {modelView.tavilyApiKeySet &&
                    ' 需要换掉时直接粘贴新的，需要删除时点下方清除按钮。'}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="settings-tavily-endpoint">搜索 API 端点 (Endpoint)</Label>
                <Input
                  id="settings-tavily-endpoint"
                  value={tavilyEndpoint}
                  onChange={(e) => setTavilyEndpoint(e.target.value)}
                  placeholder="https://api.tavily.com/search"
                  spellCheck={false}
                />
                <p className="m-0 text-[11px] text-muted-foreground">
                  对应环境变量 TAVILY_ENDPOINT。留空使用官方默认端点
                  https://api.tavily.com/search；使用代理或中转反代时可自定义。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 底部操作与状态栏 */}
        <footer className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-6 py-3 shrink-0">
          <div className="min-w-0 flex-1">
            {failure !== null && (
              <p className="m-0 truncate text-[12px] text-destructive">{failure}</p>
            )}
            {message !== null && (
              <p className="m-0 truncate text-[12px] text-emerald-500">{message}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {activeTab === 'model' && modelView?.apiKeySet && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={handleClearKey}
              >
                <KeyRound size={14} />
                清除已存的 OpenAI Key
              </Button>
            )}
            {activeTab === 'storage' && modelView?.postgresPasswordSet && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={handleClearPostgresPassword}
              >
                <Database size={14} />
                清除已存的数据库密码
              </Button>
            )}
            {activeTab === 'typesafe' && modelView?.typesafeApiKeySet && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={handleClearTypesafeKey}
              >
                <Cpu size={14} />
                清除已存的 TypeSafe Key
              </Button>
            )}
            {activeTab === 'mineru' && modelView?.mineruApiKeySet && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={handleClearMineruKey}
              >
                <FileText size={14} />
                清除已存的 MinerU Token
              </Button>
            )}
            {activeTab === 'tavily' && modelView?.tavilyApiKeySet && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={handleClearTavilyKey}
              >
                <Globe size={14} />
                清除已存的 Tavily Key
              </Button>
            )}
            <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
              <Save size={14} />
              {saving ? '保存中…' : '保存设置'}
            </Button>
          </div>
        </footer>
      </main>
    </div>
  )
}

export function SettingsDialog({
  open,
  onOpenChange,
  onSaved
}: SettingsDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[560px] max-w-2xl overflow-hidden p-0 gap-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">系统设置</DialogTitle>
        <DialogDescription className="sr-only">
          管理助手人设口吻与模型服务接口。人设保存后即时生效。
        </DialogDescription>
        {open && <SettingsBody onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}
