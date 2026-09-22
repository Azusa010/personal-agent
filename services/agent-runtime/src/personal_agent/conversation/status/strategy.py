"""状态栏注入策略评估器：基于 Prompt Cache 成本模型与工程守卫。"""

from typing import Literal

InjectionStrategy = Literal["append", "replace"]

# 默认缓存折扣比率：以主流前缀缓存模型（如 OpenAI Prompt Caching）为基准
DEFAULT_ALPHA: float = 0.5

# 歧义阈值守卫：当追加次数过多时，多个版本的历史 TODO LIST 会造成注意力混淆，强制切换为 replace
DEFAULT_MAX_APPEND_TURNS: int = 8

# 上下文天花板守卫：当上下文使用率达到预算的 75% 时，强制切换为 replace 防止溢出
DEFAULT_MAX_CONTEXT_RATIO: float = 0.75


def evaluate_injection_strategy(
    s_tokens: int,
    r_tokens: int,
    n_turns: int,
    alpha: float = DEFAULT_ALPHA,
    context_used_ratio: float = 0.0,
    max_append_turns: int = DEFAULT_MAX_APPEND_TURNS,
    max_context_ratio: float = DEFAULT_MAX_CONTEXT_RATIO,
) -> InjectionStrategy:
    """基于 Prompt Cache 成本收益分界点公式与工程守卫的自适应策略判定器。
    理论模型：
    #   - C_替换 ≈ (N - 1)(1 - α)R
    #   - C_追加 ≈ α S N(N - 1) / 2
    #   - 分界条件：当 (α * S * N) / 2 < (1 - α) * R 时，倾向实现二（"append"），否则倾向实现一（"replace"）。
    """
    # 边界校验
    if s_tokens < 0 or r_tokens < 0 or n_turns < 1:
        raise ValueError("参数超出有效范围")
    if not (0.0 <= alpha <= 1.0):
        raise ValueError("alpha 必须在 [0.0, 1.0] 之间")
    if not (0.0 <= context_used_ratio <= 1.0):
        raise ValueError("context_used_ratio 必须在 [0.0, 1.0] 之间")

    # 硬性守卫 1：上下文天花板
    if context_used_ratio >= max_context_ratio:
        return "replace"

    # 硬性守卫 2：陈旧状态歧义
    if n_turns > max_append_turns:
        return "replace"

    # 边界情形：首轮对话，直接追加
    if n_turns == 1:
        return "append"

    # 数学模型评估
    left = (alpha * s_tokens * n_turns) / 2.0
    right = (1.0 - alpha) * r_tokens

    if left < right:
        return "append"
    else:
        return "replace"
