-- 启用 pgvector 向量扩展与 pg_jieba 中文分词扩展
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_jieba;

-- 创建中文全文检索配置 jiebacfg 并绑定词性映射
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_ts_config WHERE cfgname = 'jiebacfg'
    ) THEN
        CREATE TEXT SEARCH CONFIGURATION jiebacfg (PARSER = jieba);
        ALTER TEXT SEARCH CONFIGURATION jiebacfg
            ADD MAPPING FOR n,v,a,i,e,l,j WITH simple;
    END IF;
END $$;
