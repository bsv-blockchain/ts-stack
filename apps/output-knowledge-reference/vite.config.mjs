import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        proposal: fileURLToPath(new URL('./proposal.html', import.meta.url))
      }
    }
  }
})
