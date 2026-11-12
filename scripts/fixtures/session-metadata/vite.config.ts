import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import webConfig from '../../../apps/webui/vite.config'

// Reuse the real browser aliases/shims and CSS pipeline, never the RPC proxy.
export default defineConfig({
  ...webConfig,
  root: __dirname,
  cacheDir: resolve(__dirname, '../../../node_modules/.vite-session-metadata'),
  build: { outDir: resolve(__dirname, '../../../.perf-preview/session-metadata') },
  server: { host: '127.0.0.1', port: 5187, strictPort: true, open: false, proxy: {},
    fs: { allow: [resolve(__dirname, '../../..'), dirname(realpathSync(resolve(__dirname, '../../../node_modules/react')))] } },
})
