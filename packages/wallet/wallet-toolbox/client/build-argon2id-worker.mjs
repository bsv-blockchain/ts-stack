import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build, stop } from 'esbuild'

const entry = fileURLToPath(new URL('./argon2id-worker.ts', import.meta.url))
const output = fileURLToPath(new URL('./out/argon2id-worker.mjs', import.meta.url))
try {
  // A worker cannot resolve the package's bare hash-wasm dependency itself.
  // Bundle the fixed entry and its audited implementation into one ESM asset.
  const result = await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent'
  })
  assert.equal(result.warnings.length, 0, 'Worker asset build warnings require review')
  assert.equal(result.outputFiles.length, 1, 'Worker asset must be self-contained')
  assert.equal(result.outputFiles[0].path, output)
  for (const artifact of Object.values(result.metafile.outputs))
    assert.equal(artifact.imports.length, 0, 'Worker asset cannot load external modules')
  await writeFile(output, result.outputFiles[0].contents)
} finally {
  await stop()
}
