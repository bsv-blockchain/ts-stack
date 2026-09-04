import argon2Api from 'hash-wasm/dist/argon2.umd.min.js'
import pbkdf2Api from 'hash-wasm/dist/pbkdf2.umd.min.js'
import sha256Api from 'hash-wasm/dist/sha256.umd.min.js'
import sha512Api from 'hash-wasm/dist/sha512.umd.min.js'
import { readyArgon2idBackend, validateArgon2idResult, type Argon2idOptions } from './Argon2idBackend'

type HashWasmArgon2idOptions = Parameters<typeof argon2Api.argon2id>[0]

interface PortableArgon2idBinaryOptions extends Argon2idOptions {
  outputType: 'binary'
  secret?: undefined
}

function isPortableArgon2idBinaryOptions(options: HashWasmArgon2idOptions): options is PortableArgon2idBinaryOptions {
  return (
    options.outputType === 'binary' &&
    options.secret === undefined &&
    options.password instanceof Uint8Array &&
    options.salt instanceof Uint8Array
  )
}

function isWebAssemblyUnavailable(error: unknown): boolean {
  if (globalThis.WebAssembly === undefined) return true
  const message = error instanceof Error ? error.message : String(error)
  return /webassembly.*(?:not supported|unavailable|disabled|compile|instantiate|module)/i.test(message)
}

/**
 * Preserves the complete hash-wasm Argon2id contract. Secret-free binary calls
 * with byte-array inputs may use a registered backend or an asynchronously
 * yielding JavaScript implementation when WebAssembly is unavailable.
 */
async function argon2idWithBackends(options: HashWasmArgon2idOptions): Promise<string | Uint8Array> {
  if (!isPortableArgon2idBinaryOptions(options)) {
    return await argon2Api.argon2id(options)
  }

  const backend = readyArgon2idBackend()
  if (backend !== undefined) {
    const result = await backend.deriveKey({
      password: options.password,
      salt: options.salt,
      iterations: options.iterations,
      parallelism: options.parallelism,
      memorySize: options.memorySize,
      hashLength: options.hashLength
    })
    return validateArgon2idResult(result, options.hashLength)
  }

  try {
    return await argon2Api.argon2id(options)
  } catch (error) {
    if (!isWebAssemblyUnavailable(error)) throw error
    const { argon2idAsync: argon2idJavaScript } = await import('@noble/hashes/argon2.js')
    return await argon2idJavaScript(options.password, options.salt, {
      t: options.iterations,
      m: options.memorySize,
      p: options.parallelism,
      dkLen: options.hashLength,
      asyncTick: 10
    })
  }
}

export const argon2id = argon2idWithBackends as typeof argon2Api.argon2id

export const pbkdf2 = pbkdf2Api.pbkdf2
export const createSHA256 = sha256Api.createSHA256
export const createSHA512 = sha512Api.createSHA512
