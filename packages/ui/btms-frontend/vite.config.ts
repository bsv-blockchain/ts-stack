import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  server: {
    host: '::',
    port: 8080
  },
  build: {
    commonjsOptions: {
      // Linked workspace packages resolve outside node_modules, including SDK entries used by UI CJS.
      include: [
        /node_modules/,
        /packages\/(?:[^/]+\/)*dist\/cjs\//,
        /packages\/ui\/[^/]+\/(?:dist|out)\//
      ]
    },
    outDir: 'build'
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src')
    }
  }
})
