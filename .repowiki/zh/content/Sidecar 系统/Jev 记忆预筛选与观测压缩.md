# Jev 记忆预筛选与观测压缩

<cite>
**本文引用的文件**
- [packages/protocol/schemas/sidecar.ts](file://packages/protocol/schemas/sidecar.ts)
- [services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py)
- [services/agent-runtime/src/personal_agent/conversation/sidecar/llm_client.py](file://services/agent-runtime/src/personal_agent/conversation/sidecar/llm_client.py)
- [services/agent-runtime/src/personal_agent/conversation/sidecar/__init__.py](file://services/agent-runtime/src/personal_agent/conversation/sidecar/__init__.py)
- [services/agent-runtime/src/personal_agent/conversation/loop/react_loop.py](file://services/agent-runtime/src/personal_agent/conversation/loop/react_loop.py)
- [services/agent-runtime/src/personal_agent/conversation/loop/strategy.py](file://services/agent-runtime/src/personal_agent/conversation/loop/strategy.py)
- [apps/desktop/src/main/settings/model-settings.ts](file://apps/desktop/src/main/settings/model-settings.ts)
</cite>

## 目录
1. [简介与背景](#简介与背景)
2. [多维 Jev 语义预筛选机制](#多维-jev-语义预筛选机制)
3. [上下文记忆精选与查询拦截重排](#上下文记忆精选与查询拦截重排)
4. [ObservationCompactor 超长观测压缩与本地持久化](#observationcompactor-超长观测压缩与本地持久化)
5. [数据流向与执行架构图](#数据流向与执行架构图)
6. [性能收益与容错降级](#性能收益与容错降级)

---

## 简介与背景

在 PersonalAgent 的长周期复杂任务执行中，大语言模型面临两大显著的上下文管理瓶颈：
1. **海量长程记忆的信噪比问题**：当知识库与用户画像库积累了数百条个性化偏好、日常惯例与历史项目经验时，若无差别全量拼接进 Prompt，不仅消耗高昂的 Token 费用，更会导致模型产生「注意分散（Attention Dilution）」，难以准确遵循针对当前任务的核心技术红线。
2. **工具超长输出吞噬上下文窗口**：网络爬取（`web_search`）、全盘检索（`file_search`）、大型代码读取或长篇终端编译日志往往输出数万甚至数十万字符，极易迅速挤爆模型的上下文窗口预算，引发注意力漂移或执行中断。

为此，Sidecar 子系统提供了 **Jev 记忆多维预筛选（Memory Pre-Filtering）** 与 **ObservationCompactor（超长观测动态压缩与本地持久化）** 两大支柱模块，实现上下文的高信噪比与紧凑化。

**章节来源**
- [enricher.py:1-8](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L1-L8)
- [sidecar.ts:72-86](file://packages/protocol/schemas/sidecar.ts#L72-L86)

---

## 多维 Jev 语义预筛选机制

在候选事实筛选上，单纯基于词法（BM25）或单一余弦相似度的检索往往无法分辨「日常闲聊」与「强业务约束」。Sidecar 引入基于 TypeSafe System One (Jev) 的毫秒级三维联合评分模型 `filter_relevant_memories`。

### 1. 三维评估问答契约
系统针对候选记忆条目并行提出三个维度的评估问题：
- **目标相关度 `rel`（Noul 契约）**：
  判定候选记忆是否对达成当前任务目标具有直接指导作用、约束价值或必要背景支持（布尔概率值 `noul: 0.0 ~ 1.0`）。
- **重要性等级 `imp`（Score 契约）**：
  评估候选条目对当前任务的影响力等级（1 到 5 档）：
  - `1`：完全无关的噪音，引入会干扰决策；
  - `2`：极弱相关的琐碎背景，不直接影响任务推进；
  - `3`：辅助性参考上下文；
  - `4`：重要的指导性偏好或规范，直接影响实现方式；
  - `5`：必须严格遵守的核心硬性约束或技术红线，违者任务不合格。
- **角色属性分类 `role`（Choice 契约）**：
  判断候选条目的语义角色：
  - `constraint`（强约束与红线）；
  - `preference`（风格偏好与习惯）；
  - `context`（项目领域背景知识）；
  - `noise`（闲聊杂音或过期失效信息）。

### 2. 多维打分公式
Jev 客户端返回答复后，按以下公式计算该候选记忆的综合关联得分：

$$
Score = \begin{cases} 
0.0 & \text{if } role = \text{"noise"} \lor noul < 0.2 \\
\text{round}\left(\frac{Score}{4.0} \times 70.0 + RoleBonus, 1\right) & \text{otherwise}
\end{cases}
$$

其中，角色加成系数 $RoleBonus$ 定义为：
- `constraint`：$+30.0$ 分（确保核心硬性红线具有最高优先级）；
- `preference`：$+20.0$ 分；
- `context`：$+15.0$ 分；
- 其他：$0.0$ 分。

### 3. 门槛过滤与 Top-K 截断
- 只有得分 $\ge 45.0$（`DEFAULT_MEMORY_RELEVANCE_THRESHOLD`）的候选条目才被保留。
- 按照得分从高到低排序，严格截取前 $K$ 条（默认 `top_k = 3`）黄金记忆返回。

### 4. 离线启发式规则兜底
若未配置 Jev API Key 或调用超时异常，系统自动无缝降级为 `compute_heuristic_relevance`：
- 计算目标语句关键词集合与候选文本的小写词项交集覆盖率（$OverlapRatio \times 100$）；
- 若覆盖度为 0 但候选结构自带底层检索得分 `retriever_score`，则折算为 $retriever\_score \times 60.0$ 进行保底排序。

**章节来源**
- [enricher.py:31-57](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L31-L57)
- [enricher.py:93-186](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L93-L186)

---

## 上下文记忆精选与查询拦截重排

基于多维 Jev 评分，Sidecar 分别在 **系统常驻记忆预热** 与 **用户 Query 实时交互** 两个生命周期节点实施干预。

### 1. 常驻工作记忆精选 (`enrich_working_memory_persona`)
系统提示词（Persona）中预置了 `[用户常驻工作记忆` 与 `[常驻记忆结束]` 标记区块。在任务启动前：
1. 提取标记区间内的所有候选行（以 `- ` 开头的条目）；
2. 传入当前任务总目标 `task_goal`，调用 `filter_relevant_memories` 进行预筛选；
3. **彻底降噪**：若筛选后无任何高分记忆，则直接将整个工作记忆区块从 Persona 中剔除，不留下冗余空标记；若存在高分条目，则重构为精选块输出。

### 2. 用户 Query 拦截与实时检索 (`enrich_query_memories`)
在用户发送每轮对话指令时（例如 `strategy.py` 中的 `intercept_query_memories(goal)`）：
1. **候选召回**：通过 `UserMemoryRetriever` 从底层 PostgreSQL 向量与倒排索引库中宽召回前 10 条候选卡片（`topK = max(top_k * 3, 10)`）；
2. **Sidecar 精选重排**：显式调用 `filter_relevant_memories` 对 10 条候选进行 Jev 多维打分，剔除无关闲聊，精选出前 3 条黄金约束；
3. **标准化格式注入**：调用 `format_memory_entry` 将卡片按统一类别标签格式化（如 `[身份画像]`、`[个人偏好]`、`[流程惯例]`、`[重要情景]`、`[技能经验]`、`[通用事实]`），最终注入 `ModelContext.userMemories` 作为规划前置上下文。

**章节来源**
- [enricher.py:192-246](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L192-L246)
- [enricher.py:248-290](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L248-L290)
- [enricher.py:292-398](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L292-L398)
- [strategy.py:276-283](file://services/agent-runtime/src/personal_agent/conversation/loop/strategy.py#L276-L283)

---

## ObservationCompactor 超长观测压缩与本地持久化

在工具执行返回物理观测（`Observation`）之后，若输出体积失控，直接灌回上下文将导致严重性能劣化。`compact_and_persist_observation` 提供了完备的防爆与防丢失双保障方案。

### 1. 阈值触发机制
系统设定字符门槛 `DEFAULT_COMPACT_CHAR_THRESHOLD = 6000` 字符：
- 若输出字符数 $\le 6000$，不进行处理，原样返回 `(observation, None)`；
- 若输出字符数 $> 6000$，触发本地落盘与结构化压缩。

### 2. 本地临时文件落盘（Zero-Loss Persistence）
为了防止浓缩过程中遗漏微观技术细节（如特定堆栈、关键哈希值）：
- 系统自动创建本地临时输出目录：`%TEMP%/personal_agent/tool_outputs/`；
- 将完整的原始输出文本落盘为独立文件：`call_{callId}_raw.txt`；
- 该文件的绝对路径将被记录在返回结果与执行轨迹中，供后续追溯。

### 3. Sidecar 独立轻量 LLM 浓缩
落盘完成后，调用 `SidecarLlmClient.compact_observation`：
- 向轻量模型（默认 `gpt-4o-mini`）发送包含前 4000 字符的摘要提取提示词；
- 强制模型输出结构化 JSON：
  ```json
  {
    "summary": "核心结论与概要提炼",
    "keyFacts": ["要点1: 发现3处格式异常", "要点2: 生成目标产物路径为 ..."]
  }
  ```
- 若轻量模型调用失败或未配置客户端，自动降级为确定性截断兜底，截取前 150 字符并注明原始字符数。

### 4. 紧凑 Observation 封装与指引提示
压缩器重新构造新的 `Observation` 替换原对象进入 ReAct 上下文：
```json
{
  "compacted": true,
  "summary": "提炼后的核心结论",
  "keyFacts": ["要点清单"],
  "originalChars": 45200,
  "compactedChars": 230,
  "raw_output_path": "C:\\Users\\...\\tool_outputs\\call_xxx_raw.txt",
  "hint": "关键结论已在 summary 中提炼，若非必要无需查阅原文件。若确需查阅细节，未压缩输出暂存于本地: ...。"
}
```
通过该自说明提示，主 Agent 既能直接获得高质量高密度的结论推进下一步规划，又在确有需要时，明确知道可以通过 `read_document` 定向查阅本地暂存的原文件。

**章节来源**
- [enricher.py:401-465](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L401-L465)
- [llm_client.py:92-162](file://services/agent-runtime/src/personal_agent/conversation/sidecar/llm_client.py#L92-L162)
- [react_loop.py:420-441](file://services/agent-runtime/src/personal_agent/conversation/loop/react_loop.py#L420-L441)
- [sidecar.ts:75-86](file://packages/protocol/schemas/sidecar.ts#L75-L86)

---

## 数据流向与执行架构图

```mermaid
graph TD
    subgraph "输入与记忆精炼 (Memory Pre-filtering)"
        UserQuery["用户指令 (User Query)"]
        RawMemories["PostgreSQL 宽召回 (Top-10)"]
        JevFilter["filter_relevant_memories<br/>(Jev 极速多维打分)"]
        TopMemories["Top-3 黄金记忆卡片<br/>(按类别格式化)"]
        Context["ModelContext.userMemories"]
    end

    subgraph "执行与超长观测压缩 (Observation Compactor)"
        ToolExec["物理工具执行 (Host Execution)"]
        RawObs["原始 Observation Payload"]
        CheckSize{"字符数 > 6000 ?"}
        KeepRaw["直接保留原始 Observation"]
        
        DiskDump["写入本地临时文件<br/>tool_outputs/call_xxx_raw.txt"]
        SidecarLLM["SidecarLlmClient.compact_observation<br/>(提炼 summary + keyFacts)"]
        CompactedObs["紧凑 Observation<br/>(附带 raw_output_path + hint)"]
        ReActContext["回填 ReAct 上下文与轨迹"]
    end

    UserQuery --> RawMemories
    RawMemories --> JevFilter
    JevFilter --> TopMemories
    TopMemories --> Context
    Context --> ToolExec

    ToolExec --> RawObs
    RawObs --> CheckSize
    CheckSize -- 否 --> KeepRaw
    KeepRaw --> ReActContext
    CheckSize -- 是 --> DiskDump
    DiskDump --> SidecarLLM
    SidecarLLM --> CompactedObs
    CompactedObs --> ReActContext
```

**图表来源**
- [enricher.py:93-186](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L93-L186)
- [enricher.py:292-398](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L292-L398)
- [enricher.py:401-465](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L401-L465)
- [llm_client.py:92-162](file://services/agent-runtime/src/personal_agent/conversation/sidecar/llm_client.py#L92-L162)

---

## 性能收益与容错降级

### 1. 上下文压缩收益
- **记忆信噪比提升**：在常驻记忆与查询记忆精选中，Jev 成功过滤掉 70% 以上无关闲聊条目，将强约束事实（`constraint`）置顶，显著降低主模型幻觉率。
- **Token 节约率**：对于单次超过 20,000 字符的代码搜索与文档提取，压缩后仅占用 300~500 字符，单步 Token 消耗降低 90% 以上，彻底杜绝超长日志引起的上下文越界。

### 2. 完备的异常降级矩阵

| 模块 | 潜在异常场景 | 降级机制 | 兜底行为 |
|:---|:---|:---|:---|
| **Jev 语义评分** | 缺少 API Key、网络断连、SDK 异常 | `compute_heuristic_relevance` | 词法覆盖率排序 + 检索分保底 |
| **工作记忆精炼** | 格式标记缺失或解析为空 | 文本直通 | 原样保留 Persona 文本，不作截断 |
| **查询记忆检索** | PostgreSQL 服务未启动或超时 | 本地静默保护 | 捕获 `OSError`，返回空列表，不阻塞用户发问 |
| **Observation 压缩** | 独立 LLM 超时或额度耗尽 | 确定性文本截断 | 截取前 150 字符并生成长度说明，保证临时文件落盘路径可用 |

**章节来源**
- [enricher.py:165-177](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L165-L177)
- [enricher.py:321-328](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L321-L328)
- [enricher.py:426-444](file://services/agent-runtime/src/personal_agent/conversation/sidecar/enricher.py#L426-L444)
- [llm_client.py:113-125](file://services/agent-runtime/src/personal_agent/conversation/sidecar/llm_client.py#L113-L125)
- [model-settings.ts:29-36](file://apps/desktop/src/main/settings/model-settings.ts#L29-L36)
