// Check the advertised CommonJS leaf from both CommonJS and ESM consumers.
import hashWasm = require('@bsv/wallet-toolbox/out/src/utility/hashWasm')

type IsAny<T> = 0 extends 1 & T ? true : false
const hasImplicitAny: IsAny<typeof hashWasm.argon2id> = false
const original: typeof import('hash-wasm').argon2id = hashWasm.argon2id
const binary: Promise<Uint8Array> = hashWasm.argon2id({
  password: new Uint8Array([1]),
  salt: new Uint8Array(16),
  iterations: 1,
  parallelism: 1,
  memorySize: 8,
  hashLength: 32,
  outputType: 'binary'
})
const encoded: Promise<string> = hashWasm.argon2id({
  password: 'synthetic',
  salt: 'synthetic-salt',
  iterations: 1,
  parallelism: 1,
  memorySize: 8,
  hashLength: 32,
  outputType: 'encoded'
})
export { hasImplicitAny, original, binary, encoded }
