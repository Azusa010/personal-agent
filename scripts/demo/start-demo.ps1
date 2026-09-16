<#
.SYNOPSIS
  TASK-029 的一步式演示：准备素材（PDF + 剧本）并启动 PersonalAgent。

.DESCRIPTION
  脚本做三件事，然后启动 app：
    1. 把一份 fixture PDF 放进演示 Downloads 根（每次重置成干净状态）；
    2. 从 tests/fixtures/scripts/golden-path.json 生成剧本，替换两个占位符：
       {{DOWNLOADS_ROOT}} 与 {{REMIND_AT}}（默认 ⇒ 现在 + 2 分钟，演示里能等到提醒弹出）；
    3. 设好 PERSONAL_AGENT_DOWNLOADS_DIR / PERSONAL_AGENT_SCRIPT 后启动 app。

  默认启动打包版（apps/desktop/dist/win-unpacked/PersonalAgent.exe，先跑 pnpm package:dir）；
  加 -Dev 改为启动开发版（electron-vite dev，走 venv）。

  演示步骤与观察点见 docs/DEMO.md——脚本最后会把同一份清单打在屏幕上。

.EXAMPLE
  pnpm package:dir          # 首次：构建打包版（含 Python 冻结产物）
  powershell -File scripts/demo/start-demo.ps1

.EXAMPLE
  powershell -File scripts/demo/start-demo.ps1 -Dev -RemindInMinutes 1
#>
[CmdletBinding()]
param(
  # 演示根目录：脚本只在这个目录里建 Downloads 与剧本，不碰别处。
  [string]$Root = (Join-Path $env:TEMP 'personal-agent-demo'),

  # 提醒在几分钟后触发。这个时刻在脚本运行时就算死了（剧本是静态 JSON，不支持
  # 「任务开始后 N 分钟」），所以要给审批留够时间：三个批准面板点完之前提醒就过期的话，
  # scheduler.create 会以 REMINDER_TIME_IN_PAST 失败，任务照样会被闸口判不通过。
  [int]$RemindInMinutes = 3,

  # 启动开发版（electron-vite dev，Python 走仓库 venv）而不是打包版。
  [switch]$Dev
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$downloads = Join-Path $Root 'Downloads'
$scriptPath = Join-Path $Root 'golden-path-script.json'
$pdf = Join-Path $repo 'tests\fixtures\pdfs\three-page-text.pdf'
$template = Join-Path $repo 'tests\fixtures\scripts\golden-path.json'

Write-Host '== PersonalAgent 演示准备 ==' -ForegroundColor Cyan
Write-Host "演示根：$Root"

# 1. 干净的 Downloads：每次从「一份未整理的 PDF」开始
if (Test-Path $Root) {
  Remove-Item -Recurse -Force $Root
}
New-Item -ItemType Directory -Path $downloads -Force | Out-Null

# fixture PDF 未入库（.gitignore 忽略 *.pdf），缺了就用既有生成器现造一份。
if (-not (Test-Path $pdf)) {
  Write-Host "缺 $pdf，调用生成器（WRITE_PDF_FIXTURES=1）..." -ForegroundColor Yellow
  $env:WRITE_PDF_FIXTURES = '1'
  try {
    & pnpm --dir (Join-Path $repo 'apps\desktop') exec vitest run src/main/capabilities/pdf-fixtures.test.ts
    if ($LASTEXITCODE -ne 0) { throw '生成 fixture PDF 失败' }
  }
  finally {
    Remove-Item Env:\WRITE_PDF_FIXTURES -ErrorAction SilentlyContinue
  }
}
Copy-Item $pdf (Join-Path $downloads 'three-page-text.pdf')

# 2. 剧本：替换两个占位符。路径用正斜杠（与 TS 侧 toPosix 的写法一致）。
$remindAt = (Get-Date).ToUniversalTime().AddMinutes($RemindInMinutes).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$downloadsPosix = $downloads.Replace('\', '/')
$text = (Get-Content -Raw $template).
  Replace('{{DOWNLOADS_ROOT}}', $downloadsPosix).
  Replace('{{REMIND_AT}}', $remindAt)
# 必须无 BOM 写盘：PowerShell 5.1 的 -Encoding UTF8 会带 BOM，
# Python 的 json.loads 读到 BOM 直接报 "Expecting value"。
[System.IO.File]::WriteAllText($scriptPath, $text, (New-Object System.Text.UTF8Encoding($false)))

# 3. 环境变量：app（以及它 spawn 的 Python）从这里读授权根与剧本。
$env:PERSONAL_AGENT_DOWNLOADS_DIR = $downloads
$env:PERSONAL_AGENT_SCRIPT = $scriptPath

Write-Host ''
Write-Host '演示清单（详细版见 docs/DEMO.md）：' -ForegroundColor Cyan
Write-Host "  Downloads 根：$downloads"
Write-Host "  提醒时间：    $remindAt（$RemindInMinutes 分钟后）"
if ($Dev) {
  Write-Host '  运行时：      开发布局（仓库 venv）'
} else {
  Write-Host '  运行时：      打包布局（随包冻结产物）'
}
Write-Host ''
Write-Host '  1) 在输入框发送：整理 Downloads 里的 PDF，给出带页码引用的摘要'
Write-Host '  2) 计划出现五步：list → extract → create_dir → move → scheduler.create'
Write-Host '  3) 依次批准三次写操作（建 Reading、移动文件、建提醒），每次都能看到完整路径'
Write-Host '  4) 任务 completed 后核对：摘要带页码引用（1/2/3 页）、时间线事件完整'
Write-Host "  5) 等到 $RemindInMinutes 分钟后应弹一次 Windows 通知；诊断面板能看到 Reminder 记录"
Write-Host '  6) 在资源管理器里确认文件已移动到 Downloads\Reading\three-page-text.pdf'
Write-Host ''

if ($Dev) {
  Write-Host '启动开发版（Ctrl+C 结束）...' -ForegroundColor Green
  & pnpm --dir (Join-Path $repo 'apps\desktop') dev
}
else {
  $exe = Join-Path $repo 'apps\desktop\dist\win-unpacked\PersonalAgent.exe'
  if (-not (Test-Path $exe)) {
    throw "找不到打包版：$exe`n先跑：pnpm package:dir（免安装目录）或 pnpm package:win（NSIS 安装包）"
  }
  Write-Host '启动打包版（关掉窗口即结束）...' -ForegroundColor Green
  & $exe
}