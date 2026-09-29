#!/usr/bin/env python3
"""
Tool: template_tool
Description: 示例标准工具脚本模板，用于演示工具元数据头部约定、参数解析、IO隔离与退出码规范。
Version: 1.0.0
Created: 2026-09-29
Tags: template, example, utility

Usage:
    python template_tool.py --input-file <path> [--mode <fast|thorough>] [--json]

Input:
    --input-file (str): 待处理文件的相对或绝对路径（必须位于工作区授权根内）
    --mode (str, optional): 运行模式，可选 fast 或 thorough，默认 fast
    --json (flag, optional): 显式指定输出格式为 JSON

Output:
    stdout: 结构化 JSON 结果 (如 {"ok": true, "result": {...}})
    stderr: 诊断日志、调试追踪信息与警告，绝不输出业务数据

Exit Codes:
    0: 执行成功 (Success)
    1: 命令行参数非法或缺失 (Invalid Argument)
    2: 业务逻辑校验失败或资源不可达 (Operational Failure)
    3: 运行时未捕获异常或环境崩溃 (Runtime Crash)
"""

import argparse
import json
import os
import sys
from typing import Any


def log_diag(msg: str) -> None:
    """输出诊断日志到 stderr，绝不污染 stdout 的结构化返回流。"""
    sys.stderr.write(f"[template_tool] {msg}\n")
    sys.stderr.flush()


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="PersonalAgent 规范化工具脚本模板",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--input-file",
        required=True,
        help="待处理的文件路径",
    )
    parser.add_argument(
        "--mode",
        choices=["fast", "thorough"],
        default="fast",
        help="处理模式：fast (默认) 或 thorough",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        default=True,
        help="输出 JSON 结果 (默认启用)",
    )
    return parser.parse_args()


def execute_tool(input_file: str, mode: str) -> dict[str, Any]:
    """核心业务处理逻辑。"""
    log_diag(f"开始处理文件: {input_file}, 模式: {mode}")

    if not os.path.exists(input_file):
        raise FileNotFoundError(f"输入文件不存在: {input_file}")

    file_size = os.path.getsize(input_file)
    log_diag(f"文件大小检测: {file_size} 字节")

    # 业务处理示例
    summary = {
        "filePath": os.path.abspath(input_file),
        "fileSizeBytes": file_size,
        "modeApplied": mode,
        "status": "processed",
    }
    return summary


def main() -> int:
    try:
        args = parse_arguments()
    except SystemExit as exc:
        # argparse 参数解析失败，退出码归一化为 1
        return 1 if exc.code != 0 else 0

    try:
        result_data = execute_tool(args.input_file, args.mode)
        # 严格向 stdout 输出单行或紧凑的结构化 JSON
        output_payload = {
            "ok": True,
            "data": result_data,
        }
        sys.stdout.write(json.dumps(output_payload, ensure_ascii=False, indent=2) + "\n")
        sys.stdout.flush()
        return 0

    except FileNotFoundError as fnf_err:
        log_diag(f"业务失败: {fnf_err}")
        err_payload = {
            "ok": False,
            "code": "FILE_NOT_FOUND",
            "error": str(fnf_err),
        }
        sys.stdout.write(json.dumps(err_payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return 2

    except Exception as exc:  # noqa: BLE001
        log_diag(f"致命未捕获异常: {exc}")
        err_payload = {
            "ok": False,
            "code": "INTERNAL_ERROR",
            "error": f"工具执行异常: {exc}",
        }
        sys.stdout.write(json.dumps(err_payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return 3


if __name__ == "__main__":
    sys.exit(main())
