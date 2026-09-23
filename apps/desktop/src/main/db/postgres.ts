import { Pool, PoolConfig } from 'pg'

export interface PostgresConfig {
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  max?: number
  idleTimeoutMillis?: number
  connectionTimeoutMillis?: number
}

export function getDefaultPostgresConfig(): PoolConfig {
  return {
    host: process.env.POSTGRES_HOST || '127.0.0.1',
    port: process.env.POSTGRES_PORT ? Number(process.env.POSTGRES_PORT) : 5432,
    database: process.env.POSTGRES_DB || 'personal_agent',
    user: process.env.POSTGRES_USER || 'pa_user',
    password: process.env.POSTGRES_PASSWORD || 'pa_dev_password',
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  }
}

let pool: Pool | null = null

export function getPgPool(configOverride?: PoolConfig): Pool {
  if (!pool) {
    const config = configOverride || getDefaultPostgresConfig()
    pool = new Pool(config)
    pool.on('error', (err) => {
      console.error('[pg-pool] Unexpected error on idle client:', err)
    })
  }
  return pool
}

export async function closePgPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

export interface PgHealthResult {
  ok: boolean
  version?: string
  extensions?: string[]
  error?: string
}

export async function checkPgHealth(poolInstance?: Pool): Promise<PgHealthResult> {
  const p = poolInstance || getPgPool()
  try {
    const versionRes = await p.query<{ version: string }>('SELECT version()')
    const extRes = await p.query<{ extname: string }>('SELECT extname FROM pg_extension')
    return {
      ok: true,
      version: versionRes.rows[0]?.version,
      extensions: extRes.rows.map((r) => r.extname)
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
