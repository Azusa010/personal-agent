"""动态 Agent 状态栏环境感知测试套件 (Phase 2 Task 2.2)

本测试套件依据《AGENTS.md》约定 100% 由 AI 写全写透全部断言：
1. 契约模型增强验证：SystemEnvironment 支持 workspace, git_branch, git_status
2. Git 状态轻量探测与边界韧性：正常 Git 仓库、非 Git 目录、命令超时与异常兜底
3. 状态栏区块渲染：SystemInfoProvider 完整包含 Coding Agent 关键环境字段
4. KV Cache 保护判定：状态栏严格置于 Prompt 上下文末尾，不破坏前缀稳定性
"""

import subprocess
from pathlib import Path
from unittest.mock import patch

from personal_agent.conversation.model.gateway import ModelContext
from personal_agent.conversation.model.live_model import render_messages
from personal_agent.conversation.status.models import (
    StatusBarState,
    SystemEnvironment,
)
from personal_agent.conversation.status.providers import (
    SystemInfoProvider,
    detect_git_status,
    detect_system_environment,
)
from personal_agent.conversation.status.renderer import (
    STATUS_BAR_CLOSE_TAG,
    STATUS_BAR_OPEN_TAG,
)


def test_system_environment_model_fields():
    """验证 SystemEnvironment 模型扩展了 workspace、git_branch 与 git_status 字段。"""
    env = SystemEnvironment(
        current_time="2026-09-29 12:00:00",
        cwd="D:/my-project/src",
        os_type="Windows 11",
        shell="PowerShell",
        python_version="3.13.3",
        workspace="D:/my-project",
        git_branch="feature/coding-agent",
        git_status="2 files modified (src/api.ts, tests/api.test.ts)",
    )

    dumped = env.model_dump()
    assert dumped["workspace"] == "D:/my-project"
    assert dumped["git_branch"] == "feature/coding-agent"
    assert dumped["git_status"] == "2 files modified (src/api.ts, tests/api.test.ts)"


def test_detect_git_status_in_actual_repo():
    """验证在真实 Git 项目根目录下可探测出分支与状态。"""
    repo_root = Path(__file__).resolve().parents[3]
    branch, status = detect_git_status(str(repo_root))

    # 本代码库必然处于 Git 托管下
    assert branch is not None
    assert len(branch) > 0
    assert status is not None
    assert isinstance(status, str)


def test_detect_git_status_in_non_git_directory(tmp_path: Path):
    """验证在非 Git 目录（临时目录）下轻量退化返回 (None, None)，不抛出任何异常。"""
    branch, status = detect_git_status(str(tmp_path))
    assert branch is None
    assert status is None


def test_detect_git_status_timeout_and_error_resilience():
    """验证当 git 子进程超时或环境缺失 git 命令时，安全捕获并降级返回 (None, None)。"""
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="git", timeout=1)):
        branch, status = detect_git_status(".")
        assert branch is None
        assert status is None

    with patch("subprocess.run", side_effect=FileNotFoundError("git not found")):
        branch, status = detect_git_status(".")
        assert branch is None
        assert status is None


def test_detect_system_environment_includes_git_and_workspace():
    """验证 detect_system_environment 聚合探测出 workspace 与 git 信息。"""
    repo_root = Path(__file__).resolve().parents[3]
    env = detect_system_environment(cwd=str(repo_root))

    assert env.cwd == str(repo_root)
    assert env.workspace is not None
    assert env.git_branch is not None


def test_system_info_provider_renders_coding_environment():
    """验证 SystemInfoProvider 格式化输出 Coding Agent 规范中的各项环境状态。"""
    env = SystemEnvironment(
        current_time="2026-09-29 12:00:00",
        cwd="D:/my-project/src",
        os_type="Windows 11",
        shell="PowerShell",
        python_version="3.13.3",
        workspace="D:/my-project",
        git_branch="feature/auth",
        git_status="2 files modified (src/api.ts, tests/api.test.ts)",
    )
    state = StatusBarState(system_env=env)
    provider = SystemInfoProvider()

    output = provider.render(state)
    assert output is not None

    # 断言包含各项关键信息
    assert "## 🖥️ 系统环境" in output
    assert "- 工作区根: D:/my-project" in output
    assert "- 工作目录: D:/my-project/src" in output
    assert "- Git 分支: feature/auth" in output
    assert "- Git 状态: 2 files modified (src/api.ts, tests/api.test.ts)" in output


def test_status_bar_injected_at_tail_for_kv_cache_preservation():
    """验证在组装模型消息时，状态栏严格追加在上下文末尾，不破坏前置 system/user 消息前缀。"""
    status_bar_content = f"{STATUS_BAR_OPEN_TAG}\n[Environment Status]\n- Workspace: D:/test\n{STATUS_BAR_CLOSE_TAG}"
    context = ModelContext(
        taskGoal="编写快速排序算法",
        visibleCapabilities=["file_write"],
        statusBar=status_bar_content,
    )

    messages = render_messages(context)

    # 1. 结构断言：必须有 system 消息和 user 消息
    assert len(messages) >= 2
    assert messages[0]["role"] == "system"

    # 2. KV Cache 保护断言：最后一条消息必须是 status_bar 内容，确保前缀缓存完全命中
    last_msg = messages[-1]
    assert last_msg["role"] == "user"
    assert STATUS_BAR_OPEN_TAG in str(last_msg["content"])
    assert "Workspace: D:/test" in str(last_msg["content"])
