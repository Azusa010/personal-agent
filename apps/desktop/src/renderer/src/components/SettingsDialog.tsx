import { useEffect, useState } from 'react'
import { Bot, KeyRound, Save, Sparkles } from 'lucide-react'
import type {
  AgentProfileView,
  ModelSettingsView,
  SetAgentProfileInput,
  SetModelSettingsInput,
  SetModelSettingsResult
} from '../../../shared/ipc-contract'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { Textarea } from './ui/textarea'

export interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

function SettingsBody({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [modelView, setModelView] = useState<ModelSettingsView | null>(null)
  const [profileView, setProfileView] = useState<AgentProfileView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 模型配置
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')

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
    void submit(
      {
        model: model.trim() === '' ? null : model.trim(),
        baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
        apiKey: apiKey.trim() === '' ? undefined : apiKey.trim()
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

  if (loadError !== null) {
    return <p className="m-0 text-[12px] text-destructive">读取设置失败：{loadError}</p>
  }
  if (modelView === null || profileView === null) {
    return <p className="m-0 text-[12px] text-muted-foreground">读取设置中…</p>
  }

  return (
    <div className="space-y-4 text-[13px]">
      {/* 助手人设分区 */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Bot size={16} className="text-primary" />
          <span>助手人设</span>
        </div>

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
            rows={3}
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
            <span className="flex items-center gap-1">
              <Sparkles size={13} className="text-amber-500" />
              开启思维链摘要（仅推理模型可用，流式接收 thinking delta）
            </span>
          </Label>
        </div>
      </div>

      <Separator />

      {/* 模型配置分区 */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <KeyRound size={16} className="text-primary" />
          <span>模型服务 (OpenAI 兼容接口)</span>
        </div>

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
            {modelView.apiKeySet && ' 需要换掉时直接粘贴新的，需要删除时点清除按钮。'}
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
          <Label htmlFor="settings-base-url">API Base URL</Label>
          <Input
            id="settings-base-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="留空用官方地址；用中转站时填它的 /v1 地址"
            spellCheck={false}
          />
        </div>
      </div>

      {failure !== null && <p className="m-0 text-[12px] text-destructive">{failure}</p>}
      {message !== null && <p className="m-0 text-[12px] text-emerald-500">{message}</p>}

      <div className="flex items-center justify-end gap-2 pt-2">
        {modelView.apiKeySet && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={handleClearKey}
          >
            <KeyRound size={14} />
            清除已存的 Key
          </Button>
        )}
        <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
          <Save size={14} />
          {saving ? '保存中…' : '保存设置'}
        </Button>
      </div>
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>
            管理助手人设口吻与模型服务接口。人设保存后即时生效。
          </DialogDescription>
        </DialogHeader>
        {open && <SettingsBody onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}
