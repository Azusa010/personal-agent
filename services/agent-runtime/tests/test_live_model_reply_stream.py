"""LiveModel 正文流式（finish_task 的 reply 边生成边抽取）的测试。

与 test_live_model.py 的思维流式测试对称：流上已经逐 token 到达的 reply
不该憋到决策解析完才一次性冒出来。Fake 客户端自带，不与既有文件共享，
避免测试文件之间的隐式耦合。
"""

import json
from types import SimpleNamespace

from personal_agent.conversation.model.gateway import (
    ModelContext,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.conversation.model.live_model import (
    FINISH_TASK_TOOL_NAME,
    LiveModel,
)


def context() -> ModelContext:
    return ModelContext(
        taskGoal="整理工作区里的 PDF", visibleCapabilities=["filesystem_list"]
    )


def responses_stream(events: list, final_response):
    """Responses API 的流：可迭代、能给出 final response（与 SDK 形状对齐）。"""

    class _Stream:
        def __iter__(self):
            return iter(events)

        def get_final_response(self):
            return final_response

    class _Manager:
        def __enter__(self):
            return _Stream()

        def __exit__(self, *exc):
            return False

    return _Manager()


def chat_chunk(delta: SimpleNamespace, finish_reason: str | None = None):
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=finish_reason)])


def tool_call_delta(index: int, name: str = "", arguments: str = "", id: str | None = None):
    func = SimpleNamespace(name=name, arguments=arguments)
    return SimpleNamespace(index=index, id=id, type="function", function=func)


def finish_task_args_chunks(reply: str) -> list[str]:
    """把完整 arguments JSON 按 4 字符切碎，模拟逐 token 上线。"""
    args = json.dumps({"reply": reply, "facts": [{"text": "p1 说了 A", "pageRefs": [1]}]})
    return [args[i : i + 4] for i in range(0, len(args), 4)]


# ---- Chat Completions 路径 ----


def test_chat_stream_emits_reply_deltas_as_arguments_arrive():
    chunks_in = finish_task_args_chunks("第一段正文，第二段。")
    events = [
        chat_chunk(SimpleNamespace(reasoning_content="思考中", content=None, tool_calls=None)),
        chat_chunk(
            SimpleNamespace(
                reasoning_content=None,
                content=None,
                tool_calls=[tool_call_delta(0, name=FINISH_TASK_TOOL_NAME, arguments=chunks_in[0], id="call-1")],
            )
        ),
    ]
    events += [
        chat_chunk(SimpleNamespace(reasoning_content=None, content=None, tool_calls=[tool_call_delta(0, arguments=p)]))
        for p in chunks_in[1:]
    ]
    events.append(chat_chunk(SimpleNamespace(reasoning_content=None, content=None, tool_calls=None), finish_reason="tool_calls"))

    class FakeCompletions:
        def __init__(self):
            self.stream_requests = []

        def create(self, **kwargs):
            self.stream_requests.append(kwargs)

            class _Stream:
                def __enter__(self):
                    return iter(events)

                def __exit__(self, *exc):
                    return False

            return _Stream()

    completions = FakeCompletions()
    model = LiveModel(
        model="gpt-test",
        client=SimpleNamespace(chat=SimpleNamespace(completions=completions)),
        api_protocol="chat_completions",
        reasoning_summary=True,
    )

    reply_chunks: list[str] = []
    decision = model.decide(context(), on_reply=reply_chunks.append)

    assert isinstance(decision, SummaryDecision)
    assert decision.reply == "第一段正文，第二段。"
    # 4 字符一片的 arguments delta 至少挤出多条正文增量，拼接还原全文
    assert len(reply_chunks) >= 2
    assert "".join(reply_chunks) == "第一段正文，第二段。"


def test_chat_stream_non_finish_task_tool_call_emits_no_reply():
    events = [
        chat_chunk(
            SimpleNamespace(
                reasoning_content=None,
                content=None,
                tool_calls=[tool_call_delta(0, name="filesystem_list", id="call-1")],
            )
        ),
        chat_chunk(
            SimpleNamespace(
                reasoning_content=None,
                content=None,
                tool_calls=[tool_call_delta(0, arguments='{"rootId": "workspace", "note": "reply"}')],
            )
        ),
    ]

    class FakeCompletions:
        def create(self, **kwargs):
            class _Stream:
                def __enter__(self):
                    return iter(events)

                def __exit__(self, *exc):
                    return False

            return _Stream()

    model = LiveModel(
        model="gpt-test",
        client=SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions())),
        api_protocol="chat_completions",
        reasoning_summary=True,
    )

    reply_chunks: list[str] = []
    decision = model.decide(context(), on_reply=reply_chunks.append)

    assert isinstance(decision, ToolCallDecision)
    assert reply_chunks == []


# ---- Responses 路径 ----


def test_responses_stream_emits_reply_deltas_from_function_call_arguments():
    # ensure_ascii=False：真实模型大多直接吐 UTF-8，切点才能落在正文字符中间
    args = json.dumps({"reply": "流式正文", "facts": []}, ensure_ascii=False)
    events = [
        SimpleNamespace(type="response.reasoning_summary_text.delta", delta="想想"),
        SimpleNamespace(
            type="response.output_item.added",
            item=SimpleNamespace(type="function_call", id="fc-1", name=FINISH_TASK_TOOL_NAME),
        ),
        SimpleNamespace(type="response.function_call_arguments.delta", item_id="fc-1", delta=args[:13]),
        SimpleNamespace(type="response.function_call_arguments.delta", item_id="fc-1", delta=args[13:]),
    ]
    final_response = SimpleNamespace(
        output_text=json.dumps({"kind": "summary", "reply": "流式正文", "facts": []}),
        usage=None,
    )

    class FakeResponses:
        def __init__(self):
            self.stream_requests = []

        def stream(self, **kwargs):
            self.stream_requests.append(kwargs)
            return responses_stream(events, final_response)

    responses = FakeResponses()
    model = LiveModel(
        model="gpt-test",
        client=SimpleNamespace(responses=responses),
        reasoning_summary=True,
    )

    reply_chunks: list[str] = []
    decision = model.decide(context(), on_reply=reply_chunks.append)

    assert isinstance(decision, SummaryDecision)
    assert decision.reply == "流式正文"
    assert len(reply_chunks) >= 2
    assert "".join(reply_chunks) == "流式正文"


def test_responses_stream_ignores_other_tool_calls_arguments():
    events = [
        SimpleNamespace(
            type="response.output_item.added",
            item=SimpleNamespace(type="function_call", id="fc-1", name="filesystem_list"),
        ),
        SimpleNamespace(
            type="response.function_call_arguments.delta",
            item_id="fc-1",
            delta='{"rootId": "workspace", "reply": "假正文"}',
        ),
    ]
    final_response = SimpleNamespace(
        output_text=json.dumps(
            {"kind": "tool_call", "callId": "call-1", "capability": "filesystem_list", "arguments": {"rootId": "workspace"}}
        ),
        usage=None,
    )

    class FakeResponses:
        def stream(self, **kwargs):
            return responses_stream(events, final_response)

    model = LiveModel(
        model="gpt-test",
        client=SimpleNamespace(responses=FakeResponses()),
        reasoning_summary=True,
    )

    reply_chunks: list[str] = []
    decision = model.decide(context(), on_reply=reply_chunks.append)

    assert isinstance(decision, ToolCallDecision)
    assert reply_chunks == []


# ---- 兜底路径 ----


def test_non_streaming_call_falls_back_to_chunked_reply():
    args = json.dumps({"reply": "完整的一次性回复，来自非流式调用。", "facts": []})
    final = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    role="assistant",
                    content=None,
                    tool_calls=[
                        SimpleNamespace(
                            id="call-1",
                            type="function",
                            function=SimpleNamespace(name=FINISH_TASK_TOOL_NAME, arguments=args),
                        )
                    ],
                ),
                finish_reason="tool_calls",
            )
        ]
    )

    class FakeCompletions:
        def __init__(self):
            self.requests = []

        def create(self, **kwargs):
            self.requests.append(kwargs)
            return final

    model = LiveModel(
        model="gpt-test",
        client=SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions())),
        api_protocol="chat_completions",
        reasoning_summary=False,
    )

    reply_chunks: list[str] = []
    decision = model.decide(context(), on_reply=reply_chunks.append)

    assert isinstance(decision, SummaryDecision)
    assert "".join(reply_chunks) == "完整的一次性回复，来自非流式调用。"


def test_streamed_reply_not_duplicated_by_fallback():
    args = json.dumps({"reply": "只发一遍", "facts": []})
    events = [
        SimpleNamespace(
            type="response.output_item.added",
            item=SimpleNamespace(type="function_call", id="fc-1", name=FINISH_TASK_TOOL_NAME),
        ),
        SimpleNamespace(type="response.function_call_arguments.delta", item_id="fc-1", delta=args),
    ]
    final_response = SimpleNamespace(
        output_text=json.dumps({"kind": "summary", "reply": "只发一遍", "facts": []}),
        usage=None,
    )

    class FakeResponses:
        def stream(self, **kwargs):
            return responses_stream(events, final_response)

    model = LiveModel(
        model="gpt-test",
        client=SimpleNamespace(responses=FakeResponses()),
        reasoning_summary=True,
    )

    reply_chunks: list[str] = []
    model.decide(context(), on_reply=reply_chunks.append)

    assert reply_chunks == ["只发一遍"]
