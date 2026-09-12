"""SummaryVerifier 的行为测试 —— 指导书 TEST-007 Summary Grounding 的落地。

四类要覆盖的：页码存在性、错误页码、缺失引用、结构错误。
另外钉两条边界：参照集合怎么从观察历史里挖出来，以及验证器**不做**语义判定。
"""

import pytest

from personal_agent.model_gateway import Observation
from personal_agent.protocol.models import SummaryFact
from personal_agent.summary import (
    EXTRACT_PDF_CAPABILITY,
    SummaryRejected,
    collect_extracted_pages,
    verify_summary,
)


def obs(capability=EXTRACT_PDF_CAPABILITY, ok=True, payload=None):
    return Observation(
        callId="c-1",
        capability=capability,
        ok=ok,
        payload={} if payload is None else payload,
    )


def pdf_obs(*page_numbers):
    """一次成功的 extract_pdf，pages 形状与 host 侧 DocumentExtractPdfResult 一致。"""
    return obs(
        payload={
            "pages": [{"pageNumber": n, "text": f"第 {n} 页正文"} for n in page_numbers]
        }
    )


def failed_pdf_obs():
    """一次失败的 extract_pdf：payload 里是 code 与 reason，没有 pages。"""
    return obs(ok=False, payload={"code": "FILE_UNREADABLE", "reason": "PDF 已加密"})


def list_obs():
    return obs(
        capability="filesystem.list",
        payload={
            "entries": [
                {
                    "name": "a.pdf",
                    "absolutePath": "D:/downloads/a.pdf",
                    "modifiedAt": "2026-09-01T00:00:00Z",
                    "sizeBytes": 2048,
                }
            ]
        },
    )


def fact(text="结论", page_refs=None):
    return {"text": text, "pageRefs": [1] if page_refs is None else page_refs}


PAGES_123 = frozenset({1, 2, 3})


# ---- collect_extracted_pages ----


def test_collect_returns_page_numbers_from_successful_extract():
    got = collect_extracted_pages([pdf_obs(1, 2, 3)])
    assert got == {1, 2, 3}


def test_collect_on_empty_history_returns_empty_set():
    assert collect_extracted_pages([]) == frozenset()


def test_collect_ignores_failed_extract():
    # 提取失败的 payload 里是 code 与 reason，没有 pages。
    # 让它贡献页码等于给模型发通行证：加密 PDF 提取失败，
    # 模型却能引用「第 1 页」并通过校验。
    assert collect_extracted_pages([failed_pdf_obs()]) == frozenset()


def test_collect_ignores_other_capabilities():
    # filesystem.list 的 payload 里是 entries，形状完全不同。
    assert collect_extracted_pages([list_obs()]) == frozenset()


def test_collect_unions_pages_across_multiple_extracts():
    got = collect_extracted_pages([pdf_obs(1, 2), pdf_obs(2, 3, 4)])
    assert got == {1, 2, 3, 4}


def test_collect_deduplicates_same_pdf_extracted_twice():
    got = collect_extracted_pages([pdf_obs(1, 2), pdf_obs(1, 2)])
    assert got == {1, 2}


def test_collect_mixes_success_and_failure():
    got = collect_extracted_pages([failed_pdf_obs(), pdf_obs(7), list_obs()])
    assert got == {7}


def test_collect_skips_payload_without_pages_key():
    assert collect_extracted_pages([obs(payload={"entries": []})]) == frozenset()


def test_collect_skips_pages_that_is_not_a_list():
    assert collect_extracted_pages([obs(payload={"pages": "第一页"})]) == frozenset()
    assert collect_extracted_pages([obs(payload={"pages": {"1": "正文"}})]) == frozenset()


def test_collect_skips_items_that_are_not_dicts():
    got = collect_extracted_pages(
        [obs(payload={"pages": ["散文", {"pageNumber": 2, "text": "正文"}, 42]})]
    )
    # 坏条目跳过，好条目照收：一条脏数据不该把整份 PDF 的页码抹掉。
    assert got == {2}


def test_collect_skips_items_missing_page_number():
    got = collect_extracted_pages([obs(payload={"pages": [{"text": "没有页码"}]})])
    assert got == frozenset()


@pytest.mark.parametrize("bad", ["1", 1.5, None, [], {}])
def test_collect_skips_non_integer_page_number(bad):
    got = collect_extracted_pages(
        [obs(payload={"pages": [{"pageNumber": bad, "text": "正文"}]})]
    )
    assert got == frozenset()


def test_collect_skips_page_number_below_one():
    got = collect_extracted_pages(
        [obs(payload={"pages": [{"pageNumber": 0, "text": "正文"}]})]
    )
    assert got == frozenset()


def test_collect_does_not_mutate_observations():
    observations = [pdf_obs(1, 2), list_obs()]
    before = [(o.capability, o.ok, dict(o.payload)) for o in observations]

    collect_extracted_pages(observations)

    after = [(o.capability, o.ok, dict(o.payload)) for o in observations]
    assert after == before


# ---- verify_summary：页码存在性 ----


def test_verify_accepts_refs_that_exist():
    facts = verify_summary([fact(page_refs=[1, 3])], PAGES_123)
    assert len(facts) == 1
    assert facts[0].pageRefs == [1, 3]


def test_verify_returns_summary_fact_instances_not_dicts():
    # engine 把返回值直接塞进 RunTaskCompleted.facts，那字段要的是模型实例。
    facts = verify_summary([fact()], PAGES_123)
    assert all(isinstance(f, SummaryFact) for f in facts)


def test_verify_keeps_order_across_multiple_facts():
    facts = verify_summary(
        [fact(text="第一条", page_refs=[1]), fact(text="第二条", page_refs=[2, 3])],
        PAGES_123,
    )
    assert [f.text for f in facts] == ["第一条", "第二条"]
    assert [f.pageRefs for f in facts] == [[1], [2, 3]]


def test_verify_does_not_judge_text_content():
    # 能力边界：只验结构与引用存在性。fact 的文本是不是真的由那一页推出，
    # 是语义判定，Phase 1 Execution Rules 明确不许用第二个 LLM 来做。
    # 这条测试钉住「不许悄悄往里加语义判定」。
    facts = verify_summary([fact(text="完全编造的结论")], PAGES_123)
    assert facts[0].text == "完全编造的结论"


# ---- verify_summary：错误页码 ----


def test_verify_rejects_page_ref_outside_available_pages():
    with pytest.raises(SummaryRejected):
        verify_summary([fact(page_refs=[9999])], PAGES_123)


def test_verify_rejects_when_only_one_ref_is_bad():
    # 一条 fact 里混着合法与非法页码，整条拒：不能悄悄把非法的那个删掉，
    # 那会让 UI 显示出一条与模型原话不同的摘要。
    with pytest.raises(SummaryRejected):
        verify_summary([fact(page_refs=[1, 9999])], PAGES_123)


def test_verify_rejection_reason_locates_the_fact_and_page():
    with pytest.raises(SummaryRejected) as exc:
        verify_summary(
            [fact(text="第一条"), fact(text="第二条", page_refs=[9999])], PAGES_123
        )
    reason = exc.value.reason
    # facts 一多，一句「摘要不合法」没法排查：要能定位到第几条、哪个页码。
    assert "2" in reason
    assert "9999" in reason


def test_verify_rejection_reason_stays_short_with_many_pages():
    many_pages = frozenset(range(1, 501))
    with pytest.raises(SummaryRejected) as exc:
        verify_summary([fact(page_refs=[9999])], many_pages)
    # 页码全集塞进 reason 的话，一份 500 页的 PDF 就是两千字符，
    # 而 UI 那边一行摘要超 160 字符就截断，真正有用的定位信息会被切掉。
    assert len(exc.value.reason) < 200


def test_verify_rejects_everything_when_no_page_was_extracted():
    with pytest.raises(SummaryRejected):
        verify_summary([fact(page_refs=[1])], frozenset())


def test_verify_distinguishes_no_extraction_from_out_of_range():
    # 模型压根没调 extract_pdf，与调了但引用超出页数，排查方向完全不同：
    # 前者是模型跑偏，后者可能是 PDF 解析少给了页。两句话不能一样。
    with pytest.raises(SummaryRejected) as never_extracted:
        verify_summary([fact(page_refs=[1])], frozenset())
    with pytest.raises(SummaryRejected) as out_of_range:
        verify_summary([fact(page_refs=[9999])], PAGES_123)

    assert never_extracted.value.reason != out_of_range.value.reason


# ---- verify_summary：缺失引用 ----


def test_verify_rejects_empty_page_refs():
    # REQ-007：每条摘要必须可追溯到页面。没有引用的 fact 无从核对。
    with pytest.raises(SummaryRejected):
        verify_summary([fact(page_refs=[])], PAGES_123)


def test_verify_rejects_when_one_of_several_facts_has_no_refs():
    with pytest.raises(SummaryRejected):
        verify_summary([fact(page_refs=[1]), fact(page_refs=[])], PAGES_123)


# ---- verify_summary：结构错误 ----


def test_verify_rejects_empty_fact_list():
    # 一个 fact 都没有不构成 PAT-003 要的 evidence。
    with pytest.raises(SummaryRejected):
        verify_summary([], PAGES_123)


def test_verify_rejects_empty_text():
    with pytest.raises(SummaryRejected):
        verify_summary([fact(text="")], PAGES_123)


@pytest.mark.parametrize("bad_ref", [0, -1, 1.5, None, []])
def test_verify_rejects_malformed_page_ref(bad_ref):
    with pytest.raises(SummaryRejected):
        verify_summary([fact(page_refs=[bad_ref])], PAGES_123)


def test_verify_coerces_numeric_string_page_ref():
    # 双端语义漂移，这条钉的是现状而不是期望：TS 侧 zod 是
    # z.number().int().min(1)，字符串 "1" 会被拒；Pydantic 默认 lax 模式
    # 把 "1" 强转成 1 放行。facts 来自模型输出的 JSON，不过 TS 那道 zod，
    # 所以这里是第一道关。要收紧得在 SummaryFact 上开 strict，
    # 那是跨语言契约的改动，不在验证器里补。将来谁开了 strict，
    # 这条会红 —— 那就是它该红的时候。
    facts = verify_summary([fact(page_refs=["1"])], PAGES_123)
    assert facts[0].pageRefs == [1]


def test_verify_rejects_fact_that_is_not_a_dict():
    with pytest.raises(SummaryRejected):
        verify_summary(["模型直接回了一句散文"], PAGES_123)


def test_verify_rejects_fact_missing_page_refs_key():
    with pytest.raises(SummaryRejected):
        verify_summary([{"text": "只有正文没有引用"}], PAGES_123)


def test_verify_rejects_fact_missing_text_key():
    with pytest.raises(SummaryRejected):
        verify_summary([{"pageRefs": [1]}], PAGES_123)


# ---- verify_summary：失败形态 ----


def test_verify_gives_no_partial_result():
    # 三条里第二条非法 → 整体拒，不返回「通过的那两条」。
    # 部分通过会让 task 标成 completed，而 UI 显示的摘要比模型说的少一条。
    with pytest.raises(SummaryRejected):
        verify_summary(
            [
                fact(text="第一条"),
                fact(text="第二条", page_refs=[9999]),
                fact(text="第三条"),
            ],
            PAGES_123,
        )


@pytest.mark.parametrize(
    "facts",
    [
        ["散文"],
        [None],
        [42],
        [{"text": "", "pageRefs": []}],
        [{"text": "结论", "pageRefs": "第一页"}],
        [{"text": "结论", "pageRefs": [{"pageNumber": 1}]}],
        [fact(), "散文"],
    ],
)
def test_verify_only_raises_summary_rejected(facts):
    # engine 只接 SummaryRejected。ValidationError / TypeError / AttributeError
    # 冒上去会落到 runtime 的兜底 except，变成 RUNTIME_INTERNAL，
    # timeline 上就看不出是摘要的问题还是进程的问题。
    with pytest.raises(SummaryRejected):
        verify_summary(facts, PAGES_123)


def test_verify_rejection_reason_is_non_empty_string():
    with pytest.raises(SummaryRejected) as exc:
        verify_summary([fact(page_refs=[9999])], PAGES_123)
    assert isinstance(exc.value.reason, str)
    assert exc.value.reason.strip()
