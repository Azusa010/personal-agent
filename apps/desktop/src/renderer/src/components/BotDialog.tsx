import { useState } from 'react'
import { Bot, Check, Sparkles } from 'lucide-react'
import type { BotView } from '../../../shared/ipc-contract'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

export interface BotDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bot?: BotView | null
  onSaved: (bot: BotView) => void
}

const PRESET_AVATARS = [
  '🤖',
  '💻',
  '🔍',
  '🎨',
  '⚡',
  '📝',
  '🧠',
  '🚀',
  '🛡️',
  '📊',
  '💼',
  '🧪',
  '🌱',
  '🦉'
]

interface BotFormProps {
  bot?: BotView | null
  onClose: () => void
  onSaved: (bot: BotView) => void
}

function BotForm({ bot, onClose, onSaved }: BotFormProps): React.JSX.Element {
  const isEditing = bot !== null && bot !== undefined

  const [name, setName] = useState(bot?.name ?? '')
  const [avatar, setAvatar] = useState(bot?.avatar || '🤖')
  const [description, setDescription] = useState(bot?.description ?? '')
  const [persona, setPersona] = useState(bot?.persona ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('智能体名称不能为空')
      return
    }
    if (trimmedName.length > 40) {
      setError('智能体名称不能超过 40 个字符')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const now = new Date().toISOString()
      if (isEditing && bot) {
        const res = await window.personalAgent.updateBot({
          id: bot.id,
          name: trimmedName,
          avatar: avatar.trim() || '🤖',
          description: description.trim(),
          persona: persona.trim(),
          updatedAt: now
        })
        if (!res.ok) {
          setError(res.message)
          return
        }
        onSaved(res.bot)
        onClose()
      } else {
        const res = await window.personalAgent.createBot({
          name: trimmedName,
          avatar: avatar.trim() || '🤖',
          description: description.trim(),
          persona: persona.trim(),
          createdAt: now,
          updatedAt: now
        })
        if (!res.ok) {
          setError(res.message)
          return
        }
        onSaved(res.bot)
        onClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot size={20} />
          </div>
          <div>
            <DialogTitle className="text-base font-semibold">
              {isEditing ? `编辑伴侣设定 · ${bot.name}` : '创建专属智能体角色'}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {isEditing
                ? '修改伴侣人设、专业定位与行为指令。设定将即时注入后续对话。'
                : '基于 Dots 与 Grok 范式，为特定领域打造具备长期记忆与独立人设的伴侣。'}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4 pt-2">
        {/* 头像选择 */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">角色形象 (Avatar)</Label>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-secondary text-2xl shadow-xs">
              {avatar || '🤖'}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PRESET_AVATARS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setAvatar(emoji)}
                  className={`flex h-7 w-7 items-center justify-center rounded-lg border text-sm transition-transform active:scale-95 ${
                    avatar === emoji
                      ? 'border-primary bg-primary/15 scale-105'
                      : 'border-border/60 hover:border-border hover:bg-secondary/60'
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 名称 */}
        <div className="space-y-1.5">
          <Label htmlFor="bot-name" className="text-xs font-medium">
            智能体名称 <span className="text-destructive">*</span>
          </Label>
          <Input
            id="bot-name"
            placeholder="例如：全栈极客 / 深度分析师 / 论文伴读"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            className="text-xs"
          />
        </div>

        {/* 一句话简介 */}
        <div className="space-y-1.5">
          <Label htmlFor="bot-desc" className="text-xs font-medium">
            领域定位与简介
          </Label>
          <Input
            id="bot-desc"
            placeholder="例如：精通全栈架构、代码重构与性能审计"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={100}
            className="text-xs"
          />
        </div>

        {/* 角色设定与系统 Prompt */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="bot-persona" className="text-xs font-medium">
              角色人设 (Persona Prompt)
            </Label>
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Sparkles size={11} className="text-primary" />
              注入顶层 System Instruction
            </span>
          </div>
          <Textarea
            id="bot-persona"
            rows={4}
            placeholder="例如：你是一个极具洞察力且严谨的高级工程师。在回答前先分析上下文与边界条件，给出最简且优雅的解决方案，绝不写冗余的假大空代码..."
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            className="text-xs leading-relaxed"
          />
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={saving}
            className="text-xs"
          >
            取消
          </Button>
          <Button type="submit" size="sm" disabled={saving} className="gap-1.5 text-xs">
            <Check size={14} />
            <span>{saving ? '保存中…' : isEditing ? '保存修改' : '立即创建'}</span>
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

export function BotDialog({
  open,
  onOpenChange,
  bot,
  onSaved
}: BotDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-6">
        {open && (
          <BotForm
            key={bot?.id ?? 'new'}
            bot={bot}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
