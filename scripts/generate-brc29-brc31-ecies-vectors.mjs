#!/usr/bin/env node
/**
 * Generates expanded conformance vectors for:
 *  - wallet/brc29/payment-derivation.json  (3 → 25+ vectors)
 *  - messaging/brc31/authrite-signature.json (4 → 25+ vectors)
 *  - sdk/crypto/ecies.json (5 → 25+ vectors)
 */
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const { PrivateKey, ProtoWallet, ECIES: ECIESCompat } = await import(
  `${rootDir}/packages/sdk/dist/esm/mod.js`
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hexToBytes(hex) {
  const bytes = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  return bytes
}

function wallet(scalarHex) {
  return new ProtoWallet(PrivateKey.fromHex(scalarHex))
}

// Known private keys and their identity public keys
const KEYS = [
  { scalar: '0000000000000000000000000000000000000000000000000000000000000001', pubkey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' },
  { scalar: '0000000000000000000000000000000000000000000000000000000000000002', pubkey: '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5' },
  { scalar: '0000000000000000000000000000000000000000000000000000000000000003', pubkey: '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9' },
  { scalar: '0000000000000000000000000000000000000000000000000000000000000004', pubkey: '02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13' },
  { scalar: '0000000000000000000000000000000000000000000000000000000000000005', pubkey: '022f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4' },
]

// ---------------------------------------------------------------------------
// BRC-29: payment derivation vectors
// ---------------------------------------------------------------------------
async function generateBrc29Vectors() {
  const vectors = []
  let id = 1

  // prefix/suffix pairs to use
  const pairs = [
    ['rBpqFxcNxkmqWBxU', 'FDWH1mTbSBrC7yoW'],
    ['YmFzZTY0cmFuZG9t', 'b3V0cHV0c3VmZml4'],
    ['cGF5bWVudHByZWZp', 'eHN1ZmZpeHZhbHVl'],
    ['aW52b2ljZXByZWZp', 'eHN1ZmZpeHZhbHVl'],
    ['dHJhbnNhY3Rpb25w', 'cHJlZml4dmFsdWU0'],
    ['bm9uY2VwcmVmaXgx', 'bm9uY2VzdWZmaXgx'],
    ['MTIzNDU2Nzg5MA==', 'YWJjZGVmZ2hpams='],
    ['a2V5ZGVyaXZhdGlv', 'bm91dHB1dGtleXN1'],
  ]

  // 1. Sender derives recipient key: various sender/recipient combos
  for (let senderIdx = 0; senderIdx < 3; senderIdx++) {
    for (let recipientIdx = 0; recipientIdx < 3; recipientIdx++) {
      if (senderIdx === recipientIdx) continue
      for (const [prefix, suffix] of pairs.slice(0, 3)) {
        const w = wallet(KEYS[senderIdx].scalar)
        const result = await w.getPublicKey({
          protocolID: [2, '3241645161d8'],
          keyID: `${prefix} ${suffix}`,
          counterparty: KEYS[recipientIdx].pubkey,
        })
        vectors.push({
          id: `wallet.brc29.payment-derivation.${id++}`,
          description: `Sender (key ${senderIdx + 1}) derives recipient (key ${recipientIdx + 1}) output key: prefix='${prefix}', suffix='${suffix}'`,
          input: {
            root_key: KEYS[senderIdx].scalar,
            args: {
              protocolID: [2, '3241645161d8'],
              keyID: `${prefix} ${suffix}`,
              counterparty: KEYS[recipientIdx].pubkey,
            },
          },
          expected: { publicKey: result.publicKey },
          tags: ['brc-29', 'brc-42', 'payment', 'sender-derives'],
        })
      }
    }
  }

  // 2. Recipient derives same key (forSelf=true)
  for (let recipientIdx = 0; recipientIdx < 2; recipientIdx++) {
    for (let senderIdx = 0; senderIdx < 2; senderIdx++) {
      if (senderIdx === recipientIdx) continue
      for (const [prefix, suffix] of pairs.slice(0, 2)) {
        const w = wallet(KEYS[recipientIdx].scalar)
        const result = await w.getPublicKey({
          protocolID: [2, '3241645161d8'],
          keyID: `${prefix} ${suffix}`,
          counterparty: KEYS[senderIdx].pubkey,
          forSelf: true,
        })
        vectors.push({
          id: `wallet.brc29.payment-derivation.${id++}`,
          description: `Recipient (key ${recipientIdx + 1}) forSelf=true derives same key with senderIdentityKey (key ${senderIdx + 1}): prefix='${prefix}'`,
          input: {
            root_key: KEYS[recipientIdx].scalar,
            args: {
              protocolID: [2, '3241645161d8'],
              keyID: `${prefix} ${suffix}`,
              counterparty: KEYS[senderIdx].pubkey,
              forSelf: true,
            },
          },
          expected: { publicKey: result.publicKey },
          tags: ['brc-29', 'brc-42', 'payment', 'recipient-view', 'forSelf'],
        })
      }
    }
  }

  // 3. Symmetry: verify sender-derived == recipient-derived for same pair
  const [p0, s0] = pairs[0]
  const w1 = wallet(KEYS[0].scalar)
  const w2 = wallet(KEYS[1].scalar)
  const senderResult = await w1.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: `${p0} ${s0}`,
    counterparty: KEYS[1].pubkey,
  })
  const recipResult = await w2.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: `${p0} ${s0}`,
    counterparty: KEYS[0].pubkey,
    forSelf: true,
  })
  // They should be equal (same derived key)
  vectors.push({
    id: `wallet.brc29.payment-derivation.${id++}`,
    description: 'Symmetry: sender-derived == recipient-derived for same prefix/suffix (schema note)',
    input: {
      root_key: KEYS[0].scalar,
      args: {
        protocolID: [2, '3241645161d8'],
        keyID: `${p0} ${s0}`,
        counterparty: KEYS[1].pubkey,
      },
      _schema_note: `recipient forSelf=true with senderKey MUST produce same publicKey: ${recipResult.publicKey}`,
    },
    expected: { publicKey: senderResult.publicKey },
    tags: ['brc-29', 'brc-42', 'payment', 'symmetry'],
  })

  // 4. Self-payment (sender == recipient, counterparty='self')
  const wSelf = wallet(KEYS[0].scalar)
  const selfResult = await wSelf.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: `${p0} ${s0}`,
    counterparty: 'self',
  })
  vectors.push({
    id: `wallet.brc29.payment-derivation.${id++}`,
    description: 'Self-payment: sender pays self, counterparty="self"',
    input: {
      root_key: KEYS[0].scalar,
      args: {
        protocolID: [2, '3241645161d8'],
        keyID: `${p0} ${s0}`,
        counterparty: 'self',
      },
    },
    expected: { publicKey: selfResult.publicKey },
    tags: ['brc-29', 'brc-42', 'payment', 'self-payment'],
  })

  // 5. Different key pairs with timestamps as suffix (BRC-121 pattern)
  const timestampSuffixes = ['MTcxOTUwMDAwMDAwMA==', 'MTcxOTUxMDAwMDAwMA==', 'MTcxOTUyMDAwMDAwMA==']
  for (const suffix of timestampSuffixes) {
    const w = wallet(KEYS[2].scalar)
    const result = await w.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `3q2+7w== ${suffix}`,
      counterparty: KEYS[3].pubkey,
    })
    vectors.push({
      id: `wallet.brc29.payment-derivation.${id++}`,
      description: `BRC-121 timestamp suffix pattern: prefix='3q2+7w==', suffix='${suffix}' (base64-encoded Unix ms)`,
      input: {
        root_key: KEYS[2].scalar,
        args: {
          protocolID: [2, '3241645161d8'],
          keyID: `3q2+7w== ${suffix}`,
          counterparty: KEYS[3].pubkey,
        },
      },
      expected: { publicKey: result.publicKey },
      tags: ['brc-29', 'brc-42', 'payment', 'brc-121-timestamp'],
    })
  }

  return vectors
}

// ---------------------------------------------------------------------------
// BRC-31: authrite signature vectors
// ---------------------------------------------------------------------------
async function generateBrc31Vectors() {
  const vectors = []
  let id = 1

  // Pre-compute some nonce bytes as base64 strings
  const nonces = [
    Buffer.alloc(32, 0x00).toString('base64'), // all zeros
    Buffer.alloc(32, 0x01).toString('base64'), // all 0x01
    Buffer.alloc(32, 0x02).toString('base64'), // all 0x02
    Buffer.alloc(32, 0x03).toString('base64'), // all 0x03
    Buffer.alloc(32, 0xAA).toString('base64'), // all 0xAA
    Buffer.alloc(32, 0xFF).toString('base64'), // all 0xFF
    Buffer.from('deadbeef'.repeat(8), 'hex').toString('base64'),
    Buffer.from('cafebabe'.repeat(8), 'hex').toString('base64'),
  ]

  // Data payloads for general messages
  const payloads = [
    Buffer.from('{"hello":"Authrite!"}').toString('hex'),
    Buffer.from('{"action":"listOutputs","limit":10}').toString('hex'),
    Buffer.from('GET /sendMessage HTTP/1.1').toString('hex'),
    Buffer.alloc(0).toString('hex'), // empty
    Buffer.from(new Uint8Array(32).fill(0x42)).toString('hex'), // 32 bytes of 0x42
  ]

  // Phase 1: initialResponse signatures (various sender/recipient combos)
  const handshakePairs = [
    { senderIdx: 0, recipientIdx: 1 }, // Key1 → Key2
    { senderIdx: 1, recipientIdx: 0 }, // Key2 → Key1
    { senderIdx: 0, recipientIdx: 2 }, // Key1 → Key3
    { senderIdx: 2, recipientIdx: 0 }, // Key3 → Key1
  ]

  for (const { senderIdx, recipientIdx } of handshakePairs) {
    for (let nonceI = 0; nonceI < 3; nonceI++) {
      const senderNonce = nonces[nonceI]
      const recipientNonce = nonces[(nonceI + 1) % nonces.length]
      // Data = concat of both nonce bytes
      const senderNonceBytes = Buffer.from(senderNonce, 'base64')
      const recipientNonceBytes = Buffer.from(recipientNonce, 'base64')
      const data = Buffer.concat([senderNonceBytes, recipientNonceBytes]).toString('hex')
      const keyID = `${senderNonce} ${recipientNonce}`

      const senderWallet = wallet(KEYS[senderIdx].scalar)
      const signResult = await senderWallet.createSignature({
        data: hexToBytes(data),
        protocolID: [2, 'authrite message signature'],
        keyID,
        counterparty: KEYS[recipientIdx].pubkey,
      })

      vectors.push({
        id: `messaging.brc31.authrite-signature.${id++}`,
        description: `initialResponse: key${senderIdx + 1} signs concat(nonce_A || nonce_B) with keyID='<nonceA> <nonceB>', counterparty=key${recipientIdx + 1}`,
        input: {
          root_key: KEYS[senderIdx].scalar,
          method: 'createSignature',
          args: {
            data,
            protocolID: [2, 'authrite message signature'],
            keyID,
            counterparty: KEYS[recipientIdx].pubkey,
          },
        },
        expected: { signature: Buffer.from(signResult.signature).toString('hex') },
        tags: ['brc-31', 'brc-43', 'initial-response', `key${senderIdx + 1}-to-key${recipientIdx + 1}`],
      })

      // Corresponding verify
      const recipientWallet = wallet(KEYS[recipientIdx].scalar)
      const verifyResult = await recipientWallet.verifySignature({
        data: hexToBytes(data),
        signature: signResult.signature,
        protocolID: [2, 'authrite message signature'],
        keyID,
        counterparty: KEYS[senderIdx].pubkey,
      })
      vectors.push({
        id: `messaging.brc31.authrite-signature.${id++}`,
        description: `initialResponse verify: key${recipientIdx + 1} verifies key${senderIdx + 1}'s signature`,
        input: {
          root_key: KEYS[recipientIdx].scalar,
          method: 'verifySignature',
          args: {
            data,
            signature: Buffer.from(signResult.signature).toString('hex'),
            protocolID: [2, 'authrite message signature'],
            keyID,
            counterparty: KEYS[senderIdx].pubkey,
          },
        },
        expected: { valid: true },
        tags: ['brc-31', 'brc-43', 'initial-response', 'verify', `key${senderIdx + 1}-to-key${recipientIdx + 1}`],
      })
    }
  }

  // Phase 2: general message signatures
  for (let si = 0; si < 3; si++) {
    for (let ri = 0; ri < 2; ri++) {
      if (si === ri) continue
      for (const payload of payloads.slice(0, 3)) {
        const origNonce = nonces[si % nonces.length]
        const newNonce = nonces[(si + 2) % nonces.length]
        const keyID = `${origNonce} ${newNonce}`

        const sWallet = wallet(KEYS[si].scalar)
        const signResult = await sWallet.createSignature({
          data: hexToBytes(payload) || [],
          protocolID: [2, 'authrite message signature'],
          keyID,
          counterparty: KEYS[ri].pubkey,
        })
        vectors.push({
          id: `messaging.brc31.authrite-signature.${id++}`,
          description: `general message: key${si + 1} signs ${payload.length > 0 ? `payload (${payload.length / 2}B)` : 'empty payload'} to key${ri + 1}`,
          input: {
            root_key: KEYS[si].scalar,
            method: 'createSignature',
            args: {
              data: payload,
              protocolID: [2, 'authrite message signature'],
              keyID,
              counterparty: KEYS[ri].pubkey,
            },
          },
          expected: { signature: Buffer.from(signResult.signature).toString('hex') },
          tags: ['brc-31', 'brc-43', 'general-message'],
        })
      }
    }
  }

  // Invalid signature cases
  const baseNonce = nonces[0]
  const altNonce = nonces[1]
  const basePayload = Buffer.from('test payload').toString('hex')
  const baseWallet = wallet(KEYS[0].scalar)
  const validSig = await baseWallet.createSignature({
    data: hexToBytes(basePayload),
    protocolID: [2, 'authrite message signature'],
    keyID: `${baseNonce} ${altNonce}`,
    counterparty: KEYS[1].pubkey,
  })

  // Flip last byte of signature
  const tamperedSig = [...validSig.signature]
  tamperedSig[tamperedSig.length - 1] ^= 0xFF
  vectors.push({
    id: `messaging.brc31.authrite-signature.${id++}`,
    description: 'invalid signature: tampered DER byte — verify returns false',
    input: {
      root_key: KEYS[1].scalar,
      method: 'verifySignature',
      args: {
        data: basePayload,
        signature: Buffer.from(tamperedSig).toString('hex'),
        protocolID: [2, 'authrite message signature'],
        keyID: `${baseNonce} ${altNonce}`,
        counterparty: KEYS[0].pubkey,
      },
    },
    expected: { valid: false },
    tags: ['brc-31', 'brc-43', 'error', 'tampered-signature'],
  })

  // Wrong data
  const wrongPayload = Buffer.from('wrong data').toString('hex')
  vectors.push({
    id: `messaging.brc31.authrite-signature.${id++}`,
    description: 'invalid signature: correct sig but wrong data — verify returns false',
    input: {
      root_key: KEYS[1].scalar,
      method: 'verifySignature',
      args: {
        data: wrongPayload,
        signature: Buffer.from(validSig.signature).toString('hex'),
        protocolID: [2, 'authrite message signature'],
        keyID: `${baseNonce} ${altNonce}`,
        counterparty: KEYS[0].pubkey,
      },
    },
    expected: { valid: false },
    tags: ['brc-31', 'brc-43', 'error', 'wrong-data'],
  })

  return vectors
}

// ---------------------------------------------------------------------------
// ECIES vectors
// ---------------------------------------------------------------------------
async function generateEciesVectors() {
  // ECIES is non-deterministic (random ephemeral key), so we can't precompute
  // a fixed ciphertext. Instead we verify round-trips with descriptive metadata.
  // However the runner for ECIES needs to actually run encrypt+decrypt.
  // Let's create structural vectors documenting the interface.

  const vectors = []
  let id = 1

  const messages = [
    { label: 'single byte', hex: 'ff', lenBytes: 1 },
    { label: '4 bytes', hex: '01020304', lenBytes: 4 },
    { label: '16 bytes', hex: '000102030405060708090a0b0c0d0e0f', lenBytes: 16 },
    { label: '32 bytes', hex: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20', lenBytes: 32 },
    { label: 'ASCII text', hex: Buffer.from('Hello, BSV!').toString('hex'), lenBytes: 11 },
    { label: 'JSON-like payload', hex: Buffer.from('{"action":"pay","amount":1000}').toString('hex'), lenBytes: 30 },
    { label: '100 bytes', hex: Buffer.alloc(100, 0x42).toString('hex'), lenBytes: 100 },
    { label: '256 bytes', hex: Buffer.alloc(256, 0xAB).toString('hex'), lenBytes: 256 },
    { label: 'all zeros 32B', hex: Buffer.alloc(32, 0).toString('hex'), lenBytes: 32 },
  ]

  // For each sender/recipient pair, document the round-trip interface
  const pairs = [
    { sender: KEYS[0], recipient: KEYS[1] },
    { sender: KEYS[1], recipient: KEYS[0] },
    { sender: KEYS[2], recipient: KEYS[3] },
    { sender: KEYS[0], recipient: KEYS[2] },
    { sender: KEYS[3], recipient: KEYS[4] },
  ]

  for (const { sender, recipient } of pairs.slice(0, 3)) {
    for (const msg of messages.slice(0, 4)) {
      const senderWallet = wallet(sender.scalar)
      // Encrypt
      const encResult = await senderWallet.encrypt({
        plaintext: hexToBytes(msg.hex),
        protocolID: [0, 'ECIES'],
        keyID: '1',
        counterparty: recipient.pubkey,
      })
      // Decrypt from recipient side
      const recipientWallet = wallet(recipient.scalar)
      const decResult = await recipientWallet.decrypt({
        ciphertext: encResult.ciphertext,
        protocolID: [0, 'ECIES'],
        keyID: '1',
        counterparty: sender.pubkey,
      })
      // Verify the round-trip gives back the original
      const decHex = Buffer.from(decResult.plaintext).toString('hex')
      if (decHex !== msg.hex) throw new Error(`ECIES round-trip failed for ${msg.label}`)

      vectors.push({
        id: `sdk.crypto.ecies.${id++}`,
        description: `ECIES round-trip ${msg.label}: encrypt then decrypt recovers plaintext`,
        input: {
          sender_key: sender.scalar,
          recipient_key: recipient.scalar,
          plaintext: msg.hex,
          protocolID: [0, 'ECIES'],
          keyID: '1',
          counterparty_pub: recipient.pubkey,
          _note: 'ECIES is non-deterministic; this vector documents the interface and verifies round-trip correctness',
        },
        expected: {
          plaintext_recovered: msg.hex,
          roundtrip: true,
        },
        tags: ['ecies', 'round-trip', `${msg.lenBytes}B`],
      })
    }
  }

  // Document error cases
  vectors.push({
    id: `sdk.crypto.ecies.${id++}`,
    description: 'ECIES decrypt with wrong recipient key — error expected',
    input: {
      sender_key: KEYS[0].scalar,
      recipient_key: KEYS[2].scalar, // WRONG key
      plaintext: Buffer.from('test message').toString('hex'),
      protocolID: [0, 'ECIES'],
      keyID: '1',
      counterparty_pub: KEYS[1].pubkey, // encrypted to key2
      _note: 'decrypt with key3 instead of key2 must fail',
    },
    expected: {
      error: true,
    },
    tags: ['ecies', 'error', 'wrong-key'],
  })

  vectors.push({
    id: `sdk.crypto.ecies.${id++}`,
    description: 'ECIES decrypt tampered ciphertext — error expected',
    input: {
      sender_key: KEYS[0].scalar,
      recipient_key: KEYS[1].scalar,
      plaintext: Buffer.from('integrity check').toString('hex'),
      protocolID: [0, 'ECIES'],
      keyID: '1',
      counterparty_pub: KEYS[1].pubkey,
      _note: 'HMAC check fails on tampered ciphertext',
      _tamper: 'flip_last_byte',
    },
    expected: {
      error: true,
    },
    tags: ['ecies', 'error', 'tampered-ciphertext'],
  })

  // Self-encryption
  for (const msg of messages.slice(0, 2)) {
    const w = wallet(KEYS[0].scalar)
    const encResult = await w.encrypt({
      plaintext: hexToBytes(msg.hex),
      protocolID: [0, 'ECIES'],
      keyID: '1',
      counterparty: 'self',
    })
    const decResult = await w.decrypt({
      ciphertext: encResult.ciphertext,
      protocolID: [0, 'ECIES'],
      keyID: '1',
      counterparty: 'self',
    })
    const decHex = Buffer.from(decResult.plaintext).toString('hex')
    if (decHex !== msg.hex) throw new Error(`Self ECIES round-trip failed`)
    vectors.push({
      id: `sdk.crypto.ecies.${id++}`,
      description: `ECIES self-encryption round-trip ${msg.label}`,
      input: {
        sender_key: KEYS[0].scalar,
        recipient_key: KEYS[0].scalar,
        plaintext: msg.hex,
        protocolID: [0, 'ECIES'],
        keyID: '1',
        counterparty_pub: 'self',
      },
      expected: {
        plaintext_recovered: msg.hex,
        roundtrip: true,
      },
      tags: ['ecies', 'round-trip', 'self'],
    })
  }

  // Different keyIDs (verify distinct derivation)
  for (const keyID of ['1', '2', 'payment-key', 'session-42']) {
    const w = wallet(KEYS[0].scalar)
    const encResult = await w.encrypt({
      plaintext: hexToBytes('deadbeef'),
      protocolID: [0, 'ECIES'],
      keyID,
      counterparty: KEYS[1].pubkey,
    })
    const rw = wallet(KEYS[1].scalar)
    const decResult = await rw.decrypt({
      ciphertext: encResult.ciphertext,
      protocolID: [0, 'ECIES'],
      keyID,
      counterparty: KEYS[0].pubkey,
    })
    if (Buffer.from(decResult.plaintext).toString('hex') !== 'deadbeef') throw new Error(`keyID round-trip failed for ${keyID}`)
    vectors.push({
      id: `sdk.crypto.ecies.${id++}`,
      description: `ECIES round-trip with keyID='${keyID}'`,
      input: {
        sender_key: KEYS[0].scalar,
        recipient_key: KEYS[1].scalar,
        plaintext: 'deadbeef',
        protocolID: [0, 'ECIES'],
        keyID,
        counterparty_pub: KEYS[1].pubkey,
      },
      expected: {
        plaintext_recovered: 'deadbeef',
        roundtrip: true,
      },
      tags: ['ecies', 'round-trip', 'keyID-variant'],
    })
  }

  return vectors
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const base = `${rootDir}/conformance/vectors`

  // BRC-29
  console.log('Generating BRC-29 vectors...')
  const brc29Existing = JSON.parse(readFileSync(`${base}/wallet/brc29/payment-derivation.json`, 'utf8'))
  const brc29New = await generateBrc29Vectors()
  const brc29File = {
    ...brc29Existing,
    vectors: brc29New,
  }
  writeFileSync(`${base}/wallet/brc29/payment-derivation.json`, JSON.stringify(brc29File, null, 2))
  console.log(`  BRC-29: ${brc29New.length} vectors`)

  // BRC-31
  console.log('Generating BRC-31 vectors...')
  const brc31Existing = JSON.parse(readFileSync(`${base}/messaging/brc31/authrite-signature.json`, 'utf8'))
  const brc31New = await generateBrc31Vectors()
  const brc31File = {
    ...brc31Existing,
    vectors: brc31New,
  }
  writeFileSync(`${base}/messaging/brc31/authrite-signature.json`, JSON.stringify(brc31File, null, 2))
  console.log(`  BRC-31: ${brc31New.length} vectors`)

  // ECIES
  console.log('Generating ECIES vectors...')
  const eciesExisting = JSON.parse(readFileSync(`${base}/sdk/crypto/ecies.json`, 'utf8'))
  const eciesNew = await generateEciesVectors()
  const eciesFile = {
    ...eciesExisting,
    vectors: eciesNew,
  }
  writeFileSync(`${base}/sdk/crypto/ecies.json`, JSON.stringify(eciesFile, null, 2))
  console.log(`  ECIES: ${eciesNew.length} vectors`)

  console.log('\nDone!')
}

main().catch(console.error)
