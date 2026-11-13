import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  test: {
    globalSetup: [
      fileURLToPath(
        new URL(
          '../../packages/overlays/overlay/src/__tests/mongo/MongoReplicaFixture.ts',
          import.meta.url
        )
      )
    ]
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        proposal: fileURLToPath(new URL('./proposal.html', import.meta.url))
      }
    }
  }
})
