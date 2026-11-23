// Generates src/__tests__/fixtures/sigma-vectors.json from the built package.
// Run after `pnpm --filter @bsv/sigma-permission-module build`.
// The proof scalar is derived here with node:crypto alone, so the fixture carries a
// derivation path that does not depend on the code under test.
import { hkdfSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CachedKeyDeriver, KeyDeriver, PrivateKey } from '@bsv/sdk'
import { SigmaPermissionModule } from '../dist/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'src', '__tests__', 'fixtures', 'sigma-vectors.json')

const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const hex = bytes => Buffer.from(bytes).toString('hex')
const bytesOf = h => [...Buffer.from(h, 'hex')]
const rootHex = n => n.toString(16).padStart(64, '0')

const SECURITY_LEVEL = 2
const LOGICAL = 'example payout'
const KEY_ID = 'member 1'
const DERIVATION_PROTOCOL = 'p sigma example payout'
const SALT = 'p sigma v1'
const ORIGINATOR = 'vectors.example'
const ctx = Array.from({ length: 68 }, (_, i) => i)

const point = k => new PrivateKey(k).toPublicKey().toString()
const G7 = point(7)
const G11 = point(11)
const G13 = point(13)

const wallets = {}
const roots = { A: 2, B: 3 }
for (const [name, k] of Object.entries(roots)) {
  wallets[name] = { rootPrivateKeyHex: rootHex(k), identityKeyHex: point(k) }
}

const modules = {}
const derivers = {}
for (const name of Object.keys(roots)) {
  derivers[name] = new KeyDeriver(new PrivateKey(roots[name]))
  modules[name] = new SigmaPermissionModule({
    keyDeriver: new CachedKeyDeriver(new PrivateKey(roots[name])),
    authorize: async () => true
  })
}

const scalarFrom = d32 => {
  const salt = Buffer.from(SALT, 'utf8')
  for (let j = 0; ; j++) {
    const info = Buffer.concat([Buffer.from(SALT + ' scalar', 'utf8'), Buffer.from([j])])
    const x = Buffer.from(hkdfSync('sha256', d32, salt, info, 32))
    const value = BigInt('0x' + x.toString('hex'))
    if (value > 0n && value < N) return x.toString('hex')
  }
}

const call = async (wallet, operation, counterparty, plaintext) => {
  const { ciphertext } = await modules[wallet].handleRequest(
    {
      method: 'encrypt',
      originator: ORIGINATOR,
      args: {
        protocolID: [SECURITY_LEVEL, `p sigma ${operation} ${LOGICAL}`],
        keyID: KEY_ID,
        counterparty,
        plaintext
      }
    },
    async () => {
      throw new Error('underlying wallet must not be called')
    }
  )
  return hex(ciphertext)
}

const make = async (name, wallet, counterparty, operation, plaintext) => {
  const d = derivers[wallet].derivePrivateKey(
    [SECURITY_LEVEL, DERIVATION_PROTOCOL],
    KEY_ID,
    counterparty
  )
  const childKeyHex = d.toHex(32)
  return {
    name,
    wallet,
    securityLevel: SECURITY_LEVEL,
    logicalProtocolID: LOGICAL,
    keyID: KEY_ID,
    counterparty,
    operation,
    plaintextHex: hex(plaintext),
    childKeyHex,
    scalarHex: scalarFrom(Buffer.from(childKeyHex, 'hex')),
    statementPointHex: await call(wallet, 'key', counterparty, []),
    resultHex: await call(wallet, operation, counterparty, plaintext)
  }
}

const A = wallets.A.identityKeyHex
const B = wallets.B.identityKeyHex
const vectors = [
  await make('key-self', 'A', 'self', 'key', []),
  await make('key-counterparty-b', 'A', B, 'key', []),
  await make('key-counterparty-a', 'B', A, 'key', []),
  await make('key-anyone', 'A', 'anyone', 'key', []),
  await make('key-with-base', 'A', 'self', 'key', bytesOf(G7)),
  await make('schnorr', 'A', 'self', 'schnorr', ctx),
  await make('dleq', 'A', 'self', 'dleq', [...bytesOf(G7), ...ctx]),
  await make('or-n2-position-1', 'A', 'self', 'or', [2, 1, ...bytesOf(G11), ...ctx]),
  await make('or-n2-position-2', 'A', 'self', 'or', [2, 2, ...bytesOf(G11), ...ctx]),
  await make('or-n3-position-2', 'A', 'self', 'or', [
    3,
    2,
    ...bytesOf(G11),
    ...bytesOf(G13),
    ...ctx
  ])
]

const fixture = {
  parameters: {
    securityLevel: SECURITY_LEVEL,
    logicalProtocolID: LOGICAL,
    keyID: KEY_ID,
    derivationProtocol: DERIVATION_PROTOCOL,
    invoiceNumber: `${SECURITY_LEVEL}-${DERIVATION_PROTOCOL}-${KEY_ID}`,
    contextHex: hex(ctx),
    hkdfSalt: SALT,
    points: { '7G': G7, '11G': G11, '13G': G13 }
  },
  wallets,
  vectors
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')
console.log(`wrote ${vectors.length} vectors to ${OUT}`)
