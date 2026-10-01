# .vulture_whitelist.py
# 用于豁免 Pydantic 协议模型、动态反射及系统保留字段的静态死代码误报

# 协议与 Pydantic 保留属性
_.model_config
_.model_dump
_.model_validate
_.extra
_.ConfigDict

# 框架与动态反射方法
_.from_orm
_.schema
_.dict
