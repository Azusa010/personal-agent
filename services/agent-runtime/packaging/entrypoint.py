"""PyInstaller 的入口脚本：冻结产物跑起来等价于 `python -m personal_agent`。

单独一层而不是直接拿 `__main__.py` 当入口：把包内文件当脚本喂给 PyInstaller 时，
Analysis 会以脚本所在目录（`src/personal_agent/`）为基准解析 import，能不能找到包
取决于构建机的 sys.path 运气。这里明确 `from personal_agent import main`，
与 `python -m personal_agent` 是同一条路径。
"""

from personal_agent import main

if __name__ == "__main__":
    main()