---
name: template-skill
description: 示例技能卡模板，用于指导 Agent 如何调用固化工具并遵循 Agent Skills Specification 规范
tags: [template, example, guide]
exposure: direct
---

# Template Skill 指南

## 何时使用
当用户需要运行标准化文件分析与元数据提取，或 Agent 需要参考如何编写标准技能卡时使用此技能。

典型触发场景：
- 需要对工作区内的特定文件进行结构化元数据提取与健康度扫描。
- Agent 自举固化新能力后，需要为其配套生成标准技能说明文档。

## 使用方法
通过 `code_interpreter` 执行沙箱验证，或通过 `terminal_execute` 调用固化脚本：

```bash
python .agent/tools/template_tool.py --input-file <target_file_path> [--mode fast|thorough]
```

示例调用：
```bash
python .agent/tools/template_tool.py --input-file README.md --mode fast
```

## 输入输出契约
- **输入参数**：
  - `--input-file` (必需)：目标文件路径，必须位于工作区根目录下。
  - `--mode` (可选)：处理模式，可选 `fast` (快速) 或 `thorough` (深度)。
- **输出格式**：
  - stdout 返回规范 JSON 对象：
    ```json
    {
      "ok": true,
      "data": {
        "filePath": "/workspace/README.md",
        "fileSizeBytes": 1024,
        "modeApplied": "fast",
        "status": "processed"
      }
    }
    ```
- **退出码**：
  - `0`: 成功处理。
  - `1`: 命令行参数非法（缺少必需参数或模式不支持）。
  - `2`: 业务错误（文件不存在或不可读）。
  - `3`: 运行时未捕获异常。

## 注意事项与安全约束
1. **路径限制**：输入路径必须严格遵守 `resolveWithinRootReal` 安全边界，不得指向工作区根目录之外。
2. **IO 纯净性**：工具的标准输出 stdout 只能承载 JSON 格式结果，所有调试与追踪日志均走 stderr。
3. **不可变原则**：只读分析类工具不得修改原文件内容；写操作工具必须显式在头部声明并记录变更事件。
