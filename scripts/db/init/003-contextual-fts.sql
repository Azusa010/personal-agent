-- scripts/db/init/003-contextual-fts.sql
-- Phase 4 增量迁移：让 chunks 表的全文检索向量 (fts_vector) 同时覆盖 context_prefix 与 raw_text

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'chunks' AND column_name = 'fts_vector'
    ) THEN
        DROP INDEX IF EXISTS idx_chunks_fts;
        ALTER TABLE chunks DROP COLUMN fts_vector;
        ALTER TABLE chunks ADD COLUMN fts_vector tsvector
            GENERATED ALWAYS AS (
                to_tsvector('jiebacfg', COALESCE(context_prefix || E'\n\n', '') || raw_text)
            ) STORED;
        CREATE INDEX IF NOT EXISTS idx_chunks_fts ON chunks USING gin(fts_vector);
    END IF;
END $$;
