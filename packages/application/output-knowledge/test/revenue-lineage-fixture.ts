import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { Beef, Hash, PrivateKey, signOutputPacket, Utils, type Transaction } from '@bsv/sdk'
import { BEEF_V2 } from '@bsv/sdk/transaction/Beef'
import { RevenueListing } from '@bsv/sdk/script/templates/RevenueListing'
import type { RevenueListingLineagePackage } from '../src/revenue-listing/LineagePackage.js'
import type { VerificationContext } from '../src/ports.js'
import type { ChainViewResolver } from '../src/SDKEvidenceVerifier.js'
import { assembleLineage, lineageLimits } from '../src/revenue-listing/LineagePackage.js'

const directory = new URL('./fixtures/revenue-listing/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('transactions.json', directory), 'utf8'))
function frozen(name: string, expected: string): unknown {
  const bytes = gunzipSync(readFileSync(new URL(name, directory)))
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Frozen lineage hash mismatch')
  return JSON.parse(bytes.toString('utf8'))
}
export const lineage = frozen(
  manifest.lineagePackage,
  manifest.lineagePackageSHA256
) as RevenueListingLineagePackage
export const boundary = frozen(manifest.lineageBoundary, manifest.lineageBoundarySHA256) as {
  copy: { txid: string; beef: string }
  merge: { txid: string; beef: string }
  genuinePrevious: string
}
const genesis = lineage.transactions.find(
  entry => entry.txid === lineage.genesis.body.genesis.txid
)!
const genesisTx = Beef.fromBinaryStrict(
  Utils.toArray(genesis.beef, 'base64')
).findTransactionForSigning(genesis.txid)!
export const family = new RevenueListing(genesisTx.outputs[0].lockingScript.toBinary().slice(428))

// A labelled easy-work header chain, never mainnet evidence. It extends the
// frozen checkpoint to a mature height with checked hashes, links and work.
const initialTime = new DataView(
  Uint8Array.from(Utils.toArray(manifest.chainCheckpoint.header, 'hex')).buffer
).getUint32(68, true)
function mineHeader(raw: Uint8Array): void {
  let nonce = 0
  for (;;) {
    new DataView(raw.buffer).setUint32(76, nonce++, true)
    const hash = Utils.toHex(Hash.hash256(Array.from(raw)).reverse())
    if (BigInt('0x' + hash) <= 0x7fffffn << 232n) return
  }
}
function makeHeaders(mined?: string): { hash: string; merkleRoot: string }[] {
  const selected: { hash: string; merkleRoot: string }[] = []
  let raw = Uint8Array.from(Utils.toArray(manifest.chainCheckpoint.header, 'hex'))
  for (let height = 0; height <= 101; height++) {
    if (height > 0) {
      raw = raw.slice()
      if (height === 1 && mined !== undefined) raw.set(Utils.toArray(mined, 'hex').reverse(), 36)
      raw.set(Utils.toArray(selected[height - 1].hash, 'hex').reverse(), 4)
      new DataView(raw.buffer).setUint32(68, initialTime + height * 600, true)
      mineHeader(raw)
    }
    const hash = Utils.toHex(Hash.hash256(Array.from(raw)).reverse())
    if (BigInt('0x' + hash) > 0x7fffffn << 232n) throw new Error('Invalid fixture work')
    if (height === 0 && hash !== lineage.descriptor.chain.genesisHash)
      throw new Error('Invalid fixture genesis')
    selected.push({ hash, merkleRoot: Utils.toHex(Array.from(raw.slice(36, 68)).reverse()) })
  }
  return selected
}
const headers = makeHeaders()
export function context(selected = headers): VerificationContext {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: 'lineage-view-101',
    partition: { application: 'family-fixture', account: 'synthetic', access: 'test' },
    generation: '0',
    view: {
      id: 'easy-work-101',
      chain: structuredClone(lineage.descriptor.chain),
      tipHash: selected[101].hash,
      tipHeight: '101',
      medianTimePast: String(initialTime + 96 * 600),
      chainPolicyDigest: '11'.repeat(32)
    },
    policyDigest: '22'.repeat(32),
    now: String(now),
    limits: { bytes: 2097152, transactions: 4096, dependencies: 16384, deadline: String(now + 60) }
  }
}
function resolver(selected = headers): ChainViewResolver {
  return {
    resolve: view =>
      Promise.resolve({
        view,
        tracker: {
          currentHeight: () => Promise.resolve(101),
          isValidRootForHeight: (root, height) =>
            Promise.resolve(selected[height]?.merkleRoot === root)
        },
        header: height =>
          selected[height]
            ? Promise.resolve(selected[height])
            : Promise.reject(new Error('Missing fixture header'))
      })
  }
}
export const chains = resolver()
export function minedChain(txid: string) {
  const selected = makeHeaders(txid)
  return { context: context(selected), chains: resolver(selected) }
}

/** Preserve exact raw transactions while deduplicating declared listing ancestors. */
export function compact(input: RevenueListingLineagePackage): RevenueListingLineagePackage {
  const packet = structuredClone(input)
  packet.transactions = packet.transactions.map(entry => {
    const part = Beef.fromBinaryStrict(Utils.toArray(entry.beef, 'base64'))
    part.version = BEEF_V2
    for (const other of packet.transactions)
      if (other.txid !== entry.txid) part.makeTxidOnly(other.txid)
    return { txid: entry.txid, beef: Utils.toBase64(part.toBinaryAtomic(entry.txid)) }
  })
  return packet
}

/** Public fixture key 41 authorizes a modified genesis for domain-boundary tests. */
export function changedGenesis(change: (tx: Transaction) => void): RevenueListingLineagePackage {
  const tx = Beef.fromBinaryStrict(Utils.toArray(genesis.beef, 'base64')).findTransactionForSigning(
    genesis.txid
  )!
  change(tx)
  const txid = tx.id('hex')
  const packet = structuredClone(lineage)
  packet.target = { ...packet.genesis.body.genesis, txid }
  packet.genesis = signOutputPacket(
    'sale-genesis',
    { ...packet.genesis.body, genesis: packet.target },
    new PrivateKey(41)
  )
  packet.transactions = [{ txid, beef: Utils.toBase64(tx.toAtomicBEEF()) }]
  return packet
}

/** Keep only the declared ancestors of a named frozen listing transition. */
export function atListing(name: string, outputIndex = 0): RevenueListingLineagePackage {
  const packet = structuredClone(lineage)
  const trace = manifest.traces.find((item: { name: string }) => item.name === name)
  if (trace === undefined) throw new Error('Unknown fixture transition')
  packet.target = { ...packet.target, txid: trace.txid, outputIndex }
  const assembly = assembleLineage(packet, lineageLimits({}))
  const visited = new Set<string>(),
    queue = [trace.txid as string]
  while (queue.length > 0) {
    const txid = queue.pop()!
    if (visited.has(txid)) continue
    visited.add(txid)
    const tx = assembly.transactions.get(txid)!
    for (const input of tx.inputs)
      if (assembly.entries.has(input.sourceTXID!)) queue.push(input.sourceTXID!)
  }
  packet.transactions = packet.transactions.filter(entry => visited.has(entry.txid))
  return packet
}

/** Rebind actual raw bytes after a test changes the target transaction. */
export function changedTarget(
  input: RevenueListingLineagePackage,
  change: (tx: Transaction) => void
): RevenueListingLineagePackage {
  const packet = structuredClone(input)
  const assembly = assembleLineage(packet, lineageLimits({}))
  const tx = assembly.beef.findTransactionForSigning(packet.target.txid)!
  change(tx)
  const old = packet.target.txid,
    txid = tx.id('hex')
  packet.target.txid = txid
  packet.transactions = packet.transactions.filter(entry => entry.txid !== old)
  packet.transactions.push({ txid, beef: Utils.toBase64(tx.toAtomicBEEF()) })
  packet.transactions.sort((a, b) => a.txid.localeCompare(b.txid))
  return compact(packet)
}

export function completeGenesis(): RevenueListingLineagePackage {
  const packet = structuredClone(lineage)
  const assembly = assembleLineage(packet, lineageLimits({}))
  packet.target = structuredClone(packet.genesis.body.genesis)
  packet.transactions = [
    {
      txid: packet.target.txid,
      beef: Utils.toBase64(assembly.beef.toBinaryAtomic(packet.target.txid))
    }
  ]
  return packet
}
