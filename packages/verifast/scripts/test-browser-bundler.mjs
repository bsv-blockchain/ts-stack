import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rspack } from '@rspack/core'

const outputPath = await mkdtemp(join(tmpdir(), 'verifast-rspack-'))
try {
  await new Promise((resolve, reject) => {
    rspack({
      mode: 'production',
      target: 'web',
      entry: fileURLToPath(new URL('../dist/mod.browser.js', import.meta.url)),
      output: {
        path: outputPath,
        filename: 'consumer.js'
      }
    }, (error, stats) => {
      if (error != null) {
        reject(error)
        return
      }
      if (stats === undefined || stats.hasErrors()) {
        reject(new Error(stats?.toString({ all: false, errors: true }) ?? 'Rspack returned no build result'))
        return
      }
      resolve()
    })
  })
  console.log('ok - browser package export production-bundler build')
} finally {
  await rm(outputPath, { recursive: true, force: true })
}
