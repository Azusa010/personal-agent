import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../../../src/main/eval/paths'

const exec = promisify(execFile)
const root = repoRoot()
const electron = join(root, 'node_modules/electron/dist/electron.exe')
const checker = join(root, 'tests/evals/html-page-check.cjs')

interface PageResult {
  data: { missing: string[]; filtered?: string; hasChart?: boolean }
  submissions: unknown[]
}

async function runPage(html: string, scenario: string): Promise<PageResult> {
  const dir = mkdtempSync(join(tmpdir(), 'pa-html-check-'))
  try {
    const input = join(dir, 'page.html'),
      output = join(dir, 'result.json')
    writeFileSync(input, html)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    await exec(electron, [checker, input, scenario, join(dir, 'capture.png'), output], {
      env,
      timeout: 20000
    })
    return JSON.parse(readFileSync(output, 'utf8')) as PageResult
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('HTML evaluation page host', () => {
  it('fills the missing reminder time and captures the submitted values', async () => {
    const result = await runPage(
      `<input id="title" value="提交周报"><input id="date" value="2026-12-18"><input id="time"><button id="submit" onclick="evalHost.submit({title:document.getElementById('title').value,date:document.getElementById('date').value,time:document.getElementById('time').value})">提交</button>`,
      'reminder-form'
    )
    expect(result.data.missing).toEqual([])
    expect(result.submissions).toEqual([{ title: '提交周报', date: '2026-12-18', time: '09:30' }])
  })
  it('reports missing controls rather than passing an empty page', async () => {
    const result = await runPage('<p>empty</p>', 'reminder-form')
    expect(result.data.missing).toEqual(['title', 'date', 'time', 'submit'])
    expect(result.submissions).toEqual([])
  })
  it('changes the filter and captures the rendered result', async () => {
    const result = await runPage(
      `<p>sales.csv</p><svg></svg><select id="region" onchange="document.getElementById('results').textContent=this.value==='North'?'120 95 215':'75 130'"><option>All</option><option>North</option></select><div id="results"></div>`,
      'csv-chart'
    )
    expect(result.data.hasChart).toBe(true)
    expect(result.data.filtered).toBe('120 95 215')
  })
  it('captures the selected card', async () => {
    const result = await runPage(
      `<button id="choice-A">A</button><button id="choice-B" onclick="evalHost.submit({choice:'B'})">B</button><button id="choice-C">C</button>`,
      'choice-cards'
    )
    expect(result.submissions).toEqual([{ choice: 'B' }])
  })
  it('recognizes a visible CSS bar chart', async () => {
    const result = await runPage(
      `<select id="region"><option>North</option></select><div id="results"><div class="bar-fill" style="width:100px;height:10px;background:blue"></div><div class="bar-fill" style="width:60px;height:10px;background:blue"></div></div>`,
      'csv-chart'
    )
    expect(result.data.hasChart).toBe(true)
  })
})
