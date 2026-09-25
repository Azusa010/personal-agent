"""本地 PII 脱敏模块 (memory_sanitizer) 单元测试。"""

from personal_agent.knowledge.memory_sanitizer import (
    mask_string_pii,
    sanitize_memory_data,
)


def test_mask_string_pii_phone():
    """验证手机号码确定性脱敏 (保留前3后4，中间4位掩码)。"""
    raw = "用户联系电话为 13812345678，请尽快回拨。"
    masked, changed = mask_string_pii(raw)
    assert changed is True
    assert "138****5678" in masked
    assert "13812345678" not in masked


def test_mask_string_pii_id_card():
    """验证居民身份证号确定性脱敏 (保留前2后1，中间掩码)。"""
    raw = "身份证号码: 11010119900307239X，需留档。"
    masked, changed = mask_string_pii(raw)
    assert changed is True
    assert "11****X" in masked or "11****" in masked
    assert "11010119900307239X" not in masked


def test_mask_string_pii_bank_card():
    """验证银行卡号脱敏为 [REDACTED_CARD]。"""
    raw = "转账账号为 6222021234567890123。"
    masked, changed = mask_string_pii(raw)
    assert changed is True
    assert "[REDACTED_CARD]" in masked
    assert "6222021234567890123" not in masked


def test_mask_string_pii_secret():
    """验证敏感凭证与 Token 键值对脱敏。"""
    raw = "配置参数: api_key='sk-abcdef1234567890abcdef', token='secret_token_12345'"
    masked, changed = mask_string_pii(raw)
    assert changed is True
    assert "[REDACTED_SECRET]" in masked
    assert "sk-abcdef1234567890abcdef" not in masked


def test_sanitize_memory_data_nested_dict():
    """验证复杂嵌套字典与列表的递归脱敏与不可变性。"""
    raw_data = {
        "user": {
            "name": "张三",
            "phone": "13987654321",
            "emergency_contact": {
                "name": "李四",
                "phone": "13600001111",
            },
        },
        "tags": ["vip", "电话:15822223333"],
        "score": 100,
        "is_active": True,
        "notes": None,
    }

    sanitized, changed = sanitize_memory_data(raw_data)
    assert changed is True

    # 验证原字典未被原地篡改（深拷贝语义）
    assert raw_data["user"]["phone"] == "13987654321"

    # 验证嵌套脱敏结果
    assert sanitized["user"]["name"] == "张三"
    assert sanitized["user"]["phone"] == "139****4321"
    assert sanitized["user"]["emergency_contact"]["phone"] == "136****1111"
    assert "158****3333" in sanitized["tags"][1]
    assert sanitized["score"] == 100
    assert sanitized["is_active"] is True
    assert sanitized["notes"] is None


def test_sanitize_memory_data_scalars():
    """验证非敏感标量数据原样返回且 changed 为 False。"""
    for scalar in [123, 45.67, True, False, None]:
        res, changed = sanitize_memory_data(scalar)
        assert res == scalar
        assert changed is False
