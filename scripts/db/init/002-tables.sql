-- 文档元数据
CREATE TABLE IF NOT EXISTS documents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_path   TEXT NOT NULL UNIQUE,
    file_name     TEXT NOT NULL,
    file_type     TEXT NOT NULL,          -- 'pdf', 'markdown', 'txt'
    file_size     BIGINT,
    file_hash     TEXT,                   -- 内容哈希，判断是否需要重新索引
    parsed_at     TIMESTAMPTZ,
    page_count    INT,
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

-- 文档分块
CREATE TABLE IF NOT EXISTS chunks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id    UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index    INT NOT NULL,
    page_numbers   INT[],                  -- 来源页码（溯源用）
    heading_path   TEXT,                   -- 标题层级路径，如 "第3章/3.2节/定义"
    raw_text       TEXT NOT NULL,          -- 原始分块文本
    context_prefix TEXT,                  -- 上下文感知前缀（Phase 4 填充）
    dense_embedding vector(1024),         -- bge-m3 稠密向量
    sparse_vector  JSONB,                 -- bge-m3 稀疏向量 {term_id: weight}
    fts_vector     tsvector               -- PostgreSQL 全文检索向量 (覆盖上下文前缀与正文)
        GENERATED ALWAYS AS (to_tsvector('jiebacfg', COALESCE(context_prefix || E'\n\n', '') || raw_text)) STORED,
    token_count    INT,
    created_at     TIMESTAMPTZ DEFAULT now()
);

-- 向量索引 (HNSW)
CREATE INDEX IF NOT EXISTS idx_chunks_dense ON chunks
    USING hnsw (dense_embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- 全文检索索引
CREATE INDEX IF NOT EXISTS idx_chunks_fts ON chunks USING gin(fts_vector);

-- 复合索引
CREATE INDEX IF NOT EXISTS idx_chunks_doc_index ON chunks(document_id, chunk_index);

-- 用户记忆（Phase 5 使用）
CREATE TABLE IF NOT EXISTS user_memories (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_type    TEXT NOT NULL,          -- 'semantic', 'episodic', 'procedural'
    category       TEXT,                   -- 'preference', 'identity', 'relationship'
    subject        TEXT,
    content        JSONB NOT NULL,         -- Advanced JSON Card 结构
    backstory      TEXT,                   -- 信息来源叙事
    source_task_id TEXT,                  -- 来源任务 ID
    confidence     REAL DEFAULT 1.0,
    valid_from     TIMESTAMPTZ DEFAULT now(),
    superseded_by  UUID REFERENCES user_memories(id),
    dense_embedding vector(1024),
    fts_vector     tsvector
        GENERATED ALWAYS AS (to_tsvector('jiebacfg', content::text)) STORED,
    created_at     TIMESTAMPTZ DEFAULT now(),
    updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memories_dense ON user_memories
    USING hnsw (dense_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_memories_fts ON user_memories USING gin(fts_vector);
