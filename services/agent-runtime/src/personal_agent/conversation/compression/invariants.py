"""5W1H 语义完整性守卫：防御残缺压缩，守护关键时空与实体锚点。"""

from personal_agent.conversation.compression.models import DistilledFact


def validate_semantic_integrity(fact: DistilledFact) -> tuple[bool, str]:
    """校验提炼的事实是否满足 5W1H 语义无损约束。"""
    if fact.subject.strip() == "":
        return False, "缺少事实主体 (subject)"
    if fact.predicate.strip() == "":
        return False, "缺少事实动作或谓词 (predicate)"
    if fact.object.strip() == "" and (fact.temporal is None or fact.temporal.strip() == ""):
        return False, "事实语义残缺：缺少时间锚点与关联客体"
    if fact.object.strip() == "":
        return False, "缺少关联客体或作用对象 (object)"
    return True, "ok"
