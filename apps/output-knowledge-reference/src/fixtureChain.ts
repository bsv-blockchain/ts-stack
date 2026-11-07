import { canonicalOutputJSON, Hash, Transaction, Utils, type OutputPartition } from '@bsv/sdk'
import type {
  ChainViewResolver,
  EvidenceCandidate,
  VerificationContext
} from '@bsv/output-knowledge'
import fixture from './fixtures/chain.json'

/** Public deterministic fixtures only. These funds and headers have no mainnet value. */
export type FixtureRecord = 'A' | 'AC' | 'Q' | 'X'
export const fixtureChain = Object.freeze({
  network: 'brc-reconciliation-fixture',
  genesisHash: fixture.headers[0].hash
})
export const fixtureLabels: Record<FixtureRecord, string> = {
  A: 'First edition',
  AC: 'Revised edition (spends the first)',
  Q: 'Independent record',
  X: 'Another independent record'
}
const headers = fixture.headers.map((header, index) => {
  const bytes = Utils.toArray(header.raw, 'hex')
  const data = new DataView(Uint8Array.from(bytes).buffer)
  const previous = Utils.toHex(bytes.slice(4, 36).reverse())
  if (
    bytes.length !== 80 ||
    header.height !== index ||
    Utils.toHex(Hash.hash256(bytes).reverse()) !== header.hash ||
    data.getUint32(72, true) !== 0x207fffff ||
    BigInt('0x' + header.hash) > 0x7fffffn << 232n ||
    previous !== (index === 0 ? '00'.repeat(32) : fixture.headers[index - 1].hash)
  )
    throw new Error('Invalid synthetic reference-chain ancestry')
  return {
    ...header,
    merkleRoot: Utils.toHex(bytes.slice(36, 68).reverse()),
    time: data.getUint32(68, true)
  }
})
const tip = headers.at(-1)!
const times = headers
  .slice(-11)
  .map(header => header.time)
  .sort((a, b) => a - b)
const view = Object.freeze({
  id: 'reference-fixed-view-1',
  chain: fixtureChain,
  tipHash: tip.hash,
  tipHeight: String(tip.height),
  medianTimePast: String(times[Math.floor(times.length / 2)]),
  chainPolicyDigest: Utils.toHex(
    Hash.sha256(Utils.toArray('synthetic-easy-pow-pinned-ancestry/1', 'utf8'))
  )
})
const transactions = new Map(
  Object.entries(fixture.transactions).map(([name, item]) => [name, Transaction.fromHex(item.raw)])
)
const names = new Map(Object.entries(fixture.transactions).map(([name, item]) => [item.txid, name]))
for (const anchor of fixture.anchors) {
  transactions.get(anchor.name)!.merklePath = Transaction.fromAtomicBEEF(
    Utils.toArray(anchor.beef, 'base64')
  ).merklePath
}
for (const transaction of transactions.values()) {
  for (const input of transaction.inputs)
    input.sourceTransaction = transactions.get(names.get(input.sourceTXID!) ?? '')
}

export function referenceContext(partition: OutputPartition): VerificationContext {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: 'reference-verification-1',
    partition: { ...partition },
    generation: '0',
    view: structuredClone(view),
    policyDigest: '02'.repeat(32),
    now: String(now),
    limits: { bytes: 4194304, transactions: 4096, dependencies: 16384, deadline: String(now + 60) }
  }
}

export const referenceResolver: ChainViewResolver = {
  resolve(requested) {
    if (canonicalOutputJSON(requested) !== canonicalOutputJSON(view))
      return Promise.reject(new Error('Unrecognized reference chain view'))
    return Promise.resolve({
      view: structuredClone(view),
      tracker: {
        currentHeight: () => Promise.resolve(tip.height),
        isValidRootForHeight: (root, height) =>
          Promise.resolve(headers.some(row => row.height === height && row.merkleRoot === root))
      },
      header(height) {
        const row = headers.find(header => header.height === height)
        if (!row) return Promise.reject(new Error('Reference header unavailable'))
        return Promise.resolve({ hash: row.hash, merkleRoot: row.merkleRoot })
      }
    })
  }
}

export function referenceEvidence(name: FixtureRecord): EvidenceCandidate {
  const transaction = transactions.get(name)!
  const bytes = transaction.toAtomicBEEF()
  return {
    chain: { ...fixtureChain },
    evidence: { txid: transaction.id('hex'), outputIndex: 0, beef: Utils.toBase64(bytes) },
    variantId: Utils.toHex(Hash.sha256(bytes))
  }
}
