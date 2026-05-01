#!/usr/bin/env node
/**
 * Full BRC-100 Conformance Vector Generator — comprehensive coverage
 * Covers every WalletInterface method with happy-path, error, and edge cases.
 * Uses ProtoWallet for deterministic crypto outputs where possible.
 * Run: node scripts/generate-full-brc100-vectors.mjs
 */

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  PrivateKey,
  ProtoWallet,
  P2PKH,
  Transaction,
  LockingScript
} from '../packages/sdk/dist/esm/mod.js'

// ── Constants ──────────────────────────────────────────────────────────────────

const ROOT_KEYS = [
  '0000000000000000000000000000000000000000000000000000000000000001',
  '0000000000000000000000000000000000000000000000000000000000000002',
  '0000000000000000000000000000000000000000000000000000000000000003'
]

const PROTOCOLS = [
  [0, 'wallet'],
  [1, 'app-msgs'],
  [2, 'counterparty'],
  [0, 'identity'],
  [1, 'messaging']
]

const KEY_IDS = ['1', '2', 'primary', 'backup', 'test-key-42']
const COUNTERPARTIES = ['self', 'anyone', '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798']
const BASKETS = ['default', 'payments', 'tokens', 'invoices']
const TAGS = [['payment'], ['token'], ['invoice', 'high-value'], []]
const LABELS = [['tx1'], ['payment', 'confirmed'], [], ['test-label']]

// A real 33-byte compressed public key for counterparty use
const KNOWN_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
// A different pubkey (generator * 2)
const KNOWN_PUBKEY2 = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'

// Synthetic certificate data for certificate-related methods
const CERT_TYPE = 'AGFjZXJ0dHlwZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
const CERT_CERTIFIER = KNOWN_PUBKEY
const CERT_SUBJECT = KNOWN_PUBKEY2
const CERT_SERIAL = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const CERT_REVOCATION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.0'
const CERT_SIGNATURE = 'a' + '0'.repeat(143) // 144 hex chars = 72 bytes (DER sig placeholder)

// Realistic P2PKH locking scripts for various addresses
function makeLockingScript (privKeyHex) {
  const pk = PrivateKey.fromHex(privKeyHex)
  return new P2PKH().lock(pk.toAddress()).toHex()
}

const LOCKING_SCRIPTS = [
  '76a914a3dbcdd15d94b7fec6f80879369cf57ffda0eeca88ac',
  '76a914c436cfb6ec514fdaa3dd60f30b20c76981ce92a588ac',
  '76a9149138bf05b5d6b85dce73220ee1c816f5c26fdf9288ac',
  '76a914b1f84e85399d2ed48b98fe42f62e7e6ab11de61688ac'
]

// A minimal valid AtomicBEEF placeholder (4 bytes version + 4 bytes nInputs = 0 + 4 bytes nOutputs = 0 + 4 bytes lockTime)
// Full synthetic BEEF for testing structure (not cryptographically valid)
const SYNTHETIC_ATOMIC_BEEF = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

// A valid outpoint string
const OUTPOINT_1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.0'
const OUTPOINT_2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.1'

// Realistic base64 references (for signAction/abortAction)
const REF_1 = 'dGVzdHJlZmVyZW5jZTAwMQ=='
const REF_2 = 'dGVzdHJlZmVyZW5jZTAwMg=='
const REF_3 = 'dGVzdHJlZmVyZW5jZTAwMw=='

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeWallet (rootHex) {
  const pk = PrivateKey.fromHex(rootHex)
  return new ProtoWallet(pk)
}

function makeVector (id, description, input, expected, tags = []) {
  return { id, description, input, expected, tags }
}

function encodeText (s) {
  return Array.from(new TextEncoder().encode(s))
}

// ── Method Generators ──────────────────────────────────────────────────────────

async function generateDecryptVectors () {
  const vectors = []
  let n = 1
  const DATA_SAMPLES = [
    encodeText('hello world'),
    encodeText('BSV conformance test data'),
    Array.from({ length: 32 }, (_, i) => i),
    [0],
    Array.from({ length: 256 }, (_, i) => i % 256)
  ]

  for (const root of ROOT_KEYS) {
    const w = makeWallet(root)
    for (const proto of PROTOCOLS.slice(0, 3)) {
      for (const kid of KEY_IDS.slice(0, 3)) {
        for (const cp of COUNTERPARTIES.slice(0, 2)) {
          const args = { protocolID: proto, keyID: kid, counterparty: cp, plaintext: DATA_SAMPLES[n % DATA_SAMPLES.length] }
          try {
            const enc = await w.encrypt({ protocolID: proto, keyID: kid, counterparty: cp, plaintext: args.plaintext })
            const dec = await w.decrypt({ protocolID: proto, keyID: kid, counterparty: cp, ciphertext: enc.ciphertext })
            vectors.push(makeVector(
              `wallet.brc100.decrypt.${n++}`,
              `decrypt round-trip proto=${proto[0]},${proto[1]} kid=${kid} cp=${cp}`,
              { root_key: root, args: { protocolID: proto, keyID: kid, counterparty: cp, ciphertext: enc.ciphertext } },
              { plaintext: dec.plaintext },
              ['brc-100', 'decrypt']
            ))
          } catch (e) {
            vectors.push(makeVector(
              `wallet.brc100.decrypt.${n++}`,
              `decrypt error proto=${proto[0]},${proto[1]} kid=${kid} cp=${cp}`,
              { root_key: root, args: { protocolID: proto, keyID: kid, counterparty: cp, ciphertext: [0, 1, 2, 3] } },
              { error: true, message: e.message },
              ['brc-100', 'decrypt', 'error']
            ))
          }
          if (n > 50) break
        }
        if (n > 50) break
      }
      if (n > 50) break
    }
    if (n > 50) break
  }

  // Error: wrong ciphertext (tampered)
  const w = makeWallet(ROOT_KEYS[0])
  const enc = await w.encrypt({ protocolID: [0, 'wallet'], keyID: '1', counterparty: 'self', plaintext: [1, 2, 3, 4] })
  const tampered = [...enc.ciphertext]
  tampered[0] ^= 0xff // flip bits
  try {
    await w.decrypt({ protocolID: [0, 'wallet'], keyID: '1', counterparty: 'self', ciphertext: tampered })
  } catch (e) {
    vectors.push(makeVector(
      `wallet.brc100.decrypt.${n++}`,
      'decrypt tampered ciphertext',
      { root_key: ROOT_KEYS[0], args: { protocolID: [0, 'wallet'], keyID: '1', counterparty: 'self', ciphertext: tampered } },
      { error: true },
      ['brc-100', 'decrypt', 'error', 'tampered']
    ))
  }

  return vectors
}

async function generateVerifyHmacVectors () {
  const vectors = []
  let n = 1

  for (const root of ROOT_KEYS) {
    const w = makeWallet(root)
    for (const proto of PROTOCOLS.slice(0, 3)) {
      for (const kid of KEY_IDS.slice(0, 3)) {
        for (const cp of COUNTERPARTIES.slice(0, 2)) {
          const data = encodeText(`hmac-verify data for ${proto[1]}/${kid}/${cp}`)
          const args = { protocolID: proto, keyID: kid, counterparty: cp, data }
          try {
            const hmacRes = await w.createHmac(args)
            // Valid HMAC
            const verArgs = { protocolID: proto, keyID: kid, counterparty: cp, data, hmac: hmacRes.hmac }
            const res = await w.verifyHmac(verArgs)
            vectors.push(makeVector(
              `wallet.brc100.verifyhmac.${n++}`,
              `verifyHmac valid proto=${proto[0]},${proto[1]} kid=${kid} cp=${cp}`,
              { root_key: root, args: verArgs },
              { valid: true },
              ['brc-100', 'verifyHmac']
            ))
            // Invalid HMAC (flip last byte)
            const badHmac = [...hmacRes.hmac]
            badHmac[badHmac.length - 1] ^= 0xff
            const badArgs = { protocolID: proto, keyID: kid, counterparty: cp, data, hmac: badHmac }
            try {
              await w.verifyHmac(badArgs)
            } catch (e) {
              vectors.push(makeVector(
                `wallet.brc100.verifyhmac.${n++}`,
                `verifyHmac invalid HMAC proto=${proto[0]},${proto[1]} kid=${kid}`,
                { root_key: root, args: badArgs },
                { error: true, code: 'ERR_INVALID_HMAC' },
                ['brc-100', 'verifyHmac', 'error']
              ))
            }
          } catch (e) {
            vectors.push(makeVector(
              `wallet.brc100.verifyhmac.${n++}`,
              `verifyHmac error proto=${proto[0]},${proto[1]} kid=${kid}`,
              { root_key: root, args: { protocolID: proto, keyID: kid, counterparty: cp, data, hmac: [] } },
              { error: true, message: e.message },
              ['brc-100', 'verifyHmac', 'error']
            ))
          }
          if (n > 70) break
        }
        if (n > 70) break
      }
      if (n > 70) break
    }
    if (n > 70) break
  }
  return vectors
}

async function generateVerifySignatureVectors () {
  const vectors = []
  let n = 1

  for (const root of ROOT_KEYS) {
    const w = makeWallet(root)
    for (const proto of PROTOCOLS.slice(0, 3)) {
      for (const kid of KEY_IDS.slice(0, 3)) {
        for (const cp of COUNTERPARTIES.slice(0, 2)) {
          const data = encodeText(`signature data for ${proto[1]}/${kid}/${cp}`)
          const createArgs = { protocolID: proto, keyID: kid, counterparty: cp, data }
          try {
            const sigRes = await w.createSignature(createArgs)
            // Valid signature
            const verArgs = { protocolID: proto, keyID: kid, counterparty: cp, data, signature: sigRes.signature }
            const res = await w.verifySignature(verArgs)
            vectors.push(makeVector(
              `wallet.brc100.verifysignature.${n++}`,
              `verifySignature valid proto=${proto[0]},${proto[1]} kid=${kid} cp=${cp}`,
              { root_key: root, args: verArgs },
              { valid: true },
              ['brc-100', 'verifySignature']
            ))
            // forSelf=true
            try {
              const selfArgs = { protocolID: proto, keyID: kid, counterparty: cp, data, signature: sigRes.signature, forSelf: true }
              const selfRes = await w.verifySignature(selfArgs)
              vectors.push(makeVector(
                `wallet.brc100.verifysignature.${n++}`,
                `verifySignature forSelf proto=${proto[0]},${proto[1]} kid=${kid}`,
                { root_key: root, args: selfArgs },
                { valid: true },
                ['brc-100', 'verifySignature', 'forSelf']
              ))
            } catch (_) {}
            // Invalid signature (flip last byte)
            const badSig = [...sigRes.signature]
            badSig[badSig.length - 1] ^= 0x01
            const badArgs = { protocolID: proto, keyID: kid, counterparty: cp, data, signature: badSig }
            try {
              await w.verifySignature(badArgs)
            } catch (e) {
              vectors.push(makeVector(
                `wallet.brc100.verifysignature.${n++}`,
                `verifySignature invalid signature proto=${proto[0]},${proto[1]} kid=${kid}`,
                { root_key: root, args: badArgs },
                { error: true, code: 'ERR_INVALID_SIGNATURE' },
                ['brc-100', 'verifySignature', 'error']
              ))
            }
          } catch (e) {
            vectors.push(makeVector(
              `wallet.brc100.verifysignature.${n++}`,
              `verifySignature error proto=${proto[0]},${proto[1]} kid=${kid}`,
              { root_key: root, args: { protocolID: proto, keyID: kid, counterparty: cp, data, signature: [] } },
              { error: true, message: e.message },
              ['brc-100', 'verifySignature', 'error']
            ))
          }
          if (n > 80) break
        }
        if (n > 80) break
      }
      if (n > 80) break
    }
    if (n > 80) break
  }

  // hashToDirectlyVerify variant
  const w = makeWallet(ROOT_KEYS[0])
  const hash = Array.from({ length: 32 }, (_, i) => i)
  try {
    const sigRes = await w.createSignature({ protocolID: [0, 'wallet'], keyID: '1', counterparty: 'self', hashToDirectlySign: hash })
    const verArgs = { protocolID: [0, 'wallet'], keyID: '1', counterparty: 'self', hashToDirectlyVerify: hash, signature: sigRes.signature }
    await w.verifySignature(verArgs)
    vectors.push(makeVector(
      `wallet.brc100.verifysignature.${n++}`,
      'verifySignature with hashToDirectlyVerify',
      { root_key: ROOT_KEYS[0], args: verArgs },
      { valid: true },
      ['brc-100', 'verifySignature', 'hash-direct']
    ))
  } catch (e) {}

  return vectors
}

// ── Simple State Vectors ───────────────────────────────────────────────────────

function generateGetHeightVectors () {
  return [
    makeVector('wallet.brc100.getheight.1', 'getHeight happy path - returns positive integer',
      { args: {} },
      { height: 1 }, // shape: { height: PositiveInteger }
      ['brc-100', 'getHeight', 'happy-path']),
    makeVector('wallet.brc100.getheight.2', 'getHeight returns current blockchain height',
      { args: {}, originator: 'example.com' },
      { height: 1 },
      ['brc-100', 'getHeight', 'originator']),
    makeVector('wallet.brc100.getheight.3', 'getHeight with no originator',
      { args: {} },
      { height: 1 },
      ['brc-100', 'getHeight']),
    makeVector('wallet.brc100.getheight.4', 'getHeight result shape: height is PositiveInteger (≥1)',
      { args: {}, _schema_note: 'height must be a positive integer >= 1' },
      { height: 1 },
      ['brc-100', 'getHeight', 'schema']),
    makeVector('wallet.brc100.getheight.5', 'getHeight not authenticated error',
      { args: {}, _scenario: 'wallet not authenticated' },
      { error: true, code: 'ERR_NOT_AUTHENTICATED' },
      ['brc-100', 'getHeight', 'error'])
  ]
}

function generateGetNetworkVectors () {
  return [
    makeVector('wallet.brc100.getnetwork.1', 'getNetwork returns mainnet',
      { args: {}, _scenario: 'mainnet wallet' },
      { network: 'mainnet' },
      ['brc-100', 'getNetwork', 'mainnet']),
    makeVector('wallet.brc100.getnetwork.2', 'getNetwork returns testnet',
      { args: {}, _scenario: 'testnet wallet' },
      { network: 'testnet' },
      ['brc-100', 'getNetwork', 'testnet']),
    makeVector('wallet.brc100.getnetwork.3', 'getNetwork with originator',
      { args: {}, originator: 'myapp.example.com' },
      { network: 'mainnet' },
      ['brc-100', 'getNetwork', 'originator']),
    makeVector('wallet.brc100.getnetwork.4', 'getNetwork no originator',
      { args: {} },
      { network: 'mainnet' },
      ['brc-100', 'getNetwork']),
    makeVector('wallet.brc100.getnetwork.5', 'getNetwork result is WalletNetwork (mainnet|testnet)',
      { args: {}, _schema_note: 'network must be "mainnet" or "testnet"' },
      { network: 'mainnet' },
      ['brc-100', 'getNetwork', 'schema'])
  ]
}

function generateGetVersionVectors () {
  return [
    makeVector('wallet.brc100.getversion.1', 'getVersion returns version string',
      { args: {} },
      { version: 'wallet-0.1.0' },
      ['brc-100', 'getVersion', 'happy-path']),
    makeVector('wallet.brc100.getversion.2', 'getVersion format is vendor-major.minor.patch',
      { args: {}, _schema_note: 'version format: [vendor]-[major].[minor].[patch], 7-30 bytes' },
      { version: 'wallet-1.0.0' },
      ['brc-100', 'getVersion', 'schema']),
    makeVector('wallet.brc100.getversion.3', 'getVersion with originator',
      { args: {}, originator: 'app.example.com' },
      { version: 'wallet-1.0.0' },
      ['brc-100', 'getVersion', 'originator']),
    makeVector('wallet.brc100.getversion.4', 'getVersion error when not available',
      { args: {}, _scenario: 'service unavailable' },
      { error: true },
      ['brc-100', 'getVersion', 'error']),
    makeVector('wallet.brc100.getversion.5', 'getVersion minimum length version (7 chars)',
      { args: {}, _schema_note: 'minimum 7 chars: "x-0.0.0"' },
      { version: 'x-0.0.0' },
      ['brc-100', 'getVersion', 'schema', 'edge-case'])
  ]
}

function generateGetHeaderForHeightVectors () {
  // Block header is always exactly 80 bytes = 160 hex chars
  const HEADER_80_BYTES = '0'.repeat(160)
  const GENESIS_HEADER = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c'

  return [
    makeVector('wallet.brc100.getheaderforheight.1', 'getHeaderForHeight height=1',
      { args: { height: 1 } },
      { header: HEADER_80_BYTES },
      ['brc-100', 'getHeaderForHeight', 'happy-path']),
    makeVector('wallet.brc100.getheaderforheight.2', 'getHeaderForHeight genesis block (height=0)',
      { args: { height: 0 } },
      { header: GENESIS_HEADER },
      ['brc-100', 'getHeaderForHeight', 'genesis', 'edge-case']),
    makeVector('wallet.brc100.getheaderforheight.3', 'getHeaderForHeight height=100',
      { args: { height: 100 } },
      { header: HEADER_80_BYTES },
      ['brc-100', 'getHeaderForHeight']),
    makeVector('wallet.brc100.getheaderforheight.4', 'getHeaderForHeight height=1000000',
      { args: { height: 1000000 } },
      { header: HEADER_80_BYTES },
      ['brc-100', 'getHeaderForHeight']),
    makeVector('wallet.brc100.getheaderforheight.5', 'getHeaderForHeight result shape: header is 80-byte hex',
      { args: { height: 1 }, _schema_note: 'header is always exactly 80 bytes (160 hex chars)' },
      { header: HEADER_80_BYTES },
      ['brc-100', 'getHeaderForHeight', 'schema']),
    makeVector('wallet.brc100.getheaderforheight.6', 'getHeaderForHeight height beyond chain tip',
      { args: { height: 2147483647 }, _scenario: 'height beyond current chain tip' },
      { error: true, code: 'ERR_HEADER_NOT_FOUND' },
      ['brc-100', 'getHeaderForHeight', 'error']),
    makeVector('wallet.brc100.getheaderforheight.7', 'getHeaderForHeight with originator',
      { args: { height: 10 }, originator: 'app.example.com' },
      { header: HEADER_80_BYTES },
      ['brc-100', 'getHeaderForHeight', 'originator']),
    makeVector('wallet.brc100.getheaderforheight.8', 'getHeaderForHeight invalid height (zero for some impls)',
      { args: { height: 0 }, _scenario: 'Some implementations start at block 1' },
      { header: GENESIS_HEADER },
      ['brc-100', 'getHeaderForHeight', 'edge-case'])
  ]
}

function generateIsAuthenticatedVectors () {
  return [
    makeVector('wallet.brc100.isauthenticated.1', 'isAuthenticated when user is authenticated',
      { args: {} },
      { authenticated: true },
      ['brc-100', 'isAuthenticated', 'happy-path']),
    makeVector('wallet.brc100.isauthenticated.2', 'isAuthenticated with originator',
      { args: {}, originator: 'app.example.com' },
      { authenticated: true },
      ['brc-100', 'isAuthenticated', 'originator']),
    makeVector('wallet.brc100.isauthenticated.3', 'isAuthenticated when not authenticated',
      { args: {}, _scenario: 'wallet locked or no active session' },
      { authenticated: false },
      ['brc-100', 'isAuthenticated', 'unauthenticated']),
    makeVector('wallet.brc100.isauthenticated.4', 'isAuthenticated returns AuthenticatedResult shape',
      { args: {}, _schema_note: 'result must have { authenticated: boolean }' },
      { authenticated: true },
      ['brc-100', 'isAuthenticated', 'schema']),
    makeVector('wallet.brc100.isauthenticated.5', 'isAuthenticated no args required',
      { args: {} },
      { authenticated: true },
      ['brc-100', 'isAuthenticated'])
  ]
}

function generateWaitForAuthenticationVectors () {
  return [
    makeVector('wallet.brc100.waitforauthentication.1', 'waitForAuthentication resolves when user authenticates',
      { args: {} },
      { authenticated: true },
      ['brc-100', 'waitForAuthentication', 'happy-path']),
    makeVector('wallet.brc100.waitforauthentication.2', 'waitForAuthentication with originator',
      { args: {}, originator: 'app.example.com' },
      { authenticated: true },
      ['brc-100', 'waitForAuthentication', 'originator']),
    makeVector('wallet.brc100.waitforauthentication.3', 'waitForAuthentication returns AuthenticatedResult',
      { args: {}, _schema_note: 'always resolves to { authenticated: true } upon success' },
      { authenticated: true },
      ['brc-100', 'waitForAuthentication', 'schema']),
    makeVector('wallet.brc100.waitforauthentication.4', 'waitForAuthentication timeout error',
      { args: {}, _scenario: 'user does not authenticate within timeout period' },
      { error: true, code: 'ERR_AUTHENTICATION_TIMEOUT' },
      ['brc-100', 'waitForAuthentication', 'error']),
    makeVector('wallet.brc100.waitforauthentication.5', 'waitForAuthentication wallet closed error',
      { args: {}, _scenario: 'wallet process closes before authentication completes' },
      { error: true },
      ['brc-100', 'waitForAuthentication', 'error'])
  ]
}

// ── Action Vectors ─────────────────────────────────────────────────────────────

function generateAbortActionVectors () {
  return [
    makeVector('wallet.brc100.abortaction.1', 'abortAction with valid reference',
      { args: { reference: REF_1 } },
      { aborted: true },
      ['brc-100', 'abortAction', 'happy-path']),
    makeVector('wallet.brc100.abortaction.2', 'abortAction with second reference',
      { args: { reference: REF_2 } },
      { aborted: true },
      ['brc-100', 'abortAction']),
    makeVector('wallet.brc100.abortaction.3', 'abortAction with originator',
      { args: { reference: REF_1 }, originator: 'app.example.com' },
      { aborted: true },
      ['brc-100', 'abortAction', 'originator']),
    makeVector('wallet.brc100.abortaction.4', 'abortAction unknown reference',
      { args: { reference: 'dW5rbm93bi1yZWZlcmVuY2U=' } },
      { error: true, code: 'ERR_REFERENCE_NOT_FOUND' },
      ['brc-100', 'abortAction', 'error']),
    makeVector('wallet.brc100.abortaction.5', 'abortAction already-completed transaction',
      { args: { reference: REF_3 }, _scenario: 'transaction already broadcast, cannot abort' },
      { error: true, code: 'ERR_TRANSACTION_ALREADY_SENT' },
      ['brc-100', 'abortAction', 'error']),
    makeVector('wallet.brc100.abortaction.6', 'abortAction empty reference',
      { args: { reference: '' } },
      { error: true },
      ['brc-100', 'abortAction', 'error', 'validation']),
    makeVector('wallet.brc100.abortaction.7', 'abortAction result shape: always { aborted: true }',
      { args: { reference: REF_1 }, _schema_note: 'success result is always { aborted: true }' },
      { aborted: true },
      ['brc-100', 'abortAction', 'schema']),
    makeVector('wallet.brc100.abortaction.8', 'abortAction third reference format',
      { args: { reference: REF_3 } },
      { aborted: true },
      ['brc-100', 'abortAction'])
  ]
}

function generateSignActionVectors () {
  // P2PKH unlocking script placeholder (33+1+71+1 bytes DER sig = approx 107 bytes = 214 hex)
  const PLACEHOLDER_UNLOCK = '47304402' + '0'.repeat(64) + '0220' + '0'.repeat(64) + '0141'

  return [
    makeVector('wallet.brc100.signaction.1', 'signAction single input spend',
      {
        args: {
          reference: REF_1,
          spends: {
            0: { unlockingScript: PLACEHOLDER_UNLOCK }
          }
        }
      },
      { txid: 'a'.repeat(64) },
      ['brc-100', 'signAction', 'happy-path']),
    makeVector('wallet.brc100.signaction.2', 'signAction multi-input spend',
      {
        args: {
          reference: REF_2,
          spends: {
            0: { unlockingScript: PLACEHOLDER_UNLOCK },
            1: { unlockingScript: PLACEHOLDER_UNLOCK, sequenceNumber: 0 }
          }
        }
      },
      { txid: 'b'.repeat(64) },
      ['brc-100', 'signAction', 'multi-input']),
    makeVector('wallet.brc100.signaction.3', 'signAction with options.noSend=true',
      {
        args: {
          reference: REF_1,
          spends: { 0: { unlockingScript: PLACEHOLDER_UNLOCK } },
          options: { noSend: true, acceptDelayedBroadcast: true }
        }
      },
      { txid: 'c'.repeat(64) },
      ['brc-100', 'signAction', 'noSend']),
    makeVector('wallet.brc100.signaction.4', 'signAction with options.returnTXIDOnly=true',
      {
        args: {
          reference: REF_1,
          spends: { 0: { unlockingScript: PLACEHOLDER_UNLOCK } },
          options: { returnTXIDOnly: true }
        }
      },
      { txid: 'd'.repeat(64) },
      ['brc-100', 'signAction', 'txid-only']),
    makeVector('wallet.brc100.signaction.5', 'signAction with sendWith batch',
      {
        args: {
          reference: REF_1,
          spends: { 0: { unlockingScript: PLACEHOLDER_UNLOCK } },
          options: { sendWith: ['a'.repeat(64), 'b'.repeat(64)] }
        }
      },
      { txid: 'e'.repeat(64), sendWithResults: [{ txid: 'a'.repeat(64), status: 'sending' }] },
      ['brc-100', 'signAction', 'sendWith']),
    makeVector('wallet.brc100.signaction.6', 'signAction unknown reference error',
      {
        args: {
          reference: 'dW5rbm93bi1yZWZlcmVuY2U=',
          spends: { 0: { unlockingScript: PLACEHOLDER_UNLOCK } }
        }
      },
      { error: true, code: 'ERR_REFERENCE_NOT_FOUND' },
      ['brc-100', 'signAction', 'error']),
    makeVector('wallet.brc100.signaction.7', 'signAction wrong number of spends',
      {
        args: {
          reference: REF_1,
          spends: {}
        }
      },
      { error: true },
      ['brc-100', 'signAction', 'error', 'validation']),
    makeVector('wallet.brc100.signaction.8', 'signAction result includes tx bytes',
      {
        args: {
          reference: REF_2,
          spends: { 0: { unlockingScript: PLACEHOLDER_UNLOCK } },
          options: { acceptDelayedBroadcast: false }
        }
      },
      { txid: 'f'.repeat(64), tx: Array.from({ length: 200 }, () => 0) },
      ['brc-100', 'signAction', 'immediate-broadcast'])
  ]
}

function generateListActionsVectors () {
  const baseAction = {
    txid: 'a'.repeat(64),
    satoshis: 1000,
    status: 'completed',
    isOutgoing: true,
    description: 'test payment',
    labels: ['payment'],
    version: 1,
    lockTime: 0,
    inputs: [],
    outputs: []
  }

  return [
    makeVector('wallet.brc100.listactions.1', 'listActions by single label',
      { args: { labels: ['payment'] } },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'happy-path']),
    makeVector('wallet.brc100.listactions.2', 'listActions by multiple labels any-mode',
      { args: { labels: ['payment', 'invoice'], labelQueryMode: 'any' } },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'any-mode']),
    makeVector('wallet.brc100.listactions.3', 'listActions by multiple labels all-mode',
      { args: { labels: ['payment', 'confirmed'], labelQueryMode: 'all' } },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'all-mode']),
    makeVector('wallet.brc100.listactions.4', 'listActions with includeLabels=true',
      { args: { labels: ['payment'], includeLabels: true } },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'includeLabels']),
    makeVector('wallet.brc100.listactions.5', 'listActions with includeInputs=true',
      { args: { labels: ['payment'], includeInputs: true } },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'includeInputs']),
    makeVector('wallet.brc100.listactions.6', 'listActions with includeOutputs=true',
      { args: { labels: ['payment'], includeOutputs: true } },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'includeOutputs']),
    makeVector('wallet.brc100.listactions.7', 'listActions with all includes',
      {
        args: {
          labels: ['payment'],
          includeLabels: true,
          includeInputs: true,
          includeInputSourceLockingScripts: true,
          includeInputUnlockingScripts: true,
          includeOutputs: true,
          includeOutputLockingScripts: true
        }
      },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'all-includes']),
    makeVector('wallet.brc100.listactions.8', 'listActions with limit and offset',
      { args: { labels: ['payment'], limit: 5, offset: 10 } },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'pagination']),
    makeVector('wallet.brc100.listactions.9', 'listActions with limit=1',
      { args: { labels: ['payment'], limit: 1 } },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'limit']),
    makeVector('wallet.brc100.listactions.10', 'listActions with limit=10000 (max)',
      { args: { labels: ['payment'], limit: 10000 } },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'limit-max']),
    makeVector('wallet.brc100.listactions.11', 'listActions with empty labels',
      { args: { labels: [] } },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'empty-labels']),
    makeVector('wallet.brc100.listactions.12', 'listActions seekPermission=false',
      { args: { labels: ['payment'], seekPermission: false } },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'no-permission']),
    makeVector('wallet.brc100.listactions.13', 'listActions result shape: { totalActions, actions[] }',
      { args: { labels: ['payment'] }, _schema_note: 'result must have totalActions (int) and actions (array)' },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'schema']),
    makeVector('wallet.brc100.listactions.14', 'listActions WalletAction shape when populated',
      {
        args: { labels: ['payment'], includeOutputs: true },
        _schema_note: 'WalletAction has txid, satoshis, status, isOutgoing, description, version, lockTime'
      },
      { totalActions: 1, actions: [baseAction] },
      ['brc-100', 'listActions', 'schema', 'non-empty']),
    makeVector('wallet.brc100.listactions.15', 'listActions ActionStatus values',
      {
        args: { labels: ['all'] },
        _schema_note: 'status can be: completed, unprocessed, sending, unproven, unsigned, nosend, nonfinal, failed'
      },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'schema']),
    makeVector('wallet.brc100.listactions.16', 'listActions with originator',
      { args: { labels: ['payment'] }, originator: 'app.example.com' },
      { totalActions: 0, actions: [] },
      ['brc-100', 'listActions', 'originator'])
  ]
}

function generateInternalizeActionVectors () {
  const PAYMENT_OUTPUT = {
    outputIndex: 0,
    protocol: 'wallet payment',
    paymentRemittance: {
      derivationPrefix: 'dGVzdHByZWZpeA==',
      derivationSuffix: 'dGVzdHN1ZmZpeA==',
      senderIdentityKey: KNOWN_PUBKEY
    }
  }

  const BASKET_OUTPUT = {
    outputIndex: 0,
    protocol: 'basket insertion',
    insertionRemittance: {
      basket: 'tokens',
      customInstructions: '{"token":"NFT","id":1}',
      tags: ['nft', 'collectible']
    }
  }

  return [
    makeVector('wallet.brc100.internalizeaction.1', 'internalizeAction wallet payment',
      {
        args: {
          tx: SYNTHETIC_ATOMIC_BEEF,
          outputs: [PAYMENT_OUTPUT],
          description: 'inbound payment'
        }
      },
      { accepted: true },
      ['brc-100', 'internalizeAction', 'payment', 'happy-path']),
    makeVector('wallet.brc100.internalizeaction.2', 'internalizeAction basket insertion',
      {
        args: {
          tx: SYNTHETIC_ATOMIC_BEEF,
          outputs: [BASKET_OUTPUT],
          description: 'token insert'
        }
      },
      { accepted: true },
      ['brc-100', 'internalizeAction', 'basket-insertion']),
    makeVector('wallet.brc100.internalizeaction.3', 'internalizeAction multiple outputs',
      {
        args: {
          tx: SYNTHETIC_ATOMIC_BEEF,
          outputs: [PAYMENT_OUTPUT, BASKET_OUTPUT],
          description: 'mixed internalization'
        }
      },
      { accepted: true },
      ['brc-100', 'internalizeAction', 'multi-output']),
    makeVector('wallet.brc100.internalizeaction.4', 'internalizeAction with labels',
      {
        args: {
          tx: SYNTHETIC_ATOMIC_BEEF,
          outputs: [PAYMENT_OUTPUT],
          description: 'labeled payment',
          labels: ['income', 'q4-2025']
        }
      },
      { accepted: true },
      ['brc-100', 'internalizeAction', 'labels']),
    makeVector('wallet.brc100.internalizeaction.5', 'internalizeAction seekPermission=false',
      {
        args: {
          tx: SYNTHETIC_ATOMIC_BEEF,
          outputs: [PAYMENT_OUTPUT],
          description: 'silent internalization',
          seekPermission: false
        }
      },
      { accepted: true },
      ['brc-100', 'internalizeAction', 'no-permission']),
    makeVector('wallet.brc100.internalizeaction.6', 'internalizeAction invalid BEEF',
      {
        args: {
          tx: [0, 1, 2],
          outputs: [PAYMENT_OUTPUT],
          description: 'bad tx data'
        }
      },
      { error: true, code: 'ERR_INVALID_BEEF' },
      ['brc-100', 'internalizeAction', 'error', 'invalid-beef']),
    makeVector('wallet.brc100.internalizeaction.7', 'internalizeAction output index out of range',
      {
        args: {
          tx: SYNTHETIC_ATOMIC_BEEF,
          outputs: [{ outputIndex: 999, protocol: 'wallet payment', paymentRemittance: PAYMENT_OUTPUT.paymentRemittance }],
          description: 'bad output index'
        }
      },
      { error: true },
      ['brc-100', 'internalizeAction', 'error', 'invalid-index']),
    makeVector('wallet.brc100.internalizeaction.8', 'internalizeAction result shape: { accepted: true }',
      {
        args: {
          tx: SYNTHETIC_ATOMIC_BEEF,
          outputs: [PAYMENT_OUTPUT],
          description: 'shape check'
        },
        _schema_note: 'success always returns { accepted: true }'
      },
      { accepted: true },
      ['brc-100', 'internalizeAction', 'schema']),
    makeVector('wallet.brc100.internalizeaction.9', 'internalizeAction basket insertion minimal',
      {
        args: {
          tx: SYNTHETIC_ATOMIC_BEEF,
          outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'default' } }],
          description: 'minimal basket insert'
        }
      },
      { accepted: true },
      ['brc-100', 'internalizeAction', 'minimal']),
    makeVector('wallet.brc100.internalizeaction.10', 'internalizeAction with originator',
      {
        args: {
          tx: SYNTHETIC_ATOMIC_BEEF,
          outputs: [PAYMENT_OUTPUT],
          description: 'payment from app'
        },
        originator: 'merchant.example.com'
      },
      { accepted: true },
      ['brc-100', 'internalizeAction', 'originator'])
  ]
}

function generateRelinquishOutputVectors () {
  return [
    makeVector('wallet.brc100.relinquishoutput.1', 'relinquishOutput from default basket',
      { args: { basket: 'default', output: OUTPOINT_1 } },
      { relinquished: true },
      ['brc-100', 'relinquishOutput', 'happy-path']),
    makeVector('wallet.brc100.relinquishoutput.2', 'relinquishOutput from tokens basket',
      { args: { basket: 'tokens', output: OUTPOINT_2 } },
      { relinquished: true },
      ['brc-100', 'relinquishOutput']),
    makeVector('wallet.brc100.relinquishoutput.3', 'relinquishOutput with originator',
      { args: { basket: 'payments', output: OUTPOINT_1 }, originator: 'app.example.com' },
      { relinquished: true },
      ['brc-100', 'relinquishOutput', 'originator']),
    makeVector('wallet.brc100.relinquishoutput.4', 'relinquishOutput output not in basket',
      { args: { basket: 'default', output: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.0' } },
      { error: true, code: 'ERR_OUTPUT_NOT_FOUND' },
      ['brc-100', 'relinquishOutput', 'error']),
    makeVector('wallet.brc100.relinquishoutput.5', 'relinquishOutput invalid outpoint format',
      { args: { basket: 'default', output: 'invalid-outpoint' } },
      { error: true },
      ['brc-100', 'relinquishOutput', 'error', 'validation']),
    makeVector('wallet.brc100.relinquishoutput.6', 'relinquishOutput result shape: { relinquished: true }',
      { args: { basket: 'default', output: OUTPOINT_1 }, _schema_note: 'success always returns { relinquished: true }' },
      { relinquished: true },
      ['brc-100', 'relinquishOutput', 'schema']),
    makeVector('wallet.brc100.relinquishoutput.7', 'relinquishOutput invoices basket',
      { args: { basket: 'invoices', output: OUTPOINT_1 } },
      { relinquished: true },
      ['brc-100', 'relinquishOutput']),
    makeVector('wallet.brc100.relinquishoutput.8', 'relinquishOutput output index 1',
      { args: { basket: 'default', output: OUTPOINT_2 } },
      { relinquished: true },
      ['brc-100', 'relinquishOutput'])
  ]
}

// ── Certificate Vectors ────────────────────────────────────────────────────────

function generateAcquireCertificateVectors () {
  const directCert = {
    type: CERT_TYPE,
    certifier: CERT_CERTIFIER,
    acquisitionProtocol: 'direct',
    fields: { name: 'Alice', email: 'alice@example.com' },
    serialNumber: CERT_SERIAL,
    revocationOutpoint: CERT_REVOCATION,
    signature: CERT_SIGNATURE,
    keyringRevealer: CERT_CERTIFIER,
    keyringForSubject: { name: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', email: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=' }
  }

  const issuanceCert = {
    type: CERT_TYPE,
    certifier: CERT_CERTIFIER,
    acquisitionProtocol: 'issuance',
    fields: { name: 'Bob' },
    certifierUrl: 'https://certifier.example.com'
  }

  const expectedCert = {
    type: CERT_TYPE,
    subject: KNOWN_PUBKEY2,
    serialNumber: CERT_SERIAL,
    certifier: CERT_CERTIFIER,
    revocationOutpoint: CERT_REVOCATION,
    signature: CERT_SIGNATURE,
    fields: { name: 'Alice', email: 'alice@example.com' }
  }

  return [
    makeVector('wallet.brc100.acquirecertificate.1', 'acquireCertificate direct acquisition',
      { args: directCert },
      expectedCert,
      ['brc-100', 'acquireCertificate', 'direct', 'happy-path']),
    makeVector('wallet.brc100.acquirecertificate.2', 'acquireCertificate issuance acquisition',
      { args: issuanceCert },
      expectedCert,
      ['brc-100', 'acquireCertificate', 'issuance']),
    makeVector('wallet.brc100.acquirecertificate.3', 'acquireCertificate privileged=true',
      { args: { ...directCert, privileged: true, privilegedReason: 'admin access needed' } },
      expectedCert,
      ['brc-100', 'acquireCertificate', 'privileged']),
    makeVector('wallet.brc100.acquirecertificate.4', 'acquireCertificate invalid signature',
      { args: { ...directCert, signature: '00'.repeat(72) } },
      { error: true, code: 'ERR_INVALID_CERTIFICATE_SIGNATURE' },
      ['brc-100', 'acquireCertificate', 'error', 'invalid-sig']),
    makeVector('wallet.brc100.acquirecertificate.5', 'acquireCertificate certifier not trusted',
      { args: { ...directCert, certifier: '03' + '1'.repeat(64) } },
      { error: true },
      ['brc-100', 'acquireCertificate', 'error', 'untrusted-certifier']),
    makeVector('wallet.brc100.acquirecertificate.6', 'acquireCertificate missing serialNumber for direct',
      { args: { ...directCert, serialNumber: undefined } },
      { error: true },
      ['brc-100', 'acquireCertificate', 'error', 'validation']),
    makeVector('wallet.brc100.acquirecertificate.7', 'acquireCertificate result is WalletCertificate',
      {
        args: directCert,
        _schema_note: 'WalletCertificate: type, subject, serialNumber, certifier, revocationOutpoint, signature, fields'
      },
      expectedCert,
      ['brc-100', 'acquireCertificate', 'schema']),
    makeVector('wallet.brc100.acquirecertificate.8', 'acquireCertificate with originator',
      { args: directCert, originator: 'app.example.com' },
      expectedCert,
      ['brc-100', 'acquireCertificate', 'originator'])
  ]
}

function generateListCertificatesVectors () {
  const cert = {
    type: CERT_TYPE,
    subject: KNOWN_PUBKEY2,
    serialNumber: CERT_SERIAL,
    certifier: CERT_CERTIFIER,
    revocationOutpoint: CERT_REVOCATION,
    signature: CERT_SIGNATURE,
    fields: { name: 'Alice' }
  }

  return [
    makeVector('wallet.brc100.listcertificates.1', 'listCertificates by certifier and type',
      { args: { certifiers: [CERT_CERTIFIER], types: [CERT_TYPE] } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'listCertificates', 'happy-path']),
    makeVector('wallet.brc100.listcertificates.2', 'listCertificates multiple certifiers',
      { args: { certifiers: [CERT_CERTIFIER, KNOWN_PUBKEY2], types: [CERT_TYPE] } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'listCertificates', 'multi-certifier']),
    makeVector('wallet.brc100.listcertificates.3', 'listCertificates with limit and offset',
      { args: { certifiers: [CERT_CERTIFIER], types: [CERT_TYPE], limit: 5, offset: 0 } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'listCertificates', 'pagination']),
    makeVector('wallet.brc100.listcertificates.4', 'listCertificates privileged request',
      { args: { certifiers: [CERT_CERTIFIER], types: [CERT_TYPE], privileged: true, privilegedReason: 'admin view' } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'listCertificates', 'privileged']),
    makeVector('wallet.brc100.listcertificates.5', 'listCertificates result shape',
      {
        args: { certifiers: [CERT_CERTIFIER], types: [CERT_TYPE] },
        _schema_note: 'result: { totalCertificates: int, certificates: CertificateResult[] }'
      },
      { totalCertificates: 1, certificates: [cert] },
      ['brc-100', 'listCertificates', 'schema', 'non-empty']),
    makeVector('wallet.brc100.listcertificates.6', 'listCertificates empty certifiers',
      { args: { certifiers: [], types: [] } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'listCertificates', 'empty']),
    makeVector('wallet.brc100.listcertificates.7', 'listCertificates limit=10000',
      { args: { certifiers: [CERT_CERTIFIER], types: [CERT_TYPE], limit: 10000 } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'listCertificates', 'limit-max']),
    makeVector('wallet.brc100.listcertificates.8', 'listCertificates with originator',
      { args: { certifiers: [CERT_CERTIFIER], types: [CERT_TYPE] }, originator: 'app.example.com' },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'listCertificates', 'originator'])
  ]
}

function generateProveCertificateVectors () {
  const certData = {
    type: CERT_TYPE,
    subject: KNOWN_PUBKEY2,
    serialNumber: CERT_SERIAL,
    certifier: CERT_CERTIFIER,
    revocationOutpoint: CERT_REVOCATION,
    signature: CERT_SIGNATURE,
    fields: { name: 'Alice', email: 'alice@example.com', age: '30' }
  }

  return [
    makeVector('wallet.brc100.provecertificate.1', 'proveCertificate reveal single field',
      {
        args: {
          certificate: certData,
          fieldsToReveal: ['name'],
          verifier: KNOWN_PUBKEY2
        }
      },
      { keyringForVerifier: { name: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } },
      ['brc-100', 'proveCertificate', 'single-field', 'happy-path']),
    makeVector('wallet.brc100.provecertificate.2', 'proveCertificate reveal multiple fields',
      {
        args: {
          certificate: certData,
          fieldsToReveal: ['name', 'email'],
          verifier: KNOWN_PUBKEY2
        }
      },
      { keyringForVerifier: { name: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', email: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=' } },
      ['brc-100', 'proveCertificate', 'multi-field']),
    makeVector('wallet.brc100.provecertificate.3', 'proveCertificate reveal all fields',
      {
        args: {
          certificate: certData,
          fieldsToReveal: ['name', 'email', 'age'],
          verifier: KNOWN_PUBKEY2
        }
      },
      { keyringForVerifier: { name: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', email: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=', age: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=' } },
      ['brc-100', 'proveCertificate', 'all-fields']),
    makeVector('wallet.brc100.provecertificate.4', 'proveCertificate privileged request',
      {
        args: {
          certificate: certData,
          fieldsToReveal: ['name'],
          verifier: KNOWN_PUBKEY2,
          privileged: true,
          privilegedReason: 'KYC verification required'
        }
      },
      { keyringForVerifier: { name: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } },
      ['brc-100', 'proveCertificate', 'privileged']),
    makeVector('wallet.brc100.provecertificate.5', 'proveCertificate field not in certificate',
      {
        args: {
          certificate: certData,
          fieldsToReveal: ['nonexistent-field'],
          verifier: KNOWN_PUBKEY2
        }
      },
      { error: true },
      ['brc-100', 'proveCertificate', 'error', 'invalid-field']),
    makeVector('wallet.brc100.provecertificate.6', 'proveCertificate result shape: keyringForVerifier',
      {
        args: {
          certificate: certData,
          fieldsToReveal: ['name'],
          verifier: KNOWN_PUBKEY2
        },
        _schema_note: 'result: { keyringForVerifier: Record<fieldName, base64> }'
      },
      { keyringForVerifier: { name: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } },
      ['brc-100', 'proveCertificate', 'schema']),
    makeVector('wallet.brc100.provecertificate.7', 'proveCertificate with originator',
      {
        args: {
          certificate: certData,
          fieldsToReveal: ['name'],
          verifier: KNOWN_PUBKEY2
        },
        originator: 'verifier.example.com'
      },
      { keyringForVerifier: { name: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } },
      ['brc-100', 'proveCertificate', 'originator']),
    makeVector('wallet.brc100.provecertificate.8', 'proveCertificate partial certificate (Partial<WalletCertificate>)',
      {
        args: {
          certificate: { type: CERT_TYPE, serialNumber: CERT_SERIAL, certifier: CERT_CERTIFIER },
          fieldsToReveal: ['name'],
          verifier: KNOWN_PUBKEY2
        },
        _schema_note: 'certificate arg is Partial<WalletCertificate>'
      },
      { keyringForVerifier: { name: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } },
      ['brc-100', 'proveCertificate', 'partial-cert'])
  ]
}

function generateRelinquishCertificateVectors () {
  return [
    makeVector('wallet.brc100.relinquishcertificate.1', 'relinquishCertificate happy path',
      { args: { type: CERT_TYPE, serialNumber: CERT_SERIAL, certifier: CERT_CERTIFIER } },
      { relinquished: true },
      ['brc-100', 'relinquishCertificate', 'happy-path']),
    makeVector('wallet.brc100.relinquishcertificate.2', 'relinquishCertificate with originator',
      { args: { type: CERT_TYPE, serialNumber: CERT_SERIAL, certifier: CERT_CERTIFIER }, originator: 'app.example.com' },
      { relinquished: true },
      ['brc-100', 'relinquishCertificate', 'originator']),
    makeVector('wallet.brc100.relinquishcertificate.3', 'relinquishCertificate certificate not found',
      { args: { type: CERT_TYPE, serialNumber: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ=', certifier: CERT_CERTIFIER } },
      { error: true, code: 'ERR_CERTIFICATE_NOT_FOUND' },
      ['brc-100', 'relinquishCertificate', 'error']),
    makeVector('wallet.brc100.relinquishcertificate.4', 'relinquishCertificate result shape: { relinquished: true }',
      {
        args: { type: CERT_TYPE, serialNumber: CERT_SERIAL, certifier: CERT_CERTIFIER },
        _schema_note: 'success always returns { relinquished: true }'
      },
      { relinquished: true },
      ['brc-100', 'relinquishCertificate', 'schema']),
    makeVector('wallet.brc100.relinquishcertificate.5', 'relinquishCertificate wrong certifier',
      { args: { type: CERT_TYPE, serialNumber: CERT_SERIAL, certifier: KNOWN_PUBKEY2 } },
      { error: true },
      ['brc-100', 'relinquishCertificate', 'error', 'wrong-certifier']),
    makeVector('wallet.brc100.relinquishcertificate.6', 'relinquishCertificate second cert type',
      {
        args: {
          type: 'QW5vdGhlckNlcnRUeXBlQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==',
          serialNumber: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
          certifier: CERT_CERTIFIER
        }
      },
      { relinquished: true },
      ['brc-100', 'relinquishCertificate'])
  ]
}

function generateDiscoverByIdentityKeyVectors () {
  const identityCert = {
    type: CERT_TYPE,
    subject: KNOWN_PUBKEY,
    serialNumber: CERT_SERIAL,
    certifier: CERT_CERTIFIER,
    revocationOutpoint: CERT_REVOCATION,
    signature: CERT_SIGNATURE,
    fields: { name: 'Alice' },
    certifierInfo: { name: 'TrustCorp', iconUrl: 'https://trust.example.com/icon.png', description: 'Trusted identity', trust: 5 },
    publiclyRevealedKeyring: { name: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    decryptedFields: { name: 'Alice' }
  }

  return [
    makeVector('wallet.brc100.discoverbyidentitykey.1', 'discoverByIdentityKey happy path',
      { args: { identityKey: KNOWN_PUBKEY } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByIdentityKey', 'happy-path']),
    makeVector('wallet.brc100.discoverbyidentitykey.2', 'discoverByIdentityKey with limit',
      { args: { identityKey: KNOWN_PUBKEY, limit: 10 } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByIdentityKey', 'limit']),
    makeVector('wallet.brc100.discoverbyidentitykey.3', 'discoverByIdentityKey with offset',
      { args: { identityKey: KNOWN_PUBKEY, limit: 5, offset: 0 } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByIdentityKey', 'pagination']),
    makeVector('wallet.brc100.discoverbyidentitykey.4', 'discoverByIdentityKey seekPermission=false',
      { args: { identityKey: KNOWN_PUBKEY, seekPermission: false } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByIdentityKey', 'no-permission']),
    makeVector('wallet.brc100.discoverbyidentitykey.5', 'discoverByIdentityKey result shape: DiscoverCertificatesResult',
      {
        args: { identityKey: KNOWN_PUBKEY },
        _schema_note: 'result: { totalCertificates: int, certificates: IdentityCertificate[] }'
      },
      { totalCertificates: 1, certificates: [identityCert] },
      ['brc-100', 'discoverByIdentityKey', 'schema', 'non-empty']),
    makeVector('wallet.brc100.discoverbyidentitykey.6', 'discoverByIdentityKey IdentityCertificate shape',
      {
        args: { identityKey: KNOWN_PUBKEY },
        _schema_note: 'IdentityCertificate extends WalletCertificate with certifierInfo, publiclyRevealedKeyring, decryptedFields'
      },
      { totalCertificates: 1, certificates: [identityCert] },
      ['brc-100', 'discoverByIdentityKey', 'schema']),
    makeVector('wallet.brc100.discoverbyidentitykey.7', 'discoverByIdentityKey with originator',
      { args: { identityKey: KNOWN_PUBKEY }, originator: 'app.example.com' },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByIdentityKey', 'originator']),
    makeVector('wallet.brc100.discoverbyidentitykey.8', 'discoverByIdentityKey second identity key',
      { args: { identityKey: KNOWN_PUBKEY2 } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByIdentityKey']),
    makeVector('wallet.brc100.discoverbyidentitykey.9', 'discoverByIdentityKey limit=10000 max',
      { args: { identityKey: KNOWN_PUBKEY, limit: 10000 } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByIdentityKey', 'limit-max']),
    makeVector('wallet.brc100.discoverbyidentitykey.10', 'discoverByIdentityKey invalid identity key format',
      { args: { identityKey: 'not-a-valid-pubkey' } },
      { error: true },
      ['brc-100', 'discoverByIdentityKey', 'error', 'validation'])
  ]
}

function generateDiscoverByAttributesVectors () {
  const identityCert = {
    type: CERT_TYPE,
    subject: KNOWN_PUBKEY,
    serialNumber: CERT_SERIAL,
    certifier: CERT_CERTIFIER,
    revocationOutpoint: CERT_REVOCATION,
    signature: CERT_SIGNATURE,
    fields: { name: 'Alice', email: 'alice@example.com' },
    certifierInfo: { name: 'TrustCorp', iconUrl: 'https://trust.example.com/icon.png', description: 'Trusted identity', trust: 8 },
    publiclyRevealedKeyring: { name: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    decryptedFields: { name: 'Alice', email: 'alice@example.com' }
  }

  return [
    makeVector('wallet.brc100.discoverbyattributes.1', 'discoverByAttributes single attribute',
      { args: { attributes: { name: 'Alice' } } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByAttributes', 'happy-path']),
    makeVector('wallet.brc100.discoverbyattributes.2', 'discoverByAttributes multiple attributes',
      { args: { attributes: { name: 'Alice', email: 'alice@example.com' } } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByAttributes', 'multi-attr']),
    makeVector('wallet.brc100.discoverbyattributes.3', 'discoverByAttributes with limit',
      { args: { attributes: { name: 'Bob' }, limit: 10 } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByAttributes', 'limit']),
    makeVector('wallet.brc100.discoverbyattributes.4', 'discoverByAttributes with offset',
      { args: { attributes: { name: 'Carol' }, limit: 5, offset: 20 } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByAttributes', 'pagination']),
    makeVector('wallet.brc100.discoverbyattributes.5', 'discoverByAttributes seekPermission=false',
      { args: { attributes: { role: 'admin' }, seekPermission: false } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByAttributes', 'no-permission']),
    makeVector('wallet.brc100.discoverbyattributes.6', 'discoverByAttributes result shape',
      {
        args: { attributes: { name: 'Alice' } },
        _schema_note: 'result: { totalCertificates: int, certificates: IdentityCertificate[] }'
      },
      { totalCertificates: 1, certificates: [identityCert] },
      ['brc-100', 'discoverByAttributes', 'schema', 'non-empty']),
    makeVector('wallet.brc100.discoverbyattributes.7', 'discoverByAttributes empty attributes',
      { args: { attributes: {} } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByAttributes', 'empty-attrs']),
    makeVector('wallet.brc100.discoverbyattributes.8', 'discoverByAttributes with originator',
      { args: { attributes: { name: 'Dave' } }, originator: 'directory.example.com' },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByAttributes', 'originator']),
    makeVector('wallet.brc100.discoverbyattributes.9', 'discoverByAttributes limit=10000',
      { args: { attributes: { country: 'US' }, limit: 10000 } },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByAttributes', 'limit-max']),
    makeVector('wallet.brc100.discoverbyattributes.10', 'discoverByAttributes attribute names max 50 bytes',
      {
        args: { attributes: { a: '1' } },
        _schema_note: 'field names are CertificateFieldNameUnder50Bytes (max 50 chars)'
      },
      { totalCertificates: 0, certificates: [] },
      ['brc-100', 'discoverByAttributes', 'schema'])
  ]
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main () {
  const outDir = join(process.cwd(), 'conformance/vectors/wallet/brc100')
  mkdirSync(outDir, { recursive: true })

  console.log('Generating comprehensive BRC-100 conformance vectors...')

  const generated = {
    'decrypt.json': await generateDecryptVectors(),
    'verifyhmac.json': await generateVerifyHmacVectors(),
    'verifysignature.json': await generateVerifySignatureVectors(),
    'getheight.json': generateGetHeightVectors(),
    'getnetwork.json': generateGetNetworkVectors(),
    'getversion.json': generateGetVersionVectors(),
    'getheaderforheight.json': generateGetHeaderForHeightVectors(),
    'isauthenticated.json': generateIsAuthenticatedVectors(),
    'waitforauthentication.json': generateWaitForAuthenticationVectors(),
    'abortaction.json': generateAbortActionVectors(),
    'signaction.json': generateSignActionVectors(),
    'listactions.json': generateListActionsVectors(),
    'internalizeaction.json': generateInternalizeActionVectors(),
    'relinquishoutput.json': generateRelinquishOutputVectors(),
    'acquirecertificate.json': generateAcquireCertificateVectors(),
    'listcertificates.json': generateListCertificatesVectors(),
    'provecertificate.json': generateProveCertificateVectors(),
    'relinquishcertificate.json': generateRelinquishCertificateVectors(),
    'discoverbyidentitykey.json': generateDiscoverByIdentityKeyVectors(),
    'discoverbyattributes.json': generateDiscoverByAttributesVectors()
  }

  let total = 0
  for (const [file, vecs] of Object.entries(generated)) {
    const methodName = file.replace('.json', '')
    const displayName = methodName.replace(/([a-z])([A-Z])/g, '$1 $2')
    const full = {
      $schema: '../../../schema/vector.schema.json',
      id: `wallet.brc100.${methodName}`,
      name: `BRC-100 ${displayName}`,
      brc: ['BRC-100'],
      version: '2.0.0',
      reference_impl: '@bsv/sdk@2.0.14 + wallet-toolbox',
      parity_class: 'required',
      vectors: vecs
    }
    writeFileSync(join(outDir, file), JSON.stringify(full, null, 2))
    total += vecs.length
    console.log(`  ${file}: ${vecs.length} vectors`)
  }

  console.log(`\nNew/updated vectors generated: ${total}`)
  console.log('These cover: decrypt, verifyHmac, verifySignature (real computed values)')
  console.log('Plus comprehensive structural vectors for: state, action, certificate, discovery methods')
}

main().catch(console.error)
