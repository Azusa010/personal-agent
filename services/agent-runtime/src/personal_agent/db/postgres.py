"""PostgreSQL 异步连接池与 pgvector 扩展绑定。"""

import os
from typing import Any

import asyncpg
from pgvector.asyncpg import register_vector

_pool: asyncpg.Pool | None = None


def get_postgres_config() -> dict[str, Any]:
    """获取 PostgreSQL 连接参数。"""
    return {
        "host": os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        "port": int(os.environ.get("POSTGRES_PORT", "5432")),
        "database": os.environ.get("POSTGRES_DB", "personal_agent"),
        "user": os.environ.get("POSTGRES_USER", "pa_user"),
        "password": os.environ.get("POSTGRES_PASSWORD", "pa_dev_password"),
        "min_size": 1,
        "max_size": 10,
    }


async def _init_connection(conn: asyncpg.Connection) -> None:
    """每个连接初始化时注册 pgvector 编解码器。"""
    await register_vector(conn)


async def get_pg_pool() -> asyncpg.Pool:
    """获取或初始化全局 asyncpg 连接池。"""
    global _pool
    if _pool is None:
        cfg = get_postgres_config()
        _pool = await asyncpg.create_pool(
            host=cfg["host"],
            port=cfg["port"],
            database=cfg["database"],
            user=cfg["user"],
            password=cfg["password"],
            min_size=cfg["min_size"],
            max_size=cfg["max_size"],
            init=_init_connection,
        )
    return _pool


async def close_pg_pool() -> None:
    """关闭全局 asyncpg 连接池。"""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def check_pg_health() -> dict[str, Any]:
    """检查数据库连接、版本以及扩展状态。"""
    try:
        pool = await get_pg_pool()
        async with pool.acquire() as conn:
            version = await conn.fetchval("SELECT version()")
            ext_records = await conn.fetch("SELECT extname FROM pg_extension")
            extensions = [r["extname"] for r in ext_records]
            return {
                "ok": True,
                "version": version,
                "extensions": extensions,
            }
    except (asyncpg.PostgresError, OSError, ConnectionError, TimeoutError) as exc:
        return {
            "ok": False,
            "error": str(exc),
        }
