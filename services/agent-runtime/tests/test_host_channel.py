"""HostChannel 与 run() 主循环的行为测试。

用假的 readline/write_msg 驱动，不起子进程：通道层的语义（阻塞、暂存、
EOF、错误分类）与真实管道无关，真实往返要到 engine 接上之后才测得了。
"""

import json
from pathlib import Path

import pytest

from personal_agent.host_channel import (
    HostChannel,
    HostChannelClosed,
    HostRequestFailed,
)
from personal_agent.protocol.models import HostExecuteToolParams
from personal_agent.runtime import run

FIXTURES_DIR = (
    Path(__file__).resolve().parents[3] / "packages" / "protocol" / "fixtures"
)

# 超过这个次数说明调用方没识别 EOF（readline 一直返回 ''），会空转。
# 设上限是为了让这种 bug 表现为测试失败，而不是 pytest 卡死在那里。
READLINE_LIMIT = 50


def make_channel(lines, written=None):
    """lines 耗尽后 readline 返回 ''，与真实管道 EOF 的行为一致。"""
    box = list(lines)
    out = written if written is not None else []
    calls = {"n": 0}

    def readline():
        calls["n"] += 1
        if calls["n"] > READLINE_LIMIT:
            raise AssertionError(
                f"readline 被调用超过 {READLINE_LIMIT} 次，调用方没有正确处理 EOF"
            )
        return box.pop(0) if box else ""

    ch = HostChannel(readline=readline, write_msg=out.append)
    return ch, out, calls


def pdf_params(call_id="tc-9f3a"):
    return HostExecuteToolParams(
        callId=call_id,
        capability="document.extract_pdf",
        arguments={"path": "D:/Users/demo/Downloads/report-2026.pdf"},
    )


OK_CALL_1 = '{"jsonrpc": "2.0", "id": "call-1", "result": {"ok": true}}'


def test_request_shape_matches_contract_fixture():
    """call_host 发出的 wire 逐字等于契约 fixture。

    两端各自维护请求形状的话，TS 侧 safeParse 会拒掉 Python 发的请求，
    而 Python 侧单测全绿 —— 错误只在真实跨进程运行时才出现。
    fixture 里的 id 正好是 call-1，与首次调用产生的 id 一致，可以整体比对。
    """
    fixture = json.loads(
        (FIXTURES_DIR / "host-execute-tool.request.json").read_text(encoding="utf-8")
    )
    params = HostExecuteToolParams.model_validate(fixture["params"])
    ch, out, _ = make_channel([OK_CALL_1])

    ch.call_host(params)

    assert out[0] == fixture


def test_returns_result_and_keeps_extra_fields():
    ch, _, _ = make_channel(
        [
            (
                '{"jsonrpc": "2.0", "id": "call-1", "result":'
                ' {"ok": true, "pages": [{"pageNumber": 1, "text": "hi"}]}}'
            )
        ]
    )

    result = ch.call_host(pdf_params())

    assert result.ok is True
    # extra="allow" 保住了 pages。Pydantic 默认 ignore 会静默丢掉它，
    # 校验照样通过，engine 拿到只有 ok 的空壳，PDF 文本全丢且零报错。
    assert result.model_dump()["pages"] == [{"pageNumber": 1, "text": "hi"}]


def test_business_failure_returns_result_instead_of_raising():
    """capability 的业务失败走 result，不走异常。

    PDF 损坏是可预期结果，engine 要把它写进 timeline 然后继续。
    抛异常会中断整个任务，用户看到的是"任务失败"而不是"这个 PDF 读不了"。
    """
    ch, _, _ = make_channel(
        [
            (
                '{"jsonrpc": "2.0", "id": "call-1", "result":'
                ' {"ok": false, "code": "PDF_CORRUPT", "reason": "PDF 结构损坏"}}'
            )
        ]
    )

    result = ch.call_host(pdf_params())

    assert result.ok is False
    assert result.model_dump()["code"] == "PDF_CORRUPT"


def test_error_response_raises_with_code():
    ch, _, _ = make_channel(
        [
            (
                '{"jsonrpc": "2.0", "id": "call-1", "error":'
                ' {"code": "HOST_TIMEOUT", "message": "host.execute_tool 超时"}}'
            )
        ]
    )

    with pytest.raises(HostRequestFailed) as ei:
        ch.call_host(pdf_params())

    assert ei.value.code == "HOST_TIMEOUT"
    assert "超时" in ei.value.message
    # code 要出现在 str() 里，否则日志和 traceback 只剩一句中文描述
    assert "HOST_TIMEOUT" in str(ei.value)


def test_eof_raises_host_channel_closed():
    """readline 返回 '' 必须抛。不抛的话 while True 永远读空字符串。"""
    ch, _, _ = make_channel([])

    with pytest.raises(HostChannelClosed):
        ch.call_host(pdf_params())


def test_non_matching_request_goes_to_inbox():
    """阻塞等 call-1 时 TS 主动发来的请求要暂存。

    丢掉的话 TS 侧 30 秒后超时（renderer 点刷新却没响应）；
    暂存后由主循环回头处理，代价只是延迟。
    """
    ts_request = (
        '{"jsonrpc": "2.0", "id": "req-7", "method": "filesystem.list",'
        ' "params": {"rootId": "downloads"}}'
    )
    ch, _, _ = make_channel([ts_request, OK_CALL_1])

    result = ch.call_host(pdf_params())

    assert result.ok is True
    assert len(ch.inbox) == 1
    # inbox 存的是 strip 过的原始文本，主循环的 handle_line 直接能吃，
    # 不需要二次序列化
    assert ch.next_line() == ts_request
    assert len(ch.inbox) == 0


def test_line_with_method_field_never_treated_as_response():
    """id 撞上也不能当响应。

    TS 用 req-N、Python 用 call-N，正常撞不上；真撞上时请求里没有
    result/error，当响应会让 model_validate 失败或 engine 拿到垃圾。
    """
    ch, _, _ = make_channel(
        [
            (
                '{"jsonrpc": "2.0", "id": "call-1", "method": "host.execute_tool",'
                ' "params": {"callId": "tc-1", "capability": "filesystem.list",'
                ' "arguments": {}}}'
            ),
            OK_CALL_1,
        ]
    )

    result = ch.call_host(pdf_params())

    assert result.ok is True
    assert len(ch.inbox) == 1


def test_invalid_json_and_blank_lines_are_skipped():
    """非法 JSON 丢弃而不是进 inbox。

    主循环对非法 JSON 只能回 id=null 的 error，TS 侧 routeLine 拿到
    null id 直接 return，写了也没人收。进 inbox 只是多一行噪音。

    空行用 "\n" 而不是 ""：readline 返回空字符串是 EOF，两者语义不同。
    """
    ch, _, _ = make_channel(["not json at all", "\n", "   \n", OK_CALL_1])

    result = ch.call_host(pdf_params())

    assert result.ok is True
    assert len(ch.inbox) == 0


def test_response_missing_ok_raises():
    ch, _, _ = make_channel(
        ['{"jsonrpc": "2.0", "id": "call-1", "result": {"pages": []}}']
    )

    with pytest.raises(HostRequestFailed) as ei:
        ch.call_host(pdf_params())

    assert ei.value.code == "PROTOCOL_INVALID_RESPONSE"


def test_rpc_id_increments_across_calls():
    ch, out, _ = make_channel(
        [
            OK_CALL_1,
            '{"jsonrpc": "2.0", "id": "call-2", "result": {"ok": true}}',
        ]
    )

    ch.call_host(pdf_params("tc-1"))
    ch.call_host(pdf_params("tc-2"))

    assert [w["id"] for w in out] == ["call-1", "call-2"]
    # 第二次调用不能把第一次的响应误当自己的
    assert [w["params"]["callId"] for w in out] == ["tc-1", "tc-2"]


def test_run_exits_on_eof(capsys):
    """钉住 next_line 返回 '' 时 run() 必须 break。

    判 `is None` 的话这里会空转到 READLINE_LIMIT 抛 AssertionError：
    readline() 在 EOF 时返回空字符串而不是 None，那个 break 永远不触发，
    stdin 关闭后进程 100% CPU 忙等，TS 侧 stop() 只能等 3 秒后强杀，
    TEST-015 的"退出无孤儿进程"直接过不去。
    """
    ch, _, calls = make_channel(
        ['{"jsonrpc": "2.0", "id": "req-1", "method": "system.ping"}']
    )

    run(channel=ch)

    out = capsys.readouterr().out
    assert '"id": "req-1"' in out
    assert calls["n"] < READLINE_LIMIT
