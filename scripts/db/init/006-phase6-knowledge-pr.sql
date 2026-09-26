-- scripts/db/init/006-phase6-knowledge-pr.sql
-- Phase 6: 知识更新机制与 PR 闭环 (三层分离架构落地)

-- 1. 原始证据层 (只增不改 Append-Only)
CREATE TABLE IF NOT EXISTS knowledge_evidence (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type     TEXT NOT NULL,         -- 'conversation_turn', 'tool_trajectory', 'document_excerpt'
    source_ref_id   TEXT NOT NULL,         -- task_id, conversation_id 或 document_id
    payload         JSONB NOT NULL,        -- 原始不可变文本与上下文快照
    occurred_at     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evidence_source ON knowledge_evidence(source_type, source_ref_id);

-- 2. 知识变更审核表 (PR 闭环管理)
CREATE TABLE IF NOT EXISTS knowledge_change_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title               TEXT NOT NULL,
    target_layer        TEXT NOT NULL,     -- 'user_memory', 'document_chunk', 'viking_wiki'
    diff_payload        JSONB NOT NULL,    -- 增/删/改的具体条目与 diff 细节
    evidence_ids        UUID[] NOT NULL,   -- 关联的原始证据 ID 数组
    proposer_model      TEXT NOT NULL,     -- 如 'deepseek-chat' 或 'claude-3-5-sonnet'
    reviewer_model      TEXT,              -- 如 'gpt-4o'
    review_comments     TEXT,              -- Reviewer 审查意见
    verdict             TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'revision_requested'
    iteration_count     INT NOT NULL DEFAULT 1,
    applied_at          TIMESTAMPTZ,       -- 合入并发布时间
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- 约束：verdict CHECK 约束 (守住 AGENTS.md 约定 4)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_kcr_verdict'
    ) THEN
        ALTER TABLE knowledge_change_requests
            ADD CONSTRAINT check_kcr_verdict
            CHECK (verdict IN ('pending', 'approved', 'rejected', 'revision_requested'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kcr_target ON knowledge_change_requests(target_layer, verdict);

-- 3. 知识层 user_memories 增加 PR 归属追溯
ALTER TABLE user_memories 
    ADD COLUMN IF NOT EXISTS origin_pr_id UUID REFERENCES knowledge_change_requests(id);
