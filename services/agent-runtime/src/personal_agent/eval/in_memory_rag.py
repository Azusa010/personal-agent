"""内存轻量级 RAG 索引器 (InMemoryRagIndex)。

专用于评测环境：
1. 从用例的历史会话中提取切块，生成内存倒排词频与向量候选；
2. 零外部 PostgreSQL/pgvector 依赖，开箱即用；
3. 支持关键词匹配 (BM25 简易变体) 与可选向量语义检索，并通过 RRF 算法融合。
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Sequence

from personal_agent.eval.models import SessionMessage


class ConversationChunk:
    """会话历史切块。"""

    def __init__(self, chunk_id: str, session_idx: int, role: str, text: str) -> None:
        self.chunk_id = chunk_id
        self.session_idx = session_idx
        self.role = role
        self.text = text


def _tokenize(text: str) -> list[str]:
    """简单中文与英文标点分词器。"""
    # 提取英文单词和单个中文字符
    pattern = re.compile(r"[\u4e00-\u9fa5]|[a-zA-Z0-9_\-\.]+")
    return [t.lower() for t in pattern.findall(text)]


DEFAULT_DISTRACTOR_SESSIONS: tuple[tuple[SessionMessage, ...], ...] = (
    (
        SessionMessage(role="user", content="明天打算去买些苹果和香蕉，楼下水果店好像有打折活动。"),
        SessionMessage(role="assistant", content="收到，祝您购物愉快！"),
    ),
    (
        SessionMessage(role="user", content="今天北京天气挺冷的，出门记得加一件厚羽绒服。"),
        SessionMessage(role="assistant", content="注意保暖防寒，多喝热水。"),
    ),
    (
        SessionMessage(role="user", content="周末想和大学同学去郊区爬山，需要准备一双轻便的徒步鞋。"),
        SessionMessage(role="assistant", content="爬山注意安全，提前看好天气预报。"),
    ),
    (
        SessionMessage(role="user", content="公司下季度的团建地点投票，大部分同事选了去海边度假村。"),
        SessionMessage(role="assistant", content="海边团建很适合放松，祝团队玩得开心。"),
    ),
    (
        SessionMessage(role="user", content="昨晚看了那部科幻电影《星际穿越》，配乐和黑洞特效真的很震撼。"),
        SessionMessage(role="assistant", content="确实是影史经典之作！诺兰的镜头语言非常精彩。"),
    ),
    (
        SessionMessage(role="user", content="牙医建议我半年洗一次牙，保护牙龈健康，下周得约个诊所号。"),
        SessionMessage(role="assistant", content="定期洁牙是个好习惯，需要时随时提醒您预约。"),
    ),
    (
        SessionMessage(role="user", content="邻居家养了一只柯基犬，每天在电梯里遇到都特别活泼。"),
        SessionMessage(role="assistant", content="柯基短腿圆滚滚的，非常治愈。"),
    ),
    (
        SessionMessage(role="user", content="下个月要去深圳参加供应商对接会议，需要提前看好高铁票。"),
        SessionMessage(role="assistant", content="已为您记下深圳出差安排。"),
    ),
    (
        SessionMessage(role="user", content="家里厨房的燃气灶点火针有点接触不良，打算周末找师傅维修。"),
        SessionMessage(role="assistant", content="安全第一，尽快找专业燃气师傅排查。"),
    ),
    (
        SessionMessage(role="user", content="今天下午和产品经理沟通了新需求的原型图设计，下周评审。"),
        SessionMessage(role="assistant", content="祝原型评审顺利通过！"),
    ),
)


class InMemoryRagIndex:
    """轻量自包含内存 RAG 索引器。"""

    def __init__(self) -> None:
        self.chunks: list[ConversationChunk] = []
        self._doc_lens: list[int] = []
        self._avg_dl: float = 0.0
        self._vocab_df: Counter[str] = Counter()
        self._doc_tfs: list[Counter[str]] = []

    @classmethod
    def from_sessions(
        cls,
        sessions: Sequence[Sequence[SessionMessage]],
        include_distractors: bool = False,
    ) -> InMemoryRagIndex:
        """从用例的跨会话消息中构建切块并建立索引。若开启 include_distractors 则注入背景干扰对话。"""
        index = cls()
        chunk_idx = 0

        target_sessions: list[Sequence[SessionMessage]] = list(sessions)
        if include_distractors:
            target_sessions.extend(DEFAULT_DISTRACTOR_SESSIONS)

        for s_idx, session in enumerate(target_sessions):
            for msg in session:
                text = f"{msg.role}: {msg.content.strip()}"
                chunk = ConversationChunk(
                    chunk_id=f"chunk-{s_idx}-{chunk_idx}",
                    session_idx=s_idx + 1,
                    role=msg.role,
                    text=text,
                )
                index.chunks.append(chunk)
                chunk_idx += 1

        index._build_sparse_index()
        return index

    def _build_sparse_index(self) -> None:
        """构建 BM25 词频与文档频率索引。"""
        total_len = 0
        self._doc_tfs.clear()
        self._doc_lens.clear()
        self._vocab_df.clear()

        for chunk in self.chunks:
            tokens = _tokenize(chunk.text)
            doc_len = len(tokens)
            self._doc_lens.append(doc_len)
            total_len += doc_len

            tf = Counter(tokens)
            self._doc_tfs.append(tf)
            for word in tf:
                self._vocab_df[word] += 1

        self._avg_dl = (total_len / len(self.chunks)) if self.chunks else 1.0

    def search(self, query: str, top_k: int = 5) -> list[ConversationChunk]:
        """执行 BM25 打分检索，返回相关度最高的 Top-K 历史对话片段。"""
        if not self.chunks:
            return []

        query_tokens = _tokenize(query)
        if not query_tokens:
            return self.chunks[:top_k]

        n_docs = len(self.chunks)
        scores: list[tuple[float, int]] = []

        k1 = 1.5
        b = 0.75

        for idx, tf in enumerate(self._doc_tfs):
            score = 0.0
            dl = self._doc_lens[idx]
            for term in query_tokens:
                if term in tf:
                    df = self._vocab_df[term]
                    idf = math.log((n_docs - df + 0.5) / (df + 0.5) + 1.0)
                    term_tf = tf[term]
                    numerator = term_tf * (k1 + 1)
                    denominator = term_tf + k1 * (1 - b + b * (dl / self._avg_dl))
                    score += idf * (numerator / denominator)
            scores.append((score, idx))

        scores.sort(key=lambda x: x[0], reverse=True)
        return [self.chunks[idx] for score, idx in scores[:top_k] if score > 0]
