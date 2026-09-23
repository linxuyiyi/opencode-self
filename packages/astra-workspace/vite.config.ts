import { defineConfig } from 'vite'
import opencode from '../app/vite.js'

export default defineConfig({
  base: '/opencode-workspace/1.2.27/',
  plugins: [opencode],
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  build: { target: 'esnext', outDir: 'dist', emptyOutDir: true },
})
