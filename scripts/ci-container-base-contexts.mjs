import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const referencePattern = /^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/
const digestPattern = /^sha256:[a-f0-9]{64}$/

/** Select another governed transport for the identical immutable base image. */
export function containerBaseContexts(registry) {
  assert.equal(registry?.schemaVersion, 1, 'unsupported container registry schema')
  assert.equal(registry.platform, 'linux/amd64', 'unsupported container platform')
  assert.ok(Array.isArray(registry.baseImages) && registry.baseImages.length > 0)
  const contexts = new Map()
  for (const base of registry.baseImages) {
    assert.match(base.digest, digestPattern, 'base digest must be immutable')
    assert.match(base.discoveryReference, referencePattern, 'invalid canonical reference')
    assert.ok(Array.isArray(base.references) && base.references.length > 0)
    assert.equal(new Set(base.references).size, base.references.length, 'duplicate base reference')
    assert.ok(
      base.references.includes(base.discoveryReference),
      'canonical reference is not governed'
    )
    for (const reference of base.references) {
      assert.match(reference, referencePattern, 'invalid governed reference')
      if (reference === base.discoveryReference) continue
      const name = `${reference}@${base.digest}`
      assert.ok(!contexts.has(name), 'duplicate base context')
      contexts.set(name, `docker-image://${base.discoveryReference}@${base.digest}`)
    }
  }
  return [...contexts].map(([name, source]) => `${name}=${source}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const arguments_ = process.argv.slice(2)
    assert.ok(
      arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === '--github-output'),
      'Use ci-container-base-contexts.mjs [--github-output]'
    )
    const registry = JSON.parse(
      readFileSync(new URL('../governance/container-images.json', import.meta.url), 'utf8')
    )
    const contexts = containerBaseContexts(registry).join('\n')
    if (arguments_.length === 0) console.log(contexts)
    else {
      assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required')
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `contexts<<CI_PINNED_BASE_CONTEXTS\n${contexts}\nCI_PINNED_BASE_CONTEXTS\n`
      )
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
