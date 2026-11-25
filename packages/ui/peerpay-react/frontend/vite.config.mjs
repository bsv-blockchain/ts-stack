import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    commonjsOptions: { include: [/node_modules/, /packages\/ui\/[^/]+\/(?:dist|out)\//] },
    outDir: 'build'
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true
  }
})
