import { useEffect, useState } from 'react'
import { KeyRound, Save } from 'lucide-react'
import type {
  ModelSettingsView,
  SetModelSettingsInput,
  SetModelSettingsResult
} from '../../../shared/ipc-contract'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'

export interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 保存成功时调用：App 借此重新拉起 runtime 状态轮询（重启中 → 就绪） */
  onSaved: () => void
}

/** 随 Dialog 开合挂载/卸载：打开时读一次现状，表单以现状为初始值。 */
function SettingsBody({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [view, setView] = useState<ModelSettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // 读取结果同时是「表单初值」与「Key 配没配」的唯一来源。
  // Key 明文不回传（SEC-008），输入框永远从空开始，留空 = 不改。
  const applyView = (loaded: ModelSettingsView): void => {
    setView(loaded)
    setModel(loaded.model ?? '')
    setBaseUrl(loaded.baseUrl ?? '')
    setApiKey('')
  }

  const reload = async (): Promise<void> => {
    const result = await window.personalAgent.getModelSettings()
    if (result.ok) applyView(result.settings)
    else setLoadError(`[${result.code}] ${result.message}`)
  }

  useEffect(() => {
    let cancelled = false
    void window.personalAgent
      .getModelSettings()
      .then((result) => {
        if (cancelled) return
        if (result.ok) applyView(result.settings)
        else setLoadError(`[${result.code}] ${result.message}`)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 保存结局：restarted = 已经重启生效；on-next-restart = 有任务在跑，留到下次启动。
   *  两种都是保存成功，文案必须说清是哪种，不能含糊成「稍后生效」。 */
  const describeApplied = (applied: 'restarted' | 'on-next-restart'): string =>
    applied === 'restarted'
      ? '已保存，runtime 已重启，新配置已生效。'
      : '已保存。当前有任务在跑，任务结束后重启 runtime 生效。'

  const submit = async (input: SetModelSettingsInput): Promise<void> => {
    setSaving(true)
    setFailure(null)
    setMessage(null)
    let result: SetModelSettingsResult
    try {
      result = await window.personalAgent.setModelSettings(input)
    } catch (err) {
      // 正常不会进这里：契约是永不抛。真抛了说明 preload / IPC 层坏了。
      setFailure(`保存失败：${err instanceof Error ? err.message : String(err)}`)
      setSaving(false)
      return
    }
    setSaving(false)
    if (!result.ok) {
      setFailure(`[${result.code}] ${result.message}`)
      return
    }
    setMessage(describeApplied(result.applied))
    onSaved()
    await reload()
  }

  const handleSave = (): void => {
    void submit({
      // model / baseUrl 留空即清空；apiKey 留空是不改（明文不回显，空输入框就是「没动」）
      model: model.trim() === '' ? null : model.trim(),
      baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
      apiKey: apiKey.trim() === '' ? undefined : apiKey.trim()
    })
  }

  const handleClearKey = (): void => {
    void submit({ clearApiKey: true })
  }

  const form = (): React.JSX.Element => {
    if (loadError !== null) {
      return <p className="m-0 text-[12px] text-destructive">读取设置失败：{loadError}</p>
    }
    if (view === null) {
      return <p className="m-0 text-[12px] text-muted-foreground">读取设置中…</p>
    }
    return (
      <>
        <div className="space-y-2">
          <Label htmlFor="settings-api-key">API Key</Label>
          <Input
            id="settings-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={view.apiKeySet ? '已配置，留空保持不变' : '未配置，粘贴 sk-...'}
          />
          <p className="m-0 text-[11px] text-muted-foreground">
            以系统密钥库加密保存在本机，已保存的 Key 不回显、不进日志。
            {view.apiKeySet && ' 需要换掉时直接粘贴新的，需要删除时点右侧按钮。'}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="settings-model">模型名称</Label>
          <Input
            id="settings-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            spellCheck={false}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="settings-base-url">API Base URL</Label>
          <Input
            id="settings-base-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="留空用官方地址；用中转站时填它的 /v1 地址"
            spellCheck={false}
          />
        </div>

        <p className="m-0 text-[11px] text-muted-foreground">
          未填的字段沿用系统环境变量里的值。保存后主进程会重启 Python runtime
          （配置在启动时读一次），有任务在跑时留到任务结束。
        </p>

        {failure !== null && <p className="m-0 text-[12px] text-destructive">{failure}</p>}
        {message !== null && <p className="m-0 text-[12px] text-emerald-500">{message}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          {view.apiKeySet && (
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
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </>
    )
  }

  return <div className="space-y-4">{form()}</div>
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
          <DialogTitle>模型设置</DialogTitle>
          <DialogDescription>
            配置真模型（OpenAI 兼容接口）的 Key、模型名与 Base URL。保存后运行时自动重启生效。
          </DialogDescription>
        </DialogHeader>
        {open && <SettingsBody onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}
