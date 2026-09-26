-- scripts/db/init/005-memory-tiered-storage.sql
-- Phase 5 Sub-task 5.3: 分级存储改造 (Simple Notes 与 Advanced Cards 双轨并存)

-- 1. 扩充字段：entry_format, title, note_text, tags
ALTER TABLE user_memories
    ADD COLUMN IF NOT EXISTS entry_format TEXT NOT NULL DEFAULT 'card',
    ADD COLUMN IF NOT EXISTS title TEXT,
    ADD COLUMN IF NOT EXISTS note_text TEXT,
    ADD COLUMN IF NOT EXISTS tags TEXT[];

-- 2. 增加 entry_format CHECK 约束 (守住 AGENTS.md 约定 4)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_user_memories_format'
    ) THEN
        ALTER TABLE user_memories 
            ADD CONSTRAINT check_user_memories_format 
            CHECK (entry_format IN ('card', 'note'));
    END IF;
END $$;

-- 3. 升级全文检索向量 (覆盖 subject, person, title, note_text, backstory 及 content JSON)
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
                    COALESCE(title || ' ', '') ||
                    COALESCE(note_text || ' ', '') ||
                    COALESCE(backstory || ' ', '') ||
                    COALESCE(content::text, '')
                )
            ) STORED;
        CREATE INDEX IF NOT EXISTS idx_memories_fts ON user_memories USING gin(fts_vector);
    END IF;
END $$;

-- 4. 增加针对 entry_format 的索引
CREATE INDEX IF NOT EXISTS idx_memories_format_active
    ON user_memories (entry_format, confidence DESC)
    WHERE superseded_by IS NULL;
