"""conftest.py —— agent-runtime 测试套件全局环境与夹具配置。"""

import os

# 单元测试与本地验证默认开启 Mock 向量模式（零 CPU 与内存开销、无需加载深度学习模型）。
# 避免本地开启了 PostgreSQL 且存在模型目录时，跑测试触发真实神经网络加载而导致 CPU 100% 锁死。
os.environ.setdefault("KNOWLEDGE_EMBEDDER_MODE", "mock")
