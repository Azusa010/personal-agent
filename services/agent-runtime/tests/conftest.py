import os
import tempfile
from pathlib import Path

# 单元测试与本地验证默认开启 Mock 向量模式（零 CPU 与内存开销、无需加载深度学习模型）。
# 避免本地开启了 PostgreSQL 且存在模型目录时，跑测试触发真实神经网络加载而导致 CPU 100% 锁死。
os.environ.setdefault("KNOWLEDGE_EMBEDDER_MODE", "mock")

# 隔离 pytest 临时根目录，防止 Windows 下 AppData/Local/Temp/pytest-of-Azusama 历史遗留 symlink 导致权限访问拒绝，
# 且放置在 repo 外部避免影响 git status 检测测试。
runtime_tmp = Path(tempfile.gettempdir()) / f"pytest_agent_runtime_{os.getpid()}"
runtime_tmp.mkdir(exist_ok=True)
os.environ["PYTEST_DEBUG_TEMPROOT"] = str(runtime_tmp)
