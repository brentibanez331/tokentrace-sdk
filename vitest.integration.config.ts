import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/__tests__/integration/**/*.ts'],
    env: loadEnv(mode, process.cwd(), ''),
  },
}))
