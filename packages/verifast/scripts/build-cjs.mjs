import { mkdir, readFile, writeFile } from 'node:fs/promises'

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
  if (esm === undefined) {
    const loading = import('../mod.js')
    esm = loading
    void loading.catch(() => {
      if (esm === loading) esm = undefined
    })
  }
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
    const options = typeof args[0] === 'function' ? (args[1] || {}) : (args[0] || {})
    this.mode = options.mode || 'auto'
    this.registeredAsDefault = options.registerAsDefault ?? true
    this.disposed = false
    if (this.mode !== 'auto' && this.mode !== 'always') {
      throw new RangeError("mode must be either 'auto' or 'always'")
    }
    const scriptByteThreshold = options.scriptByteThreshold ?? 100
    if (!Number.isSafeInteger(scriptByteThreshold) || scriptByteThreshold < 0) {
      throw new RangeError('scriptByteThreshold must be a non-negative safe integer')
    }
    if (this.registeredAsDefault) {
      globalThis.__bsvSdkAsyncCryptoBackendV1 = this
      globalThis.__bsvSdkScriptVerificationBackendV1 = this
    }
  }

  getInstance () {
    if (this.disposed) return Promise.reject(new Error('BDK verifier has been disposed'))
    if (this.instance === undefined) {
      const loading = load().then(({ BdkVerifier }) => {
        if (this.disposed) throw new Error('BDK verifier has been disposed')
        this.resolvedInstance = new BdkVerifier(...this.args)
        return this.resolvedInstance
      })
      this.instance = loading
      void loading.catch(() => {
        if (this.instance === loading) this.instance = undefined
      })
    }
    return this.instance
  }

  preload () {
    return this.getInstance().then(instance => instance.preload())
  }

  preloadBatch () {
    return this.getInstance().then(instance => instance.preloadBatch())
  }

  isReady () {
    return this.resolvedInstance?.isReady() || false
  }

  supportsCrypto (operation) {
    return this.resolvedInstance?.supportsCrypto(operation) || false
  }

  verifySpendSync (...args) {
    if (this.resolvedInstance === undefined) {
      throw new Error('Synchronous Spend verification requires a preloaded BDK module')
    }
    return this.resolvedInstance.verifySpendSync(...args)
  }

  dispose () {
    if (this.disposed) return
    this.disposed = true
    this.resolvedInstance?.dispose()
    this.resolvedInstance = undefined
    this.instance = undefined
    if (globalThis.__bsvSdkAsyncCryptoBackendV1 === this) {
      delete globalThis.__bsvSdkAsyncCryptoBackendV1
    }
    if (globalThis.__bsvSdkScriptVerificationBackendV1 === this) {
      delete globalThis.__bsvSdkScriptVerificationBackendV1
    }
  }

  schedulePreparation (prepare) {
    if (this.disposed || this.resolvedInstance !== undefined || this.instance !== undefined || this.preparationScheduled) return
    this.preparationScheduled = true
    setTimeout(() => {
      this.preparationScheduled = false
      void this.getInstance().then(prepare).catch(() => {})
    }, 0)
  }

  shouldVerifyScripts (params) {
    if (this.disposed) return false
    if (this.mode === 'always') return true
    if (this.resolvedInstance !== undefined) return this.resolvedInstance.shouldVerifyScripts(params)
    this.schedulePreparation(instance => { instance.shouldVerifyScripts(params) })
    return false
  }

  shouldVerifySpend (spend) {
    if (this.disposed) return false
    if (this.mode === 'always') return true
    if (this.resolvedInstance !== undefined) return this.resolvedInstance.shouldVerifySpend(spend)
    this.schedulePreparation(instance => { instance.shouldVerifySpend(spend) })
    return false
  }
}

for (const method of [
  'verifyScriptsDetailed', 'verifyScriptsFromEFDetailed', 'verifyScripts',
  'verifyScriptsFromEF', 'verifyScriptsBatchDetailed',
  'verifyScriptsBatchFromEFDetailed', 'verifyScriptsBatch',
  'verifyScriptsBatchFromEF', 'verifySpendDetailed', 'verifySpend',
  'verifySpendsBatchDetailed', 'verifySpendsBatch', 'signDigest',
  'verifyDigest', 'verifyDigestBatch', 'publicKeyFromPrivate',
  'multiplyPublicKey', 'tweakPublicKeyAdd', 'tweakPrivateKeyAdd'
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
await Promise.all(
  ['mod', 'umd'].map(async entry => {
    const declaration = await readFile(new URL(`../dist/${entry}.d.ts`, import.meta.url), 'utf8')
    await writeFile(new URL(`../dist/${entry}.d.cts`, import.meta.url), declaration)
  })
)
