import type { StepStatus, ThoughtChainStep, ToolStepView } from './types'

/** 一行「执行叙述」：一句人话 + 行尾极淡的工具名 */
export interface FlowLine {
  id: string
  text: string
  /** 工具名，挂在行尾的旁注；thought/notice 没有 */
  cap?: string
  status: StepStatus
  step: ThoughtChainStep
}

interface Phrase {
  doing: string
  done: string
}

/**
 * 能力 → 一句人话。
 *
 * 这一层是「过程写成话」的关键：界面不再罗列 `document_extract_pdf`，
 * 而是说「逐份读了：发票_2026-10.pdf」。工具名仍然作为旁注保留在行尾，
 * 需要核对的人抬头就能看到，不需要的人读句子就够了。
 *
 * 新增能力时在这里加一条；没收录的走 generic，退化成「调用了 xxx」，
 * 不会因为漏配而空白。
 */
const PHRASES: Array<{ match: RegExp; phrase: Phrase }> = [
  {
    match: /^(filesystem_list|list_files|fs_list|list_directory|directory_list|glob|find_files)$/,
    phrase: { doing: '正在翻目录', done: '翻了一遍目录' }
  },
  {
    match: /^(document_extract_pdf|pdf_extract|extract_pdf|parse_pdf|document_read|read_pdf)$/,
    phrase: { doing: '正在逐份读', done: '逐份读了' }
  },
  {
    match: /^(filesystem_move|move_file|fs_move|rename_file|move_path)$/,
    phrase: { doing: '正在把文件挪到该在的位置', done: '把文件挪到该在的位置' }
  },
  {
    match: /^(filesystem_create_dir|create_dir|mkdir)$/,
    phrase: { doing: '正在建目录', done: '建了目录' }
  },
  {
    match: /^(filesystem_delete|delete_file|remove_file|fs_delete)$/,
    phrase: { doing: '正在删文件', done: '删掉了文件' }
  },
  {
    match: /^(file_write|filesystem_write|write_file)$/,
    phrase: { doing: '正在写文件', done: '写了文件' }
  },
  {
    match: /^(file_read|filesystem_read|read_file)$/,
    phrase: { doing: '正在打开', done: '打开看了看' }
  },
  {
    match: /^(file_edit|edit_file|apply_patch)$/,
    phrase: { doing: '正在改文件', done: '改了文件' }
  },
  {
    match: /^(table_aggregate|aggregate|summarize_amount|calc|statistics)$/,
    phrase: { doing: '正在加总', done: '把数字加总了一遍' }
  },
  {
    match: /^(scheduler_create|create_reminder|reminder_create|schedule_task)$/,
    phrase: { doing: '正准备设提醒', done: '设了一个提醒' }
  },
  {
    match: /^(web_search|search_web|web_fetch|fetch_url|browse)$/,
    phrase: { doing: '正在上网查', done: '上网查了查' }
  },
  {
    match: /^(terminal_execute|run_command|shell_exec|exec)$/,
    phrase: { doing: '正在跑命令', done: '跑了一条命令' }
  },
  {
    match: /^(knowledge_search|rag_search|memory_search|wiki_search|search_memory)$/,
    phrase: { doing: '正在翻记忆', done: '翻了翻记忆与知识库' }
  },
  {
    match: /^spawn_subagent$/,
    phrase: { doing: '正在交给子代理', done: '交给子代理去办了' }
  }
]

const TARGET_KEYS = ['path', 'file', 'filePath', 'filepath', 'target', 'url', 'query', 'q', 'name']

function pickTarget(args: Record<string, unknown> | undefined): string | null {
  if (args === undefined) return null
  for (const key of TARGET_KEYS) {
    const value = args[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    const raw = value.trim()
    const base = raw.split(/[\\/]/).filter(Boolean).pop() ?? raw
    return base.length > 22 ? `${base.slice(0, 21)}…` : base
  }
  return null
}

function phraseFor(capability: string): Phrase {
  const hit = PHRASES.find((entry) => entry.match.test(capability))
  if (hit !== undefined) return hit.phrase
  return { doing: `正在调用 ${capability}`, done: `调用了 ${capability}` }
}

/** 把工具步骤翻译成一句话。 */
function toolSentence(step: ToolStepView): string {
  const phrase = phraseFor(step.capability)
  const verb = step.status === 'running' ? phrase.doing : phrase.done
  const target = pickTarget(step.arguments)
  return target === null ? verb : `${verb}：${target}`
}

/** 思考步骤只提炼一句话，避免整段独白淹没执行叙述。 */
function thoughtSentence(text: string, recent = false): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*`>_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const sentences = flat.split(/(?<=[。！？.!?])\s*/).filter((s) => s !== '')
  // 工具后新一轮思考的 delta 累加在串尾，叙述要跟着新内容走，取最后一句；
  // 开场思考从头讲起。
  const sentence = (recent ? sentences.at(-1) : sentences[0]) ?? flat
  return sentence === ''
    ? '正在想…'
    : sentence.length > 52
      ? `${sentence.slice(0, 51)}…`
      : sentence
}

/**
 * steps → 执行叙述行。
 * 规则：工具与提醒各自成句；思考在「还没有任何动作」时保留一句；
 * 工具跑过之后，已落定的开场思考吞掉（历史态不被独白拖长），
 * 但正在进行的思考（直播新一轮）保留——那是当前唯一的活动状态。
 */
export function stepsToFlowLines(steps: ThoughtChainStep[]): FlowLine[] {
  const lines: FlowLine[] = []
  const hasTool = steps.some((step) => step.type === 'tool')

  for (const step of steps) {
    if (step.type === 'tool') {
      lines.push({
        id: step.id,
        text: toolSentence(step),
        cap: step.capability,
        status: step.status,
        step
      })
      continue
    }
    if (step.type === 'notice') {
      // permission/sidecar/budget 的结论要么走专门的审批区，要么已由
      // 聊天正文里的终态消息说明（budget_exhausted 的 reason 就是助手消息），
      // 再出一句只会重复。
      if (
        step.noticeKind === 'permission' ||
        step.noticeKind === 'sidecar' ||
        step.noticeKind === 'budget'
      )
        continue
      lines.push({
        id: step.id,
        text: step.description,
        status: step.status,
        step
      })
      continue
    }
    if (step.type === 'thought') {
      if (hasTool && step.status !== 'running') continue
      lines.push({
        id: step.id,
        text: thoughtSentence(step.thinkingText, step.recent === true),
        status: step.status,
        step
      })
    }
  }

  return lines
}
