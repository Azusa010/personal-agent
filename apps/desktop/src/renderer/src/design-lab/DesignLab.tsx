import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  ChevronDown,
  Circle,
  Clock,
  FileDown,
  FileText,
  FolderOpen,
  LoaderCircle,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { Textarea } from '@renderer/components/ui/textarea'
import './design-lab.css'

/**
 * DesignLab —— 温暖纸感 × 薄荷青绿 的可点击交互原型。
 * 用生产组件库(shadcn/Tailwind)搭,主题令牌 scope 在 body.design-lab-active,
 * 不触碰生产主题;入口为 #design(见 main.tsx),数据全部是本地 mock。
 */

type Scenario = 'running' | 'waiting' | 'idle' | 'demo'
type StepState = 'pend' | 'running' | 'done' | 'wait' | 'cancel'

const DEFAULT_GOAL =
  '帮我把 Downloads 里这周的发票 PDF 整理一下:每份做要点摘要,汇总成一份 Markdown,然后把原件归档到「发票 / 2026-06」文件夹。'

/** 会话内的 User 消息(会话导航的锚点);brief = 简单问答轮,后接一段短回复 */
interface UserTurn {
  id: string
  time: string
  goal: string
  brief?: boolean
}

const INITIAL_TURNS: UserTurn[] = [
  { id: 't1', time: '09:12', goal: '读一下租房合同里的违约条款', brief: true },
  { id: 't2', time: '09:41', goal: DEFAULT_GOAL }
]

interface PlanStepMeta {
  cap: string
  desc: string
  dur: string
  /** 演示播放时该步的持续时间(ms);第 4 步是写操作,停在「待批准」 */
  demoMs: number
}

const PLAN_STEPS: PlanStepMeta[] = [
  { cap: 'filesystem_list', desc: '扫描 Downloads,找出发票 PDF', dur: '0.8s', demoMs: 1100 },
  {
    cap: 'document_extract_pdf',
    desc: '提取 3 份 PDF 共 48 页文本与要点',
    dur: '12.4s',
    demoMs: 1900
  },
  {
    cap: 'document_create_markdown',
    desc: '生成汇总文档「文档 / 发票摘要-2026-06.md」',
    dur: '2.1s',
    demoMs: 1400
  },
  { cap: 'filesystem_move', desc: '3 份原件移入「发票 / 2026-06」', dur: '1.2s', demoMs: 0 }
]

interface HistItem {
  id: string
  title: string
  group: '今天' | '昨天' | '更早'
  time: string
  demo?: boolean
}

const HISTORY: HistItem[] = [
  {
    id: 'demo',
    title: '发票 PDF 摘要与归档',
    group: '今天',
    time: '09:41 · 4 步计划 · 第 3 步',
    demo: true
  },
  { id: 'contract', title: '读一下租房合同里的违约条款', group: '今天', time: '08:12 · 已完成' },
  { id: 'export', title: '把上周会议记录导出成 Markdown', group: '昨天', time: '21:30 · 已完成' },
  { id: 'compare', title: '对比两份报价单的差异', group: '昨天', time: '15:04 · 已完成' },
  { id: 'cleanup', title: '整理 Downloads 里的截图', group: '更早', time: '06-28 · 已完成' }
]
const HIST_GROUPS = ['今天', '昨天', '更早'] as const

const QUICK_FILLS: { icon: LucideIcon; label: string; prompt: string }[] = [
  {
    icon: FileText,
    label: '全文摘要',
    prompt: '帮我把 文档/产品白皮书.pdf 做一份全文摘要,重点提炼数字与结论'
  },
  {
    icon: ArrowLeftRight,
    label: '对比两份文档',
    prompt: '对比 文档/报价单-A.pdf 和 文档/报价单-B.pdf,列出价格与服务差异'
  },
  {
    icon: ShieldCheck,
    label: '提取关键条款',
    prompt: '从 合同/租房合同.pdf 里提取违约、退租、涨租相关条款'
  }
]

const THINK_LINES = [
  {
    tm: '09:41:02',
    tx: '识别目标:发票整理 = 列表 → 提取 → 汇总 → 归档,需要 filesystem 与 document 两类能力,其中归档是写操作。'
  },
  {
    tm: '09:41:03',
    tx: 'Downloads 下匹配「发票 / invoice」的 PDF 共 3 份,均为 6 月开具,无需额外筛选。'
  },
  {
    tm: '09:41:04',
    tx: '摘要按「抬头 / 金额 / 日期 / 用途」四栏抽取,便于横向对比;汇总文档命名 发票摘要-2026-06.md。'
  },
  { tm: '09:41:05', tx: '移动原件会改动授权根内的文件位置,先请求批准再执行。' }
]

const FACTS = [
  { ft: '云服务年费发票 — ¥2,400.00 · 2026-06-03', pg: 'p.1' },
  { ft: '图书采购发票 — ¥860.00 · 2026-06-11', pg: 'p.1' },
  { ft: '设备采购发票 — ¥12,000.00 · 2026-06-18', pg: 'p.2' }
]

const SCENARIO_CHIPS: { key: Scenario; label: string }[] = [
  { key: 'running', label: '① 任务进行中' },
  { key: 'waiting', label: '② 权限审批时刻' },
  { key: 'idle', label: '③ 新对话空态' }
]

function StepIcon({ state }: { state: StepState }): React.JSX.Element {
  if (state === 'running')
    return <LoaderCircle className="size-4 animate-spin text-[var(--mint)]" />
  if (state === 'done') return <Check className="size-4 text-[var(--mint)]" strokeWidth={2.2} />
  if (state === 'wait') return <Clock className="size-4 text-[var(--amber-strong)]" />
  if (state === 'cancel') return <X className="size-4 text-destructive" strokeWidth={2.2} />
  return <Circle className="size-3.5 text-muted-foreground/50" />
}

function stepDur(state: StepState, dur: string): string {
  if (state === 'done') return dur
  if (state === 'running') return '进行中'
  if (state === 'wait') return '待批'
  if (state === 'cancel') return '已取消'
  return '—'
}

export default function DesignLab(): React.JSX.Element {
  const [scenario, setScenario] = useState<Scenario>('running')
  const [turns, setTurns] = useState<UserTurn[]>(INITIAL_TURNS)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [activeTurn, setActiveTurn] = useState<string | null>(null)
  const [steps, setSteps] = useState<StepState[]>(['done', 'done', 'running', 'wait'])
  const [hist, setHist] = useState({
    mark: '·进行中',
    running: true,
    time: '09:41 · 4 步计划 · 第 3 步'
  })
  const [activeHist, setActiveHist] = useState('demo')
  const [reply, setReply] = useState<'none' | 'ok' | 'deny'>('none')
  const [factsRevealed, setFactsRevealed] = useState(true)
  const [input, setInput] = useState('')
  /* 审批请求不弹窗,作为聊天流内的一张卡片:pending 展示完整请求,决定后收成一条记录 */
  const [permStatus, setPermStatus] = useState<
    'idle' | 'pending' | 'approved' | 'denied' | 'expired'
  >('idle')
  const [remaining, setRemaining] = useState(45)
  const [indexOpen, setIndexOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const toastTimer = useRef<number | null>(null)
  const demoTimers = useRef<number[]>([])
  const runToken = useRef(0)
  const flashTimer = useRef<number | null>(null)

  const showToast = useCallback((msg: string, ms = 2400): void => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), ms)
  }, [])

  /** 会话导航(ZCode 式消息轨):平滑滚动到目标 User 消息并高亮一闪 */
  const jumpTo = useCallback((id: string): void => {
    const el = document.getElementById('turn-' + id)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveTurn(id)
    setFlashId(id)
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashId(null), 1300)
  }, [])

  /* 滚动时计算哪条 User 消息离视口顶部最近,消息轨上作为当前位置指示 */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const turnsRef = useRef<UserTurn[]>(turns)
  const railRaf = useRef(0)
  useEffect(() => {
    turnsRef.current = turns
  }, [turns])

  const handleChatScroll = useCallback((): void => {
    if (railRaf.current) return
    railRaf.current = window.requestAnimationFrame(() => {
      railRaf.current = 0
      const root = scrollRef.current
      if (!root) return
      const rootTop = root.getBoundingClientRect().top
      let best: string | null = null
      let bestDist = Number.POSITIVE_INFINITY
      for (const t of turnsRef.current) {
        const el = document.getElementById('turn-' + t.id)
        if (!el) continue
        const dist = Math.abs(el.getBoundingClientRect().top - rootTop - 24)
        if (dist < bestDist) {
          bestDist = dist
          best = t.id
        }
      }
      setActiveTurn(best)
    })
  }, [])

  const clearTimers = useCallback(() => {
    demoTimers.current.forEach((t) => window.clearTimeout(t))
    demoTimers.current = []
  }, [])

  useEffect(() => {
    document.body.classList.add('design-lab-active')
    handleChatScroll() /* 初始定位:消息轨亮出距视口顶最近的一条 */
    /* Claude 风格字体:Source Serif 4(拉丁)+ Noto Serif SC(中文),fontsource 走 jsdelivr,
       CJK 按 unicode-range 分包,断网回退系统宋体/Georgia */
    const links = [
      'https://cdn.jsdelivr.net/npm/@fontsource/source-serif-4@5/600.css',
      'https://cdn.jsdelivr.net/npm/@fontsource/source-serif-4@5/700.css',
      'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5/600.css',
      'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5/700.css'
    ].map((href) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      document.head.appendChild(link)
      return link
    })
    return () => {
      document.body.classList.remove('design-lab-active')
      links.forEach((link) => link.remove())
      clearTimers()
      if (railRaf.current) window.cancelAnimationFrame(railRaf.current)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
    }
  }, [clearTimers, handleChatScroll])

  const setStep = useCallback((i: number, st: StepState) => {
    setSteps((prev) => prev.map((s, idx) => (idx === i - 1 ? st : s)))
  }, [])

  /** 批准 / 拒绝(含倒计时到 0 的自动拒绝):卡片收成决定记录 */
  const decide = useCallback(
    (approved: boolean, auto = false): void => {
      setPermStatus(approved ? 'approved' : auto ? 'expired' : 'denied')
      setFactsRevealed(true)
      if (approved) {
        setStep(4, 'done')
        setHist({ mark: '·已完成', running: false, time: '09:44 · 4 步 · 全部完成' })
        showToast('已批准 · 正在移动 3 个文件')
        demoTimers.current.push(window.setTimeout(() => showToast('归档完成 · 任务已结束'), 1400))
      } else {
        setStep(4, 'cancel')
        setHist({ mark: '·已取消', running: false, time: '09:44 · 3 完成 · 1 已取消' })
        showToast(auto ? '超时未处理,已自动拒绝' : '已拒绝 · 未移动任何文件,任务结束')
      }
      setReply(approved ? 'ok' : 'deny')
    },
    [setStep, showToast]
  )

  /* 权限倒计时:打开时重置 45s(openPerm),每秒 -1;到 0 自动拒绝(fail-closed)。
     剩余秒数走 ref,由 interval 同步到 state,避免在 effect 里同步 setState。 */
  const remainingRef = useRef(45)
  const decideRef = useRef(decide)
  useEffect(() => {
    decideRef.current = decide
  }, [decide])

  const requestPerm = useCallback((): void => {
    remainingRef.current = 45
    setRemaining(45)
    setPermStatus('pending')
  }, [])

  useEffect(() => {
    if (permStatus !== 'pending') return
    const timer = window.setInterval(() => {
      const next = Math.max(0, remainingRef.current - 1)
      remainingRef.current = next
      setRemaining(next)
      if (next === 0) decideRef.current(false, true)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [permStatus])

  /* 请求出现时,把审批卡滚到可见位置 */
  const permCardRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (permStatus === 'pending') {
      permCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [permStatus])

  const enterScenario = useCallback(
    (next: Scenario) => {
      clearTimers()
      runToken.current++
      setPermStatus('idle')
      setScenario(next)
      if (next === 'idle') {
        setInput('')
        return
      }
      setTurns(INITIAL_TURNS)
      setHist({ mark: '·进行中', running: true, time: '09:41 · 4 步计划 · 第 3 步' })
      setReply('none')
      setFactsRevealed(true)
      if (next === 'running') setSteps(['done', 'done', 'running', 'wait'])
      if (next === 'waiting') {
        setSteps(['done', 'done', 'done', 'wait'])
        requestPerm()
      }
    },
    [clearTimers, requestPerm]
  )

  /** 自定义任务演示:逐步播放 1-3 步,第 4 步停在待批准 */
  const runDemo = useCallback(
    (text: string) => {
      clearTimers()
      const token = ++runToken.current
      setScenario('demo')
      setTurns((prev) => prev.map((t) => (t.id === 't2' ? { ...t, goal: text, time: '刚刚' } : t)))
      setHist({ mark: '·进行中', running: true, time: '刚刚 · 4 步计划' })
      setReply('none')
      setFactsRevealed(false)
      setSteps(['pend', 'pend', 'pend', 'pend'])
      const advance = (i: number): void => {
        if (token !== runToken.current) return
        if (i > 3) {
          setStep(4, 'wait')
          requestPerm()
          return
        }
        setStep(i, 'running')
        demoTimers.current.push(
          window.setTimeout(
            () => {
              if (token !== runToken.current) return
              setStep(i, 'done')
              demoTimers.current.push(window.setTimeout(() => advance(i + 1), 320))
            },
            PLAN_STEPS[i - 1].demoMs
          )
        )
      }
      advance(1)
    },
    [clearTimers, requestPerm, setStep]
  )

  const send = (): void => {
    const text = input.trim()
    if (!text) {
      showToast('先描述一下你的任务')
      return
    }
    setInput('')
    runDemo(text)
  }

  const doneCount = steps.filter((s) => s === 'done').length
  const runningCount = steps.filter((s) => s === 'running').length
  const waitCount = steps.filter((s) => s === 'wait').length
  const cancelCount = steps.filter((s) => s === 'cancel').length
  let planBadge = `4 步 · ${doneCount} 完成`
  if (runningCount) planBadge += ` · ${runningCount} 进行中`
  if (waitCount) planBadge += ` · ${waitCount} 待批`
  if (cancelCount) planBadge += ` · ${cancelCount} 已取消`

  const idle = scenario === 'idle'

  return (
    <>
      {/* 无边框窗口的拖拽顶栏(与正式应用 TitleBar 同规格) */}
      <header
        className="flex h-10 shrink-0 select-none items-center border-b border-[var(--border)] bg-[#f4f0e7]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="pl-4 font-mono text-[10px] tracking-[0.2em] text-[var(--mint-deep)]">
          DESIGN LAB · #design
        </span>
      </header>
      <div className="mx-auto max-w-[1200px] px-10 pb-14 pt-10">
      {/* ── 刊头 ── */}
      <header className="mb-10">
        <p className="font-mono text-[11px] tracking-[0.22em] text-[var(--mint-deep)] uppercase">
          Personal Agent · Interactive Prototype (React + shadcn)
        </p>
        <h1 className="font-claude mt-3 text-4xl font-bold tracking-wide">
          温暖纸感 <span className="text-[var(--mint-deep)]">×</span> 薄荷青绿
        </h1>
        <p className="mt-3 max-w-[640px] text-sm leading-7 text-muted-foreground">
          用项目现有的 Tailwind + shadcn 组件搭建的可点击原型,主题令牌只作用于本页;
          定稿后按下方「落地映射」搬进 app.css 即为正式界面。发一条任务、批准一次写操作试试。
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {[
            ['基调', '浅色清新'],
            ['风格', '温暖纸感'],
            ['主色', '薄荷青绿 #0F9D8F'],
            ['圆角', '10–20px'],
            ['投影', '暖棕调 · 低透明度']
          ].map(([k, v]) => (
            <span
              key={k}
              className="rounded-full border bg-card px-3.5 py-1 text-xs text-muted-foreground"
            >
              {k} <b className="font-semibold text-foreground">{v}</b>
            </span>
          ))}
        </div>
      </header>

      {/* ── 演示控制台 ── */}
      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <span className="mr-1 font-mono text-[10.5px] tracking-[0.18em] text-muted-foreground/70">
          演示控制台
        </span>
        {SCENARIO_CHIPS.map((chip) => (
          <Button
            key={chip.key}
            size="sm"
            variant={scenario === chip.key ? 'default' : 'outline'}
            onClick={() => enterScenario(chip.key)}
          >
            {chip.label}
          </Button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground/70">
          或在输入舱里随便发一条任务,原型会完整播放执行流程
        </span>
      </div>

      {/* ── 应用窗体 ── */}
      <div className="overflow-hidden rounded-2xl border border-[var(--input)] bg-[#fbf8f2] shadow-[0_1px_2px_rgba(94,80,53,0.05),0_8px_28px_rgba(94,80,53,0.08)]">
        {/* 标题栏 */}
        <div className="flex h-[42px] items-center border-b bg-[#f4f0e7] px-4">
          <div className="flex items-center gap-2.5">
            <div className="grid size-5 place-items-center rounded-md bg-gradient-to-br from-[var(--mint)] to-[var(--mint-deep)] text-white">
              <Sparkles className="size-3" />
            </div>
            <span className="font-claude text-[13px] font-bold tracking-wide">PersonalAgent</span>
          </div>
          <div className="ml-auto flex select-none gap-5 text-xs text-muted-foreground/60">
            <span>—</span>
            <span>□</span>
            <span>✕</span>
          </div>
        </div>

        <div className="relative flex h-[780px]">
          {/* 侧栏 */}
          <aside className="flex w-[252px] shrink-0 flex-col border-r bg-secondary px-3.5 pt-4 pb-3.5">
            <div className="mb-3.5 flex w-fit items-center gap-2 rounded-full border bg-card/70 px-3 py-1 text-[11.5px] text-muted-foreground">
              <span className="lab-pulse-dot size-[7px] rounded-full bg-[var(--mint)]" />
              运行时正常 · v0.3
            </div>

            <Button
              variant="outline"
              className="mb-5 w-full rounded-xl border-[var(--input)] font-semibold shadow-sm"
              onClick={() => enterScenario('idle')}
            >
              <Plus className="text-[var(--mint-deep)]" />
              新对话
            </Button>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {HIST_GROUPS.map((group) => (
                <div key={group} className="mb-4">
                  <div className="mb-2 px-1.5 text-[10.5px] font-semibold tracking-[0.14em] text-muted-foreground/70">
                    {group}
                  </div>
                  {HISTORY.filter((h) => h.group === group).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveHist(item.id)
                        if (item.demo) enterScenario('running')
                        else showToast('原型演示:只有「发票 PDF 摘要与归档」带完整流程')
                      }}
                      className={cn(
                        'mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-xl px-2.5 py-2 text-left transition-colors',
                        activeHist === item.id ? 'border bg-card shadow-sm' : 'hover:bg-card/70'
                      )}
                    >
                      <span
                        className={cn(
                          'w-full truncate text-[12.5px] leading-snug',
                          activeHist === item.id
                            ? 'font-semibold text-foreground'
                            : 'text-muted-foreground'
                        )}
                      >
                        {item.title}
                        {activeHist === item.id && (
                          <span className="text-[var(--mint-deep)]">{hist.mark}</span>
                        )}
                      </span>
                      <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground/70">
                        <span
                          className={cn(
                            'size-1.5 rounded-full',
                            activeHist === item.id && hist.running
                              ? 'bg-[var(--amber-strong)]'
                              : 'bg-[var(--mint)]'
                          )}
                        />
                        {activeHist === item.id ? hist.time : item.time}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>

            <div className="border-t pt-3">
              <div className="mb-3 flex items-center gap-1.5 px-1 text-[11.5px] text-muted-foreground">
                <FileText className="size-3.5" />
                已索引文档 <b className="font-semibold text-foreground">12</b> 份
              </div>
              <div className="flex gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 rounded-lg text-[11px] text-muted-foreground"
                  onClick={() => setIndexOpen(true)}
                >
                  <FileText className="size-3" />
                  索引
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 rounded-lg text-[11px] text-muted-foreground"
                  onClick={() => showToast('诊断:运行时正常 · 已注册能力 14 项 · 无告警')}
                >
                  <Activity className="size-3" />
                  诊断
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 rounded-lg text-[11px] text-muted-foreground"
                  onClick={() => setSettingsOpen(true)}
                >
                  <SlidersHorizontal className="size-3" />
                  设置
                </Button>
              </div>
            </div>
          </aside>

          {/* 主区 */}
          <main className="flex min-w-0 flex-1 flex-col">
            {idle ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3.5 px-10 pb-24 text-center">
                <div className="grid size-16 place-items-center rounded-3xl bg-gradient-to-br from-[var(--mint)] to-[var(--mint-deep)] text-white shadow-[0_10px_24px_rgba(15,157,143,0.3)]">
                  <Sparkles className="size-6" />
                </div>
                <h5 className="font-claude text-xl font-bold">开始一段新对话</h5>
                <p className="text-xs leading-6 text-muted-foreground/80">
                  描述你想完成的任务——读文档、做摘要、整理文件、设提醒都行。
                  <br />
                  涉及写操作时,我会先征得你的批准。
                </p>
                <div className="mt-1.5 flex flex-wrap justify-center gap-2">
                  {QUICK_FILLS.map((q) => (
                    <button
                      key={q.label}
                      type="button"
                      onClick={() => setInput(q.prompt)}
                      className="flex items-center gap-1.5 rounded-full border bg-[var(--paper-warm)] px-3 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:border-[var(--mint-line)] hover:bg-[var(--mint-tint)] hover:text-[var(--mint-deep)]"
                    >
                      <q.icon className="size-3" />
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="relative min-h-0 flex-1">
                {/* 消息轨(ZCode 式):每条 User 消息一格,点击跳转;当前滚动位置高亮 */}
                <div className="absolute top-1/2 left-1.5 z-10 flex -translate-y-1/2 flex-col items-center gap-2.5">
                  {turns.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      title={t.goal}
                      aria-label={'跳转到消息:' + t.goal}
                      onClick={() => jumpTo(t.id)}
                      className={cn(
                        'h-[2px] w-2.5 rounded-full transition-all duration-150 hover:w-4',
                        activeTurn === t.id
                          ? 'bg-[var(--mint)]'
                          : 'bg-muted-foreground/30 hover:bg-[var(--mint-deep)]'
                      )}
                    />
                  ))}
                </div>
                <div
                  ref={scrollRef}
                  onScroll={handleChatScroll}
                  className="h-full overflow-y-auto px-8 py-7"
                >
                  <div className="mx-auto flex max-w-[660px] flex-col">
                    <div className="mb-5 text-center text-[10.5px] tracking-[0.12em] text-muted-foreground/70">
                      <span className="bg-[#fbf8f2] px-3">今天</span>
                    </div>

                    {turns.map((t, i) => (
                      <Fragment key={t.id}>
                        <div id={'turn-' + t.id} className="mb-5 flex scroll-mt-3 justify-end">
                          <div
                            className={cn(
                              'max-w-[78%] rounded-2xl rounded-br-md border border-[var(--mint-line)] bg-[var(--mint-tint)] px-4 py-3 text-[13.5px] leading-relaxed text-[#1d4f49]',
                              flashId === t.id && 'lab-flash'
                            )}
                          >
                            {t.goal}
                          </div>
                        </div>
                        {t.brief && (
                          <div className="font-claude mb-6 px-1 text-[14px] leading-loose">
                            已读完整份合同(14 页)。违约条款集中在第 7–9
                            条:提前退租需支付一个月租金作为违约金,涨租需提前 60 日书面通知。
                            <span className="ml-1 rounded bg-[var(--mint-tint)] px-1.5 py-0.5 font-mono text-[9.5px] text-[var(--mint-deep)]">
                              p.9
                            </span>
                          </div>
                        )}
                        {i === turns.length - 1 && (
                          <Fragment>
                            {/* 思考链 */}
                            <Collapsible
                              defaultOpen
                              className={cn('mb-3.5', scenario === 'demo' && 'hidden')}
                            >
                              <Card className="gap-0 border-[var(--border)] bg-[var(--paper-warm)] py-0 shadow-sm">
                                <CollapsibleTrigger asChild>
                                  <CardHeader className="cursor-pointer grid-cols-[auto_auto_1fr_auto] items-center gap-2.5 border-b px-4 py-3">
                                    <CardTitle className="font-claude text-[13.5px]">
                                      思考过程
                                    </CardTitle>
                                    <Badge
                                      variant="outline"
                                      className="border-[var(--mint-line)] bg-[var(--mint-tint)] font-mono text-[10px] text-[var(--mint-deep)]"
                                    >
                                      thought-chain
                                    </Badge>
                                    <span />
                                    <ChevronDown className="size-4 text-muted-foreground" />
                                  </CardHeader>
                                </CollapsibleTrigger>
                                <CollapsibleContent>
                                  <CardContent className="relative px-4 pt-2.5 pb-3.5">
                                    <div className="lab-think-rail" />
                                    {THINK_LINES.map((line) => (
                                      <div key={line.tm} className="flex gap-3 py-1">
                                        <span className="mt-[3px] w-[52px] shrink-0 font-mono text-[10px] text-muted-foreground/70">
                                          {line.tm}
                                        </span>
                                        <span className="text-xs leading-relaxed text-muted-foreground">
                                          {line.tx}
                                        </span>
                                      </div>
                                    ))}
                                  </CardContent>
                                </CollapsibleContent>
                              </Card>
                            </Collapsible>

                            {/* 执行计划 */}
                            <Collapsible defaultOpen className="mb-3.5">
                              <Card className="gap-0 py-0 shadow-sm">
                                <CollapsibleTrigger asChild>
                                  <CardHeader className="cursor-pointer grid-cols-[auto_auto_1fr_auto] items-center gap-2.5 border-b px-4 py-3">
                                    <CardTitle className="font-claude text-[13.5px]">
                                      执行计划
                                    </CardTitle>
                                    <Badge
                                      variant="outline"
                                      className="border-[var(--mint-line)] bg-[var(--mint-tint)] font-mono text-[10px] text-[var(--mint-deep)]"
                                    >
                                      {planBadge}
                                    </Badge>
                                    <span />
                                    <ChevronDown className="size-4 text-muted-foreground" />
                                  </CardHeader>
                                </CollapsibleTrigger>
                                <CollapsibleContent>
                                  <CardContent className="px-2 py-1.5">
                                    {PLAN_STEPS.map((meta, idx) => {
                                      const st = steps[idx]
                                      return (
                                        <div
                                          key={meta.cap}
                                          className={cn(
                                            'flex items-start gap-3 px-2 py-2.5',
                                            idx > 0 && 'border-t border-dashed',
                                            st === 'running' && 'text-[var(--mint-deep)]',
                                            st === 'cancel' && 'text-destructive'
                                          )}
                                        >
                                          <span className="mt-0.5 flex shrink-0">
                                            <StepIcon state={st} />
                                          </span>
                                          <div className="min-w-0 flex-1">
                                            <div className="text-[12.8px] leading-relaxed text-foreground">
                                              {meta.desc}
                                            </div>
                                            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
                                              {meta.cap}
                                            </div>
                                          </div>
                                          <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground/70">
                                            {stepDur(st, meta.dur)}
                                          </span>
                                        </div>
                                      )
                                    })}
                                  </CardContent>
                                </CollapsibleContent>
                              </Card>
                            </Collapsible>

                            {/* 权限审批 · 流内卡片(不弹窗):pending 展示完整请求,决定后收成一条记录 */}
                            {permStatus === 'pending' && (
                              <Card
                                ref={permCardRef}
                                className="mb-3.5 gap-0 overflow-hidden border-[var(--amber-line)] py-0 shadow-[0_1px_2px_rgba(94,80,53,0.06),0_6px_20px_rgba(161,98,7,0.12)]"
                              >
                                <div className="flex items-center gap-2.5 border-b border-[var(--amber-line)] bg-[var(--amber-tint)] px-4 py-2">
                                  <AlertTriangle className="size-4 shrink-0 text-[var(--amber-strong)]" />
                                  <span className="text-xs font-semibold tracking-wide text-[var(--amber-strong)]">
                                    写操作请求 · 需要你的批准
                                  </span>
                                  <div
                                    className="relative ml-auto grid size-9 place-items-center rounded-full"
                                    style={{
                                      background: `conic-gradient(${remaining <= 10 ? 'var(--amber-strong)' : 'var(--mint)'} ${(remaining / 45) * 360}deg, var(--border) 0)`
                                    }}
                                  >
                                    <div className="absolute inset-[3px] rounded-full bg-card" />
                                    <span className="relative font-mono text-[10px] font-bold">
                                      {remaining}
                                    </span>
                                  </div>
                                </div>
                                <CardContent className="px-4 pt-3.5 pb-4">
                                  <div className="font-claude text-[15.5px] font-bold leading-snug">
                                    移动 3 个发票 PDF 到归档文件夹?
                                  </div>
                                  <div className="mt-2.5 flex items-center gap-2">
                                    <span className="rounded-lg border border-[var(--amber-line)] bg-[var(--amber-tint)] px-2 py-0.5 font-mono text-[11px] text-[var(--amber-strong)]">
                                      filesystem_move
                                    </span>
                                    <span className="text-[11px] text-muted-foreground">
                                      风险等级 中 · 与计划第 4 步一致
                                    </span>
                                  </div>
                                  <div className="mt-3 flex flex-col gap-1">
                                    <div className="flex items-center gap-2.5 rounded-lg border bg-[var(--paper-warm)] px-3 py-2 font-mono text-[10.5px] text-muted-foreground">
                                      <FileText className="size-3.5 shrink-0" />
                                      <span className="truncate">
                                        C:\Users\Azusa\Downloads\发票-云服务-2026-06.pdf 等 3 个文件
                                      </span>
                                    </div>
                                    <ArrowDown className="mx-auto size-3 text-muted-foreground" />
                                    <div className="flex items-center gap-2.5 rounded-lg border border-[var(--mint-line)] bg-[var(--mint-tint)] px-3 py-2 font-mono text-[10.5px] text-[#1d4f49]">
                                      <FolderOpen className="size-3.5 shrink-0 text-[var(--mint-deep)]" />
                                      <span className="truncate">
                                        C:\Users\Azusa\Documents\发票\2026-06\
                                      </span>
                                    </div>
                                  </div>
                                  <div className="mt-2.5 flex items-center gap-2 text-[10.5px] text-muted-foreground">
                                    参数指纹
                                    <code className="rounded border bg-[var(--paper-warm)] px-1.5 py-0.5 font-mono text-[10px]">
                                      fp:3f9a-c21e-88b7
                                    </code>
                                    · 与批准过的列表、提取参数同源
                                  </div>
                                  <div className="mt-3.5 flex items-center gap-2.5">
                                    <span className="text-[10.5px] leading-relaxed text-muted-foreground/80">
                                      {remaining} 秒后自动拒绝
                                      <br />
                                      过期需重新发起
                                    </span>
                                    <div className="ml-auto flex gap-2">
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="border border-[var(--input)]"
                                        onClick={() => decide(false)}
                                      >
                                        拒绝
                                      </Button>
                                      <Button
                                        size="sm"
                                        onClick={() => decide(true)}
                                        className="shadow-[0_4px_14px_rgba(15,157,143,0.35)]"
                                      >
                                        <Check strokeWidth={2.4} />
                                        批准并执行
                                      </Button>
                                    </div>
                                  </div>
                                  <div className="mt-3 flex items-center gap-1.5 border-t border-dashed pt-2.5 text-[10px] text-muted-foreground/70">
                                    <ShieldCheck className="size-3" />
                                    所有写操作都先经你批准 · 指纹用于防止计划外的参数篡改
                                  </div>
                                </CardContent>
                              </Card>
                            )}
                            {permStatus !== 'idle' && permStatus !== 'pending' && (
                              <div
                                className={cn(
                                  'mb-3.5 flex items-center gap-2.5 rounded-xl border px-4 py-2.5 text-xs',
                                  permStatus === 'approved' &&
                                    'border-[var(--mint-line)] bg-[var(--mint-tint)] text-[#1d4f49]',
                                  permStatus === 'denied' &&
                                    'border-destructive/30 bg-destructive/10 text-destructive',
                                  permStatus === 'expired' &&
                                    'border-[var(--amber-line)] bg-[var(--amber-tint)] text-[var(--amber-strong)]'
                                )}
                              >
                                {permStatus === 'approved' ? (
                                  <Check className="size-3.5 shrink-0" strokeWidth={2.4} />
                                ) : (
                                  <X className="size-3.5 shrink-0" strokeWidth={2.4} />
                                )}
                                <span className="font-semibold">
                                  {permStatus === 'approved' && '已批准并执行'}
                                  {permStatus === 'denied' && '已拒绝 · 未移动任何文件'}
                                  {permStatus === 'expired' && '超时未处理,已自动拒绝'}
                                </span>
                                <span className="ml-auto truncate font-mono text-[10px] opacity-70">
                                  filesystem_move · fp:3f9a-c21e-88b7 · 09:44
                                </span>
                              </div>
                            )}

                            {/* 摘要卡 */}
                            {factsRevealed && (
                              <Collapsible defaultOpen className="mb-3.5">
                                <Card className="gap-0 py-0 shadow-sm">
                                  <CollapsibleTrigger asChild>
                                    <CardHeader className="cursor-pointer grid-cols-[auto_auto_1fr_auto] items-center gap-2.5 border-b px-4 py-3">
                                      <CardTitle className="font-claude text-[13.5px]">
                                        摘要 · 3 份发票
                                      </CardTitle>
                                      <Badge
                                        variant="outline"
                                        className="border-[var(--mint-line)] bg-[var(--mint-tint)] font-mono text-[10px] text-[var(--mint-deep)]"
                                      >
                                        页码可溯源
                                      </Badge>
                                      <span />
                                      <ChevronDown className="size-4 text-muted-foreground" />
                                    </CardHeader>
                                  </CollapsibleTrigger>
                                  <CollapsibleContent>
                                    <CardContent className="px-4 pt-2 pb-3.5">
                                      {FACTS.map((f) => (
                                        <div
                                          key={f.ft}
                                          className="flex items-baseline gap-2.5 py-1.5"
                                        >
                                          <span className="text-[12.8px] leading-relaxed">
                                            {f.ft}
                                          </span>
                                          <span className="shrink-0 rounded-md bg-[var(--mint-tint)] px-1.5 font-mono text-[9.5px] text-[var(--mint-deep)]">
                                            {f.pg}
                                          </span>
                                        </div>
                                      ))}
                                      <div className="mt-2 rounded-lg bg-[var(--paper-warm)] px-3 py-2.5 text-xs text-muted-foreground">
                                        合计 <b className="text-[var(--mint-deep)]">¥15,260.00</b>
                                        ,三份均为增值税普通发票,已写入{' '}
                                        <b className="text-[var(--mint-deep)]">
                                          文档/发票摘要-2026-06.md
                                        </b>
                                      </div>
                                    </CardContent>
                                  </CollapsibleContent>
                                </Card>
                              </Collapsible>
                            )}

                            {/* 回复:Agent 的话用衬线呈现(Claude 式),用户气泡保持无衬线 */}
                            {reply === 'ok' && (
                              <div className="font-claude px-1 text-[14px] leading-loose">
                                归档完成:3 份原件已移入
                                <span className="font-semibold text-[var(--mint-deep)]">
                                  发票 / 2026-06
                                </span>
                                ,任务结束。
                                <div className="font-sans mt-1.5 text-xs text-muted-foreground/70">
                                  所有事实均来自原文并附页码,可点击页码跳转核对。
                                </div>
                              </div>
                            )}
                            {reply === 'deny' && (
                              <div className="font-claude px-1 text-[14px] leading-loose">
                                已按你的决定
                                <span className="font-semibold text-[var(--mint-deep)]">
                                  取消归档
                                </span>
                                ,未移动任何文件。汇总文档仍保留在「文档 /
                                发票摘要-2026-06.md」,随时可以重新发起归档。
                              </div>
                            )}
                          </Fragment>
                        )}
                      </Fragment>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 输入舱 */}
            <div className="pt-2.5 pb-6">
              <div className="mx-auto max-w-[660px] rounded-[20px] border border-[var(--input)] bg-card px-4 pt-3.5 pb-3 shadow-[0_1px_2px_rgba(94,80,53,0.05),0_8px_28px_rgba(94,80,53,0.08)] transition-shadow focus-within:shadow-[0_1px_2px_rgba(94,80,53,0.05),0_8px_28px_rgba(15,157,143,0.14)]">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      send()
                    }
                  }}
                  placeholder="描述你的任务,或点下面的快捷动作…"
                  className="min-h-7 resize-none border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 md:text-[13.5px]"
                  rows={1}
                />
                <div className="flex items-center gap-1.5">
                  {QUICK_FILLS.map((q) => (
                    <button
                      key={q.label}
                      type="button"
                      onClick={() => setInput(q.prompt)}
                      className="flex items-center gap-1.5 rounded-full border bg-[var(--paper-warm)] px-3 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:border-[var(--mint-line)] hover:bg-[var(--mint-tint)] hover:text-[var(--mint-deep)]"
                    >
                      <q.icon className="size-3" />
                      {q.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => showToast('已将当前会话导出为 Markdown 并复制到剪贴板')}
                    className="flex items-center gap-1.5 rounded-full border bg-[var(--paper-warm)] px-3 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:border-[var(--mint-line)] hover:bg-[var(--mint-tint)] hover:text-[var(--mint-deep)]"
                  >
                    <FileDown className="size-3" />
                    导出 Markdown
                  </button>
                  <Button
                    size="icon"
                    onClick={send}
                    className="ml-auto size-9 rounded-full shadow-[0_4px_12px_rgba(15,157,143,0.35)]"
                    aria-label="发送"
                  >
                    <ArrowUp strokeWidth={2.4} />
                  </Button>
                </div>
                <div className="mt-2 flex gap-3.5 px-1 text-[10px] text-muted-foreground/70">
                  <span>
                    <kbd className="rounded border bg-[var(--paper-warm)] px-1 font-mono text-[9px]">
                      Enter
                    </kbd>{' '}
                    发送
                  </span>
                  <span>
                    <kbd className="rounded border bg-[var(--paper-warm)] px-1 font-mono text-[9px]">
                      Shift + Enter
                    </kbd>{' '}
                    换行
                  </span>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>

      {/* ── 索引管理 ── */}
      <Dialog open={indexOpen} onOpenChange={setIndexOpen}>
        <DialogContent className="max-w-[540px] rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-claude">索引管理</DialogTitle>
            <DialogDescription>已索引的 PDF 文档及其扫描时间</DialogDescription>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>文档</TableHead>
                <TableHead>首次扫描</TableHead>
                <TableHead>最近扫描</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                ['产品白皮书.pdf', '2026-06-28', '今天 08:02'],
                ['租房合同.pdf', '2026-06-30', '昨天 21:10'],
                ['报价单-A.pdf', '2026-07-01', '昨天 15:00']
              ].map(([name, first, last]) => (
                <TableRow key={name}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell className="text-muted-foreground">{first}</TableCell>
                  <TableCell>
                    <span className="rounded-md bg-[var(--mint-tint)] px-1.5 py-0.5 font-mono text-[9.5px] text-[var(--mint-deep)]">
                      {last}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-[11px] text-muted-foreground/70">
            共 12 份已索引 · 演示仅展示最近 3 份
          </p>
        </DialogContent>
      </Dialog>

      {/* ── 模型设置 ── */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-[540px] rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-claude">模型设置</DialogTitle>
            <DialogDescription>配置 API Key、模型名与 API Base URL</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <Label>API Key</Label>
              <Input type="password" autoComplete="off" placeholder="留空 = 不修改已保存的 Key" />
              <p className="text-[10.5px] leading-relaxed text-muted-foreground/70">
                Key 只写本地,永不回传到界面;清除请用「清除已存的 Key」。
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>模型名</Label>
              <Input placeholder="如 glm-4-flash(留空 = 清空)" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>API Base URL</Label>
              <Input placeholder="https://…(留空 = 清空)" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSettingsOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                setSettingsOpen(false)
                showToast('已保存 · 运行时重启后新配置生效(演示)')
              }}
            >
              保存并重启运行时
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Toast ── */}
      <div
        className={cn(
          'fixed bottom-24 left-1/2 z-[70] -translate-x-1/2 rounded-full bg-[#3a372f] px-4.5 py-2 text-xs text-[#fdfcf8] shadow-lg transition-all',
          toast ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2.5 opacity-0'
        )}
        role="status"
      >
        {toast}
      </div>

      {/* ── 落地映射 ── */}
      <section className="mt-16 rounded-2xl border bg-card p-7 shadow-sm">
        <h2 className="font-claude text-base font-bold">
          落地映射 — 设计实验室令牌 → app.css 现有变量
        </h2>
        <Table className="mt-3">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[160px]">现变量</TableHead>
              <TableHead className="w-[240px]">新取值</TableHead>
              <TableHead>说明</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-mono text-xs text-[var(--mint-deep)]">
                --background
              </TableCell>
              <TableCell>
                <span className="mr-1.5 inline-block size-2.5 rounded-sm border border-[#d3c9b6] bg-[#f6f3ec] align-middle" />
                <b>#F6F3EC 纸白</b>
              </TableCell>
              <TableCell className="text-muted-foreground">
                全局底色;侧栏用{' '}
                <code className="font-mono text-xs text-[var(--mint-deep)]">--secondary</code>{' '}
                #EFE9DD 拉开一层
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-mono text-xs text-[var(--mint-deep)]">--card</TableCell>
              <TableCell>
                <span className="mr-1.5 inline-block size-2.5 rounded-sm border border-[#d3c9b6] bg-[#fffdf8] align-middle" />
                <b>#FFFDF8 暖白</b>
              </TableCell>
              <TableCell className="text-muted-foreground">
                计划卡 / 摘要卡 / 弹窗;投影换暖棕调
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-mono text-xs text-[var(--mint-deep)]">
                --foreground
              </TableCell>
              <TableCell>
                <span className="mr-1.5 inline-block size-2.5 rounded-sm border border-[#d3c9b6] bg-[#3a372f] align-middle" />
                <b>#3A372F 暖墨</b>
              </TableCell>
              <TableCell className="text-muted-foreground">
                正文;次级 #6E675A,弱化 #A49B8A,边线 #E4DDCF
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-mono text-xs text-[var(--mint-deep)]">--primary</TableCell>
              <TableCell>
                <span className="mr-1.5 inline-block size-2.5 rounded-sm border border-[#d3c9b6] bg-[#0f9d8f] align-middle" />
                <b>#0F9D8F 薄荷</b>
              </TableCell>
              <TableCell className="text-muted-foreground">
                只用于发送键、批准键、选中态、进行中动画;浅底 #E4F3F1
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-mono text-xs text-[var(--mint-deep)]">--warning</TableCell>
              <TableCell>
                <span className="mr-1.5 inline-block size-2.5 rounded-sm border border-[#eed9ae] bg-[#fdf3e2] align-middle" />
                <b>琥珀系</b>
              </TableCell>
              <TableCell className="text-muted-foreground">
                权限审批警示带、等待批准状态;深字 #8A5106
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-mono text-xs text-[var(--mint-deep)]">
                --font-claude(新增)
              </TableCell>
              <TableCell>
                <b>Source Serif 4 + Noto Serif SC(Claude 式衬线)</b>
              </TableCell>
              <TableCell className="text-muted-foreground">
                应用名、卡片标题、弹窗标题、Agent 回复;fontsource CDN 按需分包,断网回退系统宋体
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </section>
      </div>
    </>
  )
}
