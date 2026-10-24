import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@personal-agent/protocol': resolve('../../packages/protocol/schemas/index.ts'),
      // 组件测试（如 ErrorLogPanel）会 import 真组件，其内部经 @renderer/lib/utils 引 cn。
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    // environment 保持 node：renderer 侧目前只测 view-model.ts，它不 import react，
    // 也不需要 DOM。真要测组件再换 jsdom，那时才值得把依赖装进来。
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/main/e2e/golden-path.test.ts',
      'tests/main/e2e/failure-regression.test.ts',
      'tests/main/eval/**'
    ],
    testTimeout: 15000,
    // E2E 用例在 beforeAll 里 spawn 真实 Python 子进程，全量并行跑时 CPU 竞争会
    // 把冷启动从 ~9s 拖到 15s 以上。hook 时限放宽到 30s，避免门禁随机飘红。
    hookTimeout: 30000
  }
})
