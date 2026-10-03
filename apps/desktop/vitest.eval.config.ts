import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

/**
 * eval 专用的 vitest 配置。
 *
 * 默认配置（vitest.config.ts）把 tests/main/eval 排除在外——`pnpm test:ts` 不该
 * 每次 verify 都起 25 个真 Python 子进程。eval 套件只从 `pnpm eval` /
 * `pnpm eval:live` 进，而那两个脚本指定这份配置：include 反过来只收 eval 目录，
 * 超时放宽到分钟级（25 条 case 一条一个子进程，机器慢时 15 秒默认值不够）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@personal-agent/protocol': resolve('../../packages/protocol/schemas/index.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/main/eval/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 300_000,
    hookTimeout: 300_000
  }
})
