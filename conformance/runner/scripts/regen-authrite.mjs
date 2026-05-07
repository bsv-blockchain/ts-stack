#!/usr/bin/env node
/**
 * regen-authrite.mjs — Regenerate BRC-31 authrite-signature vectors 5–26
 *
 * For each create-signature vector (5,7,8,10,12,14,16,18,20,22,23,25):
 *   - Builds ProtoWallet(PrivateKey.fromHex(root_key))
 *   - Calls wallet.createSignature(args) against current @bsv/sdk@2.1.0
 *   - Updates vector's expected.signature with fresh hex
 *
 * For each verify-signature vector (6,9,11,13,15,17,19,21,24,26) paired to a
 * create vector:
 *   - Swaps input.args.signature with the freshly-generated one
 *   - Calls wallet.verifySignature(...) to confirm valid === true
 *
 * Also:
 *   - Restores vector 6 parity_class to "required" (removes stale skip_reason)
 *   - Bumps file version patch (1.1.0 → 1.1.1)
 *   - Updates reference_impl to @bsv/sdk@2.1.0
 *
 * Usage:
 *   node conformance/runner/scripts/regen-authrite.mjs
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..')

// Import from the built ESM dist (works without jest moduleNameMapper)
const sdkPath = resolve(repoRoot, 'packages', 'sdk', 'dist', 'esm', 'mod.js')
const { PrivateKey, ProtoWallet } = await import(sdkPath)

// ── Helpers ───────────────────────────────────────────────────────────────────

function hexToBytes (hex) {
  if (hex === '' || hex == null) return []
  if (hex.length % 2 !== 0) hex = '0' + hex
  const out = []
  for (let i = 0; i < hex.length; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16))
  }
  return out
}

function bytesToHex (bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function bumpPatch (version) {
  const parts = version.split('.')
  parts[2] = String(parseInt(parts[2], 10) + 1)
  return parts.join('.')
}

// ── Load vectors ──────────────────────────────────────────────────────────────

const vectorsPath = resolve(
  repoRoot,
  'conformance', 'vectors', 'messaging', 'brc31', 'authrite-signature.json'
)
const corpus = JSON.parse(readFileSync(vectorsPath, 'utf8'))

// ── Identify create/verify pairs ──────────────────────────────────────────────
// Create vectors: 5,7,8,10,12,14,16,18,20,22,23,25
// Verify vectors paired to them: 6,9,11,13,15,17,19,21,24,26
//
// Pairing by position sequence (as described in task):
//   create 5 → verify 6
//   create 7 → (no direct verify — Alice signs, no separate verify vector)
//   create 8 → verify 9
//   create 10 → verify 11
//   create 12 → verify 13
//   create 14 → verify 15
//   create 16 → verify 17
//   create 18 → verify 19
//   create 20 → verify 21
//   create 22 → (no paired verify in list)
//   create 23 → verify 24
//   create 25 → verify 26
//
// We determine pairs by reading adjacent vectors: a verify vector's
// input.args.signature matches the create vector's expected.signature.
// We map by description references ("from vector N").

const vectors = corpus.vectors

// Build index by numeric suffix
function vectorNum (v) {
  return parseInt(v.id.split('.').pop(), 10)
}

// Map from create-vector-num → verify-vector-num (from descriptions)
// "verifies ... from vector N" — parse N
const pairsCreateToVerify = new Map()
for (const v of vectors) {
  const num = vectorNum(v)
  const input = v.input
  if (input && input.method === 'verifySignature' && !v.expected?.error) {
    // Extract "from vector N" from description
    const match = v.description.match(/from vector (\d+)/i)
    if (match) {
      const createNum = parseInt(match[1], 10)
      pairsCreateToVerify.set(createNum, num)
    }
  }
}

console.log('Pairs (createVec → verifyVec):',
  [...pairsCreateToVerify.entries()].map(([c, v]) => `${c}→${v}`).join(', '))

// ── Regenerate ────────────────────────────────────────────────────────────────

const freshSigs = new Map() // vectorNum → hex string
const report = []

for (const v of vectors) {
  const num = vectorNum(v)
  if (v.skip) continue // vectors 1-4, skip

  const input = v.input
  if (!input) continue

  if (input.method === 'createSignature') {
    const args = input.args
    const wallet = new ProtoWallet(PrivateKey.fromHex(input.root_key))

    let newSigHex
    try {
      const { signature } = await wallet.createSignature({
        data: hexToBytes(args.data),
        protocolID: args.protocolID,
        keyID: args.keyID,
        counterparty: args.counterparty
      })
      newSigHex = bytesToHex(signature)
    } catch (err) {
      report.push({
        vectorNum: num,
        status: 'ERROR',
        error: err.message
      })
      console.error(`Vector ${num}: createSignature FAILED: ${err.message}`)
      continue
    }

    const oldSigHex = v.expected.signature
    const changed = oldSigHex !== newSigHex

    freshSigs.set(num, newSigHex)
    v.expected.signature = newSigHex

    report.push({
      vectorNum: num,
      status: changed ? 'UPDATED' : 'UNCHANGED',
      old: oldSigHex ? oldSigHex.slice(0, 20) + '...' : '(none)',
      new: newSigHex.slice(0, 20) + '...'
    })

    if (changed) {
      console.log(`Vector ${num}: UPDATED signature`)
      console.log(`  old: ${oldSigHex}`)
      console.log(`  new: ${newSigHex}`)
    } else {
      console.log(`Vector ${num}: signature unchanged`)
    }
  }
}

// ── Update verify vectors ─────────────────────────────────────────────────────

for (const v of vectors) {
  const num = vectorNum(v)
  if (v.skip) continue
  if (!v.input || v.input.method !== 'verifySignature') continue
  if (v.expected?.error) continue // error-case vectors — leave alone

  // Find which create vector this verify corresponds to
  let createNum = null
  for (const [cn, vn] of pairsCreateToVerify.entries()) {
    if (vn === num) { createNum = cn; break }
  }

  if (createNum === null) {
    console.warn(`Vector ${num}: no paired create vector found, skipping`)
    continue
  }

  const freshSig = freshSigs.get(createNum)
  if (!freshSig) {
    console.warn(`Vector ${num}: create vector ${createNum} had no fresh sig, skipping`)
    continue
  }

  const oldSigInInput = v.input.args.signature
  v.input.args.signature = freshSig

  // Verify the signature actually validates
  const args = v.input.args
  const wallet = new ProtoWallet(PrivateKey.fromHex(v.input.root_key))
  try {
    const { valid } = await wallet.verifySignature({
      data: hexToBytes(args.data),
      signature: hexToBytes(freshSig),
      protocolID: args.protocolID,
      keyID: args.keyID,
      counterparty: args.counterparty
    })
    if (!valid) {
      throw new Error('verifySignature returned valid=false')
    }
    const changed = oldSigInInput !== freshSig
    report.push({
      vectorNum: num,
      status: changed ? 'UPDATED' : 'UNCHANGED',
      note: `verify vector updated to use create-${createNum} sig; verifySignature OK`
    })
    console.log(`Vector ${num}: verify OK${changed ? ' (sig updated)' : ' (sig unchanged)'}`)
  } catch (err) {
    report.push({
      vectorNum: num,
      status: 'VERIFY_FAILED',
      error: err.message
    })
    console.error(`Vector ${num}: VERIFY FAILED: ${err.message}`)
  }
}

// ── Restore vector 6 parity_class ────────────────────────────────────────────

const vec6 = vectors.find(v => vectorNum(v) === 6)
if (vec6) {
  const hadBestEffort = vec6.parity_class === 'best-effort'
  vec6.parity_class = 'required'
  if ('skip_reason' in vec6) {
    delete vec6.skip_reason
  }
  console.log(`Vector 6: parity_class restored to "required"${hadBestEffort ? ' (was best-effort)' : ''}`)
}

// ── Bump version & reference_impl ────────────────────────────────────────────

const oldVersion = corpus.version
corpus.version = bumpPatch(oldVersion)
corpus.reference_impl = '@bsv/sdk@2.1.0'
console.log(`Version: ${oldVersion} → ${corpus.version}`)
console.log(`reference_impl: ${corpus.reference_impl}`)

// ── Write back ────────────────────────────────────────────────────────────────

const output = JSON.stringify(corpus, null, 2) + '\n'
writeFileSync(vectorsPath, output, 'utf8')
console.log(`\nWrote ${vectorsPath}`)

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n=== Regeneration Report ===')
for (const r of report) {
  const prefix = r.status === 'UPDATED' ? '  [UPDATED]' :
                 r.status === 'UNCHANGED' ? '[unchanged]' :
                 r.status === 'ERROR' ? '   [ERROR!]' :
                 r.status === 'VERIFY_FAILED' ? '  [VFAIL!]' : `[${r.status}]`
  const detail = r.error ? ` — ERROR: ${r.error}` :
                 r.old ? ` old=${r.old} new=${r.new}` :
                 r.note ? ` — ${r.note}` : ''
  console.log(`  vec${r.vectorNum}: ${prefix}${detail}`)
}

const errors = report.filter(r => r.status === 'ERROR' || r.status === 'VERIFY_FAILED')
if (errors.length === 0) {
  console.log('\nAll vectors regenerated successfully.')
} else {
  console.error(`\n${errors.length} vector(s) failed — see above.`)
  process.exit(1)
}
