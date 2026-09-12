import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@personal-agent/protocol': resolve('../../packages/protocol/schemas/index.ts')
    }
  },
  test: {
    // environment 保持 node：renderer 侧目前只测 view-model.ts，它不 import react，
    // 也不需要 DOM。真要测组件再换 jsdom，那时才值得把依赖装进来。
    environment: 'node',
    include: ['src/main/**/*.test.ts', 'src/renderer/src/**/*.test.ts']
  }
})
