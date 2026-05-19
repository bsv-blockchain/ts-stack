import { createHash, createHmac } from 'node:crypto'
import {
  hash160,
  hash256,
  ripemd160,
  sha256,
  sha256hmac,
  sha512,
  sha512hmac
} from '../dist/esm/src/primitives/Hash.js'
import { runBenchmark } from './lib/benchmark-runner.js'

function bytes (len, seed = 1) {
  const out = new Uint8Array(len)
  let x = seed >>> 0
  for (let i = 0; i < len; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    out[i] = x & 0xff
  }
  return out
}

const oneMiB = bytes(1024 * 1024, 11)
const sixteenMiB = bytes(16 * 1024 * 1024, 12)
const oneMiBArray = Array.from(oneMiB)
const key = bytes(32, 13)
const keyArray = Array.from(key)

function nodeSha256 (data) {
  return createHash('sha256').update(data).digest()
}

function nodeSha512 (data) {
  return createHash('sha512').update(data).digest()
}

function nodeRipemd160 (data) {
  return createHash('ripemd160').update(data).digest()
}

function nodeSha256Hmac (data) {
  return createHmac('sha256', key).update(data).digest()
}

function assertSameHex (name, actual, expected) {
  const actualHex = Buffer.from(actual).toString('hex')
  const expectedHex = Buffer.from(expected).toString('hex')
  if (actualHex !== expectedHex) {
    throw new Error(`${name} mismatch`)
  }
}

async function main () {
  assertSameHex('sha256', sha256(oneMiB), nodeSha256(oneMiB))
  assertSameHex('hash256', hash256(oneMiB), nodeSha256(nodeSha256(oneMiB)))
  assertSameHex('hash160', hash160(oneMiB), nodeRipemd160(nodeSha256(oneMiB)))
  assertSameHex('ripemd160', ripemd160(oneMiBArray), nodeRipemd160(oneMiB))
  assertSameHex('sha256hmac', sha256hmac(key, oneMiB), nodeSha256Hmac(oneMiB))
  assertSameHex('sha512', sha512(oneMiB), nodeSha512(oneMiB))

  const options = { minSampleMs: 300, samples: 9 }
  await runBenchmark('sha256 Uint8Array 1MiB', () => sha256(oneMiB), options)
  await runBenchmark('sha256 number[] 1MiB', () => sha256(oneMiBArray), options)
  await runBenchmark('sha256 Uint8Array 16MiB', () => sha256(sixteenMiB), {
    minSampleMs: 500,
    samples: 5
  })
  await runBenchmark('hash256 Uint8Array 1MiB', () => hash256(oneMiB), options)
  await runBenchmark('hash160 Uint8Array 1MiB', () => hash160(oneMiB), options)
  await runBenchmark('ripemd160 number[] 1MiB', () => ripemd160(oneMiBArray), options)
  await runBenchmark('sha256hmac Uint8Array 1MiB', () => sha256hmac(key, oneMiB), options)
  await runBenchmark('sha256hmac number[] 1MiB', () => sha256hmac(keyArray, oneMiBArray), options)
  await runBenchmark('sha512 Uint8Array 1MiB', () => sha512(oneMiB), options)
  await runBenchmark('sha512hmac Uint8Array 1MiB', () => sha512hmac(key, oneMiB), options)

  await runBenchmark('node sha256 Uint8Array 1MiB', () => nodeSha256(oneMiB), options)
}

try {
  await main()
} catch (err) {
  console.error(err)
  process.exit(1)
}
