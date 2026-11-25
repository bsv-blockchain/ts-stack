import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => ({
  server: {
    host: '::',
    port: 8080
  },
  build: {
    commonjsOptions: { include: [/node_modules/, /packages\/ui\/[^/]+\/(?:dist|out)\//] },
    outDir: 'build'
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
}))
