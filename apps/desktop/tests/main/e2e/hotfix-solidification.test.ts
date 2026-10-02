import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CapabilityDescriptor,
  SkillMetadata,
  SkillReadResult,
  SkillSearchResult,
  TerminalExecuteResult
} from '@personal-agent/protocol'

import type { AuthorizedCall } from '../../../src/main/capabilities/plugin'
import { codeInterpreterPlugin } from '../../../src/main/capabilities/plugins/code-interpreter'
import { fileWritePlugin } from '../../../src/main/capabilities/plugins/file-write'
import {
  clearSkillsCache,
  loadAllSkills,
  skillReadPlugin,
  skillSearchPlugin
} from '../../../src/main/capabilities/plugins/skills'
import {
  resetTerminalCwd,
  terminalExecutePlugin
} from '../../../src/main/capabilities/plugins/terminal'

/**
 * TASK-E2: 自适应热修反馈环与能力固化 E2E 闭环测试
 *
 * 验证理论规范 (§6) 中的「遇错 → 修复 → 沉淀 → 免疫」完整生命周期：
 * 1. 错误/未知格式感知：捕获非标准自定义日志或无现成 SDK 的第三方接口数据；
 * 2. 沙箱即兴热修：使用 code_interpreter 在隔离沙盒内编写并执行 Python 适配代码；
 * 3. 沙箱容错安全：语法/运行时异常被隔离拦截，不通过验证绝不提前固化；
 * 4. 固化沉淀到工作区：通过 file_write 将验证通过的工具脚本写入 .agent/tools/，
 *    并将符合 Agent Skills Specification 规范的指导书写入 .agent/skills/；
 * 5. 渐进式技能披露：通过 skill_search / skill_read 动态检索并读取固化的新能力，
 *    轻量元数据保护 KV Cache，按需加载完整正文；
 * 6. 免疫与无缝复用：后续任务可直接通过终端或解释器复用已固化的工具，无需再次推理合成；
 * 7. 技能优先级覆盖：工作区项目级自举技能覆盖全局/内置同名技能 (§2.4)。
 */

describe('自适应热修反馈环与能力固化 E2E 测试 (TASK-E2)', () => {
  let wsDir: string
  let dlDir: string

  beforeEach(async () => {
    resetTerminalCwd()
    clearSkillsCache()

    wsDir = await mkdtemp(join(tmpdir(), 'pa-ws-hotfix-'))
    dlDir = await mkdtemp(join(tmpdir(), 'pa-dl-hotfix-'))

    vi.stubEnv('PERSONAL_AGENT_WORKSPACE_DIR', wsDir)
    vi.stubEnv('PERSONAL_AGENT_DOWNLOADS_DIR', dlDir)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    clearSkillsCache()
    resetTerminalCwd()

    try {
      await rm(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      await rm(dlDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // 忽略 Windows 偶发文件句柄释放延迟
    }
  })

  it('完整闭环：非标数据遇错 → 沙箱编写适配脚本 → 沙箱验证 → 固化工具与技能卡 → 发现并免疫复用', async () => {
    // -------------------------------------------------------------------------
    // 阶段 1：遇错与样本准备 (Encounter Error / Unknown Format)
    // -------------------------------------------------------------------------
    const rawLogSample = [
      '[2026-10-02 12:00:01] IP=192.168.1.100 METHOD=POST URI=/api/v1/checkout STATUS=500 DURATION=142ms ERR="Payment gateway timeout"',
      '[2026-10-02 12:00:03] IP=10.0.0.15 METHOD=GET URI=/api/v1/health STATUS=200 DURATION=3ms ERR="-"',
      '[2026-10-02 12:00:08] IP=172.16.0.42 METHOD=POST URI=/api/v1/order STATUS=201 DURATION=88ms ERR="-"'
    ].join('\n')

    const rawLogFile = join(wsDir, 'access.log')
    await writeFile(rawLogFile, rawLogSample, 'utf-8')

    // 验证原生标准 JSON 解析在此非标日志上必然报错，证明必须现场生成适配层
    expect(() => JSON.parse(rawLogSample)).toThrow()

    // -------------------------------------------------------------------------
    // 阶段 2 & 3：即兴写适配代码并在沙箱验证 (Ad-hoc Hotfix in Sandbox)
    // -------------------------------------------------------------------------
    const adhocPythonAdapterCode = `
import json
import re

raw_log = '''
[2026-10-02 12:00:01] IP=192.168.1.100 METHOD=POST URI=/api/v1/checkout STATUS=500 DURATION=142ms ERR="Payment gateway timeout"
[2026-10-02 12:00:03] IP=10.0.0.15 METHOD=GET URI=/api/v1/health STATUS=200 DURATION=3ms ERR="-"
[2026-10-02 12:00:08] IP=172.16.0.42 METHOD=POST URI=/api/v1/order STATUS=201 DURATION=88ms ERR="-"
'''.strip()

pattern = re.compile(
    r'\\[(?P<timestamp>[^\\]]+)\\]\\s+IP=(?P<ip>[\\d.]+)\\s+METHOD=(?P<method>\\w+)\\s+URI=(?P<uri>\\S+)\\s+STATUS=(?P<status>\\d+)\\s+DURATION=(?P<duration>\\d+)ms\\s+ERR="(?P<error>[^"]*)"'
)

records = []
for line in raw_log.splitlines():
    match = pattern.match(line.strip())
    if match:
        item = match.groupdict()
        item["status"] = int(item["status"])
        item["duration_ms"] = int(item["duration"])
        del item["duration"]
        records.append(item)

print(json.dumps(records, ensure_ascii=False))
`

    const bindInterpreter = await codeInterpreterPlugin.bindArguments({
      code: adhocPythonAdapterCode,
      timeoutMs: 15_000
    })
    expect(bindInterpreter.ok).toBe(true)
    if (!bindInterpreter.ok) return

    const interpreterCall: AuthorizedCall = {
      callId: 'call-hotfix-1',
      taskId: 'task-hotfix',
      capability: codeInterpreterPlugin.descriptor as CapabilityDescriptor,
      bound: bindInterpreter.bound
    }

    const sandboxResult = (await codeInterpreterPlugin.execute(interpreterCall, {})) as Record<
      string,
      unknown
    >

    expect(sandboxResult.ok).toBe(true)
    expect(sandboxResult.exitCode).toBe(0)
    expect(typeof sandboxResult.stdout).toBe('string')

    const parsedOutput = JSON.parse(String(sandboxResult.stdout)) as Array<Record<string, unknown>>
    expect(parsedOutput).toHaveLength(3)
    expect(parsedOutput[0].ip).toBe('192.168.1.100')
    expect(parsedOutput[0].method).toBe('POST')
    expect(parsedOutput[0].uri).toBe('/api/v1/checkout')
    expect(parsedOutput[0].status).toBe(500)
    expect(parsedOutput[0].duration_ms).toBe(142)
    expect(parsedOutput[0].error).toBe('Payment gateway timeout')

    // -------------------------------------------------------------------------
    // 阶段 4：沉淀固化到工作区 (.agent/tools/ 与 .agent/skills/)
    // -------------------------------------------------------------------------
    // 4.1 固化工具可执行脚本 (遵从 §2.2 工具脚本头部与调用约定)
    const solidifiedToolScript = `#!/usr/bin/env python3
"""
Tool: access_log_parser
Description: 解析非标准 Web 访问日志并提取结构化事件记录
Version: 1.0.0
Created: 2026-10-02
Tags: log, parser, adapter, access

Usage:
    python .agent/tools/access_log_parser.py <input_file>

Input:  日志文件路径
Output: 结构化事件记录 (stdout JSON)
Exit:   0=成功, 1=参数错误, 2=解析失败
"""
import sys
import json
import re

def parse_log_file(file_path):
    pattern = re.compile(
        r'\\[(?P<timestamp>[^\\]]+)\\]\\s+IP=(?P<ip>[\\d.]+)\\s+METHOD=(?P<method>\\w+)\\s+URI=(?P<uri>\\S+)\\s+STATUS=(?P<status>\\d+)\\s+DURATION=(?P<duration>\\d+)ms\\s+ERR="(?P<error>[^"]*)"'
    )
    records = []
    with open(file_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            match = pattern.match(line)
            if match:
                item = match.groupdict()
                item["status"] = int(item["status"])
                item["duration_ms"] = int(item["duration"])
                del item["duration"]
                records.append(item)
    return records

if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(1)
    try:
        data = parse_log_file(sys.argv[1])
        print(json.dumps(data, ensure_ascii=False))
        sys.exit(0)
    except Exception as e:
        sys.stderr.write(str(e))
        sys.exit(2)
`

    const toolWriteBind = await fileWritePlugin.bindArguments({
      path: join(wsDir, '.agent', 'tools', 'access_log_parser.py'),
      content: solidifiedToolScript
    })
    expect(toolWriteBind.ok).toBe(true)
    if (!toolWriteBind.ok) return

    const toolWriteCall: AuthorizedCall = {
      callId: 'call-write-tool',
      taskId: 'task-hotfix',
      capability: fileWritePlugin.descriptor as CapabilityDescriptor,
      bound: toolWriteBind.bound
    }
    const toolWriteRes = (await fileWritePlugin.execute(toolWriteCall, {})) as Record<
      string,
      unknown
    >
    expect(toolWriteRes.ok).toBe(true)

    // 4.2 固化技能说明文档 SKILL.md (遵从 §2.3 Agent Skills Specification)
    const solidifiedSkillDoc = `---
name: access-log-parser
description: 解析非标准 Web 访问日志并提取结构化事件记录
tags: [log, parser, adapter, access]
---

# Access Log Parser

## 何时使用
当系统接收到由网关或反向代理生成的非标准格式 access.log 时使用此技能提取结构化 JSON。

## 使用方法
通过 \`terminal_execute\` 运行：
\`\`\`bash
python .agent/tools/access_log_parser.py <log_file_path>
\`\`\`

## 输入输出
- **输入**：access 日志文件路径
- **输出**：JSON 格式的访问记录数组 (stdout)
- **退出码**：0=成功, 1=参数错误, 2=解析失败
`

    const skillWriteBind = await fileWritePlugin.bindArguments({
      path: join(wsDir, '.agent', 'skills', 'access-log-parser', 'SKILL.md'),
      content: solidifiedSkillDoc
    })
    expect(skillWriteBind.ok).toBe(true)
    if (!skillWriteBind.ok) return

    const skillWriteCall: AuthorizedCall = {
      callId: 'call-write-skill',
      taskId: 'task-hotfix',
      capability: fileWritePlugin.descriptor as CapabilityDescriptor,
      bound: skillWriteBind.bound
    }
    const skillWriteRes = (await fileWritePlugin.execute(skillWriteCall, {})) as Record<
      string,
      unknown
    >
    expect(skillWriteRes.ok).toBe(true)

    // 校验工作区物理落盘
    const savedTool = await readFile(
      join(wsDir, '.agent', 'tools', 'access_log_parser.py'),
      'utf-8'
    )
    expect(savedTool).toContain('Tool: access_log_parser')
    const savedSkill = await readFile(
      join(wsDir, '.agent', 'skills', 'access-log-parser', 'SKILL.md'),
      'utf-8'
    )
    expect(savedSkill).toContain('name: access-log-parser')

    // -------------------------------------------------------------------------
    // 阶段 5：技能发现与渐进式披露 (Progressive Disclosure & Skill Search)
    // -------------------------------------------------------------------------
    clearSkillsCache()

    // 5.1 关键词检索：轻量元数据发现新技能（不含大型正文）
    const searchBind = await skillSearchPlugin.bindArguments({ query: 'access' })
    expect(searchBind.ok).toBe(true)
    if (!searchBind.ok) return

    const searchCall: AuthorizedCall = {
      callId: 'call-search-1',
      taskId: 'task-hotfix',
      capability: skillSearchPlugin.descriptor as CapabilityDescriptor,
      bound: searchBind.bound
    }
    const searchRes = (await skillSearchPlugin.execute(
      searchCall,
      {}
    )) as unknown as SkillSearchResult
    expect(searchRes.ok).toBe(true)
    expect(searchRes.total).toBeGreaterThanOrEqual(1)

    const foundSkill = searchRes.skills.find((s: SkillMetadata) => s.name === 'access-log-parser')
    expect(foundSkill).toBeDefined()
    expect(foundSkill?.description).toBe('解析非标准 Web 访问日志并提取结构化事件记录')
    expect(foundSkill?.tags).toEqual(['log', 'parser', 'adapter', 'access'])
    expect(foundSkill?.path).toContain('.agent/skills/access-log-parser/SKILL.md')
    // 必须无 content 正文，保护 KV Cache
    expect('content' in (foundSkill ?? {})).toBe(false)

    // 5.2 标签过滤检索
    const tagSearchBind = await skillSearchPlugin.bindArguments({ query: '*', tag: 'adapter' })
    expect(tagSearchBind.ok).toBe(true)
    if (!tagSearchBind.ok) return
    const tagSearchRes = (await skillSearchPlugin.execute(
      {
        callId: 'call-search-2',
        taskId: 'task-hotfix',
        capability: skillSearchPlugin.descriptor as CapabilityDescriptor,
        bound: tagSearchBind.bound
      },
      {}
    )) as unknown as SkillSearchResult
    expect(tagSearchRes.skills.some((s) => s.name === 'access-log-parser')).toBe(true)

    // 5.3 按需加载正文：skill_read 渐进披露
    const readBind = await skillReadPlugin.bindArguments({ name: 'access-log-parser' })
    expect(readBind.ok).toBe(true)
    if (!readBind.ok) return

    const readCall: AuthorizedCall = {
      callId: 'call-read-1',
      taskId: 'task-hotfix',
      capability: skillReadPlugin.descriptor as CapabilityDescriptor,
      bound: readBind.bound
    }
    const readRes = (await skillReadPlugin.execute(readCall, {})) as unknown as SkillReadResult
    expect(readRes.ok).toBe(true)
    expect(readRes.name).toBe('access-log-parser')
    expect(readRes.content).toContain('# Access Log Parser')
    expect(readRes.content).toContain('python .agent/tools/access_log_parser.py <log_file_path>')

    // -------------------------------------------------------------------------
    // 阶段 6：免疫与无缝复用 (Immunity & Reuse)
    // -------------------------------------------------------------------------
    // 准备全新的第二份日志数据
    const incomingLogData = [
      '[2026-10-02 12:30:10] IP=10.10.10.10 METHOD=GET URI=/api/v2/items STATUS=200 DURATION=12ms ERR="-"',
      '[2026-10-02 12:30:15] IP=10.10.10.11 METHOD=DELETE URI=/api/v2/items/99 STATUS=404 DURATION=8ms ERR="Item not found"'
    ].join('\n')
    const incomingLogFile = join(wsDir, 'incoming_batch.log')
    await writeFile(incomingLogFile, incomingLogData, 'utf-8')

    // 后续任务直接根据 SKILL.md 指引，通过 terminal_execute 调用固化的工具脚本，实现免疫！
    const termBind = await terminalExecutePlugin.bindArguments({
      command: `python .agent/tools/access_log_parser.py incoming_batch.log`
    })
    expect(termBind.ok).toBe(true)
    if (!termBind.ok) return

    const termCall: AuthorizedCall = {
      callId: 'call-term-reuse',
      taskId: 'task-hotfix',
      capability: terminalExecutePlugin.descriptor as CapabilityDescriptor,
      bound: termBind.bound
    }
    const termRes = (await terminalExecutePlugin.execute(
      termCall,
      {}
    )) as unknown as TerminalExecuteResult
    expect(termRes.ok).toBe(true)
    expect(termRes.exitCode).toBe(0)

    const finalRecords = JSON.parse(termRes.stdout.trim()) as Array<Record<string, unknown>>
    expect(finalRecords).toHaveLength(2)
    expect(finalRecords[0].ip).toBe('10.10.10.10')
    expect(finalRecords[0].status).toBe(200)
    expect(finalRecords[1].ip).toBe('10.10.10.11')
    expect(finalRecords[1].method).toBe('DELETE')
    expect(finalRecords[1].status).toBe(404)
    expect(finalRecords[1].error).toBe('Item not found')
  })

  it('沙箱验证失败防御：有缺陷的代码在沙箱中被拦截，绝不提前固化', async () => {
    // 模拟编写了一段存在语法与逻辑缺陷的 Python 代码
    const buggyPythonCode = `
import json
def broken_syntax( # 缺失右括号与实现
`
    const bindInterpreter = await codeInterpreterPlugin.bindArguments({
      code: buggyPythonCode
    })
    expect(bindInterpreter.ok).toBe(true)
    if (!bindInterpreter.ok) return

    const interpreterCall: AuthorizedCall = {
      callId: 'call-buggy-1',
      taskId: 'task-hotfix-defense',
      capability: codeInterpreterPlugin.descriptor as CapabilityDescriptor,
      bound: bindInterpreter.bound
    }

    const sandboxResult = (await codeInterpreterPlugin.execute(interpreterCall, {})) as Record<
      string,
      unknown
    >

    expect(sandboxResult.ok).toBe(true)
    // 进程应当以非 0 状态码失败
    expect(sandboxResult.exitCode).not.toBe(0)
    expect(String(sandboxResult.stderr)).toContain('SyntaxError')

    // 确认此时并没有在工作区留下未验证的半成品工具
    const allSkills = await loadAllSkills()
    expect(allSkills.some((s) => s.name === 'broken-tool')).toBe(false)
  })

  it('技能优先级覆盖：工作区 .agent/skills/ 优先覆盖全局内置同名技能 (§2.4)', async () => {
    // 内置列表中存在 data-cleaner
    const initialSkills = await loadAllSkills()
    const builtinDataCleaner = initialSkills.find((s) => s.name === 'data-cleaner')
    expect(builtinDataCleaner).toBeDefined()
    expect(builtinDataCleaner?.path).toBe('builtin://data-cleaner')

    // 在工作区 .agent/skills/data-cleaner/SKILL.md 中写入定制覆盖版本
    const customWorkspaceSkill = `---
name: data-cleaner
description: 工作区定制版高级数据清洗器（覆盖内置版）
tags: [data, custom, workspace, advanced]
---

# Workspace Custom Data Cleaner
使用本工作区专属的增强型数据清洗规则。
`
    const writeBind = await fileWritePlugin.bindArguments({
      path: join(wsDir, '.agent', 'skills', 'data-cleaner', 'SKILL.md'),
      content: customWorkspaceSkill
    })
    expect(writeBind.ok).toBe(true)
    if (!writeBind.ok) return

    await fileWritePlugin.execute(
      {
        callId: 'call-override-skill',
        taskId: 'task-override',
        capability: fileWritePlugin.descriptor as CapabilityDescriptor,
        bound: writeBind.bound
      },
      {}
    )

    clearSkillsCache()

    // 重新加载所有技能
    const updatedSkills = await loadAllSkills()
    const activeDataCleaner = updatedSkills.find((s) => s.name === 'data-cleaner')

    expect(activeDataCleaner).toBeDefined()
    // 覆盖断言：描述被更新为工作区定制版
    expect(activeDataCleaner?.description).toBe('工作区定制版高级数据清洗器（覆盖内置版）')
    expect(activeDataCleaner?.tags).toEqual(['data', 'custom', 'workspace', 'advanced'])
    // 路径指向 workspace 下的 .agent/skills，而不是 builtin
    expect(activeDataCleaner?.path).toContain('.agent/skills/data-cleaner/SKILL.md')

    // skill_read 同样返回工作区版本
    const readBind = await skillReadPlugin.bindArguments({ name: 'data-cleaner' })
    expect(readBind.ok).toBe(true)
    if (!readBind.ok) return
    const readRes = (await skillReadPlugin.execute(
      {
        callId: 'call-read-override',
        taskId: 'task-override',
        capability: skillReadPlugin.descriptor as CapabilityDescriptor,
        bound: readBind.bound
      },
      {}
    )) as unknown as SkillReadResult
    expect(readRes.content).toContain('# Workspace Custom Data Cleaner')
  })
})
