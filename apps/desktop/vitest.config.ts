import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@personal-agent/protocol': resolve('../../packages/protocol/schemas/index.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts']
  }
})
