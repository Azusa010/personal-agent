-- scripts/db/init/004-memory-indexes.sql
-- Phase 5: 用户记忆表强化 (约束、实体消歧、访问强化统计、多维检索索引)

-- 1. 增加类型 CHECK 约束 (守住 AGENTS.md 约定 4)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_user_memories_type'
    ) THEN
        ALTER TABLE user_memories 
            ADD CONSTRAINT check_user_memories_type 
            CHECK (memory_type IN ('semantic', 'episodic', 'procedural'));
    END IF;
END $$;

-- 2. 补齐实体消歧、时间与强化统计字段
ALTER TABLE user_memories
    ADD COLUMN IF NOT EXISTS person TEXT,
    ADD COLUMN IF NOT EXISTS relationship TEXT,
    ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS supersede_reason TEXT,
    ADD COLUMN IF NOT EXISTS access_count INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS is_sanitized BOOLEAN DEFAULT FALSE;

-- 3. 升级全文检索向量 (覆盖 subject, person, backstory 及 content JSON)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user_memories' AND column_name = 'fts_vector'
    ) THEN
        DROP INDEX IF EXISTS idx_memories_fts;
        ALTER TABLE user_memories DROP COLUMN fts_vector;
        ALTER TABLE user_memories ADD COLUMN fts_vector tsvector
            GENERATED ALWAYS AS (
                to_tsvector('jiebacfg',
                    COALESCE(subject || ' ', '') ||
                    COALESCE(person || ' ', '') ||
                    COALESCE(backstory || ' ', '') ||
                    content::text
                )
            ) STORED;
        CREATE INDEX IF NOT EXISTS idx_memories_fts ON user_memories USING gin(fts_vector);
    END IF;
END $$;

-- 4. 增强多维消歧索引、常驻加速索引与版本追踪索引
CREATE INDEX IF NOT EXISTS idx_memories_active_fast
    ON user_memories (memory_type, category, confidence DESC)
    WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_person_rel
    ON user_memories (person, relationship)
    WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_occurred_at
    ON user_memories (occurred_at)
    WHERE occurred_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_superseded_by
    ON user_memories (superseded_by);
