import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@personal-agent/protocol': resolve('../../packages/protocol/schemas/index.ts')
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@personal-agent/protocol': resolve('../../packages/protocol/schemas/index.ts')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@personal-agent/protocol': resolve('../../packages/protocol/schemas/index.ts')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
