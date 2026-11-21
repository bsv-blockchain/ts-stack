import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sources = ['property-test-batches.cjs', 'property-test-batches.d.cts']
// Mutation sandboxes copy the owning package. Keep the same test stand inside
// each package so isolated test roots do not resolve an unrelated checkout.
const packagePaths = [
  'packages/application/output-knowledge',
  'packages/content/lch',
  'packages/overlays/eqc',
  'packages/overlays/overlay',
  'packages/overlays/overlay-express',
  'packages/sdk',
  'packages/wallet/wallet-toolbox'
]

export function syncPropertyTestBatches({ check = false, directory = root } = {}) {
  for (const basename of sources) {
    const source = `config/testing/${basename}`
    const expected = `// Generated from ${source}. Run node scripts/sync-property-test-batches.mjs.\n\n${readFileSync(join(directory, source), 'utf8')}`
    for (const packagePath of packagePaths) {
      const relative = join(packagePath, 'test/utils', basename)
      const filename = join(directory, relative)
      if (check) {
        if (readFileSync(filename, 'utf8') !== expected)
          throw new Error(`Stale property test stand: ${relative}`)
      } else {
        mkdirSync(dirname(filename), { recursive: true })
        writeFileSync(filename, expected)
      }
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node scripts/sync-property-test-batches.mjs [--check]')
  }
  syncPropertyTestBatches({ check: args.length === 1 })
}
