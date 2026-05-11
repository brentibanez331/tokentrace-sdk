import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  shims: true, // adds CJS shims (require, __dirname) to ESM build
  sourcemap: true,
})
