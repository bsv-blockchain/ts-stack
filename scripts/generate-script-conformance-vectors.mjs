import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const FIXTURE_ROOT = join(ROOT, 'packages/sdk/src/script/__tests/fixtures')
const OUTPUT = join(ROOT, 'conformance/vectors/sdk/scripts/evaluation.json')
const OP_SOURCE = join(ROOT, 'packages/sdk/src/script/OP.ts')

const NODE_SOURCES = [
  {
    key: 'bitcoin-sv',
    label: 'SV Node',
    repository: 'https://github.com/bitcoin-sv/bitcoin-sv',
    commit: '90a1a00e62b93c095b9ead39bbbd922873e1e6a9',
    source_directory: 'src/test/data',
    shas: {
      'script_tests.json': 'a77f8b94412ef61e9ee59980ebc682a64212b47a16f06d87f809d91770ba496d',
      'sighash.json': '9c1afcaf81e8482f818345efa8a3f0610f6541b975023b58550d50ad2a557f63',
      'tx_invalid.json': '536a533f00714374d15fb24f601b989a87f9447a7a414a6532380e41c09c4fbe',
      'tx_valid.json': '20e42308ead38db645454c4def763288e8cef2e5c47a4d9088e53dc7fc01419d'
    }
  },
  {
    key: 'teranode',
    label: 'Teranode',
    repository: 'https://github.com/bsv-blockchain/teranode',
    commit: '2355e57b80af962327930ea32568a1b322361542',
    source_directory: 'test/consensus/testdata',
    shas: {
      'script_tests.json': '3577a2e6e71e3356c5ec06eaa5fffb243e563eeef3946bd9b0285a54f0ad87f9',
      'sighash.json': 'ca2d6449c7cb98b8a83f3e18dc994d8227001d87adedd907b5e9a235114e283f',
      'tx_invalid.json': '536a533f00714374d15fb24f601b989a87f9447a7a414a6532380e41c09c4fbe',
      'tx_valid.json': '20e42308ead38db645454c4def763288e8cef2e5c47a4d9088e53dc7fc01419d'
    }
  }
]

const GENERATED_PREFIXES = [
  'node.script.',
  'node.sighash.',
  'node.tx-valid.',
  'node.tx-invalid.'
]

// These upstream tx_invalid entries are useful provenance, but the SDK's
// script-level Spend runner does not reject them as standalone spends. Keep
// them in the corpus as intended coverage until full transaction consensus
// validation is represented in the conformance runner.
const TX_INVALID_INTENDED_INDICES = new Set([
  31, 34, 37, 39, 40,
  68, 69, 71, 72, 74, 75, 77, 79, 80, 82, 85, 87, 89, 90, 91, 93, 95, 97, 99,
  101, 106, 107, 109, 110, 118, 119, 120, 121, 125, 127
])

const opSource = readFileSync(OP_SOURCE, 'utf8')
const OP = {}
for (const match of opSource.matchAll(/\b(OP_[A-Z0-9_]+):\s*0x([0-9a-f]+)/gi)) {
  OP[match[1]] = Number.parseInt(match[2], 16)
}

function readFixture (source, file) {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, source.key, file), 'utf8'))
}

function amountFromJSON (amount) {
  return Math.round(Number(amount) * 100000000)
}

function toHex (bytes) {
  return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function scriptNumBytes (value) {
  if (value === 0n) return []

  const negative = value < 0n
  let absValue = negative ? -value : value
  const bytes = []
  while (absValue > 0n) {
    bytes.push(Number(absValue & 0xffn))
    absValue >>= 8n
  }

  if ((bytes[bytes.length - 1] & 0x80) !== 0) {
    bytes.push(negative ? 0x80 : 0)
  } else if (negative) {
    bytes[bytes.length - 1] |= 0x80
  }

  return bytes
}

function writePush (bytes, out) {
  if (bytes.length === 0) {
    out.push(OP.OP_0)
  } else if (bytes.length === 1 && bytes[0] >= 1 && bytes[0] <= 16) {
    out.push(OP.OP_1 + bytes[0] - 1)
  } else if (bytes.length === 1 && bytes[0] === 0x81) {
    out.push(OP.OP_1NEGATE)
  } else if (bytes.length < OP.OP_PUSHDATA1) {
    out.push(bytes.length, ...bytes)
  } else if (bytes.length <= 0xff) {
    out.push(OP.OP_PUSHDATA1, bytes.length, ...bytes)
  } else if (bytes.length <= 0xffff) {
    out.push(OP.OP_PUSHDATA2, bytes.length & 0xff, (bytes.length >> 8) & 0xff, ...bytes)
  } else {
    out.push(
      OP.OP_PUSHDATA4,
      bytes.length & 0xff,
      (bytes.length >> 8) & 0xff,
      (bytes.length >> 16) & 0xff,
      (bytes.length >> 24) & 0xff,
      ...bytes
    )
  }
}

function tokenToOpcode (token) {
  if (token === 'TRUE') return OP.OP_TRUE
  if (token === 'FALSE') return OP.OP_FALSE
  const opToken = token.startsWith('OP_') ? token : `OP_${token}`
  return OP[opToken]
}

function tokenizeAsm (asm) {
  return asm.match(/'[^']*'|\S+/g) ?? []
}

function parseNodeAsm (asm) {
  const out = []
  for (const token of tokenizeAsm(asm)) {
    if (token.startsWith('0x')) {
      out.push(...Buffer.from(token.slice(2), 'hex'))
      continue
    }

    if (token.startsWith("'") && token.endsWith("'")) {
      writePush(Array.from(Buffer.from(token.slice(1, -1), 'utf8')), out)
      continue
    }

    if (/^-?\d+$/.test(token)) {
      writePush(scriptNumBytes(BigInt(token)), out)
      continue
    }

    const opcode = tokenToOpcode(token)
    if (opcode === undefined) throw new Error(`Unsupported script token ${token} in ${asm}`)
    out.push(opcode)
  }
  return out
}

function flagsFromCSV (flags) {
  if (flags === '') return []
  return flags.split(',').filter(Boolean)
}

function flagSets (raw) {
  const flags = Array.isArray(raw) ? raw.map(String) : [String(raw)]
  return flags.map(flagsFromCSV)
}

function compact (text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function describeWithComment (prefix, index, comment, fallback) {
  const suffix = compact(comment) || fallback
  return `${prefix} #${index}: ${suffix}`.slice(0, 240)
}

function padIndex (index) {
  return String(index).padStart(4, '0')
}

function sourceGroupsFor (file) {
  const bySha = new Map()
  for (const source of NODE_SOURCES) {
    const sha = source.shas[file]
    const group = bySha.get(sha) ?? []
    group.push(source)
    bySha.set(sha, group)
  }
  return [...bySha.values()]
}

function sourceId (sources) {
  return sources.length > 1 ? 'shared' : sources[0].key
}

function sourceKeys (sources) {
  return sources.map(source => source.key)
}

function sourceLabels (sources) {
  return sources.map(source => source.label).join(' and ')
}

function generatedTags (type, sources, valid) {
  return [
    'script',
    type,
    'node-fixture',
    ...sourceKeys(sources),
    ...(sources.length > 1 ? ['shared-fixture'] : []),
    valid ? 'valid' : 'invalid'
  ]
}

function generateScriptVectors () {
  const vectors = []

  for (const source of NODE_SOURCES) {
    const raw = readFixture(source, 'script_tests.json')
    for (const [index, entry] of raw.entries()) {
      if (!Array.isArray(entry) || entry.length <= 1) continue

      let offset = 0
      let amount = 0
      let txVersion = 1
      let scriptSig
      let scriptPubKey
      let flags
      let expectedResult
      let comment

      if (source.key === 'bitcoin-sv') {
        if (Array.isArray(entry[0])) {
          amount = amountFromJSON(entry[0][0])
          offset = 1
        }
        txVersion = Number(entry[offset])
        scriptSig = String(entry[offset + 1])
        scriptPubKey = String(entry[offset + 2])
        flags = String(entry[offset + 3])
        expectedResult = String(entry[offset + 4])
        comment = entry[offset + 5]
      } else {
        if (Array.isArray(entry[0])) {
          amount = amountFromJSON(entry[0][0])
          offset = 1
        }
        scriptSig = String(entry[offset])
        scriptPubKey = String(entry[offset + 1])
        flags = String(entry[offset + 2])
        expectedResult = String(entry[offset + 3])
        comment = entry[offset + 4]
      }

      const valid = expectedResult === 'OK'
      vectors.push({
        id: `node.script.${source.key}.${padIndex(index)}`,
        description: describeWithComment(`${source.label} script_tests.json`, index, comment, expectedResult),
        input: {
          fixture_type: 'node-script',
          sources: [source.key],
          source_file: 'script_tests.json',
          source_index: index,
          amount_satoshis: amount,
          tx_version: txVersion,
          script_sig_asm: scriptSig,
          script_sig_hex: toHex(parseNodeAsm(scriptSig)),
          script_pubkey_asm: scriptPubKey,
          script_pubkey_hex: toHex(parseNodeAsm(scriptPubKey)),
          flags: flagsFromCSV(flags),
          flags_csv: flags
        },
        expected: {
          result: expectedResult,
          valid
        },
        tags: generatedTags('evaluation', [source], valid)
      })
    }
  }

  return vectors
}

function generateSighashVectors () {
  const vectors = []

  for (const group of sourceGroupsFor('sighash.json')) {
    const source = group[0]
    const raw = readFixture(source, 'sighash.json')
    for (const [index, entry] of raw.entries()) {
      if (!Array.isArray(entry) || entry.length <= 1) continue

      vectors.push({
        id: `node.sighash.${sourceId(group)}.${padIndex(index)}`,
        description: `${sourceLabels(group)} sighash.json #${index}`,
        input: {
          fixture_type: 'node-sighash',
          sources: sourceKeys(group),
          source_file: 'sighash.json',
          source_index: index,
          tx_hex: String(entry[0]),
          script_hex: String(entry[1]),
          input_index: Number(entry[2]),
          hash_type: Number(entry[3])
        },
        expected: {
          regular_hash: String(entry[4]),
          original_hash: String(entry[5])
        },
        tags: ['script', 'sighash', 'node-fixture', ...sourceKeys(group)]
      })
    }
  }

  return vectors
}

function normalizePrevouts (prevouts) {
  return prevouts.map(([txid, vout, scriptAsm, amount]) => ({
    txid: String(txid),
    vout: Number(vout),
    script_pubkey_asm: String(scriptAsm),
    script_pubkey_hex: toHex(parseNodeAsm(String(scriptAsm))),
    amount_satoshis: amount === undefined ? 0 : amountFromJSON(amount)
  }))
}

function generateTransactionVectors (file, valid) {
  const vectors = []

  for (const group of sourceGroupsFor(file)) {
    const source = group[0]
    const raw = readFixture(source, file)
    for (const [index, entry] of raw.entries()) {
      if (!Array.isArray(entry) || entry.length <= 1) continue

      const idType = valid ? 'tx-valid' : 'tx-invalid'
      const vector = {
        id: `node.${idType}.${sourceId(group)}.${padIndex(index)}`,
        description: `${sourceLabels(group)} ${file} #${index}`,
        input: {
          fixture_type: 'node-transaction',
          sources: sourceKeys(group),
          source_file: file,
          source_index: index,
          tx_hex: String(entry[1]),
          prevouts: normalizePrevouts(entry[0]),
          flag_strings: Array.isArray(entry[2]) ? entry[2].map(String) : [String(entry[2])],
          flag_sets: flagSets(entry[2])
        },
        expected: {
          valid
        },
        tags: generatedTags('transaction', group, valid)
      }

      if (!valid && TX_INVALID_INTENDED_INDICES.has(index)) {
        vector.parity_class = 'intended'
        vector.skip_reason = 'Preserved from upstream tx_invalid.json, but not required for script-interpreter conformance because the standalone script spend validates without full transaction consensus checks.'
        vector.tags.push('intended', 'full-transaction-consensus')
      }

      vectors.push(vector)
    }
  }

  return vectors
}

function stripGeneratedVectors (vectors) {
  return vectors.filter(vector => !GENERATED_PREFIXES.some(prefix => vector.id.startsWith(prefix)))
}

function buildSourcesMetadata () {
  return Object.fromEntries(NODE_SOURCES.map(source => [
    source.key,
    {
      label: source.label,
      repository: source.repository,
      commit: source.commit,
      source_directory: source.source_directory,
      sha256: source.shas
    }
  ]))
}

const existing = JSON.parse(readFileSync(OUTPUT, 'utf8'))
const baseVectors = stripGeneratedVectors(existing.vectors ?? [])
const generated = [
  ...generateScriptVectors(),
  ...generateSighashVectors(),
  ...generateTransactionVectors('tx_valid.json', true),
  ...generateTransactionVectors('tx_invalid.json', false)
]

const next = {
  ...existing,
  $schema: 'https://bsvblockchain.org/conformance/schema/v1.json',
  id: 'sdk.scripts.evaluation',
  name: 'Script parsing, encoding, sighash and evaluation parity with SV Node and Teranode',
  brc: ['BRC-14'],
  version: '3.0.0',
  reference_impl: 'packages/sdk/src/script/Script.ts, packages/sdk/src/script/Spend.ts, packages/sdk/src/primitives/TransactionSignature.ts',
  parity_class: 'required',
  sources: buildSourcesMetadata(),
  vectors: [...baseVectors, ...generated]
}

writeFileSync(OUTPUT, `${JSON.stringify(next, null, 2)}\n`)
console.log(`Wrote ${next.vectors.length} script conformance vectors (${generated.length} generated node vectors)`)
