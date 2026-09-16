# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包规格：把 Agent Runtime 冻结成 onedir 产物，随 Electron 分发。

为什么是 onedir 而不是 onefile：
- onefile 的 bootloader 每次启动都要把整个包解压到临时目录，握手慢一截；
- onefile 会多一层父进程（bootloader），Main 侧 kill 的是父进程，子进程可能残留——
  而 TEST-015 明确要盯「退出无孤儿进程」。onedir 的 exe 就是进程本身，kill 得干净。

产物落在 services/agent-runtime/dist/personal_agent/（dist/ 已在 .gitignore 里），
electron-builder 经 extraResources 把它放到安装包的 resources/agent-runtime/。

运行方式（仓库根）：
    pnpm package:py
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

# SPECPATH 由 PyInstaller 在执行 spec 时注入，指向本文件所在目录。
PACKAGING_DIR = Path(SPECPATH)
SERVICE_ROOT = PACKAGING_DIR.parent
REPO_ROOT = SERVICE_ROOT.parent.parent

# personal_agent 的整棵子模块树都收进来：入口脚本只静态 import 到包的 __init__，
# 靠分析器跟进链条也能走到，但能力清单、协议模型这些模块是按字符串/延迟路径
# 被引用的（例如 live_model 在构造时才 import openai），显式收集不吃亏。
hiddenimports = collect_submodules("personal_agent")

# live 模式的 SDK 是延迟 import（只有配了 OPENAI_MODEL 才走到），
# 静态分析不一定跟进；漏收的后果是「scripted 模式一切正常、一配真模型就崩」，很难查。
hiddenimports += ["openai"]

a = Analysis(  # noqa: F821 - PyInstaller 注入的 Analysis
    [str(PACKAGING_DIR / "entrypoint.py")],
    pathex=[str(SERVICE_ROOT / "src")],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "pytest_asyncio", "ruff"],
    noarchive=False,
)

pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="personal_agent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX 压出来的 exe 更容易被杀软误报，首次启动也更慢；省下的体积对 demo 不值。
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="personal_agent",
)