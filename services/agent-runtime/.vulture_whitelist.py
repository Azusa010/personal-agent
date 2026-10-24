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

# =========================================================================
# 孤岛体检登记（2026-10-24）：reports/islands-report.md 第 2 节 Python 死代码
# 118 项按主人决策全部白名单保留（零代码删除），分三节登记：
#   a. Pydantic 序列化字段噪音 —— 字段随 model_dump 序列化进 wire，Vulture 误报；
#   b. knowledge roadmap 待接线 —— knowledge/ 子系统已实现+有测试、README
#      「RAG 知识系统」已宣传，属待接线半成品，主人拍板保留；
#   c. 保留 API 与散项 —— PI-Agent 兼容公共 API（测试即契约）、仅测试引用
#      函数与其余散项。
# 粒度约定：Pydantic 字段/类常量等变量写裸名；property 与对象属性写 _.名字；
#           类方法写 类名.方法名；模块级函数与类写裸名。
# =========================================================================

# --------------------------------------------------------------------------
# a. Pydantic 序列化字段噪音：字段随 model_dump 输出到 wire，Vulture 按未读变量误报
# --------------------------------------------------------------------------
# eval/knowledge_models.py：评分维度与汇总结果字段
normalized_score
case_id
dimension_scores
avg_score
retrieval_failures
generation_failures_total
# eval/models.py：normalized_score / case_id / dimension_scores / avg_score
# 与上组同名，裸名全局生效，不重复登记
# conversation/model/gateway.py：ModelUsage 进 wire 的用量结算字段（TS 侧逐字对齐）
inputTokens
outputTokens
# knowledge/models.py：文档/切块统计字段
updated_at
chunk_count
# knowledge/raptor.py：RaptorNode.children_ids、RaptorTree.layers 为 Pydantic 字段；
# total_nodes 为树统计 property；build_raptor_tree 内 tree.layers 赋值属对象属性写
children_ids
layers
_.layers
_.total_nodes

# --------------------------------------------------------------------------
# b. knowledge roadmap 待接线（主人决策保留）：已实现+有测试+README 已宣传，
#    roadmap 见 README「RAG 知识系统」章节
# --------------------------------------------------------------------------

# knowledge/agentic_search.py：查询循环检测 + 充分性评估器
_.queries
QueryLoopDetector.reset
SufficiencyEvaluator
SufficiencyEvaluator.evaluate

# knowledge/cascader.py：自底向上级联更新器
BottomUpCascader
BottomUpCascader.plan_file_change_cascade
BottomUpCascader.execute_cascade

# knowledge/consolidator.py：知识合并器（去重/回溯取证/冲突消解）
KnowledgeConsolidator
KnowledgeConsolidator.deduplicate_entries
KnowledgeConsolidator.retrace_and_verify_evidence
KnowledgeConsolidator.resolve_conflicts_with_qualification

# knowledge/environment.py
KnowledgeEnvironment.get_knowledge_item

# knowledge/indexer.py
KnowledgeIndexer.index_directory

# knowledge/memory_extractor.py：记忆蒸馏抽取器
MemoryExtractor
MemoryExtractor.distill_and_append
MemoryExtractor.distill_from_history

# knowledge/proposer.py：提案生成与互审修订
build_proposal_from_facts
KnowledgeProposer
KnowledgeProposer.propose
KnowledgeProposer.revise

# knowledge/raptor.py：RAPTOR 树构建与检索入口
RaptorTree.get_layer_nodes
retrieve_raptor_context
build_raptor_tree

# knowledge/relation_classifier.py
classify_relations

# knowledge/relation_graph.py：关系图谱
RelationGraph
_.edge_count
RelationGraph.add_or_update_edge
RelationGraph.get_neighbors

# knowledge/repository.py：仅测试引用的仓储函数
get_chunks_by_document_id
delete_document
search_chunks_fts

# knowledge/retrieval_router.py
execute_routed_retrieval

# knowledge/source_tagger.py：外部内容包裹与注入检测
wrap_external_content
unwrap_external_content
is_injection_suspicious

# knowledge/update_loop.py：知识更新闭环
KnowledgeUpdateLoop
KnowledgeUpdateLoop.run_review_cycle

# --------------------------------------------------------------------------
# c. 保留 API 与散项
# --------------------------------------------------------------------------

# conversation/context/sectioned_prompt.py：PI-Agent 兼容公共 API，测试即契约
_.last_rendered
_.section_names
SectionedSystemPrompt.set_sections
SectionedSystemPrompt.get_section
SectionedSystemPrompt.has_section
SectionedSystemPrompt.mark_rendered
SectionedSystemPrompt.reset_rendered
SectionedSystemPrompt.render_diff
SectionedSystemPrompt.apply_diff_xml
SectionedSystemPrompt.calculate_kv_cache_ratio

# knowledge/memory_repository.py：仅测试引用的仓储函数与异常类
MemoryNotFoundError
_row_to_memory_item
get_user_memory_by_id
get_active_memories
increment_access_stats

# conversation/compression：分层压缩常量、统计 property 与进度文档方法
PERSISTENT_L2
_.compression_ratio
ProgressDocumentManager.add_note

# conversation/context/manager.py
ContextManager.set_user_memories
_.step_observations

# conversation/dream/models.py：整合结果统计字段
consolidated_items_count
index_rebuilt
lock_file_path

# conversation/extractor：收件箱读取方法与抽取批次模型字段
MemoryInbox.read_pending
source_seq_range
extracted_at
from_seq_id
to_seq_id
noop_count

# conversation/ledger：账本守卫方法与账本事件模型字段
LedgerGuard.guard_tool_result
LedgerGuard.read_blob
artifact_path
subagent_run_id
original_chars
estimated_chars
preview

# conversation/loop：并发清理、看门狗、断路器与轨迹防呆
clear_registered_capabilities
StreamWatchdog.check_alive
RecoveryPathBreaker.is_tripped
RecoveryPathBreaker.get_failure_count
RecoveryPathBreaker.reset
DeathSpiralProtector.reset
ToolFingerprintDetector.reset

# conversation/observability：记录帧写入
write_frame

# conversation/status：状态栏管理器方法/property 与模型、协议及实现类常量
_.update_count
StatusBarManager.update_todo_status
StatusBarManager.refresh_system_env
StatusBarManager.apply_to_messages
updated_at
section_id

# conversation/subagent：实例取消、错误追踪与池查询
SubagentInstance.cancel
TraceIsolator.record_error
TraceIsolator.read_trace
SubagentPool.list_active
SubagentPool.list_all

# conversation/topics/models.py：归档元数据字段
archived_epoch_id
archived_file_path

# conversation/windows/models.py：归档窗口统计字段
archived_at
events_count
time_elapsed_seconds
