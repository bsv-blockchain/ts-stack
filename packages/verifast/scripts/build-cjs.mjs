import { mkdir, writeFile } from 'node:fs/promises'

const output = new URL('../dist/cjs/mod.cjs', import.meta.url)
const source = `'use strict'

const BdkErrorDomain = Object.freeze({
  0: 'OK', 1: 'SCRIPT', 2: 'DOS', 3: 'EXCEPTION',
  OK: 0, SCRIPT: 1, DOS: 2, EXCEPTION: 3
})
const BDK_FLAG_BITS = Object.freeze({
  P2SH: 1, STRICTENC: 2, DERSIG: 4, LOW_S: 8, NULLDUMMY: 16,
  SIGPUSHONLY: 32, MINIMALDATA: 64, DISCOURAGE_UPGRADABLE_NOPS: 128,
  CLEANSTACK: 256, CHECKLOCKTIMEVERIFY: 512, CHECKSEQUENCEVERIFY: 1024,
  MINIMALIF: 8192, NULLFAIL: 16384, COMPRESSED_PUBKEYTYPE: 32768,
  SIGHASH_FORKID: 65536, GENESIS: 262144, UTXO_AFTER_GENESIS: 524288,
  CHRONICLE: 1048576, UTXO_AFTER_CHRONICLE: 2097152
})

class BdkVerificationError extends Error {
  constructor (result) {
    super(\`BDK verification failed in domain \${result.domain} with code \${result.code}\`)
    this.name = 'BdkVerificationError'
    this.result = result
  }
}

function mapVerifyFlags (verifyFlags) {
  if (verifyFlags === undefined) return 0
  const names = Array.isArray(verifyFlags) ? verifyFlags : verifyFlags.split(',')
  let bits = 0
  for (const raw of names) {
    const name = raw.trim()
    if (name.length === 0) continue
    const bit = BDK_FLAG_BITS[name]
    if (bit === undefined) throw new Error(\`Unknown BDK verification flag: \${name}\`)
    bits |= bit
  }
  return bits
}

let esm
function load () {
  esm ||= import('../mod.js')
  return esm
}

function normalizeError (error) {
  if (error !== null && typeof error === 'object' && error.name === 'BdkVerificationError' && error.result !== undefined) {
    return new BdkVerificationError(error.result)
  }
  return error
}

class BdkVerifier {
  constructor (...args) {
    this.args = args
  }

  getInstance () {
    this.instance ||= load().then(({ BdkVerifier }) => new BdkVerifier(...this.args))
    return this.instance
  }
}

for (const method of [
  'verifyScriptsDetailed', 'verifyScriptsFromEFDetailed', 'verifyScripts',
  'verifyScriptsFromEF', 'verifyScriptsBatchDetailed',
  'verifyScriptsBatchFromEFDetailed', 'verifyScriptsBatch',
  'verifyScriptsBatchFromEF', 'verifySpendDetailed', 'verifySpend',
  'verifySpendsBatchDetailed', 'verifySpendsBatch'
]) {
  BdkVerifier.prototype[method] = function (...args) {
    return this.getInstance()
      .then(instance => instance[method](...args))
      .catch(error => { throw normalizeError(error) })
  }
}

module.exports = {
  BdkVerifier,
  BdkErrorDomain,
  BdkVerificationError,
  BDK_FLAG_BITS,
  mapVerifyFlags
}
`

await mkdir(new URL('../dist/cjs/', import.meta.url), { recursive: true })
await writeFile(output, source)
