"""ContextManager 与截断策略的行为测试。

对应 3c 的三个决定：
决定 2 → record 存原样，截断只发生在 build()
决定 3 → 只截字符串叶子，结构与 pageNumber 必须活下来
决定 4 → 只有一个字符旋钮，没有滑动窗口
"""

import pytest

from personal_agent.context import (
    DEFAULT_MAX_CHARS_PER_STRING,
    TRUNCATABLE_KEYS,
    TRUNCATION_MARKER,
    ContextManager,
    truncate_strings,
)
from personal_agent.model_gateway import Observation


def obs(call_id="call-1", capability="document.extract_pdf", ok=True, payload=None):
    return Observation(
        callId=call_id,
        capability=capability,
        ok=ok,
        payload={} if payload is None else payload,
    )


def pages(*texts):
    """document.extract_pdf 的 payload 形状。

    ok 不在这里：engine 会把它提成 Observation.ok，payload 只装数据。
    """
    return {
        "pages": [
            {"pageNumber": i + 1, "text": t} for i, t in enumerate(texts)
        ]
    }


# ---- truncate_strings ----


def test_truncate_short_string_unchanged():
    assert truncate_strings("abc", 10) == "abc"


def test_truncate_empty_string_unchanged():
    assert truncate_strings("", 10) == ""


def test_truncate_exact_limit_is_not_marked():
    # 长度正好等于 limit 不该加标记。否则模型看到的「原文」里凭空多出一句
    # 截断声明，而它无从判断这是真的被切过还是 PDF 里本来就有这行字。
    assert truncate_strings("x" * 10, 10) == "x" * 10


def test_truncate_long_string_is_cut_and_marked():
    # 根位置的裸字符串没有 key 可判，按自由文本处理。
    # 实际 payload 永远是 dict，这条只是让函数能单独拿来用。
    assert truncate_strings("x" * 50, 10) == "x" * 10 + TRUNCATION_MARKER


def test_truncate_limit_one():
    assert truncate_strings("abcdef", 1) == "a" + TRUNCATION_MARKER


def test_truncate_keeps_dict_structure_and_page_numbers():
    # 决定 3 的核心。按整包 JSON 切会把 pageNumber 一起切掉，
    # 模型就产不出合法 pageRefs，SummaryVerifier 全拒 ——
    # REQ-007 整条链路崩在一个看起来只是「上下文太长」的地方。
    got = truncate_strings(pages("a" * 5000, "b" * 5000), 100)

    assert [p["pageNumber"] for p in got["pages"]] == [1, 2]
    assert list(got) == ["pages"]
    for p in got["pages"]:
        assert p["text"] == p["text"][0] * 100 + TRUNCATION_MARKER


def test_truncate_walks_through_list_of_dicts():
    # pages 是 list，每项才是 {pageNumber, text}。key 要能穿过列表传到内层，
    # 否则 text 拿不到自己的 key，白名单就失效了。
    src = {"pages": [{"pageNumber": 1, "text": "y" * 30}], "reason": "z" * 30}
    got = truncate_strings(src, 5)
    assert got == {
        "pages": [{"pageNumber": 1, "text": "y" * 5 + TRUNCATION_MARKER}],
        "reason": "z" * 5 + TRUNCATION_MARKER,
    }


def test_truncate_leaves_identifier_fields_alone():
    # code / name / absolutePath 是模型下一步要原样回传的标识符。
    # 截断 PATH_OUT_OF_ROOT 会变成 PATH_OUT_O…[truncated]，模型认不出这是
    # 哪个错误码，GUD-005 的「稳定 error code」也就不成立。
    # absolutePath 更直接：Golden Path 第二步要拿它当 document.extract_pdf
    # 的 path，截断过的路径必然打不开文件。
    src = {
        "code": "PATH_OUT_OF_ROOT",
        "name": "季度报告.pdf",
        "absolutePath": "D:/downloads/季度报告.pdf",
        "modifiedAt": "2026-09-11T10:00:00.000Z",
    }
    assert truncate_strings(src, 5) == src


def test_truncatable_keys_is_opt_in():
    # 白名单而不是黑名单：新增 capability 的字段默认不截断
    #（顶多上下文偏长），而不是默认截断（标识符被啃坏，任务静默失败）。
    # 加新成员要有意识地改这一行。
    assert TRUNCATABLE_KEYS == frozenset({"text", "reason"})


def test_truncate_leaves_non_string_scalars_alone():
    # 不为数字或布尔写专门分支：它们不是上下文膨胀的来源，
    # 而 sizeBytes 这类字段被截断会直接变成错的数据。
    src = {"n": 12345678901234567890, "f": 1.5, "t": True, "nil": None}
    assert truncate_strings(src, 3) == src


def test_truncate_does_not_mutate_input():
    # 纯函数。就地改的话 record 存下来的原始历史会被 build 污染，
    # SummaryVerifier 之后就再也拿不到完整页码去核 pageRefs。
    src = pages("a" * 5000)
    truncate_strings(src, 100)
    assert len(src["pages"][0]["text"]) == 5000


# ---- 构造与旋钮 ----


def test_default_limit_is_the_module_constant():
    assert DEFAULT_MAX_CHARS_PER_STRING == 2000


@pytest.mark.parametrize("bad", [0, -1, -100])
def test_limit_below_one_is_rejected(bad):
    # limit=0 会让每个字符串都变成光秃秃一个标记，模型看到的是 12 条
    # 「…[truncated]」，而这一切都不报错。宁可构造时就拒。
    with pytest.raises(ValueError):
        ContextManager(maxCharsPerString=bad)


def test_limit_is_configurable_per_instance():
    m = ContextManager(maxCharsPerString=10)
    m.record(obs(payload=pages("a" * 500)))
    got = m.build("g", []).observations[0].payload
    assert got["pages"][0]["text"] == "a" * 10 + TRUNCATION_MARKER


# ---- record ----


def test_record_keeps_order():
    m = ContextManager()
    m.record(obs("call-1", "filesystem.list", payload={"entries": []}))
    m.record(obs("call-2", "document.extract_pdf", payload=pages("x")))

    assert [o.callId for o in m.observations] == ["call-1", "call-2"]
    assert [o.capability for o in m.observations] == [
        "filesystem.list",
        "document.extract_pdf",
    ]


def test_record_does_not_truncate():
    # 决定 2。即使旋钮设成 10，历史里也要是原文。
    m = ContextManager(maxCharsPerString=10)
    m.record(obs(payload=pages("a" * 5000)))
    assert len(m.observations[0].payload["pages"][0]["text"]) == 5000


def test_observations_is_readonly_snapshot():
    m = ContextManager()
    m.record(obs())
    view = m.observations

    assert isinstance(view, tuple)
    m.record(obs("call-2"))
    # 拿到的是快照不是活引用：外部改不动内部，内部也不会 retro 改外部。
    assert len(view) == 1
    assert len(m.observations) == 2


# ---- build ----


def test_build_passes_goal_and_capabilities_through():
    m = ContextManager()
    ctx = m.build(
        "整理 Downloads 里的 PDF", ["filesystem.list", "document.extract_pdf"]
    )

    assert ctx.taskGoal == "整理 Downloads 里的 PDF"
    assert ctx.visibleCapabilities == ["filesystem.list", "document.extract_pdf"]


def test_build_with_empty_history():
    # 第一步决策时历史必然是空的，这时候抛异常等于 Golden Path 走不出去。
    ctx = ContextManager().build("g", [])
    assert ctx.observations == []


def test_build_truncates_payload():
    m = ContextManager(maxCharsPerString=10)
    m.record(obs(payload=pages("a" * 5000, "b" * 5)))

    texts = [p["text"] for p in m.build("g", []).observations[0].payload["pages"]]
    assert texts == ["a" * 10 + TRUNCATION_MARKER, "b" * 5]


def test_build_does_not_mutate_stored_observations():
    # engine 每步都 build 一次。就地截断的话第二次 build 拿到的
    # 是已截断的文本再截一遍，标记会一层层叠上去。
    m = ContextManager(maxCharsPerString=10)
    m.record(obs(payload=pages("a" * 5000)))

    first = m.build("g", [])
    second = m.build("g", [])

    assert first.observations[0].payload == second.observations[0].payload
    assert len(m.observations[0].payload["pages"][0]["text"]) == 5000


def test_build_preserves_call_id_capability_and_ok():
    # 只有 payload 该变。callId 是模型把「我上一步要求的那个调用」
    # 和结果对上的唯一凭据，截断逻辑碰它就等于把观察和调用解绑。
    m = ContextManager(maxCharsPerString=10)
    m.record(
        obs(
            "call-7",
            "filesystem.list",
            ok=False,
            payload={"code": "PATH_OUT_OF_ROOT", "reason": "r" * 100},
        )
    )

    got = m.build("g", []).observations[0]
    assert (got.callId, got.capability, got.ok) == (
        "call-7",
        "filesystem.list",
        False,
    )
    assert got.payload["code"] == "PATH_OUT_OF_ROOT"
    assert got.payload["reason"] == "r" * 10 + TRUNCATION_MARKER


def test_build_keeps_failed_observations():
    # 失败观察对模型是有用信息：它需要知道这条路走不通才会换。
    # 过滤是 engine 或提示词的决策，不是上下文管理的。
    m = ContextManager()
    m.record(obs("call-1", ok=True, payload={"entries": []}))
    m.record(obs("call-2", ok=False, payload={"code": "X", "reason": "y"}))

    assert [o.ok for o in m.build("g", []).observations] == [True, False]


def test_build_returns_every_observation_without_window():
    # 决定 4。12 条超过任何合理的 maxSteps，但 ContextManager 不该替 engine
    # 做预算判定 —— 真丢了也是静默丢，模型不知道自己少看了东西。
    m = ContextManager()
    for i in range(12):
        m.record(obs(f"call-{i}"))

    assert len(m.build("g", []).observations) == 12
