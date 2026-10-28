import { promiseFromSync } from '../../utility/promiseFromSync'
import { BrowserArgon2idWorkerBackend } from '../../utility/BrowserArgon2idWorker'
import {
  registerArgon2idBackend,
  unregisterArgon2idBackend,
  type AsyncArgon2idBackend
} from '../../utility/Argon2idBackend'
import {
  encryptBrc39BrowserStreamToQuarantine,
  type Brc39BrowserStreamPlaintext,
  type Brc39BrowserEncryptOptions
} from './Brc39StreamBrowser'
import { decryptBRC39 } from './index'
import { semanticStageFixture } from './Brc38SemanticStageFixture'

function selected(): Brc39BrowserEncryptOptions {
  return {
    policy: {
      maximumFileBytes: 1048576,
      maximumChunkBytes: 4096,
      maximumIterations: 7,
      maximumMemoryKiB: 131072,
      maximumParallelism: 1
    },
    maximumPasswordBytes: 1024,
    maximumPlaintextBytes: 1048576,
    maximumCryptoAllocationBytes: 262144,
    expiresAt: Date.now() + 120000,
    maximumKdfMilliseconds: 30000,
    cleanupMilliseconds: 30000
  }
}
function source(bytes: Uint8Array, width: number): Brc39BrowserStreamPlaintext {
  return {
    chunks: (async function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += width)
        yield Promise.resolve(bytes.subarray(offset, Math.min(bytes.byteLength, offset + width)))
    })(),
    validateCompleted: async () => {},
    close: async () => {}
  }
}
function output() {
  const parts: Uint8Array[] = []
  let discarded = 0
  return {
    parts,
    get discarded() {
      return discarded
    },
    appendUntrusted: (bytes: Uint8Array) => {
      return promiseFromSync(() => {
        parts.push(bytes.slice())
      })
    },
    discard: () => {
      return promiseFromSync(() => {
        for (const bytes of parts) bytes.fill(0)
        parts.length = 0
        discarded++
      })
    }
  }
}
function join(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}
// Authored UNRUN. Production worker KDF + incremental native crypto must match
// the existing complete materialized decoder. Its oracle materialization is
// limited to this small synthetic document and is not a production heap claim.
export async function verifyBrowserStreamExportIndependentLegacyDecoder(factory: () => Worker): Promise<void> {
  const backend = new BrowserArgon2idWorkerBackend(factory, {
      maximumPasswordBytes: 1024,
      maximumIterations: 7,
      maximumMemoryKiB: 131072,
      maximumParallelism: 1,
      maximumMilliseconds: 30000
    }),
    data = semanticStageFixture(),
    plaintext = new TextEncoder().encode(JSON.stringify(data))
  try {
    for (const width of [1, 15, 16, 17, 97, 4096]) {
      await backend.preload()
      registerArgon2idBackend(backend)
      const sink = output(),
        progress: { fileBytes: number; plaintextBytes: number }[] = [],
        original = source(plaintext, width)
      let validated = false,
        closed = false
      original.validateCompleted = () => {
        return promiseFromSync(() => {
          validated = true
        })
      }
      original.close = () => {
        return promiseFromSync(() => {
          if (!validated || join(sink.parts).byteLength !== 97 + plaintext.byteLength)
            throw new Error('Browser source close occurred without semantics or before complete ciphertext')
          closed = true
        })
      }
      const result = await encryptBrc39BrowserStreamToQuarantine(original, 'Cafe\u0301', sink, {
        ...selected(),
        onProgress: value => {
          if (!Object.isFrozen(value)) throw new Error('Progress was not detached')
          progress.push(value)
        }
      })
      unregisterArgon2idBackend(backend)
      const encrypted = join(sink.parts)
      try {
        const decoded = await decryptBRC39(encrypted, 'Caf\u00e9')
        if (
          JSON.stringify(decoded) !== JSON.stringify(data) ||
          !closed ||
          sink.discarded !== 0 ||
          result.fileBytes !== plaintext.byteLength + 113 ||
          result.plaintextBytes !== plaintext.byteLength ||
          progress.at(-1)?.fileBytes !== encrypted.byteLength ||
          sink.parts.some(part => part.byteLength > 4096)
        )
          throw new Error('Browser streaming export differs from legacy NFC/closure/extent/lifecycle oracle')
      } finally {
        encrypted.fill(0)
        for (const part of sink.parts) part.fill(0)
      }
    }
  } finally {
    plaintext.fill(0)
    unregisterArgon2idBackend(backend)
    await backend.retryCleanup()
    await backend.close()
  }
}
export async function verifyBrowserStreamExportSemanticFailureAndCancellation(): Promise<void> {
  const data = semanticStageFixture(),
    plaintext = new TextEncoder().encode(JSON.stringify(data)),
    backend: AsyncArgon2idBackend = {
      preload: async () => {},
      isReady: () => true,
      deriveKey: () => promiseFromSync(() => new Uint8Array(32).fill(79))
    }
  registerArgon2idBackend(backend)
  try {
    for (const mode of ['semantic', 'source-close', 'cancel', 'byte-cap', 'kdf-strength']) {
      const sink = output(),
        original = source(plaintext, 97),
        signal = new AbortController(),
        reason = new Error(mode)
      if (mode === 'semantic')
        original.validateCompleted = () => {
          return promiseFromSync(() => {
            throw reason
          })
        }
      if (mode === 'source-close') {
        let first = true
        original.close = () => {
          return promiseFromSync(() => {
            if (first) {
              first = false
              throw reason
            }
          })
        }
      }
      const options = {
        ...selected(),
        signal: signal.signal,
        ...(mode === 'byte-cap' ? { maximumPlaintextBytes: plaintext.byteLength - 1 } : {}),
        ...(mode === 'kdf-strength' ? { kdf: { iterations: 6, memoryKiB: 131072, parallelism: 1 } } : {}),
        onProgress: () => {
          if (mode === 'cancel') signal.abort(reason)
        }
      }
      let caught: unknown
      try {
        await encryptBrc39BrowserStreamToQuarantine(original, 'private', sink, options)
      } catch (cause) {
        caught = cause
      }
      if (
        caught === undefined ||
        sink.discarded !== 1 ||
        sink.parts.length !== 0 ||
        (['semantic', 'source-close', 'cancel'].includes(mode) && caught !== reason)
      )
        throw new Error('Browser export did not discard failed output or preserve exact cause')
    }
  } finally {
    plaintext.fill(0)
    unregisterArgon2idBackend(backend)
  }
}
