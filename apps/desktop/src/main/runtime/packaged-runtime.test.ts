/**
 * 打包冒烟：把 PyInstaller 冻结产物当运行时拉起来（TASK-029，TEST-015 的自动化部分）。
 *
 * 验的是「随包分发的那个 exe 还是不是一个完整的运行时」：握手、剧本加载、
 * 反向 RPC、摘要校验、进程退出。真启动安装包、点按钮、看窗口那条留给
 * docs/DEMO.md 的演示清单——Electron 窗口没法在这里拉起来。
 *
 * 冻结产物不在就整块跳过（与 python-supervisor.test.ts 的「venv 不在就跳过」
 * 同一条规矩）：先 `pnpm package:py` 再 `pnpm test:ts`，这组用例才会真的跑。
 *
 * 与 e2e/golden-path.test.ts 的分工：那边用 venv 跑真链路（真批准、真移动），
 * 覆盖「行为对不对」；这边用冻结产物跑一遍关键节点，覆盖「打包形态能不能跑」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { AGENT_RUN_TASK, ERROR_CODE, type HostExecuteToolParams } from '@personal-agent/protocol'
import { listVisibleCapabilities } from '../capabilities/host-executor'
import { repoRoot } from '../eval/paths'
import { PythonSupervisor, type HostHandler } from './python-supervisor'

const ROOT = repoRoot()
const PACKAGED_EXE = join(
  ROOT,
  'services',
  'agent-runtime',
  'dist',
  'personal_agent',
  'personal_agent.exe'
)
const SCRIPT_TEMPLATE = join(ROOT, 'tests', 'fixtures', 'scripts', 'golden-path.json')

const GOAL = '整理 Downloads 里的 PDF，给出带页码引用的摘要'
const PDF_NAME = 'three-page-text.pdf'
// 与 runtime.py 的 SCRIPT_ENV 是同一个字面量，跨语言没有共享常量表。
const SCRIPT_ENV = 'PERSONAL_AGENT_SCRIPT'

// 摘要要引用第 1~3 页，取证集合就得真有这三页（summary.py 的 collect_extracted_pages
// 按 observation.payload.pages 收页号，缺一页摘要就会被判不通过）。
const SMOKE_PAGES = [1, 2, 3].map((pageNumber) => ({
  pageNumber,
  text: `PersonalAgent fixture page ${pageNumber}`
}))

/** 冻结产物存在才跑；不存在时整块 skip，不制造假红。 */
const itPackaged = existsSync(PACKAGED_EXE) ? it : it.skip

let tempDir = ''
let downloadsRoot = ''
let scriptPath = ''
let supervisor: PythonSupervisor | null = null
let serverInfo: unknown = null
const hostCalls: HostExecuteToolParams[] = []
const stderrChunks: string[] = []

function diagnostic(): string {
  const tail = stderrChunks
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-20)
    .join('\n')
  return `python stderr 末尾:\n${tail === '' ? '（空）' : tail}`
}

/** 只回该回的东西：READ 能力给真形状的结果（摘要靠它过页码校验），
 *  WRITE 能力一律拒绝——冒烟不碰真实文件系统，批准链路由 e2e 覆盖。 */
const hostHandler: HostHandler = async (params) => {
  hostCalls.push(params)
  switch (params.capability) {
    case 'filesystem.list':
      return {
        ok: true,
        entries: [
          {
            name: PDF_NAME,
            absolutePath: `${downloadsRoot}/${PDF_NAME}`,
            modifiedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
            sizeBytes: 1024
          }
        ]
      }
    case 'document.extract_pdf':
      return { ok: true, pages: SMOKE_PAGES }
    default:
      return {
        ok: false,
        code: ERROR_CODE.PERMISSION_DENIED,
        reason: '打包冒烟不执行写操作'
      }
  }
}

function spawnPackaged(extraEnv: NodeJS.ProcessEnv = {}): PythonSupervisor {
  const sup = new PythonSupervisor({
    command: PACKAGED_EXE,
    args: [],
    cwd: dirname(PACKAGED_EXE),
    env: { ...process.env, ...extraEnv },
    capabilities: listVisibleCapabilities(),
    hostHandler
  })
  sup.on('stderr', (chunk: string) => stderrChunks.push(chunk))
  return sup
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'pa-packaged-'))
  downloadsRoot = join(tempDir, 'Downloads')
  mkdirSync(downloadsRoot, { recursive: true })

  const template = readFileSync(SCRIPT_TEMPLATE, 'utf8')
  scriptPath = join(tempDir, 'script.json')
  writeFileSync(
    scriptPath,
    template
      .replaceAll('{{DOWNLOADS_ROOT}}', downloadsRoot.replace(/\\/g, '/'))
      .replaceAll('{{REMIND_AT}}', new Date(Date.now() + 60 * 60 * 1000).toISOString()),
    'utf8'
  )

  supervisor = spawnPackaged({ [SCRIPT_ENV]: scriptPath })
  supervisor.start()
  try {
    serverInfo = (await supervisor.initialize()).server
  } catch (e) {
    throw new Error(
      `打包产物握手失败: ${e instanceof Error ? e.message : String(e)}\n${diagnostic()}`
    )
  }
}, 60_000)

afterAll(async () => {
  await supervisor?.stop().catch(() => {})
  supervisor = null
  if (tempDir !== '') rmSync(tempDir, { recursive: true, force: true })
}, 30_000)

describe.skipIf(!existsSync(PACKAGED_EXE))('打包冒烟：冻结产物作为运行时', () => {
  itPackaged('握手拿到与源码运行时一致的服务器信息', () => {
    expect(serverInfo).toEqual({ name: 'personal-agent-runtime', version: '0.1.0' })
  })

  itPackaged(
    '剧本按五步走完：每步都经反向 RPC 到达 host，摘要过校验后 completed',
    async () => {
      const result = (await supervisor!.request(
        AGENT_RUN_TASK,
        { taskId: 'packaged-smoke', goal: GOAL },
        { timeoutMs: 60_000 }
      )) as Record<string, unknown>

      expect(
        hostCalls.map((c) => c.capability),
        diagnostic()
      ).toEqual([
        'filesystem.list',
        'document.extract_pdf',
        'filesystem.create_dir',
        'filesystem.move',
        'scheduler.create'
      ])
      // WRITE 三步被 host 拒绝也不该让任务挂死：剧本走完、摘要基于真提取的页通过校验。
      expect(result['status'], diagnostic()).toBe('completed')
    },
    90_000
  )

  itPackaged(
    'stop 之后子进程真的退出：不留下孤儿（TEST-015 的退出条件）',
    async () => {
      const sup = spawnPackaged({ [SCRIPT_ENV]: scriptPath })
      sup.start()
      await sup.initialize()
      const pid = sup.pid
      expect(pid, diagnostic()).toBeTypeOf('number')

      await sup.stop()
      expect(isProcessAlive(pid!)).toBe(false)
    },
    60_000
  )

  itPackaged(
    'live 模式的 SDK 随包可用：假地址收成 MODEL_CALL_FAILED，不是进程崩溃',
    async () => {
      // 指到一个必然拒绝连接的本地端口：验的是 openai SDK 被收进包、能实例化并发起调用，
      // 而不是出网。真模型的连通性由主人的 eval:live 出手验（CON-006）。
      // NO_PROXY 走直连：不绕开本机代理的话，127.0.0.1 的请求会先被代理接管，
      // 结论一样（仍是 MODEL_CALL_FAILED），但要多等十几秒超时。
      const sup = spawnPackaged({
        OPENAI_MODEL: 'gpt-4o-mini',
        OPENAI_API_KEY: 'sk-smoke-not-real',
        OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
        NO_PROXY: '127.0.0.1',
        no_proxy: '127.0.0.1'
      })
      sup.start()
      try {
        await sup.initialize()
        const result = (await sup.request(
          AGENT_RUN_TASK,
          { taskId: 'packaged-smoke-live', goal: GOAL },
          { timeoutMs: 120_000 }
        )) as Record<string, unknown>

        expect(result['status'], diagnostic()).toBe('failed')
        expect(String(result['reason'])).toContain('MODEL_CALL_FAILED')
      } finally {
        await sup.stop().catch(() => {})
      }
    },
    150_000
  )
})
