#!/usr/bin/env node
// Development-only interoperability check: every BRC-206 signature vector, as produced by this
// package's built module, verifies under the `verifyRabinSig` sequence that the Rúnar compiler
// emits, executed in Rúnar's Script VM. Rúnar is not a dependency of this package, so the check
// skips (exit 0) unless RUNAR_NODE_MODULES names a node_modules directory containing
// runar-compiler, runar-lang and runar-testing.
//
//   RUNAR_NODE_MODULES=/path/to/node_modules pnpm test:runar
// The package is built only when the check actually runs.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CachedKeyDeriver, PrivateKey } from '@bsv/sdk'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const runarModules = process.env.RUNAR_NODE_MODULES
if (runarModules === undefined || runarModules === '' || !existsSync(runarModules)) {
  console.log(
    'verify-runar: skipped: RUNAR_NODE_MODULES is not set to a node_modules directory containing Rúnar'
  )
  process.exit(0)
}
// Build only once Rúnar is known to be available, so a skipped run costs nothing. The package's
// build script is run with this Node binary and tsdown's resolved entry point, so no executable
// is looked up on PATH.
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const [tool, ...buildArgs] = manifest.scripts.build.split(' ')
const requireFromPackage = createRequire(join(packageRoot, 'package.json'))
const toolManifestPath = requireFromPackage.resolve(`${tool}/package.json`)
const toolManifest = JSON.parse(readFileSync(toolManifestPath, 'utf8'))
const toolBin = typeof toolManifest.bin === 'string' ? toolManifest.bin : toolManifest.bin[tool]
const build = spawnSync(
  process.execPath,
  [join(dirname(toolManifestPath), toolBin), ...buildArgs],
  {
    cwd: packageRoot,
    stdio: 'inherit'
  }
)
if (build.status !== 0) {
  console.error('verify-runar: build failed')
  process.exit(1)
}
const distEntry = join(packageRoot, 'dist/index.mjs')

const requireFromRunar = createRequire(join(runarModules, 'noop.js'))
const load = async specifier =>
  await import(pathToFileURL(requireFromRunar.resolve(specifier)).href)
const { compile } = await load('runar-compiler')
const { TestSmartContract, expectScriptSuccess, expectScriptFailure } = await load(
  'runar-testing/dist/helpers.js'
)
const { RabinPermissionModule, decodeFields, scriptNum, scriptNumToBigInt } = await import(
  pathToFileURL(distEntry).href
)

const vectors = JSON.parse(
  readFileSync(join(packageRoot, 'src/__tests__/fixtures/brc206-vectors.json'), 'utf8')
)
const source = readFileSync(join(packageRoot, 'scripts/RabinCheck.runar.ts'), 'utf8')
const compiled = compile(source, { fileName: 'RabinCheck.runar.ts' })
if (!compiled.success) {
  console.error(compiled.diagnostics)
  process.exit(1)
}
const artifact = compiled.artifact
// runar-testing 1.0's argument encoder has no case for the Rabin types; both are Script numbers.
const retype = params =>
  params.forEach(param => {
    if (param.type === 'RabinSig' || param.type === 'RabinPubKey') param.type = 'bigint'
  })
retype(artifact.abi.constructor.params)
artifact.abi.methods.forEach(method => retype(method.params))

const hex = bytes => Buffer.from(bytes).toString('hex')
const fromHex = value => Array.from(Buffer.from(value, 'hex'))
const rabin = new RabinPermissionModule({
  keyDeriver: new CachedKeyDeriver(PrivateKey.fromHex(vectors.parameters.walletA)),
  authorize: async () => true
})
const encrypt = async args =>
  await rabin.handleRequest({ method: 'encrypt', args, originator: 'runar.check' }, async () => {
    throw new Error('unexpected underlying call')
  })

// Ask the module for every key and signature first (it schedules them itself), then check each
// against the Script VM.
const results = await Promise.all(
  vectors.signatures.map(async vector => {
    const keyVector = vectors.keys.find(candidate => candidate.name === vector.keyVector)
    const [keyResult, signResult] = await Promise.all([
      encrypt({ ...keyVector.request, plaintext: [] }),
      encrypt({ ...vector.request, plaintext: fromHex(vector.request.plaintext) })
    ])
    return { vector, keyResult, signResult }
  })
)

let passed = 0
for (const { vector, keyResult, signResult } of results) {
  if (hex(signResult.ciphertext) !== vector.response.ciphertext) {
    throw new Error(`${vector.name}: module output differs from the vector`)
  }
  const [nBytes] = decodeFields(keyResult.ciphertext)
  const [sigBytes, paddingBytes] = decodeFields(signResult.ciphertext)
  const n = scriptNumToBigInt(nBytes)
  const sig = scriptNumToBigInt(sigBytes)
  const padding = hex(paddingBytes)
  const contract = TestSmartContract.fromArtifact(artifact, [n], {
    maxOps: 10_000_000,
    maxStackSize: 100_000
  })

  // The VM's own pushes of n and sig are the module's field bytes.
  if (!contract.getLockingScriptHex().includes(hex(nBytes))) {
    throw new Error(`${vector.name}: locking script does not embed the key field`)
  }
  const unlocking = hex(contract.buildUnlockingScript('check', [vector.message.hex, sig, padding]))
  if (!unlocking.includes(hex(sigBytes))) {
    throw new Error(`${vector.name}: VM sig push differs from the sig field`)
  }

  expectScriptSuccess(contract.call('check', [vector.message.hex, sig, padding]))
  expectScriptFailure(contract.call('check', [`${vector.message.hex}00`, sig, padding]))
  expectScriptFailure(contract.call('check', [vector.message.hex, sig + 1n, padding]))
  const paddingPlusOne = hex(scriptNum(scriptNumToBigInt(paddingBytes) + 1n))
  expectScriptFailure(contract.call('check', [vector.message.hex, sig, paddingPlusOne]))
  const forgedPadding = hex(scriptNum(BigInt(vector.message.h)))
  expectScriptFailure(contract.call('check', [vector.message.hex, 0n, forgedPadding]))
  passed++
  console.log(`verify-runar: ${vector.name} ok (unlocking ${unlocking.length / 2} bytes)`)
}
console.log(`verify-runar: all ${passed} signature vectors verify under Rúnar verifyRabinSig`)
