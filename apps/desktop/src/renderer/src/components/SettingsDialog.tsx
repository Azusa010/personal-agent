import { useEffect, useState } from 'react'
import { Bot, Cpu, KeyRound, Save, Settings as SettingsIcon, Sparkles } from 'lucide-react'
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

type SettingsTab = 'profile' | 'model' | 'typesafe'

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
    id: 'typesafe',
    label: 'TypeSafe AI',
    description: 'Jev 决策模型与 API',
    icon: Cpu
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

    void submit(
      {
        model: model.trim() === '' ? null : model.trim(),
        baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
        apiKey: apiKey.trim() === '' ? undefined : apiKey.trim(),
        apiProtocol,
        contextWindow: validWindow,
        typesafeModel: typesafeModel.trim() === '' ? null : typesafeModel.trim(),
        typesafeBaseUrl: typesafeBaseUrl.trim() === '' ? null : typesafeBaseUrl.trim(),
        typesafeApiKey: typesafeApiKey.trim() === '' ? undefined : typesafeApiKey.trim()
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
          ) : (
            <div>
              <h3 className="m-0 flex items-center gap-2 text-[14px] font-semibold text-foreground">
                <Cpu size={16} className="text-primary" />
                TypeSafe AI / Jev 决策模型
              </h3>
              <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">
                配置专用于结构化决策与任务规划的 TypeSafe API 接入点与 Key，同等级系统安全加密。
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
                  模型最大上下文窗口（Tokens），默认 128K (128,000)。当多轮历史与工具执行负荷达到 75% 时自动启动记忆提炼与安全压缩。
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
          ) : (
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
      <DialogContent className="h-[540px] max-w-2xl overflow-hidden p-0 gap-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">系统设置</DialogTitle>
        <DialogDescription className="sr-only">
          管理助手人设口吻与模型服务接口。人设保存后即时生效。
        </DialogDescription>
        {open && <SettingsBody onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}
